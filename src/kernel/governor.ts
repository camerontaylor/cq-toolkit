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
//
// Testability contract (slice 2 depends on it): every timer goes through the
// injected `Clock` (no naked setTimeout anywhere in this module), every
// ladder rung emits a marker — what fired, in what order, with what delays,
// whether its primitive was delivered — into `BudgetGovernor.events`, and
// `runLadder` is a standalone unit so the ladder is exercisable without a
// registry.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Usage } from '../driver/types.js';
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

// PRE-SPIKE grace defaults — conservative placeholders (generous grace
// before each harder rung) chosen so nothing is killed hastily before the
// spike lands.
//
// DD-1 result: pending T1.6 — the spike-sized abortGraceMs value replaces
// these constants (and is expected to change them) in T1.6's own PR.
export const DEFAULT_ABORT_GRACE_MS = 2_000;
export const DEFAULT_KILL_GRACE_MS = 5_000;

/** Per-job ladder delays. */
export interface LadderSpec {
  /**
   * Rung-1 delay: the job's wall-clock budget in ms. Omit = no ladder — the
   * task runs unbounded (caps and observation still apply).
   */
  wallClockMs?: number;
  /** Rung 1 → rung 2 grace. Default: DEFAULT_ABORT_GRACE_MS (pre-spike). */
  abortGraceMs?: number;
  /** Rung 2 → rung 3 grace. Default: DEFAULT_KILL_GRACE_MS (pre-spike). */
  killGraceMs?: number;
}

/**
 * One observable rung. Tests assert the marker sequence: WHAT fired (rung),
 * in WHAT ORDER (markers append), with WHAT DELAYS (delayMs since the
 * previous rung / since start for rung 1), and whether the rung's
 * cancellation primitive was actually delivered.
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
 * rung even when only the signal exists.
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
    throw new Error(`governor: ladder wallClockMs must be a finite number > 0, got ${spec.wallClockMs}`);
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
        resolve({ outcome: 'completed', value: outcome.value, markers: [...markers], elapsedMs: elapsed() });
      } else if (outcome.outcome === 'killed') {
        resolve({ outcome: 'killed', markers: [...markers], elapsedMs: elapsed() });
      } else {
        resolve({ outcome: 'threw', error: outcome.error, markers: [...markers], elapsedMs: elapsed() });
      }
    };
    const fireRung = (rung: LadderRung, delayMs: number, deliver: () => boolean): void => {
      // A throwing port primitive must never escape a timer callback (that
      // would lose the marker, skip the later rungs, and never settle): the
      // rung is recorded with delivered:false plus an error note and the
      // ladder CONTINUES.
      let delivered: boolean;
      let error: string | undefined;
      try {
        delivered = deliver();
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
      opts?.onRung?.(marker);
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
            hardCancel();
            return true;
          });
          arm(killGraceMs, () => {
            fireRung('kill', killGraceMs, () => {
              const kill = port.kill;
              if (kill === undefined) return false;
              kill();
              return true;
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
  /** Rung-1 delay (Limits.perJobWallClockMs). Omit = no wall-clock ladder. */
  perJobWallClockMs?: number;
  /** Rung 1 → 2 grace. Default DEFAULT_ABORT_GRACE_MS (pre-spike; DD-1 result: pending T1.6). */
  abortGraceMs?: number;
  /** Rung 2 → 3 grace. Default DEFAULT_KILL_GRACE_MS (pre-spike; DD-1 result: pending T1.6). */
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
 * Limits.maxUsd). The in-flight ceiling rides on Limits alone — the runner's
 * pool already enforces opts.concurrency, and the governor enforces the
 * ceiling by queueing, so effective parallelism is exactly the frozen
 * min(concurrency, inFlightCeiling).
 */
export function governorConfig(
  opts: RunOptions,
  limits: Limits,
  extra?: Pick<GovernorConfig, 'abortGraceMs' | 'killGraceMs' | 'jobKey'>,
): GovernorConfig {
  const usdCaps = [opts.maxUsd, limits.maxUsd].filter((v): v is number => v !== undefined);
  return {
    ...(usdCaps.length > 0 ? { maxUsd: Math.min(...usdCaps) } : {}),
    ...(limits.perJobWallClockMs !== undefined ? { perJobWallClockMs: limits.perJobWallClockMs } : {}),
    ...(limits.maxAttemptsPerJob !== undefined ? { maxAttemptsPerJob: limits.maxAttemptsPerJob } : {}),
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
    ...((a.reasoning !== undefined || b.reasoning !== undefined)
      ? { reasoning: (a.reasoning ?? 0) + (b.reasoning ?? 0) }
      : {}),
  };
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
      wallClockMs: this.config.perJobWallClockMs,
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

  /** Observe token usage for one governed invocation (rollup; never cost). */
  observeUsage(jobKey: string, usage: Usage): void {
    this.usageN = this.usageN === undefined ? { ...usage } : addUsage(this.usageN, usage);
    this.record({ kind: 'usage', jobKey, atMs: this.now() });
  }

  /**
   * Observe USD cost for one governed invocation and check the run cap. The
   * cap is inclusive: the trip fires when the rollup EXCEEDS maxUsd.
   */
  observeCost(jobKey: string, usd: number): void {
    this.usdSpentN += usd;
    this.record({ kind: 'usage', jobKey, usd, atMs: this.now() });
    const cap = this.config.maxUsd;
    if (cap !== undefined && this.usdSpentN > cap) {
      this.trip(`usd rollup ${this.usdSpentN} exceeded cap ${cap}`);
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
   * JobStartedJournalEvent.attempt field via rescue.attemptsFromJournal)
   * and the token-usage rollup. USD seeding needs prices the kernel does not
   * own — pass `usdOf` to derive cost from journaled usage (the T1.4
   * price-map layer will own that mapping).
   *
   * Keys are seeded TWICE so every jobKeyFor fallback resolves: per journal
   * jobId (aligns with the `input.jobId` convention) AND per op name
   * (aligns with the no-identity fallback, where a dispatch's key IS its op
   * name — it must inherit the attempts of every journal job that ran that
   * op). Usage is counted only for finishes that CLOSE an open start: an
   * orphan finish in a multi-run journal is a replay re-attestation of an
   * already-counted dispatch, and counting it again would double the rollup.
   */
  seedFromJournal(events: readonly JournalEvent[], opts?: { usdOf?: (usage: Usage) => number }): void {
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
    for (const jobId of jobIds) {
      const attempts = attemptsFromJournal(events, jobId);
      totalAttempts += attempts.length;
      const op = opByJob.get(jobId);
      for (const attempt of attempts) {
        if (attempt.attempt > this.attemptsFor(jobId)) {
          this.attemptsByJob.set(jobId, attempt.attempt);
        }
        if (op !== undefined && attempt.attempt > this.attemptsFor(op)) {
          this.attemptsByJob.set(op, attempt.attempt);
        }
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
      this.usageN = this.usageN === undefined ? { ...event.usage } : addUsage(this.usageN, event.usage);
      if (opts?.usdOf !== undefined) {
        this.usdSpentN += opts.usdOf(event.usage);
      }
    }
    // A seed that already overruns the cap trips the governor BEFORE the
    // resumed run admits anything: budget-exhausted rows from the prior run
    // re-mark without op invocation (the "not auto-retried by resume" rule,
    // README "Budget governor").
    const cap = this.config.maxUsd;
    if (cap !== undefined && this.usdSpentN > cap) {
      this.trip(`seeded usd rollup ${this.usdSpentN} exceeded cap ${cap}`);
    }
    this.record({ kind: 'seeded', jobs: jobIds.size, attempts: totalAttempts, atMs: this.now() });
  }

  /** Append to the observation stream (called by the governed registry). */
  record(event: GovernorEvent): void {
    this.events.push(event);
  }
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
 * Wrap one op with the governor: admission caps → in-flight slot → wall-clock
 * ladder (inside the job context, so ops reach the signal/port via
 * currentJobContext()) → honest verdict. Refusals and kills return
 * `{status:'budget-exhausted'}` — a budget bound was hit, the one frozen
 * taxonomy value whose purpose is exactly this; throws pass through so the
 * RUNNER's failure semantics stay in charge.
 */
function governOp(op: Op<never, never>, opName: string, governor: BudgetGovernor): Op<never, never> {
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
      const outcome = await runLadder(() => op(input), governor.ladderSpec, { op: opName, jobKey, attempt }, {
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
        onUsage: (usage) => governor.observeUsage(jobKey, usage),
        onCost: (usd) => governor.observeCost(jobKey, usd),
      });
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

// Mirrors runner.ts's private stateFromResult (not exported there) — keep in
// sync; README "Budget governor" carries the note.
function stateFromResult(result: OpResult<unknown>): JobState {
  switch (result.status) {
    case 'ok':
      return 'done';
    case 'failed':
      return 'failed';
    case 'budget-exhausted':
      return 'budget-exhausted';
    case 'needs-human':
      return 'blocked';
    case 'indeterminate':
      return 'failed';
  }
}

/** Mirrors runner.ts's private emptyCounts — keep in sync. */
function emptyCounts(): RunCounts {
  return { queued: 0, running: 0, blocked: 0, done: 0, failed: 0, 'budget-exhausted': 0 };
}

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
 * No-op unless the governor actually tripped. Executed rows are never
 * rewritten. Counts are recomputed over the marked rows (needs-human→blocked
 * and indeterminate→failed per the documented T1.2 freeze workaround). The
 * T1.4 runner integration folds this into runPlan; today the caller
 * composes: `withBudgetStop(await runPlan(...), plan, governor)`.
 */
export function withBudgetStop(report: RunReport, plan: Plan, governor: BudgetGovernor): RunReport {
  if (!governor.tripped) {
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
          caused = row.result.detail.startsWith(QUEUED_MARKER);
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
      return { ...row, result: { status: 'budget-exhausted' } };
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
  const counts = emptyCounts();
  for (const row of jobs) {
    counts[stateFromResult(row.result)] += 1;
  }
  return {
    ...report,
    stoppedEarly: true,
    earlyStopReason: 'budget',
    counts,
    jobs,
  };
}
