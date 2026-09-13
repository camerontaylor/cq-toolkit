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

/** Options for the plan runner (implemented in the next goal; frozen here). */
export interface RunOptions {
  /** Max jobs in flight — the ONE integer concurrency knob. */
  concurrency: number;
  /** When true, the runner stops dispatching new jobs after the first non-`ok` terminal outcome. */
  stopOnError: boolean;
  /** Directory for the NDJSON journal, when persistence is enabled. */
  journalDir?: string;
  /** Run-level USD cap (advisory here: USD is derived, callers govern). */
  maxUsd?: number;
  /** Resume an interrupted run from its journal instead of starting fresh. */
  resume?: boolean;
}

/** Reason a run stopped early. Frozen at `budget`: a budget bound was hit before all jobs reached a terminal state. */
export type RunEarlyStopReason = 'budget';

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
  counts: Record<JobState, number>;
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
 */
export interface Limits {
  maxUsd?: number;
  perJobWallClockMs?: number;
  maxAttemptsPerJob?: number;
  inFlightCeiling?: number;
  runDispatchQuota?: number;
}

/**
 * Journal: run started. Every journal event carries `runId` and an ISO-8601
 * `at` timestamp.
 */
export interface RunStartedJournalEvent {
  type: 'run-started';
  runId: string;
  /** ISO-8601 timestamp. */
  at: string;
  planId: string;
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
 * op and its input and reproduces the outcome on resume.
 */
export interface JobFinishedJournalEvent {
  type: 'job-finished';
  runId: string;
  at: string;
  jobId: string;
  opId: string;
  inputsHash: string;
  result: OpResult<unknown>;
}

/** Journal: run finished (all jobs terminal, or stopped early). */
export interface RunFinishedJournalEvent {
  type: 'run-finished';
  runId: string;
  at: string;
  stoppedEarly: boolean;
  earlyStopReason?: RunEarlyStopReason;
}

/** NDJSON journal event union, discriminated on `type`. All members plain serializable data. */
export type JournalEvent =
  | RunStartedJournalEvent
  | JobStartedJournalEvent
  | JobFinishedJournalEvent
  | RunFinishedJournalEvent;

/**
 * Registry entry for one op. Runtime-only: never persisted (the importer is
 * a function field). `inputSchema` validates the JSON-serializable op input
 * before dispatch.
 */
export interface OpRegistryEntry<I = unknown, R = unknown> {
  name: string;
  inputSchema: z.ZodType<I>;
  importer: () => Promise<Op<I, R>>;
}

/** Registry entry for one plan. Runtime-only: never persisted. */
export interface PlanRegistryEntry {
  name: string;
  importer: () => Promise<Plan>;
}
