// Composition-kernel frozen types — T1.1 types freeze.
//
// These hand-written types are the single source of truth;
// src/kernel/schema.ts mirrors them with zod schemas for serializability
// tests and journal parsing.
//
// Invariants honored here:
//   - Vendor-neutral: imports only the driver seam types plus zod's type
//     namespace. No vendor SDK types or vocabulary.
//   - Plain data: every persisted type is JSON-serializable with no
//     function-valued fields. The only function-bearing types are the op
//     contract (`Op`) and the registry entries, which are runtime-only and
//     never persisted.
//   - Exit codes {0,1,2,3} are NOT the op's business: the OpResult taxonomy
//     below is status-based, and the CLI layer owns any exit-code mapping
//     (resolves design debt DD-7: per-op failure semantics).
import type { z } from 'zod';
import type { Usage } from '../driver/types.js';

/**
 * The atomic-op contract: a typed, async function from a JSON-serializable
 * input to an {@link OpResult}. Every op is data-in/data-out; ops never see
 * drivers, processes, or exit codes directly.
 */
export type Op<I, R> = (input: I) => Promise<OpResult<R>>;

/**
 * Result taxonomy for a single op execution (frozen). Exactly five status
 * values; adding one is a breaking change to the freeze:
 *   - `ok`               — produced `value`.
 *   - `failed`           — the op ran and definitively failed; `error` says why.
 *   - `needs-human`      — the op stopped for a decision/input only a human
 *                          can supply, captured in `reason`.
 *   - `budget-exhausted` — the op did not run (or halted) because a budget
 *                          bound was hit.
 *   - `indeterminate`    — the op could not produce a verdict (crash,
 *                          timeout, lost worker); `detail` carries what is
 *                          known. Callers must assume neither success nor
 *                          failure.
 */
export type OpResult<R> =
  | { status: 'ok'; value: R }
  | { status: 'failed'; error: string }
  | { status: 'needs-human'; reason: string }
  | { status: 'budget-exhausted' }
  | { status: 'indeterminate'; detail: string };

/**
 * Lifecycle state of one job in a run. Frozen, exactly these six values:
 * `queued` (not yet dispatched), `running` (in flight), `blocked`
 * (waiting on unfinished `dependsOn` jobs), `done`, `failed`,
 * `budget-exhausted`.
 */
export type JobState = 'queued' | 'running' | 'blocked' | 'done' | 'failed' | 'budget-exhausted';

/** Job counts by state — all six states present, zeros included. */
export type RunCounts = Record<JobState, number>;

/** Point-in-time status of one job, derived at read time (e.g. statusOf(runId)). */
export interface JobStatus {
  jobId: string;
  state: JobState;
}

/**
 * One unit of plan work. `op` names an op in the registry; `input` is the
 * JSON-serializable op input; `dependsOn` lists job ids that must complete
 * first. Serializable, no functions.
 */
export interface Job {
  id: string;
  op: string;
  input: unknown;
  dependsOn?: string[];
}

/** A serializable plan: stable id plus its jobs (plans-as-data). */
export interface Plan {
  id: string;
  /** Optional human-facing label; never load-bearing. */
  label?: string;
  jobs: Job[];
}

/**
 * Options for the plan runner (implemented in the next goal; frozen here).
 *
 * Cap precedence: where a RunOptions cap and a Limits cap overlap, the
 * EFFECTIVE cap is the min of the two — effective USD cap =
 * min(RunOptions.maxUsd, Limits.maxUsd); effective in-flight parallelism =
 * min(RunOptions.concurrency, Limits.inFlightCeiling); effective per-job
 * attempt cap = min(Budget.maxAttempts on the invocation (the
 * RunOptions-equivalent), Limits.maxAttemptsPerJob). DD-9's token cap has no
 * Limits half: the effective token cap = RunOptions.maxTokens alone (the USD
 * cap keeps the frozen min() rule).
 */
export interface RunOptions {
  /** Max jobs in flight — the ONE integer concurrency knob. */
  concurrency: number;
  /** When true, the runner stops dispatching new jobs after the first non-`ok` terminal outcome. */
  stopOnError: boolean;
  /** Directory for the NDJSON journal, when persistence is enabled. */
  journalDir?: string;
  /** Run-level USD cap (advisory here: USD is derived, callers govern). */
  maxUsd?: number;
  /** Run-level token rollup cap (DD-9): enforced by the governor against the
   * folded WorkerResult usage rollup, independently of maxUsd — a cap that
   * binds even when no price is known for a model. Either cap tripping stops
   * the run (honest stop; I9). No Limits half in v1 (recorded in
   * docs/dd-9-api-equivalent-budget.md). */
  maxTokens?: number;
  /** Resume an interrupted run from its journal instead of starting fresh. */
  resume?: boolean;
}

/**
 * Reason a run stopped early. v1.1 (ADR-0003 §2.3) widens the frozen
 * `budget` with `signal` (a run-level cancel tripped the run; CLI SIGINT/
 * SIGTERM wiring is W2.5); `stalled` | `deferred` | `lock-lost` | `provider`
 * arrive with the reservation/profile/lock slices that own them.
 */
export type RunEarlyStopReason = 'budget' | 'signal';

/** Per-job outcome row in a run report. */
export interface JobOutcome {
  jobId: string;
  op: string;
  result: OpResult<unknown>;
  /** Token usage rolled up for this job, when its driver reported usage. */
  usage?: Usage;
  /** Derived-only USD cost for this job (caller-side price map); never driver-trusted. */
  costUSD?: number;
}

/** What a completed run returns. All serializable. */
export interface RunReport {
  runId: string;
  /** Honest-stop flag: true only when the run stopped before every job reached a terminal state. */
  stoppedEarly: boolean;
  /** Why the run stopped early; present only when `stoppedEarly` is true. */
  earlyStopReason?: RunEarlyStopReason;
  /** Job counts by state (all six states, zeros included). */
  counts: RunCounts;
  /** Per-job outcome rows, one per job in the plan. */
  jobs: JobOutcome[];
  /** Run-level token usage rollup, when available. */
  usage?: Usage;
  /** Run-level derived-only USD rollup. */
  costUSD?: number;
}

/**
 * Per-run caps mirror. Dual caps are intentional and both stay:
 * `inFlightCeiling` bounds concurrent executions, while
 * `runDispatchQuota` bounds total dispatches per run.
 *
 * Cap precedence: when both RunOptions.maxUsd and Limits.maxUsd are set, the
 * EFFECTIVE USD cap is min(RunOptions.maxUsd, Limits.maxUsd); effective
 * in-flight parallelism is min(RunOptions.concurrency,
 * Limits.inFlightCeiling); effective per-job attempt cap =
 * min(Budget.maxAttempts on the invocation (the RunOptions-equivalent),
 * Limits.maxAttemptsPerJob).
 */
export interface Limits {
  maxUsd?: number;
  perJobWallClockMs?: number;
  maxAttemptsPerJob?: number;
  inFlightCeiling?: number;
  runDispatchQuota?: number;
}

/**
 * The v1.1 per-call opt-ins (ADR-0003 §2.1/§2.5; each is journalled on
 * `run-started` when honoured). Per-call by explicit key only (P7): no env
 * or profile sets these. `budget.breakLock=<runId>` arrives with the plan
 * lock (W2.4 territory).
 */
export type GovernanceOptIn =
  | 'budget.legacyJournal=reset'
  | 'budget.raiseCap'
  | 'budget.ungovernedOverGoverned';

/**
 * `run-started.governance` — present iff the run is governed (ADR-0003
 * annex §2). Plain data; the provenance `config` field (RS-15/W3.6) is not
 * part of v1.1's W2 slices.
 */
export interface GovernanceRecord {
  /** The run's USD cap, when one is configured (the ledger's C for this run). */
  capUsd?: number;
  /** The run's token-rollup cap (DD-9), when configured. */
  capTokens?: number;
  /** Operator-declared attendance (P8 default false; declared, never verified). */
  attended: boolean;
  /**
   * Present when the operator passed the ADVISORY escape (W2.3, A12c): the
   * run may dispatch ADVISORY-classified work unattended. Recorded so the
   * journal shows WHY an unattended run was allowed to spend on lanes no
   * conformance leg has proven HARD.
   */
  allowAdvisory?: boolean;
  /**
   * WHO set `allowAdvisory` (W2.3 fix round): 'operator' for the CLI's
   * `--allow-advisory-budget`, 'product' for an unattended-by-design
   * product path (review-loop, self-merge-prs). Present only alongside
   * `allowAdvisory: true` — the journal distinguishes an operator's escape
   * from the product's own posture, so a future HARD row's C_max breach is
   * attributable (ADR-0003 §2.3 puts allowAdvisory admissions OUTSIDE the
   * bound).
   */
  allowAdvisoryProvenance?: 'operator' | 'product';
  /**
   * Present when a CAPLESS governed run inherited the previous governed
   * run's `capUsd` (W2.3): the ledger's C never silently disappears between
   * runs — the uncapped run reserves against the inherited cap and journals
   * the inheritance. The inherited value stays the predecessor cap for the
   * raise refusal (an inheritance does not move C).
   */
  inheritedCapUsd?: number;
  /** Present iff `budget.legacyJournal=reset` was honoured: which v1 runs the spend bound excludes. Sticky for the named files. */
  legacyJournal?: { mode: 'reset'; v1RunIds: string[] };
  /** Present iff `budget.raiseCap` was honoured: the raised-from → raised-to cap (USD) transition. */
  raiseCap?: { from: number; to: number };
}

/**
 * Journal: run started. Every journal event carries `runId` and an ISO-8601
 * `at` timestamp.
 *
 * v2 (ADR-0003 annex §2) adds OPTIONAL fields; `journalVersion` absent ⇒ a
 * v1 record. `seq` is claimed by exclusive create of
 * `<journalDir>/<planId>.seq.<n>` (unique across the plan's files by
 * construction) and orders the resume fold; `at` is display-only for v2
 * runs. `governance` is present iff the run is governed; `ungoverned` is
 * present iff `budget.ungovernedOverGoverned` was honoured (such runs write
 * no reservation events and sit outside the spend bound).
 */
export interface RunStartedJournalEvent {
  type: 'run-started';
  runId: string;
  /** ISO-8601 timestamp. */
  at: string;
  planId: string;
  /** Journal schema version; absent ⇒ v1. The only allowed v2 value is 2. */
  journalVersion?: 2;
  /** Fold-order ordinal (v2): 1 + max(prior seq) for this plan; unique per plan. */
  seq?: number;
  /** Governed-run record (ADR-0003 annex §2); present iff the run is governed. */
  governance?: GovernanceRecord;
  /** Present iff the run is an opted-in ungoverned run over governed history. */
  ungoverned?: { optIn: true };
}

/** Journal: one job dispatched. `attempt` starts at 1. */
export interface JobStartedJournalEvent {
  type: 'job-started';
  runId: string;
  at: string;
  jobId: string;
  op: string;
  attempt: number;
}

/**
 * Journal: one job reached a terminal outcome. Carries the frozen replay
 * record verbatim — `opId` + `inputsHash` + `result` — which identifies the
 * op and its input and reproduces the outcome on resume. The optional
 * `usage`/`costUSD` rollups let a resumed run keep per-job spend accounting
 * (v1.1: a governed runner writes them — journal v2, ADR-0003 annex §2).
 * `charged` (W2.3, reservation-era runs) is the job's reservation-side
 * charge — Σ `reservation-settled.charged` over the job's dispatches this
 * run — the ledger truth that includes a full reservation charge behind an
 * abort, which the modeled `costUSD` rollup cannot see.
 */
export interface JobFinishedJournalEvent {
  type: 'job-finished';
  runId: string;
  at: string;
  jobId: string;
  opId: string;
  inputsHash: string;
  result: OpResult<unknown>;
  /** Per-job token usage rollup, when the driver reported it (USD stays derived-only downstream). */
  usage?: Usage;
  /** Per-job modeled USD rollup (costBasis 'modeled'), when cost was observed. */
  costUSD?: number;
  /** Per-job reservation charge (Σ settled charged), written by reservation-era governed runs (W2.3). */
  charged?: number;
}

/** Which budget class a reserved dispatch was admitted under (ADR-0003 §2.4). */
export type ReservationClass = 'hard' | 'advisory';

/** Why the invocation gate refused to open a reservation (ADR-0003 §2.2 step 2). */
export type ReservationRefusalReason = 'advisory-lane';

/**
 * Journal (v2, W2.3): a reservation was OPENED write-ahead, before the
 * dispatch. Durably appended (fdatasync) BEFORE the op runs — an unresolved
 * `reservation-opened` (its settle lost to a hard crash) is exactly the
 * spend-behind-a-crashed-dispatch fact W2.2 could not see: the resume fold
 * charges it IN FULL and quarantines the job (A12b). `usd` is the reserved
 * amount r; `proposedUsd` rides only when the reservation was shrunk to the
 * remaining capacity (r < the fair-share proposal).
 */
export interface ReservationOpenedJournalEvent {
  type: 'reservation-opened';
  runId: string;
  at: string;
  jobId: string;
  op: string;
  attempt: number;
  /** `${runId}:${jobId}:${attempt}:${seq}` — unique across the plan's history. */
  reservationId: string;
  /** The reserved USD amount r (the ledger holds this until settle). */
  usd: number;
  /** The budget class the dispatch was admitted under (v1.1: always 'advisory'). */
  class: ReservationClass;
  /** The fair-share proposal p, when r was shrunk below it (capacity). */
  proposedUsd?: number;
}

/**
 * How a settled reservation's charge was determined (kernel charge rule,
 * W2.3). The driver-stream basis (billed-then-failed attempt frames, ADR
 * N2) arrives with W2.1's settlement evidence and will extend this union.
 */
export type ReservationChargeBasis = 'observed' | 'full';

/**
 * Journal (v2, W2.3): a reservation settled — durably appended BEFORE the
 * job's outcome is journalled. `charged` is the ledger truth for the
 * dispatch: the invocation's observed modeled spend, or the FULL reservation
 * `usd` when the dispatch ended in unknown status (killed, or an
 * `indeterminate` verdict — spend may have happened that no evidence fold
 * can see). `charged > usd` is a breach (the reservation undersold the
 * work) and trips the run. The structured driver-seam channel
 * (`errorClass`/`providerSignals`/`failedAttemptsObserved`, ADR-0003 §2.2
 * step 9) arrives with the driver slices (W2.1/W3.3) — this kernel slice
 * journals the usage rollup only.
 */
export interface ReservationSettledJournalEvent {
  type: 'reservation-settled';
  runId: string;
  at: string;
  jobId: string;
  reservationId: string;
  /** The amount actually charged to the ledger (≤ usd except on a breach). */
  charged: number;
  /** How `charged` was determined. */
  basis: ReservationChargeBasis;
  /**
   * PRICE PRESENCE (H2/DD-9): true when the dispatch's channel observed a
   * `costUSD` — a legitimate ZERO included (a zero-priced/subscription
   * lane). The resume fold needs this to tell "priced at zero" from
   * "unpriced": the `charged` sum alone would reclassify the former as the
   * latter and hard-stop every resume over it. Absent (an older in-flight
   * journal) folds as unpriced — fail loud, never fail open.
   */
  priced?: boolean;
  /** The invocation's observed usage rollup, when any evidence folded. */
  usage?: Usage;
}

/**
 * Journal (v2, W2.3): the invocation gate refused to open a reservation —
 * nothing was dispatched. W2.3's reason is `advisory-lane` (A12c: an
 * ADVISORY-classified dispatch refused unattended without the
 * `allowAdvisory` escape). The refusal is terminal budget evidence ON THE
 * JOB (its row is budget-exhausted); dependents re-mark transitively.
 */
export interface ReservationRefusedJournalEvent {
  type: 'reservation-refused';
  runId: string;
  at: string;
  jobId: string;
  op: string;
  reason: ReservationRefusalReason;
}

/**
 * Journal (v2, W2.3): a job is QUARANTINED over an unresolved reservation —
 * charged in full at the resume fold (A12b), never dispatched, reported
 * `needs-human`, re-attested every subsequent run until an explicit per-call
 * `releaseQuarantine` (which never refunds the charge). Written by the run
 * that observes and enforces the quarantine.
 */
export interface JobQuarantinedJournalEvent {
  type: 'job-quarantined';
  runId: string;
  at: string;
  jobId: string;
  /** The unresolved reservation behind the quarantine. */
  reservationId: string;
  /** The full charge the fold took for it (never refunded). */
  chargedUsd: number;
  reason: 'unresolved-reservation';
}

/**
 * Journal (v2, W2.3): an explicit per-call `releaseQuarantine` released a
 * job. Provenance is always 'call' (P7 — no env or profile releases). The
 * reservation charge STAYS: a release re-enables dispatch, it does not
 * un-spend.
 */
export interface QuarantineReleasedJournalEvent {
  type: 'quarantine-released';
  runId: string;
  at: string;
  jobId: string;
  provenance: 'call';
}

/** Journal: run finished (all jobs terminal, or stopped early). */
export interface RunFinishedJournalEvent {
  type: 'run-finished';
  runId: string;
  at: string;
  stoppedEarly: boolean;
  earlyStopReason?: RunEarlyStopReason;
  /**
   * The run file's total event count, INCLUDING this line and the
   * run-started — written by the runner so the resume fold can detect a
   * line DELETED from a surviving run file (the corruption the paired-line
   * checks cannot see: deleting a `reservation-opened` of a crashed
   * dispatch would silently drop its full charge and quarantine). Absent on
   * v1 runs and when no journal dir was configured; a torn tail loses
   * `run-finished` itself, so the check is skipped exactly where the crash
   * windows live.
   */
  eventCount?: number;
}

/**
 * Journal (v2, W2.3): the run's budget tripped (ADR-0003 §2.8). Emitted once
 * per run, just before `run-finished`, with the trip kind and the governor's
 * reason — the durable evidence for the honest stop the report claims.
 * `signal` trips are recorded too: the event carries the truth; the
 * honest-stop CLAIM (budget vs signal) is the run-finished taxonomy's job.
 */
export interface BudgetTrippedJournalEvent {
  type: 'budget-tripped';
  runId: string;
  at: string;
  tripKind: 'exhausted' | 'token-cap' | 'breach' | 'signal';
  reason: string;
}

/** NDJSON journal event union, discriminated on `type`. All members plain serializable data. */
export type JournalEvent =
  | RunStartedJournalEvent
  | JobStartedJournalEvent
  | JobFinishedJournalEvent
  | RunFinishedJournalEvent
  | ReservationOpenedJournalEvent
  | ReservationSettledJournalEvent
  | ReservationRefusedJournalEvent
  | JobQuarantinedJournalEvent
  | QuarantineReleasedJournalEvent
  | BudgetTrippedJournalEvent;

/**
 * Registry entry for one op. Runtime-only: never persisted (the importer is
 * a function field). `inputSchema` validates the JSON-serializable op input
 * before dispatch.
 */
export interface OpRegistryEntry<I = unknown, R = unknown> {
  name: string;
  inputSchema: z.ZodType<I>;
  /**
   * Resolve the op module and bind its dependencies. MAY take the
   * dispatch-time WIRING the dispatching host binds (PR #238 review P2):
   * an importer that constructs a driver factory threads
   * `onDeprecatedAlias` into `DriverFactoryConfig` so the host's narration
   * contract holds — the CLI passes a SILENT sink in `--json` machine mode
   * (stderr stays EMPTY, like every suppressed narration line) and none in
   * human mode, where the library default already writes the same `cq:`
   * stderr line. OPTIONAL: every other caller ignores it (the kernel runner
   * passes none — plan data never carries a narration contract; the CLI
   * wraps the registry-view entries it hands the runner, src/cli/run-plan.ts),
   * and an importer is free to bind its library defaults unchanged.
   */
  importer: (wiring?: {
    /** Sink for the driver factory's deprecated-alias notice (review-debt #186). */
    onDeprecatedAlias?: (message: string) => void;
  }) => Promise<Op<I, R>>;
}

/** Registry entry for one plan. Runtime-only: never persisted. */
export interface PlanRegistryEntry {
  name: string;
  importer: () => Promise<Plan>;
}
