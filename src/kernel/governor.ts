// Budget governor — T1.3 slice 1 (ws-a items 4–5): the per-job wall-clock
// escalation ladder, per-job/per-run attempt caps, the USD rollup cap, the
// dual in-flight/dispatch caps, and the honest-stop ledger (invariant I9).
//
// SEAM — the governed runner (W2.2, ADR-0003 §2): `runPlan(plan, opts,
// registry, gov?)` takes the `Governance` handle below and performs admission
// (on the real plan job id), the ladder, the DD-9 evidence folds, the v2
// journal, and the honest stop ITSELF — this module is the per-run enforcer
// the handle carries (createGovernor), not a composition wrapper. The old
// governed-registry decorator (governRegistry/withBudgetStop/seedFromRunLog)
// is deleted with no shim: the runner is the one governed composition.
// Either way this module NEVER retries: an in-wrapper retry would hide
// attempts from the journal, which is recorded as journal-dishonest and
// rejected.
//
// Invariants honored here:
//   - I8: the governor decides WHEN to abort (this module) and the kernel
//     owns WHETHER to retry/escalate (rescue.ts); drivers never decide.
//     Enforcement is abort-only — this module never re-dispatches.
//   - I9: honest stop — at a cap the remaining work is marked
//     budget-exhausted, never fabricated; the runner claims
//     stoppedEarly only when the stop ACTUALLY gated undispatched work.
//   - DD-9: the budget is api-equivalent — maxUsd trips through MODELED cost
//     (the list-price proxy a subscription lane still produces), maxTokens
//     rolls up independently as the unpriced-model backstop, and real usage
//     folding with no costUSD under a USD cap trips loud (never fail open).
//
// Testability contract (slice 2 depends on it): every timer goes through the
// injected `Clock` (no naked setTimeout anywhere in this module), every
// ladder rung emits a marker — what fired, in what order, with what delays,
// whether its primitive was delivered — into `BudgetGovernor.events`, and
// `runLadder` is a standalone unit so the ladder is exercisable without a
// registry.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Usage, WorkerResult } from '../driver/types.js';
import { DEFAULT_ABORT_GRACE_MS } from './governor.config.js';
import { prepareProcessSignalCleanup } from './process-signals.js';
import type {
  GovernanceOptIn,
  JournalEvent,
  Limits,
  OpResult,
  ReservationChargeBasis,
  ReservationClass,
  RunOptions,
} from './types.js';

// ---------------------------------------------------------------------------
// Clock — the injectable time source (tests advance virtual time)
// ---------------------------------------------------------------------------

/**
 * Injectable time source. The governor and the ladder go through THIS and
 * only this for timers and elapsed time, so tests drive virtual time
 * deterministically (advance the clock, assert the markers).
 */
export interface Clock {
  /** Milliseconds for DURATIONS only (wall or virtual) — never persisted. */
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Production clock: Date.now() plus the host timers. */
export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// ---------------------------------------------------------------------------
// Run governance — the per-run handle `runPlan` consumes (ADR-0003 §2.1)
// ---------------------------------------------------------------------------

/** The per-run governor, behind its interface-neutral alias. */
export type Governor = BudgetGovernor;

/** Construct a per-run governor (the factory form callers compose `Governance` with). */
export function createGovernor(config: GovernorConfig, clock?: Clock): BudgetGovernor {
  return new BudgetGovernor(config, clock);
}

/**
 * Per-run governance for `runPlan(plan, opts, registry, gov?)` (ADR-0003
 * §2.1): the governor that owns admission/caps AND the run's one time source
 * (its own clock drives the ladder and every recorded event — virtualize at
 * `createGovernor`), an optional run-level cancel signal (tripping the
 * governor with trip kind `signal` stops dispatch — W2.5 wires process
 * signals to one), and the operator-declared attendance flag. Per-call
 * opt-ins ride `optIn` by explicit key only (P7).
 *
 * Recorded arrivals: `approvals` comes with the approval-token slice (W4.3);
 * `releaseQuarantine`/`allowAdvisory` come with the reservation slice (W2.3).
 */
export interface Governance {
  governor: Governor;
  /** Run-level cancel signal; an abort trips the governor (trip kind `signal`). */
  signal?: AbortSignal;
  /** Operator-declared attendance (journalled on run-started; P8 default false). */
  attended?: boolean;
  /**
   * The ADVISORY escape (W2.3, A12c): when true, an unattended run may
   * dispatch ADVISORY-classified work. The kernel refuses ADVISORY
   * dispatches unattended by default — every lane is ADVISORY at v1.1 (no
   * conformance leg has proven a lane HARD) — so an unattended governed run
   * without this flag (or `attended: true`) dispatches nothing.
   * Journalled on run-started.governance.allowAdvisory.
   */
  allowAdvisory?: boolean;
  /**
   * Job ids to release from reservation quarantine (W2.3, A12b), journalled
   * with provenance 'call' (P7 — per-call by explicit key only). A release
   * re-enables dispatch; the full charge the quarantine took is NEVER
   * refunded.
   */
  releaseQuarantine?: readonly string[];
  /** Per-call opt-ins (ADR-0003 §2.5), e.g. `budget.legacyJournal=reset`. */
  optIn?: readonly GovernanceOptIn[];
}

/**
 * Opt in at executable entrypoints, never at library import time. The signal
 * has already decided termination; this bounded grace executes that decision.
 * Managed MCP children get time to abort their own detached run groups before
 * the final force-kill. Re-raising preserves the ordinary signal exit status.
 */
export function installProcessSignalCleanup(
  beforeSignal?: () => void,
  clock: Clock = realClock,
): void {
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    try {
      beforeSignal?.();
    } finally {
      const force = prepareProcessSignalCleanup();
      const finish = (): void => {
        // Work may finish dispatching during the grace window. Sweep current
        // ownership as well as the original groups (whose leaders may be gone).
        for (const kill of prepareProcessSignalCleanup()) kill();
        for (const kill of force) kill();
        for (const ownedSignal of signals) process.removeListener(ownedSignal, onSignal);
        process.kill(process.pid, signal);
      };
      // Match subprocess DEFAULT_TERM_GRACE_MS. Keep this timer referenced:
      // descendants may survive after all direct children have exited.
      if (force.length > 0) clock.setTimeout(finish, 2_000);
      else finish();
    }
  };
  for (const signal of signals) process.on(signal, onSignal);
}

// ---------------------------------------------------------------------------
// The escalation ladder — three rungs, each observable
// ---------------------------------------------------------------------------

/** The ladder rungs, in firing order. */
export type LadderRung = 'signal' | 'timeout' | 'kill';

// DD-1 SPIKE RESULT (T1.6, docs/dd-1-abort-spike.md): the cooperative-abort
// settle latency was measured live on both governed lanes — ai-sdk ≈6 ms,
// claude-agent ≈2.0 s (the SDK's CLI-worker teardown; no transcript growth
// and no surviving worker process over the post-abort poll). The spike
// derives the rung-1 → rung-2 default in src/kernel/governor.config.ts
// (the single source of truth, imported above and re-exported here for the
// public barrel; ≈2.5× headroom over the measured worst cooperative settle —
// the pre-spike placeholder sat exactly AT it). DEFAULT_KILL_GRACE_MS stays
// a conservative constant: the spike gathered no evidence about
// SIGTERM→SIGKILL resistance, so the T1.5 process-ladder measurements stand.
export { DEFAULT_ABORT_GRACE_MS };
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Per-job ladder delays. */
export interface LadderSpec {
  /**
   * Rung-1 delay: the job's wall-clock budget in ms. Omit = no ladder — the
   * task runs unbounded (caps and observation still apply).
   */
  wallClockMs?: number;
  /** Rung 1 → rung 2 grace. Default: DEFAULT_ABORT_GRACE_MS (DD-1 spike result: 5000). */
  abortGraceMs?: number;
  /** Rung 2 → rung 3 grace. Default: DEFAULT_KILL_GRACE_MS (conservative; no spike evidence to move it). */
  killGraceMs?: number;
}

/**
 * One observable rung. Tests assert the marker sequence: WHAT fired (rung),
 * in WHAT ORDER (markers append), with WHAT DELAYS (delayMs since the
 * previous rung / since start for rung 1), and whether the rung's
 * cancellation primitive was actually delivered. Observers are isolated: an
 * onRung throw is swallowed (after the marker lands) and cannot affect the
 * ladder.
 */
export interface LadderRungMarker {
  op: string;
  jobKey: string;
  rung: LadderRung;
  /** Ms since the PREVIOUS rung (rung 1: since dispatch start). */
  delayMs: number;
  /** Ms since dispatch start. */
  sinceStartMs: number;
  /**
   * Whether the rung's primitive was delivered: rung 1 always (the signal is
   * the primitive); rungs 2–3 only when the op registered a cancel port with
   * the corresponding method — the marker records `false` otherwise, so a
   * test can see the rung FIRED even when there was nothing to deliver.
   */
  delivered: boolean;
  /**
   * Set when the rung's cancellation primitive THREW: the rung still fired,
   * later rungs still arm, and the ladder still settles — a failing port can
   * never hang the job or lose the marker.
   */
  error?: string;
  atMs: number;
}

/** What the governed invocation ended as, with its full marker history. */
export type LadderOutcome<T> =
  | { outcome: 'completed'; value: T; markers: LadderRungMarker[]; elapsedMs: number }
  | { outcome: 'killed'; markers: LadderRungMarker[]; elapsedMs: number }
  | { outcome: 'threw'; error: unknown; markers: LadderRungMarker[]; elapsedMs: number };

/** Identity of one governed invocation (governor-assigned, event-carried). */
export interface LadderContextInfo {
  op: string;
  jobKey: string;
  /** 1-based dispatch ordinal for this jobKey — JobStartedJournalEvent.attempt semantics. */
  attempt: number;
}

/**
 * The hard-cancel primitives an op can host. A subprocess-backed op (T1.4
 * op families) registers these via its JobGovernance; the ladder calls them
 * at rungs 2 and 3. Both are optional — the ladder fires and RECORDS the
 * rung even when only the signal exists. Port methods MAY be async: a
 * rejected async primitive is recorded on the rung marker (an `async: …`
 * error note) and is never an unhandled rejection.
 */
export interface JobCancelPort {
  /** Rung 2: the second, harder cancel — the subprocess-timeout placeholder (e.g. SIGTERM). */
  hardCancel?: () => void | Promise<void>;
  /** Rung 3: the SIGKILL-equivalent primitive, when the op hosts a killable worker. */
  kill?: () => void | Promise<void>;
}

/**
 * The per-invocation governance handle an op reaches through
 * `currentJobContext()` — the additive cooperative-cancel channel that the
 * frozen Op contract (one input parameter, no signal) cannot carry.
 */
export interface JobGovernance {
  /** Rung 1's cooperative cancellation signal. */
  readonly signal: AbortSignal;
  /** Register hard-cancel primitives (rungs 2–3) for subprocess-hosting ops. */
  setCancelPort(port: JobCancelPort): void;
  /**
   * Report this invocation's budget evidence in ONE fold (usage + costUSD) —
   * the TRANSITIONAL spend channel for ops that map a driver WorkerResult
   * into their OWN value shape (review.fixItem, merge.resolveConflict) and
   * so are invisible to the completion-time WorkerResult fold. Real usage
   * rolls the token cap, a present costUSD rolls the USD cap, and real
   * usage with NO costUSD under a configured maxUsd TRIPS the budget (DD-9,
   * fail loud, never fail open — the same rules as the completion fold).
   * A given measurement must reach the governor exactly once: stream it
   * here XOR return it in the WorkerResult-shaped value.
   */
  reportResult(result: { usage?: Usage; costUSD?: number }): void;
  readonly info: Readonly<LadderContextInfo & { wallClockMs?: number }>;
}

const jobContextStore = new AsyncLocalStorage<JobGovernance>();

/**
 * The governed context for the CURRENT op invocation, when running under a
 * governor. Ops read `currentJobContext()?.signal` to cooperate with rung 1
 * and register cancel ports; outside a governed invocation this is
 * undefined and ops behave exactly as un-governed.
 */
export function currentJobContext(): JobGovernance | undefined {
  return jobContextStore.getStore();
}

/** Ladder-spec validation — loud and early, like the runner's own preflight. */
function validateLadderSpec(spec: LadderSpec): void {
  if (
    spec.wallClockMs !== undefined &&
    (!Number.isFinite(spec.wallClockMs) || spec.wallClockMs <= 0)
  ) {
    throw new Error(
      `governor: ladder wallClockMs must be a finite number > 0, got ${spec.wallClockMs}`,
    );
  }
  const graces: ReadonlyArray<[string, number | undefined]> = [
    ['abortGraceMs', spec.abortGraceMs],
    ['killGraceMs', spec.killGraceMs],
  ];
  for (const [name, value] of graces) {
    if (value !== undefined && (!Number.isInteger(value) || value < 0)) {
      throw new Error(`governor: ladder ${name} must be an integer >= 0, got ${value}`);
    }
  }
}

/**
 * THE ESCALATION LADDER as a standalone unit. Runs `task` inside the job
 * context and arms the rungs:
 *
 *   rung 1 `signal` at `wallClockMs`  — cooperative: the context's
 *                                       AbortSignal fires;
 *   rung 2 `timeout` `abortGraceMs` later — the second, harder cancel:
 *                                       port.hardCancel() (subprocess-timeout
 *                                       semantics placeholder);
 *   rung 3 `kill`    `killGraceMs` later  — SIGKILL-equivalent: port.kill()
 *                                       when hosted, and ALWAYS in-process
 *                                       abandonment.
 *
 * Each fired rung appends a LadderRungMarker (and calls opts.onRung). If the
 * task settles first, every pending rung is disarmed and the outcome is the
 * task's own (completion or throw — the throw passes through so the RUNNER's
 * failure semantics stay in charge). If rung 3 fires, the task promise is
 * DETACHED — its later settlement is suppressed (no unhandled rejection) and
 * cannot change the outcome — and the invocation ends `killed`. An
 * in-process promise cannot be forcibly terminated: the honest equivalent is
 * abandonment plus a known-cause verdict; a real process kill is the cancel
 * port's business for subprocess ops.
 *
 * No wallClockMs → no rungs (the task still runs inside the job context, so
 * signal/usage reporting exist; the signal simply never fires).
 */
export function runLadder<T>(
  task: (ctx: JobGovernance) => Promise<T>,
  spec: LadderSpec,
  info: LadderContextInfo,
  opts?: {
    clock?: Clock;
    /**
     * An EXTERNAL run-level signal composed INTO this ladder's controller
     * (ADR-0003 §2.3): already-aborted ⇒ the controller is aborted before
     * the task runs (the task still runs; ops observe an aborted context
     * signal); otherwise an external abort aborts the controller. The
     * listener is removed when the ladder settles.
     */
    signal?: AbortSignal;
    /**
     * Rung observer — invoked AFTER the marker lands. A THROW here is
     * swallowed: observer failure must never break the ladder (same contract
     * as the cancel port).
     */
    onRung?: (marker: LadderRungMarker) => void;
    onResult?: (result: { usage?: Usage; costUSD?: number }) => void;
  },
): Promise<LadderOutcome<T>> {
  validateLadderSpec(spec);
  const clock = opts?.clock ?? realClock;
  const wallClockMs = spec.wallClockMs;
  const abortGraceMs = spec.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS;
  const killGraceMs = spec.killGraceMs ?? DEFAULT_KILL_GRACE_MS;
  const markers: LadderRungMarker[] = [];
  const startedAt = clock.now();
  const controller = new AbortController();
  let port: JobCancelPort = {};
  const timers: unknown[] = [];

  // External-signal composition (see opts.signal): arm BEFORE the task so an
  // abort that lands mid-task reaches ops through the context signal; the
  // disarm hook runs when the ladder settles (no listener outlives the job).
  const externalSignal = opts?.signal;
  let disarmExternalSignal: (() => void) | undefined;
  if (externalSignal !== undefined) {
    if (externalSignal.aborted) {
      controller.abort();
    } else {
      const onExternalAbort = (): void => {
        controller.abort();
      };
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
      disarmExternalSignal = (): void => {
        externalSignal.removeEventListener('abort', onExternalAbort);
      };
    }
  }

  const ctx: JobGovernance = {
    signal: controller.signal,
    setCancelPort: (p) => {
      port = p;
    },
    reportResult: (result) => opts?.onResult?.(result),
    info: {
      ...info,
      ...(wallClockMs !== undefined ? { wallClockMs } : {}),
    },
  };

  return new Promise<LadderOutcome<T>>((resolve) => {
    let settled = false;
    const elapsed = (): number => clock.now() - startedAt;
    const settle = (
      outcome:
        | { outcome: 'completed'; value: T }
        | { outcome: 'killed' }
        | { outcome: 'threw'; error: unknown },
    ): void => {
      if (settled) return; // a detached task's late settlement changes nothing
      settled = true;
      disarmExternalSignal?.();
      for (const handle of timers.splice(0)) clock.clearTimeout(handle);
      if (outcome.outcome === 'completed') {
        resolve({
          outcome: 'completed',
          value: outcome.value,
          markers: [...markers],
          elapsedMs: elapsed(),
        });
      } else if (outcome.outcome === 'killed') {
        resolve({ outcome: 'killed', markers: [...markers], elapsedMs: elapsed() });
      } else {
        resolve({
          outcome: 'threw',
          error: outcome.error,
          markers: [...markers],
          elapsedMs: elapsed(),
        });
      }
    };
    const fireRung = (rung: LadderRung, delayMs: number, deliver: () => unknown): void => {
      // A throwing port primitive must never escape a timer callback (that
      // would lose the marker, skip the later rungs, and never settle): the
      // rung is recorded with delivered:false plus an error note and the
      // ladder CONTINUES.
      let delivered: boolean;
      let error: string | undefined;
      let asyncDelivery: Promise<unknown> | undefined;
      try {
        const returned: unknown = deliver();
        if (typeof (returned as { then?: unknown } | null | undefined)?.then === 'function') {
          // An async port primitive (`async () => void`) hands back a
          // promise the sync call made: the primitive counts as invoked,
          // and its REJECTION is recorded on the marker below — never an
          // unhandled rejection.
          asyncDelivery = returned as Promise<unknown>;
          delivered = true;
        } else {
          // Sync contract: false means no port method to deliver to; any
          // other sync return (true, or a void method's undefined) means
          // the primitive was invoked.
          delivered = returned !== false;
        }
      } catch (err) {
        delivered = false;
        error = err instanceof Error ? err.message : String(err);
      }
      const atMs = clock.now();
      const marker: LadderRungMarker = {
        op: info.op,
        jobKey: info.jobKey,
        rung,
        delayMs,
        sinceStartMs: atMs - startedAt,
        delivered,
        ...(error !== undefined ? { error } : {}),
        atMs,
      };
      markers.push(marker);
      // ASYNC PORT REJECTIONS: the sync try/catch above cannot see a
      // rejected promise from an `async () => void` port — left alone it
      // would surface as an unhandled rejection. Attach a handler that
      // records the rejection on the already-pushed (mutable) marker: the
      // rung still fired, later rungs still arm, nothing goes unhandled.
      if (asyncDelivery !== undefined) {
        void asyncDelivery.then(undefined, (err: unknown) => {
          marker.error = `async: ${err instanceof Error ? err.message : String(err)}`;
        });
      }
      // Observer failure must never break the ladder (the same class as a
      // throwing port): the marker is already on the record, so an onRung
      // throw is swallowed and the ladder CONTINUES.
      try {
        opts?.onRung?.(marker);
      } catch {
        // deliberately swallowed — the markers array stays authoritative
      }
    };
    const arm = (ms: number, fn: () => void): void => {
      timers.push(clock.setTimeout(fn, ms));
    };

    if (wallClockMs !== undefined) {
      arm(wallClockMs, () => {
        fireRung('signal', wallClockMs, () => {
          controller.abort();
          return true; // the signal IS the rung-1 primitive: always delivered
        });
        arm(abortGraceMs, () => {
          fireRung('timeout', abortGraceMs, () => {
            const hardCancel = port.hardCancel;
            if (hardCancel === undefined) return false;
            return hardCancel(); // an async primitive's promise MUST flow back so its rejection is recorded (never unhandled)
          });
          arm(killGraceMs, () => {
            fireRung('kill', killGraceMs, () => {
              const kill = port.kill;
              if (kill === undefined) return false;
              return kill(); // same as hardCancel: a promise flows back to fireRung
            });
            settle({ outcome: 'killed' });
          });
        });
      });
    }

    // The task runs inside the job context so ops reach the signal/port via
    // currentJobContext(). Both settlement paths are handled HERE, so even a
    // task detached at rung 3 can never become an unhandled rejection.
    Promise.resolve()
      .then(() => jobContextStore.run(ctx, () => task(ctx)))
      .then(
        (value) => settle({ outcome: 'completed', value }),
        (error: unknown) => settle({ outcome: 'threw', error }),
      );
  });
}

// ---------------------------------------------------------------------------
// Governor config — plain data (README "Governor config")
// ---------------------------------------------------------------------------

/**
 * The governor's configuration — plain data (serializable, never persisted).
 * Built by hand or via `governorConfig` from the frozen RunOptions/Limits
 * surfaces.
 */
export interface GovernorConfig {
  /** EFFECTIVE run USD cap = min(RunOptions.maxUsd, Limits.maxUsd) — frozen precedence. */
  maxUsd?: number;
  /**
   * EFFECTIVE run token cap = RunOptions.maxTokens (DD-9's parallel token
   * rollup; no Limits half in v1). Independent of maxUsd — a cap that binds
   * even when no price is known for a model — with the same exceeds-cap trip
   * semantics as the USD cap.
   */
  maxTokens?: number;
  /** Rung-1 delay (Limits.perJobWallClockMs). Omit = no wall-clock ladder. */
  perJobWallClockMs?: number;
  /** Rung 1 → 2 grace. Default DEFAULT_ABORT_GRACE_MS (DD-1 spike result: 5000, docs/dd-1-abort-spike.md). */
  abortGraceMs?: number;
  /** Rung 2 → 3 grace. Default DEFAULT_KILL_GRACE_MS (conservative; no spike evidence to move it). */
  killGraceMs?: number;
  /** Per-job attempt cap (the effective min per the frozen precedence rule). */
  maxAttemptsPerJob?: number;
  /** Per-run dispatch quota — the PER-RUN ATTEMPT cap (Limits.runDispatchQuota). */
  runDispatchQuota?: number;
  /**
   * In-flight ceiling (Limits.inFlightCeiling) — SEPARATE from the dispatch
   * quota and enforced by FIFO QUEUEING, never by failing, so effective
   * parallelism is the frozen min(RunOptions.concurrency, ceiling).
   */
  inFlightCeiling?: number;
}

function validateConfig(config: GovernorConfig): void {
  const checkInt = (name: string, value: number | undefined, min: number): void => {
    if (value !== undefined && (!Number.isInteger(value) || value < min)) {
      throw new Error(`governor: config.${name} must be an integer >= ${min}, got ${value}`);
    }
  };
  if (config.maxUsd !== undefined && (!Number.isFinite(config.maxUsd) || config.maxUsd < 0)) {
    throw new Error(`governor: config.maxUsd must be a finite number >= 0, got ${config.maxUsd}`);
  }
  if (
    config.maxTokens !== undefined &&
    (!Number.isFinite(config.maxTokens) || config.maxTokens <= 0)
  ) {
    throw new Error(
      `governor: config.maxTokens must be a finite number > 0, got ${config.maxTokens}`,
    );
  }
  checkInt('perJobWallClockMs', config.perJobWallClockMs, 1);
  checkInt('abortGraceMs', config.abortGraceMs, 0);
  checkInt('killGraceMs', config.killGraceMs, 0);
  checkInt('maxAttemptsPerJob', config.maxAttemptsPerJob, 1);
  checkInt('runDispatchQuota', config.runDispatchQuota, 1);
  checkInt('inFlightCeiling', config.inFlightCeiling, 1);
}

/**
 * Build a GovernorConfig from the frozen option surfaces, applying the
 * frozen cap-precedence rule: effective maxUsd = min(RunOptions.maxUsd,
 * Limits.maxUsd). The token cap has no Limits half (DD-9): effective
 * maxTokens is RunOptions.maxTokens alone. The in-flight ceiling rides on
 * Limits alone — the runner's pool already enforces opts.concurrency, and
 * the governor enforces the ceiling by queueing, so effective parallelism is
 * exactly the frozen min(concurrency, inFlightCeiling).
 */
export function governorConfig(
  opts: RunOptions,
  limits: Limits,
  extra?: Pick<GovernorConfig, 'abortGraceMs' | 'killGraceMs'>,
): GovernorConfig {
  const usdCaps = [opts.maxUsd, limits.maxUsd].filter((v): v is number => v !== undefined);
  return {
    ...(usdCaps.length > 0 ? { maxUsd: Math.min(...usdCaps) } : {}),
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    ...(limits.perJobWallClockMs !== undefined
      ? { perJobWallClockMs: limits.perJobWallClockMs }
      : {}),
    ...(limits.maxAttemptsPerJob !== undefined
      ? { maxAttemptsPerJob: limits.maxAttemptsPerJob }
      : {}),
    ...(limits.runDispatchQuota !== undefined ? { runDispatchQuota: limits.runDispatchQuota } : {}),
    ...(limits.inFlightCeiling !== undefined ? { inFlightCeiling: limits.inFlightCeiling } : {}),
    ...(extra?.abortGraceMs !== undefined ? { abortGraceMs: extra.abortGraceMs } : {}),
    ...(extra?.killGraceMs !== undefined ? { killGraceMs: extra.killGraceMs } : {}),
  };
}

// ---------------------------------------------------------------------------
// Governor events — the observation stream tests assert on
// ---------------------------------------------------------------------------

/** Terminal status of a governed invocation, as the governor observed it. */
export type GovernedOutcomeStatus = OpResult<unknown>['status'] | 'threw' | 'invalid';

/** Why a governed invocation was refused without running the op. */
/**
 * Why a governed invocation was refused without running the op.
 * `advisory-lane` (W2.3, A12c): the ADVISORY-classified dispatch was refused
 * unattended without the `allowAdvisory` escape.
 */
export type ShortCircuitReason =
  | 'budget'
  | 'dispatch-quota'
  | 'attempt-cap'
  | 'budget-while-queued'
  | 'cancelled-while-queued'
  | 'advisory-lane';

/**
 * WHICH bound tripped (ADR-0003 §2.3 honest-stop taxonomy): `exhausted` — a
 * USD rollup crossed maxUsd, the unpriced fail-loud rule fired under one, or
 * reservation capacity reached the cap; `token-cap` — the DD-9 token rollup
 * crossed maxTokens; `breach` — a settle charged more than its reservation
 * held (the reservation undersold the work; W2.3); `signal` — a run-level
 * cancel (not a budget event; the runner reports it as earlyStopReason
 * 'signal', never re-marking rows budget-exhausted).
 */
export type TripKind = 'exhausted' | 'token-cap' | 'breach' | 'signal';

/**
 * The governor's event stream (BudgetGovernor.events): every admission,
 * refusal, ladder rung (with delays), completion, usage observation, the
 * budget trip, and journal seeding. Plain data; appended in fire order.
 */
export type GovernorEvent =
  | { kind: 'admitted'; op: string; jobKey: string; attempt: number; atMs: number }
  | {
      kind: 'short-circuited';
      op: string;
      jobKey: string;
      reason: ShortCircuitReason;
      atMs: number;
    }
  | {
      kind: 'ladder-rung';
      op: string;
      jobKey: string;
      rung: LadderRung;
      delayMs: number;
      sinceStartMs: number;
      delivered: boolean;
      /** Carried from the marker when the rung's primitive threw. */
      error?: string;
      atMs: number;
    }
  | {
      kind: 'completed';
      op: string;
      jobKey: string;
      attempt: number;
      status: GovernedOutcomeStatus;
      elapsedMs: number;
      atMs: number;
    }
  | {
      kind: 'usage';
      jobKey: string;
      usd?: number;
      atMs: number;
    }
  | { kind: 'budget-tripped'; tripKind: TripKind; reason: string; atMs: number }
  | { kind: 'seeded'; jobs: number; attempts: number; atMs: number }
  /**
   * Recorded by the governed runner's fold (not seedFromJournal — the runner
   * owns the exclusion decision): the spend bound EXCLUDED these
   * ungoverned-marked runs of the plan from the ledger seed (ADR-0003 annex
   * §3 rule 7). The CLI surfaces it as
   * `cq: bound excludes ungoverned runs <runIds>`; runIds are in fold order.
   */
  | { kind: 'bound-excluded-ungoverned'; runIds: string[]; atMs: number }
  /**
   * W2.3 reserve-then-settle: a reservation was opened against the cap
   * (settled + outstanding + reserved ≤ cap held at that instant). The
   * write-ahead journal event is the runner's; this is the governor's own
   * observation.
   */
  | {
      kind: 'reserved';
      jobKey: string;
      reservationId: string;
      usd: number;
      class: ReservationClass;
      atMs: number;
    }
  /** W2.3: a reservation settled — the ledger's spend truth for one dispatch. */
  | {
      kind: 'reservation-settled';
      jobKey: string;
      reservationId: string;
      charged: number;
      basis: ReservationChargeBasis;
      atMs: number;
    }
  /**
   * W2.3 (A12b): jobs quarantined at the resume fold over unresolved
   * reservations, each charged IN FULL (never refunded, never re-run until
   * an explicit `releaseQuarantine`).
   */
  | {
      kind: 'quarantined';
      jobs: ReadonlyArray<{ jobId: string; reservationId: string; usd: number }>;
      atMs: number;
    }
  /** W2.3: a capless governed run conservatively inherited the previous governed run's cap. */
  | { kind: 'cap-inherited'; usd: number; atMs: number };

/** The admission gate's verdict for one dispatch. */
export type AdmissionDecision =
  | { decision: 'admit'; attempt: number }
  | {
      decision: 'reject';
      reason: Exclude<ShortCircuitReason, 'budget-while-queued'>;
    };

/**
 * An OPEN reservation against the run's USD cap (W2.3 reserve-then-settle):
 * the cap holds `settled + outstanding + reserved ≤ C` from the instant
 * `reserve` resolves until `settle` lands. Kernel-internal by design — the
 * driver-seam `RunOptions.reservation` surface is W3.3's (one types bump on
 * the last P2 PR).
 */
export interface BudgetReservation {
  /**
   * `${jobKey}:${attempt}:${seq}` — unique within the run; the runner's
   * journal events compose it with the runId
   * (`${runId}:${jobKey}:${attempt}:${seq}`, the ADR's cross-run format).
   */
  readonly id: string;
  readonly jobKey: string;
  readonly attempt: number;
  /** The reserved USD amount r (≥ the settled charge except on a breach). */
  readonly usd: number;
  /** The budget class the dispatch was admitted under. */
  readonly class: ReservationClass;
  /** The fair-share proposal p, present only when r was shrunk below it. */
  readonly proposedUsd?: number;
}

/** Why a reserve attempt did not open a reservation. */
export type ReserveOutcome =
  | { outcome: 'reserved'; reservation: BudgetReservation }
  /** A trip (any kind) landed before capacity was granted — the caller refuses per `governor.tripKind`. */
  | { outcome: 'tripped' };

/**
 * FIFO slot pool for the in-flight ceiling. Slots transfer 1:1 from a
 * releasing holder to the head of the waiter queue (the active count only
 * changes at acquire-when-free and release-when-no-waiters), so the held
 * count can never overshoot the limit — the ceiling is enforced by
 * QUEUEING, never by failing.
 */
class SlotPool {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  get held(): number {
    return this.active;
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    if (next !== undefined) {
      next(); // 1:1 handoff to the head waiter — active count unchanged
      return;
    }
    this.active -= 1;
  }
}

function addUsage(a: Usage, b: Usage): Usage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    ...(a.reasoning !== undefined || b.reasoning !== undefined
      ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
      : {}),
  };
}

/**
 * Σ of the frozen Usage fields — the same fold the drivers totalTokens
 * report (DD-9 token rollup). `reasoning` is an `output` breakdown and must
 * already be included in `output`; adding reasoning here would double-count
 * it, so the fold counts the total once, via output — a producer must not
 * report additive reasoning. Reasoning stays a reported Usage field —
 * addUsage still sums the field itself.
 */
function totalTokensOf(usage: Usage): number {
  return usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

/**
 * USD observations must be a finite number >= 0, validated BEFORE any
 * rollup mutation — a NaN/negative fold would poison the rollup and
 * silently disable the USD cap (I9). Seeding goes through the same check:
 * a bad journaled costUSD fails loud at construction time.
 */
function assertValidUsd(field: string, usd: number): void {
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`governor: ${field} must be a finite number >= 0, got ${usd}`);
  }
}

/**
 * Token observations must be finite numbers >= 0, per field, validated
 * BEFORE any rollup mutation: one NaN/Infinity/negative fold makes
 * totalTokensOf NaN and `NaN > cap` is false — the token cap permanently
 * and silently disabled, the exact twin of the USD fail-open (I9 — fail
 * loud, never fail open; review round 2).
 */
function assertValidTokens(field: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`governor: ${field} must be a finite number >= 0, got ${value}`);
  }
}

/** Every numeric Usage field validated before a fold (see assertValidTokens). */
function assertValidUsage(prefix: string, usage: Usage): void {
  assertValidTokens(`${prefix}.input`, usage.input);
  assertValidTokens(`${prefix}.output`, usage.output);
  assertValidTokens(`${prefix}.cacheRead`, usage.cacheRead);
  assertValidTokens(`${prefix}.cacheWrite`, usage.cacheWrite);
  if (usage.reasoning !== undefined) {
    assertValidTokens(`${prefix}.reasoning`, usage.reasoning);
  }
}

/**
 * Non-throwing twins of the assertValid* probes (the DEFENSIVE-FOLD guard):
 * `observeResult` may receive evidence an op streamed through
 * reportResult, i.e. raw driver data the `workerResultOfValue` guard at the
 * completion boundary never vetted. A lying measurement (NaN/Infinity/
 * negative) folds as ZERO EVIDENCE — the guard rejects it so no post-record
 * throw escapes the op (review round: reportResult bypassed the guard).
 */
const isValidTokensValue = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

const isValidUsd = (usd: unknown): usd is number => isValidTokensValue(usd);

const isValidUsage = (usage: unknown): usage is Usage => {
  if (typeof usage !== 'object' || usage === null) return false;
  const record = usage as Record<string, unknown>;
  // Mirror the persisted UsageSchema exactly (integer cardinalities, strict
  // keys): a measurement the journal/report mirror would reject cannot fold
  // — it would trade this defensive guard for a post-record throw after the
  // op has already completed (review thread).
  const isCardinality = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 0;
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    if (!isCardinality(record[field])) return false;
  }
  const reasoning = record['reasoning'];
  if (reasoning !== undefined && !isCardinality(reasoning)) return false;
  for (const key of Object.keys(record)) {
    if (
      key !== 'input' &&
      key !== 'output' &&
      key !== 'cacheRead' &&
      key !== 'cacheWrite' &&
      key !== 'reasoning'
    ) {
      return false;
    }
  }
  return true;
};

// ---------------------------------------------------------------------------
// BudgetGovernor — the stateful per-run enforcer
// ---------------------------------------------------------------------------

/**
 * The per-run budget governor: admission caps, the in-flight ceiling, the
 * USD rollup, the ladder spec, and the event stream. One per run; the
 * governed runner (`runPlan`'s `gov` handle) drives admission, the ladder,
 * and the evidence folds through it. All time flows through the injected
 * clock.
 */
export class BudgetGovernor {
  /** Validated plain-data config. */
  readonly config: GovernorConfig;
  readonly clock: Clock;
  /** The observation stream — every event, in fire order (tests assert here). */
  readonly events: GovernorEvent[] = [];
  /**
   * Trip observer (W2.3 abort-on-trip): invoked SYNCHRONOUSLY whenever the
   * governor trips, with the trip kind — the governed runner aborts the
   * run's in-flight invocations through it. A throwing observer is swallowed
   * (the trip already landed); the trip is idempotent (first wins).
   */
  onTrip?: (tripKind: TripKind) => void;

  private dispatchedCount = 0;
  private readonly attemptsByJob = new Map<string, number>();
  private usdSpentN = 0;
  private usageN?: Usage;
  private trippedFlag = false;
  private tripReasonN?: string;
  private tripKindN?: TripKind;
  private readonly slots: SlotPool | undefined;
  // --- W2.3 reserve-then-settle state --------------------------------------
  /** The outstanding (open) reservations by id — the O in `S + O + r ≤ C` — with the evidence folds attributed to each. */
  private readonly outstanding = new Map<
    string,
    { reservation: BudgetReservation; foldedUsd: number }
  >();
  /** jobKey → open reservation id (a job holds at most one open reservation: one dispatch at a time). */
  private readonly openByJob = new Map<string, string>();
  private outstandingUsdN = 0;
  private reservationSeqN = 0;
  /** FIFO waiters for reservation capacity; woken by a settle, or by a trip. */
  private readonly reserveWaiters: Array<() => void> = [];
  /** A capless governed run's conservative inheritance of the previous governed run's cap. */
  private inheritedCapUsdN: number | undefined;
  /** Jobs quarantined at the resume fold over unresolved reservations (A12b). */
  private readonly quarantinedN = new Map<string, { reservationId: string; usd: number }>();

  constructor(config: GovernorConfig, clock: Clock = realClock) {
    validateConfig(config);
    this.config = config;
    this.clock = clock;
    this.slots =
      config.inFlightCeiling !== undefined ? new SlotPool(config.inFlightCeiling) : undefined;
  }

  // --- Readouts -------------------------------------------------------------

  /** True once the budget cap has tripped (idempotent — first trip wins). */
  get tripped(): boolean {
    return this.trippedFlag;
  }

  /** Why the budget tripped, when it did. */
  get tripReason(): string | undefined {
    return this.tripReasonN;
  }

  /** WHICH bound tripped (USD/token/signal), when one did. */
  get tripKind(): TripKind | undefined {
    return this.tripKindN;
  }

  /** USD rollup observed so far (reported via the job context; never derived). */
  get usdSpent(): number {
    return this.usdSpentN;
  }

  /** Token-usage rollup observed so far, when anything reported. */
  get usage(): Usage | undefined {
    return this.usageN;
  }

  /** Dispatches admitted this run (admission = the dispatch decision). */
  get dispatchCount(): number {
    return this.dispatchedCount;
  }

  /** Governed invocations currently holding an in-flight slot. */
  get inFlight(): number {
    return this.slots?.held ?? 0;
  }

  /**
   * The EFFECTIVE USD cap (W2.3): the configured cap, or — on a capless
   * governed run over capped history — the conservatively inherited
   * predecessor cap (`inheritCapUsd`). Undefined = no USD bound: dispatches
   * are reservation-less and the ledger folds observed evidence directly.
   */
  get capUsd(): number | undefined {
    return this.config.maxUsd ?? this.inheritedCapUsdN;
  }

  /** USD currently held by OPEN reservations (the O in `S + O + r ≤ C`). */
  get outstandingUsd(): number {
    return this.outstandingUsdN;
  }

  /** Open reservation count. */
  get outstandingCount(): number {
    return this.outstanding.size;
  }

  /**
   * Jobs quarantined at the resume fold (A12b): keyed by jobId, each with
   * the unresolved reservation that charged it in full. Populated by
   * `seedFromJournal`; the governed runner refuses these jobs dispatch and
   * reports them `needs-human` until an explicit `releaseQuarantine`.
   */
  get quarantinedJobs(): ReadonlyMap<string, { reservationId: string; usd: number }> {
    return this.quarantinedN;
  }

  /** The ladder spec this run enforces (grace defaults applied). */
  get ladderSpec(): LadderSpec {
    return {
      ...(this.config.perJobWallClockMs === undefined
        ? {}
        : { wallClockMs: this.config.perJobWallClockMs }),
      abortGraceMs: this.config.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS,
      killGraceMs: this.config.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    };
  }

  /** Current clock reading (for event timestamps and test assertions). */
  now(): number {
    return this.clock.now();
  }

  /** Per-job attempt ordinal so far (0 = never dispatched under this key). */
  attemptsFor(jobKey: string): number {
    return this.attemptsByJob.get(jobKey) ?? 0;
  }

  // --- Admission ------------------------------------------------------------

  /**
   * THE ADMISSION GATE for one dispatch, checked in order: budget tripped →
   * per-run dispatch quota → per-job attempt cap. On admit, BOTH counters
   * advance (admission IS the dispatch decision — before any in-flight
   * queueing) and the returned `attempt` is the job's next 1-based ordinal,
   * with JobStartedJournalEvent.attempt semantics.
   */
  admit(jobKey: string): AdmissionDecision {
    if (this.trippedFlag) {
      return { decision: 'reject', reason: 'budget' };
    }
    if (
      this.config.runDispatchQuota !== undefined &&
      this.dispatchedCount >= this.config.runDispatchQuota
    ) {
      return { decision: 'reject', reason: 'dispatch-quota' };
    }
    if (
      this.config.maxAttemptsPerJob !== undefined &&
      this.attemptsFor(jobKey) >= this.config.maxAttemptsPerJob
    ) {
      return { decision: 'reject', reason: 'attempt-cap' };
    }
    this.dispatchedCount += 1;
    const attempt = this.attemptsFor(jobKey) + 1;
    this.attemptsByJob.set(jobKey, attempt);
    return { decision: 'admit', attempt };
  }

  /** Acquire an in-flight slot (FIFO when the ceiling is configured). */
  acquireSlot(): Promise<void> {
    return this.slots !== undefined ? this.slots.acquire() : Promise.resolve();
  }

  /** Release an in-flight slot (hand it to the head waiter, if any). */
  releaseSlot(): void {
    this.slots?.release();
  }

  // --- Reservations (W2.3 reserve-then-settle, ADR-0003 §2.2/§2.3) ----------

  /**
   * THE RESERVATION GATE. Admits one dispatch against the USD cap under the
   * reserve-then-settle invariant `settled + outstanding + reserved ≤ C`:
   *
   *   capacity = C − S − O;  r = min(proposedUsd, capacity)
   *
   * When capacity covers less than the proposal, the reservation SHRINKS to
   * what is left (`proposedUsd` records the ask). When capacity is zero or
   * less and outstanding reservations exist, the dispatch waits FIFO for a
   * settle ("wait FIFO for a settle", ADR §2.2 step 3); with NO outstanding
   * reservations nothing can free capacity anymore and the run trips
   * `exhausted`. Any trip wakes and refuses every waiter. The caller opens
   * the write-ahead journal event after this resolves and dispatches only
   * then — `settled` completes the cycle and frees capacity for the next
   * waiter.
   *
   * The invariant holds synchronously: reserve/settle mutate S and O in one
   * synchronous critical section, so two dispatches can never interleave a
   * capacity check. `charged ≤ r` at settle keeps the sum from ever growing
   * past C (a `charged > r` settle trips `breach`).
   *
   * Call only when `capUsd` is defined — an uncapped run is reservation-less
   * (its ledger folds observed evidence directly; there is no bound to hold
   * capacity against).
   */
  async reserve(
    jobKey: string,
    attempt: number,
    proposedUsd: number,
    class_: ReservationClass,
  ): Promise<ReserveOutcome> {
    const cap = this.capUsd;
    if (cap === undefined) {
      throw new Error(
        'governor: reserve requires a USD cap (capUsd) — uncapped runs are reservation-less',
      );
    }
    assertValidUsd('proposed reservation', proposedUsd);
    while (true) {
      if (this.trippedFlag) {
        return { outcome: 'tripped' };
      }
      const capacity = cap - this.usdSpentN - this.outstandingUsdN;
      if (capacity > 0) {
        const usd = Math.min(proposedUsd, capacity);
        const id = `${jobKey}:${attempt}:${++this.reservationSeqN}`;
        const reservation: BudgetReservation = {
          id,
          jobKey,
          attempt,
          usd,
          class: class_,
          ...(usd < proposedUsd ? { proposedUsd } : {}),
        };
        this.outstanding.set(id, { reservation, foldedUsd: 0 });
        this.openByJob.set(jobKey, id);
        this.outstandingUsdN += usd;
        this.record({
          kind: 'reserved',
          jobKey,
          reservationId: id,
          usd,
          class: class_,
          atMs: this.now(),
        });
        // Wake chain: when this reservation left further capacity free and
        // waiters are still parked, hand the next one its turn immediately —
        // otherwise idle capacity would sit behind a parked FIFO head until
        // the next settle.
        const left = cap - this.usdSpentN - this.outstandingUsdN;
        if (left > 0 && this.reserveWaiters.length > 0) {
          const wake = this.reserveWaiters.shift();
          wake?.();
        }
        return { outcome: 'reserved', reservation };
      }
      if (this.outstanding.size === 0) {
        // Capacity gone with nothing outstanding to settle: the cap is
        // spent. Tripping wakes every waiter — each refuses (budget family).
        this.trip(
          'exhausted',
          `reservation capacity exhausted: settled ${this.usdSpentN} + outstanding ${this.outstandingUsdN} leave nothing of cap ${cap}`,
        );
        return { outcome: 'tripped' };
      }
      // FIFO: park until a settle frees capacity or a trip wakes everyone.
      // `settle` wakes the head only when capacity is actually free, so a
      // parked waiter is never spuriously re-queued behind its juniors.
      await new Promise<void>((resolve) => {
        this.reserveWaiters.push(resolve);
      });
    }
  }

  /**
   * SETTLE one open reservation: the dispatch's charge closes here (ADR §2.2
   * step 9 — "the gate is the only writer of spend"). The charge is computed
   * by the GOVERNOR from its own fold attribution, never trusted from the
   * caller:
   *
   *   - basis 'observed' — the invocation ended in a definitive verdict:
   *     charged = the evidence folds attributed to this reservation (the
   *     invocation's observed modeled spend, 0 when nothing folded).
   *   - basis 'full' — the dispatch ended in UNKNOWN status (killed,
   *     indeterminate, unreturned): charged = max(r, folded) — at least the
   *     full reservation (spend may exist that no fold saw), and at least
   *     what actually folded (a dispatch that overshot its reservation pays
   *     the overshoot, and the overshoot trips breach below).
   *
   * The LEDGER move is only the remainder `charged − folded` (never
   * negative): the folds already entered the rollup as they arrived
   * (`observeCost`), so live ledger and the journaled `charged` sum each
   * dispatch exactly once. `charged > r` is a BREACH — the reservation
   * undersold the work — and trips the run. Returns the charge for the
   * runner's `reservation-settled` journal event.
   */
  settle(
    reservation: BudgetReservation,
    charge: { basis: ReservationChargeBasis; usage?: Usage },
  ): { charged: number; basis: ReservationChargeBasis } {
    if (charge.usage !== undefined) {
      assertValidUsage('settled usage', charge.usage);
    }
    const held = this.outstanding.get(reservation.id);
    if (held === undefined || held.reservation !== reservation) {
      throw new Error(`governor: settle for unknown reservation '${reservation.id}'`);
    }
    const folded = held.foldedUsd;
    const charged = charge.basis === 'observed' ? folded : Math.max(held.reservation.usd, folded);
    this.outstanding.delete(reservation.id);
    this.openByJob.delete(held.reservation.jobKey);
    this.outstandingUsdN -= held.reservation.usd;
    const remainder = Math.max(0, charged - folded);
    this.usdSpentN += remainder;
    this.record({
      kind: 'reservation-settled',
      jobKey: held.reservation.jobKey,
      reservationId: held.reservation.id,
      charged,
      basis: charge.basis,
      atMs: this.now(),
    });
    if (charged > held.reservation.usd) {
      this.trip(
        'breach',
        `charged ${charged} exceeds reservation ${held.reservation.usd} (${charge.basis} basis) — the reservation undersold the work`,
      );
    } else if (this.capUsd !== undefined && this.usdSpentN > this.capUsd) {
      // Belt-and-braces: the fold-time trip usually lands first; kept so a
      // settle-side remainder can never silently push the ledger past the cap.
      this.trip('exhausted', `usd rollup ${this.usdSpentN} exceeded cap ${this.capUsd}`);
    }
    // Wake the FIFO head on EVERY settle (unless the trip above already
    // woke everyone): a full-charge settle frees nothing, so a
    // wake-only-when-free rule would park the head forever once every
    // outstanding reservation settles at `r` — the re-evaluation is what
    // lets the head trip `exhausted` when capacity is gone for good.
    const wake = this.reserveWaiters.shift();
    wake?.();
    return { charged, basis: charge.basis };
  }

  /**
   * A capless governed run over capped history conservatively INHERITS the
   * predecessor cap (W2.3): the ledger's C never silently disappears between
   * runs — the uncapped run reserves against the inherited cap and journals
   * the inheritance on run-started.governance.inheritedCapUsd. An explicit
   * config cap is never overridden (returns false); the predecessor cap for
   * the raise refusal does not move (an inheritance is not a raise).
   */
  inheritCapUsd(cap: number): boolean {
    if (this.config.maxUsd !== undefined) {
      return false;
    }
    assertValidUsd('inherited cap', cap);
    if (this.inheritedCapUsdN !== undefined) {
      return this.inheritedCapUsdN === cap;
    }
    this.inheritedCapUsdN = cap;
    this.record({ kind: 'cap-inherited', usd: cap, atMs: this.now() });
    return true;
  }

  // --- Observation ------------------------------------------------------------

  /**
   * Observe token usage for one governed invocation (rollup; never cost).
   * The token cap (DD-9) rides the same rollup with the same exceeds
   * semantics as the USD cap: the trip fires when the fold EXCEEDS maxTokens.
   * Every numeric Usage field is validated BEFORE the rollup mutates — one
   * NaN/Infinity/negative fold would make totalTokensOf NaN and `NaN > cap`
   * is false, silently disabling the token cap forever (I9 — fail loud,
   * never fail open; the USD cap's exact twin, review round 2).
   */
  observeUsage(jobKey: string, usage: Usage): void {
    assertValidUsage('usage', usage);
    this.usageN = this.usageN === undefined ? { ...usage } : addUsage(this.usageN, usage);
    this.record({ kind: 'usage', jobKey, atMs: this.now() });
    const tokenCap = this.config.maxTokens;
    if (
      tokenCap !== undefined &&
      this.usageN !== undefined &&
      totalTokensOf(this.usageN) > tokenCap
    ) {
      this.trip('token-cap', `token rollup ${totalTokensOf(this.usageN)} exceeded cap ${tokenCap}`);
    }
  }

  /**
   * Observe USD cost EVIDENCE for one governed invocation and check the run
   * cap. The cap is inclusive: the trip fires when the rollup EXCEEDS maxUsd
   * (W2.2 semantics, unchanged — on an ADVISORY lane this fold-time trip is
   * the only mid-flight guard a runaway dispatch can trip). The observation
   * is validated BEFORE the rollup mutates: a NaN/negative value throws
   * instead of poisoning the cap (I9 — fail loud, never fail open). When the
   * job holds an OPEN reservation, the evidence is attributed to it: the
   * settle (below) charges only the remainder up to the reservation's
   * charge, so live folds and the journaled `charged` sum exactly once.
   */
  observeCost(jobKey: string, usd: number): void {
    assertValidUsd('observed cost', usd);
    this.usdSpentN += usd;
    const openId = this.openByJob.get(jobKey);
    if (openId !== undefined) {
      const open = this.outstanding.get(openId);
      if (open !== undefined) {
        open.foldedUsd += usd;
      }
    }
    this.record({ kind: 'usage', jobKey, usd, atMs: this.now() });
    const cap = this.capUsd;
    if (cap !== undefined && this.usdSpentN > cap) {
      this.trip('exhausted', `usd rollup ${this.usdSpentN} exceeded cap ${cap}`);
    }
  }

  /**
   * Fold ONE driver result's budget evidence (DD-9): real usage rolls the
   * token cap; a present costUSD rolls the USD cap; real usage with NO
   * costUSD under a configured maxUsd TRIPS the budget — an unpriced model
   * would make the USD cap unenforceable, and a silently unlimited run is
   * the failure DD-9 exists to prevent (fail loud, never fail open; the
   * honest-stop path marks the rest budget-exhausted). A zero-usage result
   * folds nothing (nothing was measured — I9).
   *
   * `counts` keeps the fold ONCE-ONLY for an invocation whose evidence was
   * already streamed through the job context: usage or cost already counted
   * via reportResult is skipped here, and the unpriced trip fires
   * only when THIS invocation's usage has no cost evidence either way — a
   * `costAlreadyCounted` flag means cost evidence existed and was counted,
   * so there is nothing left to fail loud about.
   *
   * DEFENSIVE FOLD (review round): evidence arriving through the job
   * context (reportResult) is raw driver data that never passed
   * `workerResultOfValue`; a lying measurement (NaN/Infinity/negative) is
   * sanitized to ZERO EVIDENCE here instead of throwing out of the op.
   */
  observeResult(
    jobKey: string,
    result: { usage?: Usage; costUSD?: number },
    counts?: { usageAlreadyCounted?: boolean; costAlreadyCounted?: boolean },
  ): void {
    const usage = isValidUsage(result.usage) ? result.usage : undefined;
    const costUSD = isValidUsd(result.costUSD) ? result.costUSD : undefined;
    const hasRealUsage = usage !== undefined && totalTokensOf(usage) > 0;
    if (hasRealUsage && usage !== undefined && counts?.usageAlreadyCounted !== true) {
      this.observeUsage(jobKey, usage);
    }
    if (costUSD !== undefined) {
      if (counts?.costAlreadyCounted !== true) {
        this.observeCost(jobKey, costUSD);
      }
    } else if (hasRealUsage && this.capUsd !== undefined && counts?.costAlreadyCounted !== true) {
      this.trip(
        'exhausted',
        'unpriced usage under a USD cap — maxUsd cannot bind an unpriced model; refusing to run past an unenforceable budget (DD-9)',
      );
    }
  }

  /**
   * Trip the budget cap (idempotent — the first reason is kept). Under W2.3
   * reserve-then-settle a trip stops NEW reservations, wakes and refuses
   * every capacity waiter, and — through `onTrip` — aborts the run's
   * in-flight invocations (their reservations settle when each returns; the
   * slot is held until then). The kind records WHICH bound fired
   * (`exhausted` for USD-rollup/capacity and the unpriced fail-loud rule,
   * `token-cap` for the DD-9 rollup, `breach` for a charged-over-reservation
   * settle, `signal` via `tripSignal`).
   */
  trip(tripKind: TripKind, reason: string): void {
    if (this.trippedFlag) {
      return;
    }
    this.trippedFlag = true;
    this.tripReasonN = reason;
    this.tripKindN = tripKind;
    this.record({ kind: 'budget-tripped', tripKind, reason, atMs: this.now() });
    // Any trip wakes and refuses every capacity waiter (ADR §2.2 step 3).
    const waiters = this.reserveWaiters.splice(0);
    for (const wake of waiters) wake();
    // The runner's abort-on-trip hook: synchronous, best-effort — an
    // observer failure must not un-trip the run.
    try {
      this.onTrip?.(tripKind);
    } catch {
      // deliberately swallowed — the trip state stays authoritative
    }
  }

  /**
   * Trip from a run-level cancel signal (ADR-0003 §2.3): trip kind `signal`
   * is NOT a budget event — the governed runner reports `earlyStopReason:
   * 'signal'` and keeps undispatched rows queued (never re-marks them
   * budget-exhausted); it only stops further dispatch.
   */
  tripSignal(detail?: string): void {
    this.trip('signal', detail ?? 'run-level cancel signal received');
  }

  /**
   * Seed caps state from a plan's journal history so a resumed run continues
   * the SAME budget. Admission is keyed on REAL plan job ids (the governed
   * runner admits on `job.id`), so the per-job seed is the annex rule
   * (ADR-0003 annex §2): attempt = 1 + count of PRIOR STARTS — the seed
   * value per jobId is the COUNT of its `job-started` events. The total
   * dispatch count seeds the same way (runDispatchQuota carries across
   * resume instead of restarting at 0), and the token-usage rollup seeds
   * from job-finished `usage`.
   *
   * CONTRACT on `events`: the ORDERED CONCATENATION of ALL the plan's run
   * journals, oldest-first — exactly what the governed runner's fold
   * (journal `foldOrderRuns`) builds before seeding. The latest run's
   * journal alone UNDERCOUNTS: a re-attested job appears as a finish-only
   * event (no open start to close, so its usage/cost is skipped) and
   * chained dispatches from earlier runs vanish — silently resetting the
   * budget this method promises to continue.
   *
   * SPEND FOLDS BY RUN ERA (W2.3). A run whose events contain any
   * `reservation-opened` is RESERVATION-ERA: its ledger spend is
   * `Σ reservation-settled.charged + Σ r(unresolved)` (ADR §2.5's resume
   * fold) and its job-finished costUSD lines are IGNORED for spend (they
   * restate the settled charges; folding both would double-count). A run
   * WITHOUT reservation events is a W2.2-era governed run: no reservations
   * exist for its dispatches, so its spend folds from job-finished costUSD
   * exactly as in W2.2 — only a finish that CLOSES an open start
   * (keyed PER (run, job), so a finish-only re-attestation can never close
   * and double-charge a dead run's start) counts. A12b lives here: an
   * UNRESOLVED reservation (opened, never settled — the hard-crash window)
   * is charged IN FULL and its job is QUARANTINED (`quarantinedJobs`), the
   * crash-spend undercount W2.2 recorded closed.
   *
   * costUSD seeding (W2.2-era): a CLOSING job-finished that carries
   * `costUSD` folds into the USD rollup, validated like every seeded
   * measurement (finite >= 0, fail loud at construction time). v1 journals
   * carry no costUSD — the governed runner refuses them when they have
   * dispatches unless `budget.legacyJournal=reset` was honoured.
   */
  seedFromJournal(events: readonly JournalEvent[]): void {
    const jobIds = new Set<string>();
    const startsByJob = new Map<string, number>();
    let totalStarts = 0;
    let unpricedClosingUsage = false;
    // Era per run: any reservation-opened makes the whole run reservation-era.
    const reservationEra = new Set<string>();
    for (const event of events) {
      if (event.type === 'reservation-opened') reservationEra.add(event.runId);
    }
    // W2.2-era dedupe: only a finish that closes an open start represents a
    // dispatch's own spend; an orphan finish (re-attestation) restates an
    // already-counted dispatch and is skipped. Keyed PER (run, job): a
    // finish closes only its OWN run's start. A jobId-only key would let run
    // B's finish-only re-attestation close the start run A left open when it
    // died before its finish — charging the re-attested (already-counted)
    // spend a second time and, when the re-attestation carried usage without
    // costUSD, tripping a spurious DD-9 `exhausted` at the next seed
    // (review r1; the composite key is the cycle-3 hardening M2 landed and
    // this rework preserves).
    const openStarts = new Set<string>();
    // Reservation-era opens, by exact reservation id and by (run, job) for
    // the corruption check below.
    const openReservations = new Map<string, { jobId: string; usd: number }>();
    const openByRunJob = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'job-started') {
        jobIds.add(event.jobId);
        startsByJob.set(event.jobId, (startsByJob.get(event.jobId) ?? 0) + 1);
        totalStarts += 1;
        openStarts.add(`${event.runId}:${event.jobId}`);
        continue;
      }
      if (event.type === 'reservation-opened') {
        openReservations.set(event.reservationId, { jobId: event.jobId, usd: event.usd });
        openByRunJob.set(`${event.runId}:${event.jobId}`, event.reservationId);
        continue;
      }
      if (event.type === 'reservation-settled') {
        const open = openReservations.get(event.reservationId);
        if (open === undefined) {
          // Writer order is opened → settled within one run and the fold is
          // run-ordered, so a settle without an open is not a torn write (a
          // torn tail can only lose the LAST line) — it is evidence rot.
          throw new Error(
            `journal: corrupt — reservation-settled for '${event.reservationId}' (run '${event.runId}') has no matching reservation-opened`,
          );
        }
        openReservations.delete(event.reservationId);
        openByRunJob.delete(`${event.runId}:${event.jobId}`);
        assertValidUsd('seeded reservation charge', event.charged);
        this.usdSpentN += event.charged;
        if (event.usage !== undefined) {
          assertValidUsage('seeded reservation usage', event.usage);
          this.usageN =
            this.usageN === undefined ? { ...event.usage } : addUsage(this.usageN, event.usage);
          if (event.charged === 0 && totalTokensOf(event.usage) > 0) {
            // A settled dispatch with real usage and ZERO charge is UNPRICED
            // spend (an unpriced model) — the reservation-era twin of the
            // W2.2-era usage-without-costUSD rule below: maxUsd cannot bind
            // it, so the seed trips before the resumed run admits anything.
            unpricedClosingUsage = true;
          }
        }
        continue;
      }
      if (event.type !== 'job-finished') {
        continue;
      }
      jobIds.add(event.jobId);
      if (reservationEra.has(event.runId)) {
        // Reservation-era finish: its spend folded from the reservations.
        // A finish while THIS job's reservation is still open is impossible
        // from an honest writer (settle is durable BEFORE the finish is
        // even issued) — the settle line was lost under an intact finish:
        // evidence rot, never silently folded.
        const stillOpen = openByRunJob.get(`${event.runId}:${event.jobId}`);
        if (stillOpen !== undefined) {
          throw new Error(
            `journal: corrupt — job-finished for '${event.jobId}' (run '${event.runId}') while reservation '${stillOpen}' is unsettled`,
          );
        }
        continue;
      }
      const closed = openStarts.delete(`${event.runId}:${event.jobId}`); // any finish closes ITS OWN RUN's start
      if (!closed) {
        continue;
      }
      if (event.usage !== undefined) {
        // Same fail-loud rule as the live fold (review round 2): a seeded
        // NaN/negative usage would disable the token cap for the whole
        // resumed run — and seeding is construction time, the earliest loud
        // failure there is.
        assertValidUsage('seeded usage', event.usage);
        this.usageN =
          this.usageN === undefined ? { ...event.usage } : addUsage(this.usageN, event.usage);
        if (event.costUSD === undefined && totalTokensOf(event.usage) > 0) {
          // A closing finish with real usage but no costUSD is UNPRICED
          // spend (an unpriced model's dispatch). Another finish's costUSD
          // does not price it — DD-9 requires maxUsd to bind every seeded
          // token, so this state trips below even in a mixed fold.
          unpricedClosingUsage = true;
        }
      }
      if (event.costUSD !== undefined) {
        // A seeded NaN/negative cost would poison the USD rollup the same
        // way — fail loud and EARLY, never silently disable maxUsd.
        assertValidUsd('seeded costUSD', event.costUSD);
        this.usdSpentN += event.costUSD;
      }
    }
    // A12b (ADR §2.5): every reservation still open at fold end is an
    // UNRESOLVED dispatch — charged IN FULL (its real spend is unknowable,
    // the full reservation is the honest ceiling within the bound) and its
    // job is QUARANTINED: never re-run, reported needs-human, dependents
    // blocked, re-attested each run until an explicit `releaseQuarantine`
    // — which never refunds. The charge lands in the seeded ledger, so a
    // crash that spent the cap trips the seeded-overrun check below.
    const quarantined: Array<{ jobId: string; reservationId: string; usd: number }> = [];
    for (const [reservationId, open] of openReservations) {
      assertValidUsd('unresolved reservation', open.usd);
      this.usdSpentN += open.usd;
      this.quarantinedN.set(open.jobId, { reservationId, usd: open.usd });
      quarantined.push({ jobId: open.jobId, reservationId, usd: open.usd });
    }
    if (quarantined.length > 0) {
      this.record({ kind: 'quarantined', jobs: quarantined, atMs: this.now() });
    }
    // Per-job attempt seed: the COUNT of prior starts (annex rule) — the
    // next admission of the job is attempt count + 1.
    for (const [jobId, starts] of startsByJob) {
      if (starts > this.attemptsFor(jobId)) {
        this.attemptsByJob.set(jobId, starts);
      }
    }
    // The dispatch quota is part of the SAME budget: seeding replays the
    // journaled dispatch count so runDispatchQuota carries across resume
    // instead of restarting at 0.
    this.dispatchedCount += totalStarts;
    // DD-9 fail-loud at seed time: spend whose evidence carries real usage
    // with NO price — a W2.2-era closing finish with usage and no costUSD,
    // or a reservation-era settle with usage and a zero charge — cannot be
    // bound by maxUsd, so trip BEFORE the resumed run admits anything (fail
    // loud, never fail open). Other events' prices do not price this one
    // (the mixed priced/unpriced fold trips too). v2 governed journals carry
    // costUSD on priced finishes and ABSENT usage when a reservation
    // settled unknown; a v1 journal with dispatches never reaches this seed
    // (the runner refuses it first).
    if (this.capUsd !== undefined && unpricedClosingUsage) {
      this.trip(
        'exhausted',
        `seeded prior usage cannot be fully priced — spend with real usage carries no price in the folded history, so maxUsd ${this.capUsd} cannot bind the resumed run's prior spend; refusing to continue past an unenforceable budget (DD-9)`,
      );
    }
    // A seed that already overruns a cap trips the governor BEFORE the
    // resumed run admits anything: budget-exhausted rows from the prior run
    // re-mark without op invocation (the "not auto-retried by resume" rule,
    // README "Budget governor"). BOTH caps check here — a seeded token
    // rollup over maxTokens that only tripped on later usage would admit
    // and dispatch before any new fold, and never trip at all if no
    // further usage-reporting op ran (DD-9). The USD check reads the
    // EFFECTIVE cap (an inherited predecessor cap binds a capless resume
    // too), and includes the unresolved reservations' full charges.
    const cap = this.capUsd;
    if (cap !== undefined && this.usdSpentN > cap) {
      this.trip('exhausted', `seeded usd rollup ${this.usdSpentN} exceeded cap ${cap}`);
    }
    const tokenCap = this.config.maxTokens;
    if (
      tokenCap !== undefined &&
      this.usageN !== undefined &&
      totalTokensOf(this.usageN) > tokenCap
    ) {
      this.trip(
        'token-cap',
        `seeded token rollup ${totalTokensOf(this.usageN)} exceeded cap ${tokenCap}`,
      );
    }
    this.record({ kind: 'seeded', jobs: jobIds.size, attempts: totalStarts, atMs: this.now() });
  }

  /** Append to the observation stream (called by the governed runner). */
  record(event: GovernorEvent): void {
    this.events.push(event);
  }
}

/**
 * Structural guard for a governed 'ok' value (defensive — contract-violating
 * returns exist): when the value carries a WorkerResult shape, return it for
 * the DD-9 budget fold; anything else returns undefined and folds nothing.
 * Requires `usage` to be an object
 * with FINITE non-negative numeric input/output/cacheRead/cacheWrite
 * (`denials` an array, `stopReason` one of the four frozen
 * DriverStopReason strings; a present `costUSD` must be a finite number
 * >= 0 as well — a lying cost rejects the WHOLE result): a LYING
 * WorkerResult folds NOTHING — the guard rejects it so the completion-time
 * fold never trips assertValidUsage/assertValidUsd post-record (the
 * verdict stays real evidence; the usage stays zero-evidence).
 *
 * EXPORTED for the governed runner (W2.2): runPlan's governed dispatch runs
 * the completion-time evidence fold itself (the ladder task returns the
 * checked OpResult, and the fold reads its `value`).
 */
export function workerResultOfValue(
  value: unknown,
): Pick<WorkerResult, 'usage' | 'costUSD'> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const candidate = value as {
    usage?: unknown;
    costUSD?: unknown;
    denials?: unknown;
    stopReason?: unknown;
  };
  const usage = candidate.usage;
  if (typeof usage !== 'object' || usage === null) {
    return undefined;
  }
  const usageRec = usage as Record<string, unknown>;
  for (const field of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
    const v = usageRec[field];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return undefined; // lying measurement — zero evidence, never a throw
    }
  }
  const reasoning = usageRec['reasoning'];
  if (
    reasoning !== undefined &&
    (typeof reasoning !== 'number' || !Number.isFinite(reasoning) || reasoning < 0)
  ) {
    return undefined;
  }
  if (!Array.isArray(candidate.denials)) {
    return undefined;
  }
  const stopReason = candidate.stopReason;
  if (
    stopReason !== 'complete' &&
    stopReason !== 'aborted' &&
    stopReason !== 'budget' &&
    stopReason !== 'error'
  ) {
    return undefined;
  }
  // A present costUSD must be a finite number >= 0 too: a NaN/Infinity/
  // negative cost would survive this guard, reach observeCost, and trip
  // assertValidUsd AFTER the completed event was recorded — the exact
  // post-record throw this defensive guard exists to prevent (review
  // thread). A lying cost rejects the WHOLE result: zero evidence, never a
  // post-record throw.
  const costUSD = candidate.costUSD;
  if (
    costUSD !== undefined &&
    (typeof costUSD !== 'number' || !Number.isFinite(costUSD) || costUSD < 0)
  ) {
    return undefined;
  }
  return {
    usage: usage as Usage,
    ...(typeof costUSD === 'number' ? { costUSD } : {}),
  };
}

/**
 * Non-throwing sanitization of one spend-evidence fold, EXPORTED for the
 * governed runner: only the VALID measurements survive (a NaN/Infinity/
 * negative usage or costUSD is dropped), so a runner-side fold can apply
 * the same once-only flags as `observeResult` without importing the private
 * predicates. Mirrors observeResult's defensive-fold rule exactly — a lying
 * measurement is ZERO evidence, never a throw.
 */
export function validSpendEvidence(result: { usage?: Usage; costUSD?: number }): {
  usage?: Usage;
  costUSD?: number;
} {
  const usage = isValidUsage(result.usage) ? result.usage : undefined;
  const costUSD = isValidUsd(result.costUSD) ? result.costUSD : undefined;
  return {
    ...(usage !== undefined ? { usage } : {}),
    ...(costUSD !== undefined ? { costUSD } : {}),
  };
}
