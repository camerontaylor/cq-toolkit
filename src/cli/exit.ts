// CLI exit-code machinery — I1 slice B. This is where design debt DD-7
// (per-op failure semantics) resolves: the frozen OpResult taxonomy is
// status-based and never carries exit codes; the CLI layer owns the mapping.
//
// The four codes {0, 1, 2, 3}:
//   0 — ok (or a run whose every job row reached `ok`).
//   1 — definitive failure: a `failed`/`indeterminate` result or row, or an
//       uncaught exception ("thrown").
//   2 — usage: arg-shaped errors the CLI ITSELF detects (unknown subcommand,
//       bad flag syntax, duplicate flag, positional tokens, schema-invalid
//       input). 2 is NEVER derived from a taxonomy value — no function here
//       returns it.
//   3 — needs-human / budget: the run stopped for a human decision, or a
//       budget bound was hit (including transitively, via withBudgetStop's
//       re-marked rows or the honest-stop annotation).
//
// A thrown uncaught exception mapping to 1 is decided by the CALLER
// (main.ts's catches), not by these functions — they only map the frozen
// result/report taxonomy mechanically.
import type { OpResult, RunReport } from '../kernel/types.js';

/** The exit-code table. `usage` (2) is reserved for CLI-detected arg errors; see the header. */
export const EXIT_CODES = { ok: 0, thrown: 1, usage: 2, needsHuman: 3 } as const;

/**
 * Map one op result's frozen status to the process exit code:
 * 'ok' → 0; 'failed' | 'indeterminate' → 1; 'needs-human' |
 * 'budget-exhausted' → 3. Mechanical — no interpretation.
 */
export function exitCodeForOpResult(r: OpResult<unknown>): 0 | 1 | 3 {
  switch (r.status) {
    case 'ok':
      return EXIT_CODES.ok;
    case 'failed':
    case 'indeterminate':
      return EXIT_CODES.thrown;
    case 'needs-human':
    case 'budget-exhausted':
      return EXIT_CODES.needsHuman;
  }
}

/**
 * Map a run report to the process exit code, mechanically over its rows:
 * if any job row's result status is 'needs-human' or 'budget-exhausted',
 * OR (r.stoppedEarly && r.earlyStopReason === 'budget') → 3; else if any row
 * is 'failed' or 'indeterminate' → 1; else 0.
 *
 * The row scan is the PRIMARY evidence: rows come from runPlan +
 * withBudgetStop, and withBudgetStop re-marks transitively budget-caused
 * rows as budget-exhausted, so a budget stop shows up in the rows
 * themselves. The earlyStopReason check is the belt: a stop annotated
 * honest-stop can only be a budget stop (the frozen RunEarlyStopReason's
 * only value), and 3 dominates 1 so a budget stop is never misreported as a
 * mere failure even if some row kept a real failed verdict.
 */
export function exitCodeForRunReport(r: RunReport): 0 | 1 | 3 {
  const needsHumanRow = r.jobs.some(
    (row) => row.result.status === 'needs-human' || row.result.status === 'budget-exhausted',
  );
  if (needsHumanRow || (r.stoppedEarly && r.earlyStopReason === 'budget')) {
    return EXIT_CODES.needsHuman;
  }
  const failedRow = r.jobs.some(
    (row) => row.result.status === 'failed' || row.result.status === 'indeterminate',
  );
  return failedRow ? EXIT_CODES.thrown : EXIT_CODES.ok;
}
