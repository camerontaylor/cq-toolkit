// diagnoseMergeFailure — the execution report's post-mortem, for humans
// (goal F3, ws-f scope item 5; UC §3 row 45). PURE: a plain report in, a
// plain diagnosis out — no I/O, no effects, no clock; same report →
// deep-equal diagnosis, always. It reads ONLY the shape executeMerges
// returned and maps each not-merged bucket to ONE plain-language cause
// (stable snake_case, safe to log, group, and assert on — the family's
// reason discipline):
//   stale   → `state_drift`        the PR's head moved (or vanished) OR
//                                  the base was retargeted between plan
//                                  and run; nothing merged; re-plan to
//                                  recover.
//   failed  → `merge_rejected`     the merge (or its fetch) was
//                                  refused by the forge or the transport.
//   blocked → `blocked_by_ancestor` not this PR's fault — a stack ancestor
//                                  did not merge, so this rung was held.
//
// The diagnosis names EVERY needs-human PR (the union of the three
// not-merged buckets, pr-number sorted — a human works a sorted list, not
// a bucket order) and produces a ONE-LINE summary carrying every count, so
// a sweep log answers "what happened, and who do I owe?" without opening
// the report. A report of all merges diagnoses to: nothing to do.
import type { ExecutionReport } from './executeMerges.js';

/** The frozen cause vocabulary — one value per not-merged bucket. Changing
 * it is a recorded deviation, same as PlanBlockReason. */
export type MergeFailureCause = 'state_drift' | 'merge_rejected' | 'blocked_by_ancestor';

/** The post-mortem: the one-line summary, every needs-human pr (sorted,
 * deduped), and each not-merged pr with its cause (pr-number sorted). */
export interface MergeFailureDiagnosis {
  /** One line: merged/retargeted counts, the needs-human count, and the
   * per-cause breakdown — always all three counts, zero included, so the
   * line is shape-stable for log diffing. */
  summary: string;
  /** Every pr a human owes work on — the union of stale/failed/blocked,
   * deduped and pr-number sorted. */
  needsHuman: number[];
  /** Each not-merged pr with its cause, pr-number sorted. */
  causes: Array<{ pr: number; cause: MergeFailureCause }>;
}

/**
 * Diagnose an ExecutionReport (UC row 45). Pure — see the module doc for
 * the bucket→cause mapping and the summary shape.
 */
export function diagnoseMergeFailure(report: ExecutionReport): MergeFailureDiagnosis {
  const causes: Array<{ pr: number; cause: MergeFailureCause }> = [
    ...report.stale.map((entry) => ({ pr: entry.pr, cause: 'state_drift' as const })),
    ...report.failed.map((entry) => ({ pr: entry.pr, cause: 'merge_rejected' as const })),
    ...report.blocked.map((entry) => ({ pr: entry.pr, cause: 'blocked_by_ancestor' as const })),
  ].sort((a, b) => a.pr - b.pr);
  const needsHuman = [...new Set(causes.map((entry) => entry.pr))].sort((a, b) => a - b);
  const summary =
    `merge run: ${String(report.merged.length)} merged, ${String(report.retargeted.length)} retargeted, ` +
    `${String(needsHuman.length)} need a human ` +
    `(state_drift: ${String(report.stale.length)}, merge_rejected: ${String(report.failed.length)}, ` +
    `blocked_by_ancestor: ${String(report.blocked.length)})`;
  return { summary, needsHuman, causes };
}
