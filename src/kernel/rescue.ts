// Rescue lane — T1.3 slice 1 (ws-a item 5): the policy TABLE and the pure
// decision engine that consumes it.
//
// I8 placement: rescue/escalation policy lives HERE, in the kernel, as
// serializable DATA — never in the driver, and never as code constants. The
// engine decides WHETHER a job may be re-dispatched and WHAT the re-dispatch
// carries (a stronger model/driver as plain data, a session resume token);
// EXECUTION belongs to the caller — a resumed runPlan whose dispatches honor
// the decision (see the governor README section). The kernel never
// constructs driver objects itself: escalation rows carry
// `{model, provider, driver}` handles that a driver-owning layer maps onto
// real drivers.
//
// Conservative termination: rescue is strictly opt-in. Every case the table
// and caps do not explicitly license terminates with a recorded reason, and
// the skip-retry guards (`baseline-failed`, `human-intervened`) override
// every row — when a guard trips, rescue NEVER retries. The all-empty table
// (`CONSERVATIVE_RESCUE_POLICY`) rescues nothing.
//
// Decision INPUT is plain data assembled from two evidence sources:
//   - journal facts: `attemptsFromJournal` folds a run journal's events for
//     one job into per-dispatch attempt records, using the frozen
//     JobStartedJournalEvent.attempt field (see that function);
//   - driver-seam observations: a session resume token observed as
//     WorkerResult.sessionId rides on an attempt as `sessionRef` and is
//     carried forward into the decision so the re-dispatch can resume the
//     session via OpInvocation.sessionRef (the frozen-seam mechanism).
//
// This module is pure: no I/O, no clocks, no timers — entirely testable with
// plain data.
import type { JournalEvent, OpResult } from './types.js';

/**
 * Outcome of one rescue attempt. The five frozen OpResult statuses plus
 * `killed` — a governor ladder termination. From journal evidence alone a
 * kill is indistinguishable from any other budget-exhausted result (the
 * frozen journal cannot express it); callers holding the governor's event
 * stream refine budget-exhausted to `killed` when they know better.
 */
export type RescueOutcome =
  | 'ok'
  | 'failed'
  | 'needs-human'
  | 'budget-exhausted'
  | 'indeterminate'
  | 'killed';

/**
 * Model/driver escalation as PLAIN DATA — a stronger model/provider and/or a
 * stronger driver handle for the re-dispatch. Never a constructed driver
 * object (the kernel has no driver factory and must never grow one).
 */
export interface RescueEscalation {
  model?: string;
  provider?: string;
  driver?: string;
}

/** What a matched policy row instructs. */
export type RescueAction =
  | {
      kind: 'retry';
      /**
       * MAX TOTAL attempts for the job under this row (not retries): 1 means
       * the initial dispatch only — never re-dispatch. The EFFECTIVE cap is
       * min(row.maxAttempts, Limits.maxAttemptsPerJob) per the frozen
       * cap-precedence rule.
       */
      maxAttempts: number;
      /** Swap to a stronger model/driver for this and later attempts. */
      escalate?: RescueEscalation;
      /**
       * Carry the latest attempt's session resume token forward
       * (RescueAttempt.sessionRef → the re-dispatch's decision.sessionRef).
       */
      carrySessionRef?: boolean;
    }
  | { kind: 'skip' };

/** One row of the policy table. First matching row wins. */
export interface RescuePolicyRow {
  /** Stable row id — audit/journal references name the row that decided. */
  id: string;
  /** The latest attempt's outcome this row applies to; `'any'` matches all. */
  on: RescueOutcome | 'any';
  /** Op-name scope; absent = every op. */
  op?: string;
  action: RescueAction;
}

/**
 * THE POLICY TABLE — plain serializable data (JSON round-trips losslessly;
 * no functions). Rows are evaluated first-match-wins against the LATEST
 * attempt; anything unmatched terminates conservatively.
 */
export interface RescuePolicy {
  rows: RescuePolicyRow[];
}

/** The conservative default: no rows, nothing is ever rescued. */
export const CONSERVATIVE_RESCUE_POLICY: RescuePolicy = { rows: [] };

/**
 * Skip-retry guards. When one trips, rescue NEVER retries — conservative
 * termination — regardless of what any row says:
 *   - `baseline-failed` — the job's pre-rescue baseline attempt ended in a
 *     definitive failure (a real verdict, not a lost one); re-dispatch
 *     cannot help, so don't.
 *   - `human-intervened` — a human already owns this job's next move.
 * `needs-human` as the latest outcome auto-trips the human-intervened guard.
 */
export type RescueGuard = 'baseline-failed' | 'human-intervened';

/** One dispatch of the job, as evidence. Plain data; `attempt` is 1-based. */
export interface RescueAttempt {
  /**
   * The 1-based dispatch ordinal — the same semantics as the frozen
   * JobStartedJournalEvent.attempt field (which is where it is read from;
   * see attemptsFromJournal for the fold).
   */
  attempt: number;
  outcome: RescueOutcome;
  /** error/reason/detail text of the outcome, when it carries one (audit only). */
  detail?: string;
  /** Session resume token observed on the driver seam for this attempt. */
  sessionRef?: string;
  /** What ran (plain data, for escalation decisions and audit). */
  model?: string;
  provider?: string;
  driver?: string;
}

/** The decision input: one job's attempt history plus its guards. */
export interface RescueInput {
  jobId: string;
  op: string;
  /** Ordered attempt evidence (the engine keys on `attempt`, not order). */
  attempts: readonly RescueAttempt[];
  guards?: readonly RescueGuard[];
}

/** Why the engine terminated conservatively. */
export type RescueTerminationReason =
  | 'guard-baseline-failed'
  | 'guard-human-intervened'
  | 'already-ok'
  | 'no-attempts'
  | 'no-policy-row'
  | 'policy-skip'
  | 'attempt-cap';

/**
 * The engine's verdict — plain data either way:
 *   - `retry`: re-dispatch as `attempt` (the next 1-based ordinal), carrying
 *     the row's escalation and, when licensed, the session resume token.
 *     Execution is the caller's: a resumed runPlan whose dispatches honor
 *     the decision (so JobStartedJournalEvent.attempt rises honestly).
 *   - `terminate`: conservative termination with the reason; `rowId` names
 *     the deciding row when a row decided, `guard` names a tripped guard,
 *     `cap` names which attempt bound refused the retry.
 */
export type RescueDecision =
  | {
      kind: 'retry';
      attempt: number;
      rowId: string;
      escalate?: RescueEscalation;
      sessionRef?: string;
    }
  | {
      kind: 'terminate';
      reason: RescueTerminationReason;
      rowId?: string;
      guard?: RescueGuard;
      cap?: 'per-job-attempts' | 'row-max-attempts';
    };

/**
 * THE DECISION RULES, in order — first termination wins (conservative by
 * construction):
 *
 *   1. Guards first: any tripped guard in `input.guards` terminates with the
 *      guard named. No row overrides a guard — rescue NEVER retries a
 *      guarded job.
 *   2. No attempts → terminate (`no-attempts`).
 *   3. Latest attempt (highest `attempt`; last occurrence wins ties):
 *      `ok` → terminate (`already-ok` — nothing to rescue);
 *      `needs-human` → terminate (`guard-human-intervened`, auto-derived).
 *   4. First matching row (`on` matches the latest outcome or `'any'`; `op`
 *      matches or is absent). None → terminate (`no-policy-row`).
 *   5. `skip` row → terminate (`policy-skip`).
 *   6. `retry` row: bounded by the EFFECTIVE per-job attempt cap =
 *      min(row.action.maxAttempts, caps.maxAttemptsPerJob) — at cap,
 *      terminate (`attempt-cap`, naming which bound is the binder).
 *      Otherwise retry as `attemptsSoFar + 1` with the row's escalation and
 *      — only when the row says `carrySessionRef` and the latest attempt
 *      observed a session token — `sessionRef` carried forward.
 */
export function decideRescue(
  input: RescueInput,
  policy: RescuePolicy,
  caps?: { maxAttemptsPerJob?: number },
): RescueDecision {
  for (const guard of input.guards ?? []) {
    return {
      kind: 'terminate',
      reason: guard === 'baseline-failed' ? 'guard-baseline-failed' : 'guard-human-intervened',
      guard,
    };
  }
  if (input.attempts.length === 0) {
    return { kind: 'terminate', reason: 'no-attempts' };
  }
  const latest = input.attempts.reduce((a, b) => (b.attempt >= a.attempt ? b : a));
  if (latest.outcome === 'ok') {
    return { kind: 'terminate', reason: 'already-ok' };
  }
  if (latest.outcome === 'needs-human') {
    return { kind: 'terminate', reason: 'guard-human-intervened', guard: 'human-intervened' };
  }
  const row = policy.rows.find(
    (candidate) =>
      (candidate.on === latest.outcome || candidate.on === 'any') &&
      (candidate.op === undefined || candidate.op === input.op),
  );
  if (row === undefined) {
    return { kind: 'terminate', reason: 'no-policy-row' };
  }
  if (row.action.kind === 'skip') {
    return { kind: 'terminate', reason: 'policy-skip', rowId: row.id };
  }
  const attemptsSoFar = latest.attempt;
  const rowMax = row.action.maxAttempts;
  // Policy validation (fail loud, never fail open): a retry cap that is not
  // a positive integer — NaN, fractional, zero, negative — would corrupt
  // the effective-cap arithmetic below into either an unbounded or a
  // silent never-retry decision. Reject the row loudly instead.
  if (!Number.isInteger(rowMax) || rowMax < 1) {
    throw new Error(`rescue: policy row '${row.id}' maxAttempts must be an integer >= 1, got ${rowMax}`);
  }
  const jobCap = caps?.maxAttemptsPerJob;
  const effectiveCap = jobCap !== undefined ? Math.min(rowMax, jobCap) : rowMax;
  if (attemptsSoFar >= effectiveCap) {
    return {
      kind: 'terminate',
      reason: 'attempt-cap',
      rowId: row.id,
      cap: jobCap !== undefined && jobCap < rowMax ? 'per-job-attempts' : 'row-max-attempts',
    };
  }
  return {
    kind: 'retry',
    attempt: attemptsSoFar + 1,
    rowId: row.id,
    ...(row.action.escalate !== undefined
      ? { escalate: { ...row.action.escalate } }
      : {}),
    ...(row.action.carrySessionRef === true && latest.sessionRef !== undefined
      ? { sessionRef: latest.sessionRef }
      : {}),
  };
}

/** error/reason/detail text of an outcome, when it carries one (audit only). */
function detailOf(result: OpResult<unknown>): string | undefined {
  switch (result.status) {
    case 'failed':
      return result.error;
    case 'needs-human':
      return result.reason;
    case 'indeterminate':
      return result.detail;
    default:
      return undefined;
  }
}

/**
 * Evidence fold: one job's journal events → its attempt records.
 *
 *   - Each `job-started` for the job opens a dispatch. The record's ordinal
 *     is max(frozen event.attempt, dispatch occurrence count): today the
 *     runner writes `attempt: 1` on every run (retries are the governor
 *     integration's to journal), so the occurrence count carries the truth;
 *     once the runner raises real attempt numbers the frozen field dominates
 *     and the fold is unchanged. Forward-compatible by construction.
 *   - The matching `job-finished` closes the dispatch with the frozen
 *     result's status (and its error/reason/detail as `detail`).
 *   - A start with no finish — hard crash, torn tail — stays `killed`
 *     (started, no verdict): exactly the honest reading of the evidence, and
 *     the reason resume re-runs it.
 *   - An orphan `job-finished` (no open start) is a replay re-attestation of
 *     the last dispatch; it refreshes that attempt's outcome. With no
 *     history at all it is not attributable and is ignored.
 *
 * Note: from journal evidence alone, a governor ladder kill and any other
 * budget-exhausted result fold to the same frozen status; refine to `killed`
 * from the governor's event stream when available.
 */
export function attemptsFromJournal(
  events: readonly JournalEvent[],
  jobId: string,
): RescueAttempt[] {
  const attempts: RescueAttempt[] = [];
  let occurrence = 0;
  for (const event of events) {
    if (event.type === 'job-started' && event.jobId === jobId) {
      occurrence += 1;
      attempts.push({ attempt: Math.max(event.attempt, occurrence), outcome: 'killed' });
      continue;
    }
    if (event.type === 'job-finished' && event.jobId === jobId) {
      const last = attempts[attempts.length - 1];
      if (last !== undefined) {
        attempts[attempts.length - 1] = {
          ...last,
          outcome: event.result.status,
          ...(detailOf(event.result) !== undefined ? { detail: detailOf(event.result) } : {}),
        };
      }
    }
  }
  return attempts;
}

/** Assemble a RescueInput from a journal (evidence fold + identity + guards). */
export function rescueInputFromJournal(
  events: readonly JournalEvent[],
  jobId: string,
  op: string,
  guards?: readonly RescueGuard[],
): RescueInput {
  return {
    jobId,
    op,
    attempts: attemptsFromJournal(events, jobId),
    ...(guards !== undefined ? { guards: [...guards] } : {}),
  };
}
