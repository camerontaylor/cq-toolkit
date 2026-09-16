// Budget governor — T1.3 slice 1 (ws-a items 4–5): the per-job wall-clock
// escalation ladder, per-job/per-run attempt caps, the USD rollup cap, the
// dual in-flight/dispatch caps, and honest-stop marking (invariant I9).
//
// SEAM — governed-registry decorator (recorded decision, README "Budget
// governor"): `governRegistry` wraps an OpRegistryView so every op
// invocation runs under admission caps, the in-flight ceiling, and the
// escalation ladder. runPlan (T1.2) is untouched — T1.2 call-sites and tests
// compile and pass unchanged — and composition with resume falls out of the
// runner's own journal logic. The `runPlan(plan, opts, registry, gov?)`
// parameter alternative is the recorded T1.4 runner-integration path, where
// retries must raise the frozen JobStartedJournalEvent.attempt field (only
// the runner journals dispatches — so this module NEVER retries: an
// in-wrapper retry would hide attempts from the journal, which is recorded
// as journal-dishonest and rejected).
//
// Invariants honored here:
//   - I8: the governor decides WHEN to abort (this module) and the kernel
//     owns WHETHER to retry/escalate (rescue.ts); drivers never decide.
//     Enforcement is abort-only — this module never re-dispatches.
//   - I9: honest stop — at a cap the remaining work is marked
//     budget-exhausted, never fabricated; `withBudgetStop` annotates a
//     report only when the governor ACTUALLY tripped.
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
import { candidateRunsForPlan, type RunLog } from './journal.js';
import { attemptsFromJournal } from './rescue.js';
import type { OpRegistryView } from './runner.js';
import type {
  JobOutcome,
  JobState,
  JournalEvent,
  Limits,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunCounts,
  RunOptions,
  RunReport,
  RunStartedJournalEvent,
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
  hardCancel?: () => void;
  /** Rung 3: the SIGKILL-equivalent primitive, when the op hosts a killable worker. */
  kill?: () => void;
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
  /** Report token usage for this invocation into the governor's rollup. */
  reportUsage(usage: Usage): void;
  /**
   * Report observed USD cost into the governor's rollup — the USD cap's
   * input. The kernel never derives cost itself; until the T1.4 price-map
   * layer lands, tests inject cost here.
   */
  reportCost(usd: number): void;
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
     * Rung observer — invoked AFTER the marker lands. A THROW here is
     * swallowed: observer failure must never break the ladder (same contract
     * as the cancel port).
     */
    onRung?: (marker: LadderRungMarker) => void;
    onUsage?: (usage: Usage) => void;
    onCost?: (usd: number) => void;
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

  const ctx: JobGovernance = {
    signal: controller.signal,
    setCancelPort: (p) => {
      port = p;
    },
    reportUsage: (usage) => opts?.onUsage?.(usage),
    reportCost: (usd) => opts?.onCost?.(usd),
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
 * The governor's configuration — plain data for now (the one runtime-only
 * field is `jobKey`, a function, like the registry's importer; never
 * persisted). Built by hand or via `governorConfig` from the frozen
 * RunOptions/Limits surfaces.
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
  /**
   * Job-key extractor for per-job caps. The frozen Op contract carries no
   * job identity, so the governor keys on this when given; otherwise the
   * `input.jobId` plan-jobId convention (which the runner's ops and the
   * phase-2 op families follow), else the OP NAME — under that fallback
   * every dispatch of an op counts as another attempt of that op, so
   * attempt caps always exist. Stable PER-JOB identity needs config.jobKey
   * or input.jobId. Runtime-only: never persisted.
   *
   * RESUME LIMITATION (recorded): a custom jobKey is NOT seeded on resume —
   * `seedFromJournal` seeds per journal jobId (max-of-ordinals) and per op
   * name (sum), so a custom jobKey must align with those conventions or
   * per-job caps reset across resume.
   */
  jobKey?: (op: string, input: unknown) => string;
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
  extra?: Pick<GovernorConfig, 'abortGraceMs' | 'killGraceMs' | 'jobKey'>,
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
    ...(extra?.jobKey !== undefined ? { jobKey: extra.jobKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// Governor events — the observation stream tests assert on
// ---------------------------------------------------------------------------

/** Terminal status of a governed invocation, as the governor observed it. */
export type GovernedOutcomeStatus = OpResult<unknown>['status'] | 'threw' | 'invalid';

/** Why a governed invocation was refused without running the op. */
export type ShortCircuitReason =
  | 'budget'
  | 'dispatch-quota'
  | 'attempt-cap'
  | 'budget-while-queued';

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
  | { kind: 'usage'; jobKey: string; usd?: number; atMs: number }
  | { kind: 'budget-tripped'; reason: string; atMs: number }
  | { kind: 'seeded'; jobs: number; attempts: number; atMs: number };

/** The admission gate's verdict for one dispatch. */
export type AdmissionDecision =
  | { decision: 'admit'; attempt: number }
  | {
      decision: 'reject';
      reason: Exclude<ShortCircuitReason, 'budget-while-queued'>;
    };

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

  constructor(private readonly limit: number) {}

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
 * a bad `usdOf` derivation fails loud at construction time.
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

// ---------------------------------------------------------------------------
// BudgetGovernor — the stateful per-run enforcer
// ---------------------------------------------------------------------------

/**
 * The per-run budget governor: admission caps, the in-flight ceiling, the
 * USD rollup, the ladder spec, and the event stream. One per run; compose
 * with a registry via `governRegistry` and with a report via
 * `withBudgetStop`. All time flows through the injected clock.
 */
export class BudgetGovernor {
  /** Validated plain-data config (jobKey is the one runtime-only field). */
  readonly config: GovernorConfig;
  readonly clock: Clock;
  /** The observation stream — every event, in fire order (tests assert here). */
  readonly events: GovernorEvent[] = [];

  private dispatchedCount = 0;
  private readonly attemptsByJob = new Map<string, number>();
  private usdSpentN = 0;
  private usageN?: Usage;
  private trippedFlag = false;
  private tripReasonN?: string;
  private readonly slots: SlotPool | undefined;

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

  /**
   * Job identity for per-job caps and events: the explicit config.jobKey
   * extractor when configured, else the input's string `jobId` (the
   * plan-jobId convention), else the OP NAME. Under that fallback every
   * dispatch of an op counts as another attempt of that op — the per-job
   * (here: per-op) attempt cap always EXISTS instead of silently never
   * tripping; stable per-job identity needs config.jobKey or input.jobId.
   */
  jobKeyFor(op: string, input: unknown): string {
    if (this.config.jobKey !== undefined) {
      return this.config.jobKey(op, input);
    }
    if (typeof input === 'object' && input !== null && 'jobId' in input) {
      const id = (input as { jobId?: unknown }).jobId;
      if (typeof id === 'string' && id !== '') {
        return id;
      }
    }
    return op;
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
      this.trip(`token rollup ${totalTokensOf(this.usageN)} exceeded cap ${tokenCap}`);
    }
  }

  /**
   * Observe USD cost for one governed invocation and check the run cap. The
   * cap is inclusive: the trip fires when the rollup EXCEEDS maxUsd. The
   * observation is validated BEFORE the rollup mutates: a NaN/negative
   * value throws instead of poisoning the cap (I9 — fail loud, never fail
   * open).
   */
  observeCost(jobKey: string, usd: number): void {
    assertValidUsd('observed cost', usd);
    this.usdSpentN += usd;
    this.record({ kind: 'usage', jobKey, usd, atMs: this.now() });
    const cap = this.config.maxUsd;
    if (cap !== undefined && this.usdSpentN > cap) {
      this.trip(`usd rollup ${this.usdSpentN} exceeded cap ${cap}`);
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
   * via reportUsage/reportCost is skipped here, and the unpriced trip fires
   * only when THIS invocation's usage has no cost evidence either way — a
   * `costAlreadyCounted` flag means cost evidence existed and was counted,
   * so there is nothing left to fail loud about.
   */
  observeResult(
    jobKey: string,
    result: { usage?: Usage; costUSD?: number },
    counts?: { usageAlreadyCounted?: boolean; costAlreadyCounted?: boolean },
  ): void {
    const usage = result.usage;
    const hasRealUsage = usage !== undefined && totalTokensOf(usage) > 0;
    if (hasRealUsage && usage !== undefined && counts?.usageAlreadyCounted !== true) {
      this.observeUsage(jobKey, usage);
    }
    if (result.costUSD !== undefined) {
      if (counts?.costAlreadyCounted !== true) {
        this.observeCost(jobKey, result.costUSD);
      }
    } else if (
      hasRealUsage &&
      this.config.maxUsd !== undefined &&
      counts?.costAlreadyCounted !== true
    ) {
      this.trip(
        'unpriced usage under a USD cap — maxUsd cannot bind an unpriced model; refusing to run past an unenforceable budget (DD-9)',
      );
    }
  }

  /**
   * Trip the budget cap (idempotent — the first reason is kept). Tripping
   * gates ADMISSION ONLY: in-flight jobs were admitted before the trip and
   * their outcomes stay real evidence (documented decision, README).
   */
  trip(reason: string): void {
    if (this.trippedFlag) {
      return;
    }
    this.trippedFlag = true;
    this.tripReasonN = reason;
    this.record({ kind: 'budget-tripped', reason, atMs: this.now() });
  }

  /**
   * Seed caps state from a prior run's journal so a resumed run continues
   * the SAME budget: per-job attempt ordinals (folded from the frozen
   * JobStartedJournalEvent.attempt field via rescue.attemptsFromJournal),
   * the token-usage rollup, and the DISPATCH COUNT (runDispatchQuota carries
   * across resume). USD seeding needs prices the kernel does not own — pass
   * `usdOf` to derive cost from journaled usage (the T1.4 price-map layer
   * will own that mapping).
   *
   * CONTRACT on `events`: the ORDERED CONCATENATION of ALL the plan's run
   * journals, oldest-first — exactly what `seedFromRunLog` builds. The
   * latest run's journal alone UNDERCOUNTS: a re-attested job appears as a
   * finish-only event (no open start to close, so its usage is skipped and
   * it contributes no attempt ordinal) and chained dispatches from earlier
   * runs vanish — silently resetting the budget this method promises to
   * continue.
   *
   * Keys are seeded TWICE so every jobKeyFor fallback resolves, with
   * different aggregation per key: per journal jobId (aligns with the
   * `input.jobId` convention) as MAX-of-ordinals — a job's highest dispatch —
   * and per op name (aligns with the no-identity fallback, where a
   * dispatch's key IS its op name) as the SUM of the op's dispatches across
   * all journal jobs — the fallback's ordinal IS the op's dispatch count, so
   * a max would understate it (2 jobs × 2 attempts = 4 dispatches) and let a
   * resumed run exceed the cap. Usage is counted only for finishes that
   * CLOSE an open start: an orphan finish in a multi-run journal is a replay
   * re-attestation of an already-counted dispatch, and counting it again
   * would double the rollup.
   */
  seedFromJournal(
    events: readonly JournalEvent[],
    opts?: { usdOf?: (usage: Usage) => number },
  ): void {
    const jobIds = new Set<string>();
    const opByJob = new Map<string, string>();
    for (const event of events) {
      if (event.type === 'job-started') {
        jobIds.add(event.jobId);
        opByJob.set(event.jobId, event.op);
      } else if (event.type === 'job-finished') {
        jobIds.add(event.jobId);
      }
    }
    let totalAttempts = 0;
    const dispatchesByOp = new Map<string, number>(); // SUM across journal jobs sharing the op
    for (const jobId of jobIds) {
      const attempts = attemptsFromJournal(events, jobId);
      totalAttempts += attempts.length;
      const op = opByJob.get(jobId);
      if (op !== undefined) {
        dispatchesByOp.set(op, (dispatchesByOp.get(op) ?? 0) + attempts.length);
      }
      for (const attempt of attempts) {
        // jobId keys keep max-of-ordinals: the job's highest dispatch.
        if (attempt.attempt > this.attemptsFor(jobId)) {
          this.attemptsByJob.set(jobId, attempt.attempt);
        }
      }
    }
    for (const [op, dispatches] of dispatchesByOp) {
      if (dispatches > this.attemptsFor(op)) {
        this.attemptsByJob.set(op, dispatches);
      }
    }
    // Usage/USD dedupe: only a finish that closes an open start represents a
    // dispatch's own usage; an orphan finish (re-attestation) restates an
    // already-counted dispatch and is skipped.
    const openStarts = new Set<string>();
    for (const event of events) {
      if (event.type === 'job-started') {
        openStarts.add(event.jobId);
        continue;
      }
      if (event.type !== 'job-finished') {
        continue;
      }
      const closed = openStarts.delete(event.jobId); // any finish closes its start
      if (event.usage === undefined || !closed) {
        continue;
      }
      // Same fail-loud rule as the live fold (review round 2): a seeded
      // NaN/negative usage would disable the token cap for the whole
      // resumed run — and seeding is construction time, the earliest loud
      // failure there is.
      assertValidUsage('seeded usage', event.usage);
      this.usageN =
        this.usageN === undefined ? { ...event.usage } : addUsage(this.usageN, event.usage);
      if (opts?.usdOf !== undefined) {
        const usd = opts.usdOf(event.usage);
        // Seeding happens at construction: a derived cost that is not a
        // finite number >= 0 fails loud and EARLY, never poisons the rollup.
        assertValidUsd('derived cost', usd);
        this.usdSpentN += usd;
      }
    }
    // The dispatch quota is part of the SAME budget: seeding replays the
    // journaled dispatch count so runDispatchQuota carries across resume
    // instead of restarting at 0.
    this.dispatchedCount += totalAttempts;
    // DD-9 fail-loud at seed time: real journaled usage with NO price
    // mapping under a configured maxUsd means the resumed run's PRIOR
    // usage cannot be priced, so maxUsd cannot bind it — trip BEFORE the
    // resumed run admits anything (fail loud, never fail open).
    if (
      opts?.usdOf === undefined &&
      this.config.maxUsd !== undefined &&
      this.usageN !== undefined &&
      totalTokensOf(this.usageN) > 0
    ) {
      this.trip(
        `seeded prior usage (${totalTokensOf(this.usageN)} tokens) cannot be priced — no usdOf mapping, so maxUsd ${this.config.maxUsd} cannot bind the resumed run's prior usage; refusing to continue past an unenforceable budget (DD-9)`,
      );
    }
    // A seed that already overruns a cap trips the governor BEFORE the
    // resumed run admits anything: budget-exhausted rows from the prior run
    // re-mark without op invocation (the "not auto-retried by resume" rule,
    // README "Budget governor"). BOTH caps check here — a seeded token
    // rollup over maxTokens that only tripped on later usage would admit
    // and dispatch before any new fold, and never trip at all if no
    // further usage-reporting op ran (DD-9).
    const cap = this.config.maxUsd;
    if (cap !== undefined && this.usdSpentN > cap) {
      this.trip(`seeded usd rollup ${this.usdSpentN} exceeded cap ${cap}`);
    }
    const tokenCap = this.config.maxTokens;
    if (
      tokenCap !== undefined &&
      this.usageN !== undefined &&
      totalTokensOf(this.usageN) > tokenCap
    ) {
      this.trip(`seeded token rollup ${totalTokensOf(this.usageN)} exceeded cap ${tokenCap}`);
    }
    this.record({ kind: 'seeded', jobs: jobIds.size, attempts: totalAttempts, atMs: this.now() });
  }

  /** Append to the observation stream (called by the governed registry). */
  record(event: GovernorEvent): void {
    this.events.push(event);
  }
}

/**
 * The easy path for chained resumes: construct a governor seeded from ALL of
 * the plan's run journals — `log.runs()` (oldest-first) filtered by the
 * `<planId>--` candidate prefix and the run-started `planId` exact matcher,
 * mirroring the runner's own resume rules — and return it. This builds the
 * ordered concatenation that `seedFromJournal`'s events contract requires:
 * the latest run's journal alone undercounts re-attested jobs (finish-only
 * events) and chained dispatches, silently resetting the budget.
 */
export async function seedFromRunLog(
  log: RunLog,
  planId: string,
  opts?: {
    config?: GovernorConfig;
    clock?: Clock;
    usdOf?: (usage: Usage) => number;
  },
): Promise<BudgetGovernor> {
  const governor = new BudgetGovernor(opts?.config ?? {}, opts?.clock);
  const events: JournalEvent[] = [];
  // Shared candidate filter — journal.candidateRunsForPlan — mirroring the
  // runner's resume rules (the coupling is declared on both sides): prefix +
  // two-segment runId tail, so a planId that merely extends this one
  // ('a' vs 'a--b') cannot slip in and a corrupt journal of ANOTHER plan
  // cannot block this seed.
  for (const runId of candidateRunsForPlan(await log.runs(), planId)) {
    const runEvents = await log.read(runId);
    const started = runEvents.find(
      (event): event is RunStartedJournalEvent => event.type === 'run-started',
    );
    if (started?.planId !== planId) {
      continue; // exact matcher — rejects a pathological id that merely shares the prefix
    }
    events.push(...runEvents);
  }
  governor.seedFromJournal(events, opts?.usdOf === undefined ? {} : { usdOf: opts.usdOf });
  return governor;
}

// ---------------------------------------------------------------------------
// The governed-registry decorator — THE seam (recorded decision)
// ---------------------------------------------------------------------------

/** Terminal status read off a governed value, defensively (contract-violating returns exist). */
function statusOfValue(value: unknown): GovernedOutcomeStatus {
  if (typeof value === 'object' && value !== null && 'status' in value) {
    const status = (value as { status: unknown }).status;
    if (
      status === 'ok' ||
      status === 'failed' ||
      status === 'needs-human' ||
      status === 'budget-exhausted' ||
      status === 'indeterminate'
    ) {
      return status;
    }
  }
  return 'invalid';
}

/**
 * Structural guard for a governed 'ok' value (the same defensive style as
 * statusOfValue — contract-violating returns exist): when the value carries
 * a WorkerResult shape, return it for the DD-9 budget fold; anything else
 * returns undefined and folds nothing. Requires `usage` to be an object
 * with FINITE non-negative numeric input/output/cacheRead/cacheWrite
 * (`denials` an array, `stopReason` one of the four frozen
 * DriverStopReason strings; a present `costUSD` must be a finite number
 * >= 0 as well — a lying cost rejects the WHOLE result): a LYING
 * WorkerResult folds NOTHING — the guard rejects it so the completion-time
 * fold never trips assertValidUsage/assertValidUsd post-record (the
 * verdict stays real evidence; the usage stays zero-evidence).
 */
function workerResultOfValue(value: unknown): WorkerResult | undefined {
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
    denials: candidate.denials,
    stopReason,
    ...(typeof costUSD === 'number' ? { costUSD } : {}),
  };
}

/**
 * Wrap one op with the governor: admission caps → in-flight slot → wall-clock
 * ladder (inside the job context, so ops reach the signal/port via
 * currentJobContext()) → honest verdict. Refusals and kills return
 * `{status:'budget-exhausted'}` — a budget bound was hit, the one frozen
 * taxonomy value whose purpose is exactly this; throws pass through so the
 * RUNNER's failure semantics stay in charge.
 */
function governOp(
  op: Op<never, never>,
  opName: string,
  governor: BudgetGovernor,
): Op<never, never> {
  return async (input: never): Promise<OpResult<never>> => {
    const jobKey = governor.jobKeyFor(opName, input);
    const admission = governor.admit(jobKey);
    if (admission.decision === 'reject') {
      governor.record({
        kind: 'short-circuited',
        op: opName,
        jobKey,
        reason: admission.reason,
        atMs: governor.now(),
      });
      return { status: 'budget-exhausted' };
    }
    governor.record({
      kind: 'admitted',
      op: opName,
      jobKey,
      attempt: admission.attempt,
      atMs: governor.now(),
    });
    await governor.acquireSlot();
    try {
      // The budget can trip while this dispatch waited for a slot; a queued
      // dispatch that can no longer be paid for does not run (I9: honest).
      if (governor.tripped) {
        governor.record({
          kind: 'short-circuited',
          op: opName,
          jobKey,
          reason: 'budget-while-queued',
          atMs: governor.now(),
        });
        return { status: 'budget-exhausted' };
      }
      const attempt = admission.attempt;
      // The once-only guard: usage/cost the op STREAMED through the job
      // context is folded by the callbacks below — the flags tell the
      // completion-time WorkerResult fold to skip that evidence instead of
      // counting it twice.
      let reportedUsage = false;
      let reportedCost = false;
      const outcome = await runLadder(
        () => op(input),
        governor.ladderSpec,
        { op: opName, jobKey, attempt },
        {
          clock: governor.clock,
          onRung: (marker) => {
            governor.record({
              kind: 'ladder-rung',
              op: marker.op,
              jobKey: marker.jobKey,
              rung: marker.rung,
              delayMs: marker.delayMs,
              sinceStartMs: marker.sinceStartMs,
              delivered: marker.delivered,
              ...(marker.error !== undefined ? { error: marker.error } : {}),
              atMs: marker.atMs,
            });
          },
          onUsage: (usage) => {
            reportedUsage = true;
            governor.observeUsage(jobKey, usage);
          },
          onCost: (usd) => {
            reportedCost = true;
            governor.observeCost(jobKey, usd);
          },
        },
      );
      if (outcome.outcome === 'completed') {
        governor.record({
          kind: 'completed',
          op: opName,
          jobKey,
          attempt,
          status: statusOfValue(outcome.value),
          elapsedMs: outcome.elapsedMs,
          atMs: governor.now(),
        });
        // DD-9 evidence fold: a completed 'ok' result whose value is
        // WorkerResult-shaped carries this invocation's budget evidence —
        // fold it ONCE, skipping whatever the op already streamed (the
        // flags above).
        if (statusOfValue(outcome.value) === 'ok') {
          const worker = workerResultOfValue((outcome.value as { value?: unknown }).value);
          if (worker !== undefined) {
            governor.observeResult(jobKey, worker, {
              usageAlreadyCounted: reportedUsage,
              costAlreadyCounted: reportedCost,
            });
          }
        }
        return outcome.value;
      }
      if (outcome.outcome === 'threw') {
        governor.record({
          kind: 'completed',
          op: opName,
          jobKey,
          attempt,
          status: 'threw',
          elapsedMs: outcome.elapsedMs,
          atMs: governor.now(),
        });
        throw outcome.error;
      }
      // Rung 3 fired: the op was killed — detached in-process with its
      // rejections suppressed — and the honest known-cause verdict is
      // returned in its place (I9; see the README for the taxonomy choice).
      governor.record({
        kind: 'completed',
        op: opName,
        jobKey,
        attempt,
        status: 'budget-exhausted',
        elapsedMs: outcome.elapsedMs,
        atMs: governor.now(),
      });
      return { status: 'budget-exhausted' };
    } finally {
      governor.releaseSlot();
    }
  };
}

/**
 * THE SEAM (recorded decision): wrap an OpRegistryView so every op
 * invocation runs under the governor — admission caps, the in-flight
 * ceiling, the wall-clock ladder, usage/cost observation. Purely additive
 * and backwards-compatible: the returned view satisfies OpRegistryView,
 * runPlan (T1.2) consumes it unchanged, ops that never call
 * currentJobContext() behave identically except for cap enforcement, and
 * input validation stays exactly where it was (the entry's inputSchema
 * passes through untouched).
 */
export function governRegistry(view: OpRegistryView, governor: BudgetGovernor): OpRegistryView {
  const cache = new Map<string, OpRegistryEntry<never, never> | undefined>();
  return {
    get(name: string): OpRegistryEntry<never, never> | undefined {
      if (cache.has(name)) {
        return cache.get(name);
      }
      const entry = view.get(name);
      if (entry === undefined) {
        cache.set(name, undefined);
        return undefined;
      }
      const governed: OpRegistryEntry<never, never> = {
        name: entry.name,
        inputSchema: entry.inputSchema,
        importer: async () => {
          const op = await entry.importer();
          return governOp(op, name, governor);
        },
      };
      cache.set(name, governed);
      return governed;
    },
  };
}

// ---------------------------------------------------------------------------
// Honest stop (I9) — report annotation on a REAL trip only
// ---------------------------------------------------------------------------

// The runner's never-dispatched row markers (runner.ts is frozen for this
// slice; these prefixes are its documented row vocabulary).
const QUEUED_MARKER = 'queued:';
const BLOCKED_MARKER = 'blocked:';

/**
 * HONEST STOP (I9): annotate a returned run report with the budget stop —
 * `stoppedEarly: true` + `earlyStopReason: 'budget'` (the frozen
 * RunEarlyStopReason's ONLY allowed value; this is its purpose) — and mark
 * the jobs that never reached an op verdict because the budget bound hit:
 *
 *   - rows carrying the runner's `queued: …` marker (never dispatched,
 *     dependencies fine) → OpResult `{status:'budget-exhausted'}`;
 *   - rows carrying a `blocked: …` marker whose ENTIRE dependency
 *     obstruction is transitively budget-caused → budget-exhausted too; a
 *     blocked row with any definitively-failed dependency keeps its real
 *     verdict (that obstruction is evidence, not budget).
 *
 * TWO honesty rules (I9: annotate only a real stop that actually gated
 * undispatched work):
 *   - the STOP must be budget-family: the governor tripped, OR the run hit
 *     the per-run dispatch quota — a 'dispatch-quota' short-circuit stops
 *     the run for budget-family reasons even though `tripped` stays false.
 *     An 'attempt-cap' is PER-JOB (it gates only that job's own
 *     re-dispatch, never the run) and must NOT trigger annotation.
 *   - the stop must actually GATE: if NO row differs from the input report
 *     after the marking pass (identity compare below), nothing undispatched
 *     was gated — the refused rows are themselves real terminal verdicts —
 *     and the report is returned WITHOUT the stoppedEarly claim.
 *
 * Executed rows are never rewritten: a `queued:`-marker row the governor's
 * events show as ADMITTED (or completed) carries a detail fabricated by
 * executed code, not the runner's never-dispatched marker, and keeps its
 * real verdict. Counts are recomputed over the marked rows
 * (needs-human→blocked and indeterminate→failed per the documented T1.2
 * freeze workaround). The T1.4 runner integration folds this into runPlan;
 * today the caller composes:
 * `withBudgetStop(await runPlan(...), plan, governor)`.
 */
export function withBudgetStop(report: RunReport, plan: Plan, governor: BudgetGovernor): RunReport {
  // Honesty rule 1 — a budget-family stop only (see the doc comment): the
  // trip, or a per-run dispatch-quota refusal. 'attempt-cap' is per-job and
  // deliberately absent here.
  const dispatchQuotaRefused = governor.events.some(
    (event) => event.kind === 'short-circuited' && event.reason === 'dispatch-quota',
  );
  if (!governor.tripped && !dispatchQuotaRefused) {
    return report;
  }
  const rowsByJob = new Map<string, JobOutcome>(report.jobs.map((row) => [row.jobId, row]));
  const depsOf = new Map<string, readonly string[]>(
    plan.jobs.map((job) => [job.id, job.dependsOn ?? []]),
  );
  // Is this job's non-execution attributable to the budget (transitively)?
  // Memoized per jobId: a diamond dependency (A → B,C → D) must reuse D's
  // verdict when the SECOND branch reaches it — a visited marker is not a
  // "no" verdict, and reading it as one kept dishonest `blocked…` verdicts
  // on diamond roots (I9). inProgress is a cycle guard only (runPlan forbids
  // cycles) and is never memoized, so a partial walk cannot poison results.
  const memo = new Map<string, boolean>();
  const inProgress = new Set<string>();
  // Provenance predicate (shared by the re-mark pass and budgetCaused below
  // so the two cannot drift): the runner writes `queued: …` ONLY for jobs it
  // never dispatched — an 'admitted' or 'completed' event for the jobKey
  // means the marker came from EXECUTED code (an op fabricating an
  // indeterminate `queued: …` verdict), not from the runner's
  // never-dispatch sweep. Conservative: custom config.jobKey layouts simply
  // never match the row id and behave exactly as before.
  const hasAdmissionEvidence = (jobKey: string): boolean =>
    governor.events.some(
      (event) =>
        (event.kind === 'admitted' || event.kind === 'completed') && event.jobKey === jobKey,
    );
  const budgetCaused = (jobId: string): boolean => {
    const memoed = memo.get(jobId);
    if (memoed !== undefined) {
      return memoed;
    }
    if (inProgress.has(jobId)) {
      return false; // defensive: runPlan forbids cycles
    }
    inProgress.add(jobId);
    let caused = false;
    const row = rowsByJob.get(jobId);
    if (row === undefined) {
      caused = false; // unknown row — conservative: don't attribute
    } else {
      switch (row.result.status) {
        case 'budget-exhausted':
          caused = true;
          break;
        case 'indeterminate':
          // The SAME provenance rule the re-mark pass applies (shared
          // predicate above): a `queued:`-prefixed detail on a row the
          // governor ADMITTED is a lie from executed code — not evidence of
          // a budget-caused non-execution — so its dependents keep their
          // real blocked verdicts (review round 3).
          caused = row.result.detail.startsWith(QUEUED_MARKER) && !hasAdmissionEvidence(jobId);
          break;
        case 'failed':
          if (row.result.error.startsWith(BLOCKED_MARKER)) {
            caused = (depsOf.get(jobId) ?? []).every((dep) => budgetCaused(dep));
          }
          break;
        default:
          caused = false; // ok / needs-human: real verdicts
      }
    }
    inProgress.delete(jobId);
    memo.set(jobId, caused);
    return caused;
  };
  const jobs: JobOutcome[] = report.jobs.map((row) => {
    if (row.result.status === 'indeterminate' && row.result.detail.startsWith(QUEUED_MARKER)) {
      // Provenance check (hasAdmissionEvidence above — one predicate, both
      // uses): if the governor's events show an admission (or a completion)
      // for this jobKey, the marker came from EXECUTED code, not the
      // runner's never-dispatch sweep — keep the real verdict.
      if (!hasAdmissionEvidence(row.jobId)) {
        return { ...row, result: { status: 'budget-exhausted' } };
      }
    }
    if (
      row.result.status === 'failed' &&
      row.result.error.startsWith(BLOCKED_MARKER) &&
      budgetCaused(row.jobId)
    ) {
      return { ...row, result: { status: 'budget-exhausted' } };
    }
    return row;
  });
  // Counts: start from the runner's OWN counts and move only the re-marked
  // rows (untouched rows are the same object — identity comparison). A full
  // recompute from result statuses migrates genuinely-blocked rows (result
  // `failed`, error `blocked: …`) into counts.failed even though the budget
  // never touched them; a re-marked row was counted by the runner as
  // `queued` (queued marker) or `blocked` (blocked marker) — move exactly
  // those.
  const counts: RunCounts = { ...report.counts };
  let reMarked = false;
  report.jobs.forEach((original, index) => {
    const row = jobs[index];
    if (row === original) {
      return; // untouched — the runner's count stands
    }
    reMarked = true;
    const priorState: JobState = original.result.status === 'indeterminate' ? 'queued' : 'blocked';
    counts[priorState] -= 1;
    counts['budget-exhausted'] += 1;
  });
  // Honesty rule 2 — the stop must have actually GATED undispatched work:
  // every row kept its real verdict (a refusal row is itself terminal
  // evidence), so there is no early stop to claim (I9).
  if (!reMarked) {
    return report;
  }
  return {
    ...report,
    stoppedEarly: true,
    earlyStopReason: 'budget',
    counts,
    jobs,
  };
}
