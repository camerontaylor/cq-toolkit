import type { FixTask } from '../sweep/tasks.js';
import type { FailedAttemptGate, FixTaskReport, TaskAttempt } from '../sweep/taskLoop.js';

/**
 * A fix-run task outcome: the sweep task loop's own three outcomes plus the
 * three refinements the run composition derives for tasks the loop could not
 * conclude honestly (the loop reports them `escalated-to-human`; the
 * refinement separates never-dispatched work from terminal human review
 * without touching the loop's report):
 *   - `not-started` — the task was planned but never dispatched (its unit
 *     stopped for human review or failed before reaching it, or the unit
 *     itself never ran; the reason carries the cause).
 *   - `cancelled` — the enclosing job was cancelled before or while the task
 *     ran; no verdict exists.
 *   - `exhausted` — the run's shared token or wall budget stopped the task
 *     before any attempt was dispatched (the reason says so).
 * `fixed`/`unfixed`/`escalated-to-human` keep the task loop's meaning.
 */
export type FixTaskOutcome =
  | 'fixed'
  | 'unfixed'
  | 'escalated-to-human'
  | 'not-started'
  | 'cancelled'
  | 'exhausted';

/**
 * One failed-attempt or outstanding-work row per task: the retained
 * failed-attempt evidence when an attempt produced any, else the honest
 * no-artifact row (branchless) for work the run never got evidence for. A
 * task that was eventually fixed keeps its failed-attempt rows as history;
 * the task row's `fixed` outcome separates them from work still outstanding.
 */
export interface FixTaskFailure {
  /** The unit that planned the task: `<kind>/<slug>`, as in the failed refs. */
  unit: string;
  task: string;
  outcome: FixTaskOutcome;
  gate: FailedAttemptGate;
  reason: string;
  /** The retained failed-attempt branch; absent when no attempt left evidence. */
  branch?: string;
  /** The retained failed-attempt commit; absent when no attempt left evidence. */
  sha?: string;
}

/**
 * One accounting row per planned unit of work: every task the run's units
 * planned (attempted or not), plus one row per planned unit that never ran
 * (its task list is unknown until its baseline probe, so a fabricated
 * per-task split would invent evidence; the row names the unit and the
 * stop reason instead). Evidence detail stays on `report.tasks`; a row is
 * the bounded accounting view.
 */
export interface PlannedTaskRow {
  /** The unit that planned the work: `<kind>/<slug>`, as in the failed refs. */
  unit: string;
  /** The planner's task identity; for a never-run unit, the package name. */
  task: Pick<FixTask, 'id' | 'files'>;
  outcome: FixTaskOutcome;
  attempts: TaskAttempt[];
  rounds?: FixTaskReport['rounds'];
  reason?: string;
  /** The unit branch, when the run derived one. */
  branch?: string;
  commits: string[];
  /** Retained failed-attempt evidence; branchless rows are work without artifact. */
  failures: FixTaskFailure[];
  /** The failed-attempt branch this run published, when it did. */
  publishedBranch?: string;
}

/**
 * Explicit fix-run denominators. `planned` counts every accounting row
 * (planned tasks plus never-run units); `attempted` counts rows the run
 * dispatched at least one worker or rescue invocation for; `fixed` counts
 * rows with a verified commit; `skipped` counts rows resolved without an
 * attempt by an earlier verified sibling; `unresolved = planned - fixed`
 * counts every row still needing work. Rescue counting is separate, never a
 * ratio: `rescueAttempts` counts rescue-tier rounds recorded by tasks with
 * round evidence, `rescueFixes` counts fixed rows whose attempts include a
 * rescue tier. No cross-run state participates.
 */
export interface FixRunCounters {
  planned: number;
  attempted: number;
  fixed: number;
  skipped: number;
  unresolved: number;
  rescueAttempts: number;
  rescueFixes: number;
}

/** The unit label of a sweep branch: `<kind>/<slug>` of `<prefix>/<kind>/<slug>`. */
export function unitLabelOf(branch: string): string {
  const kind = branch.split('/').at(-2);
  const slug = branch.split('/').at(-1);
  return kind && slug ? `${kind}/${slug}` : branch;
}

/**
 * A task's failed-attempt and outstanding-work rows. Retained round evidence
 * is preserved verbatim (one row per failed round); a task fixed later keeps
 * those rows as history. A task outcome of `fixed` with failures is a past
 * failure eventually fixed; any other outcome is work still outstanding.
 */
export function failureRowsOf(task: FixTaskReport, unit: string): FixTaskFailure[] {
  const id = task.task.id;
  const rounds = task.rounds ?? [];
  if (rounds.some((round) => round.failedAttempt !== undefined))
    return rounds
      .filter((round) => round.failedAttempt !== undefined)
      .map((round) => ({
        unit,
        task: id,
        outcome: round.outcome ?? (task.outcome === 'fixed' ? 'unfixed' : task.outcome),
        gate: round.gate ?? 'none',
        reason: round.reason,
        branch: round.failedAttempt!.branch,
        sha: round.failedAttempt!.sha,
      }));
  if (task.failedAttempt !== undefined)
    return [
      {
        unit,
        task: id,
        outcome: task.outcome === 'fixed' ? 'unfixed' : task.outcome,
        gate: 'none',
        reason: task.reason ?? 'failed attempt',
        branch: task.failedAttempt.branch,
        sha: task.failedAttempt.sha,
      },
    ];
  if (task.outcome === 'fixed') return [];
  return [
    {
      unit,
      task: id,
      outcome: task.outcome,
      gate: 'none',
      reason: task.reason ?? 'unit did not reach this task',
    },
  ];
}

/**
 * The accounting row of one task report, with the outcome refinement of
 * {@link FixTaskOutcome}: a `not-started`/`cancelled`/`exhausted` label for
 * never-dispatched or cancelled work, keeping `escalated-to-human` for
 * terminal human review and leaving attempted, concluded tasks untouched.
 */
export function plannedTaskRowOf(task: FixTaskReport): PlannedTaskRow {
  const unit = unitLabelOf(task.branch);
  let outcome: FixTaskOutcome = task.outcome;
  if (task.outcome === 'escalated-to-human') {
    const reason = task.reason ?? '';
    const cancelled = reason.includes('cancelled');
    if (cancelled) outcome = 'cancelled';
    else if (task.attempts.length === 0)
      outcome = reason.includes('budget') ? 'exhausted' : 'not-started';
  }
  return {
    unit,
    task: { id: task.task.id, files: task.task.files },
    outcome,
    attempts: task.attempts,
    ...(task.rounds === undefined ? {} : { rounds: task.rounds }),
    ...(task.reason === undefined ? {} : { reason: task.reason }),
    branch: task.branch,
    commits: task.commits,
    failures: failureRowsOf(task, unit),
    ...(task.failedAttemptPublished && task.failedAttempt !== undefined
      ? { publishedBranch: task.failedAttempt.branch }
      : {}),
  };
}

/**
 * The accounting row of a planned unit that never ran: its task list was
 * never derived (the baseline probe never completed), so the row names the
 * unit, its planned branch and the stop reason, and carries no fabricated
 * tasks. The row counts as planned and unresolved.
 */
export function neverStartedRow(
  segments: { kind: string; slug: string; branch: string },
  task: string,
  reason: string,
): PlannedTaskRow {
  return {
    unit: `${segments.kind}/${segments.slug}`,
    task: { id: task, files: [] },
    outcome: 'not-started',
    attempts: [],
    reason,
    branch: segments.branch,
    commits: [],
    failures: [
      {
        unit: `${segments.kind}/${segments.slug}`,
        task,
        outcome: 'not-started',
        gate: 'none',
        reason,
      },
    ],
  };
}

/** The explicit counters over the planned rows (see {@link FixRunCounters}). */
export function fixRunCounters(rows: readonly PlannedTaskRow[]): FixRunCounters {
  const attempted = rows.filter((row) => row.attempts.length > 0).length;
  const fixed = rows.filter((row) => row.outcome === 'fixed' && row.commits.length > 0).length;
  return {
    planned: rows.length,
    attempted,
    fixed,
    skipped: rows.filter((row) => row.outcome === 'fixed' && row.commits.length === 0).length,
    unresolved: rows.length - fixed,
    rescueAttempts: rows.flatMap((row) => row.rounds ?? []).filter((round) => round.tier === 'rescue')
      .length,
    rescueFixes: rows.filter(
      (row) => row.outcome === 'fixed' && row.attempts.some((attempt) => attempt.tier === 'rescue'),
    ).length,
  };
}
