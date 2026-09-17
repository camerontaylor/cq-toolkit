// PR lane (goal D3; R2 D9) — the fleet run report: a merge-READINESS
// artifact over the injected {@link PrEffects} seam. Per package the op
// reads the check rollup and the review decision and folds them into a
// THREE-VALUED verdict — `ready` | `blocked` | `unknown` — where any
// unresolvable state (pending checks, an unreadable review decision, an
// effects fault) lands on `unknown` rather than being fabricated into a
// pass or a fail. The report NEVER merges anything: {@link PrEffects}
// admits no merge member by construction (the seam-type pin lives on the
// interface doc + the key-set test), and this op's only write is the
// optional in-place tracker body refresh when `tracker` is present.
//
// Invariants honored here:
//   - I9 — fleet runs collect all results: a per-package effects fault
//     lands on that row as `unknown` with the fault as the reason; the op
//     never fails because ONE package's evidence could not be read.
//   - A tracker update fault IS an op failure (a run report that claims
//     `trackerUpdated` while the tracker kept its stale body would be a
//     silently lying merge-readiness artifact).
//   - No throws across the op seam; counts include zeros; the report is
//     plain JSON.
import type { Op } from '../../kernel/types.js';
import type { PrChecks, PrEffects, PrReviewState } from './assemblePrs.js';

/** JSON-serializable input of the `pr.runReport` op. */
export interface RunReportInput {
  /** Repository the PRs live in (the subprocess effects bind `gh` to it). */
  repoRoot: string;
  /** The run's reserved branch prefix — labels the report, matching the assembled fleet. */
  runPrefix: string;
  /** When present, the report refreshes this tracker PR's body in place (editPrBody, never a new PR). */
  tracker?: { number: number };
  /** One entry per package PR: the package name and its PR number. */
  packages: Array<{ name: string; number: number }>;
}

/** The three-valued merge-readiness verdict (R2 D9): unknown is honest, never fabricated. */
export type PrReadiness = 'ready' | 'blocked' | 'unknown';

/** One per-package row of the run report. */
export interface RunReportRow {
  name: string;
  number: number;
  readiness: PrReadiness;
  /** The observed check-rollup state (`pass`/`fail`/`pending`/`none`), or `unknown` when it could not be read. */
  checks: string;
  /** The observed review state (`approved`/`changes-requested`/`none`/`unknown`), or `unknown` when it could not be read. */
  review: string;
  /** Why the row is `blocked`/`unknown` — a checks/review deadlock explanation or the effects fault. */
  reason?: string;
}

/**
 * The fleet run report: the merge-readiness artifact. Plain JSON; counts
 * include zeros; `trackerUpdated` is true only when a tracker body edit was
 * requested AND landed.
 */
export interface PrRunReport {
  runPrefix: string;
  rows: RunReportRow[];
  counts: Record<PrReadiness, number>;
  trackerUpdated: boolean;
}

/**
 * Control characters (Unicode Cc) — refused on the strings this op feeds
 * gh or writes into the tracker body (the boundary style of the family).
 */
const CONTROL_CHARS_RE = /[\p{Cc}]/u;

/**
 * Build the `pr.runReport` op over injected gh effects. Per package, in
 * input order, BOTH readiness effects are consulted (each in its own
 * try — a fault on one read must not blank the other's evidence): readiness
 * = checks pass AND review approved-or-none → `ready`; checks fail OR
 * review changes-requested → `blocked`; everything else (pending/none
 * checks, unknown review, effects faults) → `unknown` with the reason
 * spelled out. When `tracker` is present the rows are rendered into the
 * tracker manifest style and written in place via editPrBody — the report
 * never opens a PR and never merges.
 */
export function makeRunReport(gh: PrEffects): Op<RunReportInput, PrRunReport> {
  return async (input) => {
    const fault = inputFaultOf(input);
    if (fault !== null) return { status: 'failed', error: fault };

    const rows: RunReportRow[] = [];
    for (const pkg of input.packages) {
      // I9: both reads settle independently — a faulting read becomes the
      // row's reason while the other read's evidence still shows.
      const checks = await settled(() => gh.getPrChecks(pkg.number));
      const review = await settled(() => gh.getPrReviewState(pkg.number));
      if (checks.outcome === 'fault' || review.outcome === 'fault') {
        const reasons: string[] = [];
        if (checks.outcome === 'fault') reasons.push(`checks: ${checks.message}`);
        if (review.outcome === 'fault') reasons.push(`review: ${review.message}`);
        rows.push({
          name: pkg.name,
          number: pkg.number,
          readiness: 'unknown',
          checks: checks.outcome === 'settled' ? checks.value.state : 'unknown',
          review: review.outcome === 'settled' ? review.value.state : 'unknown',
          reason: reasons.join('; '),
        });
        continue;
      }
      const verdict = readinessOf(checks.value, review.value);
      rows.push({
        name: pkg.name,
        number: pkg.number,
        readiness: verdict.readiness,
        checks: checks.value.state,
        review: review.value.state,
        ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
      });
    }

    const counts: Record<PrReadiness, number> = { ready: 0, blocked: 0, unknown: 0 };
    for (const row of rows) counts[row.readiness] += 1;

    let trackerUpdated = false;
    if (input.tracker !== undefined) {
      try {
        await gh.editPrBody(input.tracker.number, reportBody(input.runPrefix, rows));
        trackerUpdated = true;
      } catch (err) {
        return {
          status: 'failed',
          error: `pr: could not update tracker PR #${String(input.tracker.number)} with the run report — ${messageOf(err)}`,
        };
      }
    }

    return {
      status: 'ok',
      value: { runPrefix: input.runPrefix, rows, counts, trackerUpdated },
    };
  };
}

// ---------------------------------------------------------------------------
// The three-valued fold — checks × review → readiness
// ---------------------------------------------------------------------------

/**
 * The readiness decision table (R2 D9). `blocked` wins over everything
 * (a failing check or an outstanding changes-requested is a hard no);
 * `ready` requires BOTH halves green (checks pass, review approved or
 * none — an unreviewed PR with green checks is not ready); every
 * unresolvable combination is `unknown` with the reason naming the half
 * that could not resolve. Never fabricated into pass/fail.
 */
function readinessOf(
  checks: PrChecks,
  review: PrReviewState,
): { readiness: PrReadiness; reason?: string } {
  if (checks.state === 'fail') {
    const failing = checks.failing === undefined ? '' : ` (${checks.failing.join(', ')})`;
    return { readiness: 'blocked', reason: `checks failing${failing}` };
  }
  if (review.state === 'changes-requested') {
    return { readiness: 'blocked', reason: 'changes requested on the review' };
  }
  if (checks.state === 'pass' && (review.state === 'approved' || review.state === 'none')) {
    return { readiness: 'ready' };
  }
  if (checks.state === 'pending') {
    return { readiness: 'unknown', reason: 'checks pending — no verdict yet' };
  }
  if (checks.state === 'none') {
    return { readiness: 'unknown', reason: 'no checks configured on the PR' };
  }
  return { readiness: 'unknown', reason: `review state unreadable (${review.state})` };
}

// ---------------------------------------------------------------------------
// The report body — the tracker manifest style, three-valued
// ---------------------------------------------------------------------------

/**
 * The run report rendered in the tracker manifest style: one bullet per
 * package with its PR number, the observed evidence, and the verdict;
 * blocked/unknown rows carry their reason. Plain markdown, updated in
 * place on the tracker PR.
 */
function reportBody(runPrefix: string, rows: readonly RunReportRow[]): string {
  const lines: string[] = [
    `<!-- cq-toolkit fleet-run report: runPrefix ${runPrefix} (generated; merge-readiness, never auto-merges) -->`,
    `# Fleet run \`${runPrefix}\` — merge readiness`,
    '',
    'Three-valued readiness per package: `ready` / `blocked` / `unknown`. This report is evidence only — nothing is merged by it.',
    '',
    '## Packages',
  ];
  if (rows.length === 0) {
    lines.push('- (no package PRs in this run)');
  }
  for (const row of rows) {
    const verdict = row.readiness.toUpperCase();
    const why = row.reason === undefined ? '' : ` — ${singleLine(row.reason)}`;
    lines.push(
      `- \`${row.name}\` — #${String(row.number)} — checks: ${row.checks}; review: ${row.review} — ${verdict}${why}`,
    );
  }
  return `${lines.join('\n')}\n`;
}

/** Flatten a reason to one safe markdown line (Cc runs become spaces). */
function singleLine(text: string): string {
  return text
    .split(/[\p{Cc}]/u)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// Boundary validation — `failed` naming the field, before any gh call
// ---------------------------------------------------------------------------

/** Library-level input contract; the registry schema mirrors the JSON shape. */
function inputFaultOf(input: RunReportInput): string | null {
  // TOP-LEVEL GUARD FIRST: a null/non-object input is a `failed` result
  // here, never a TypeError at the field reads.
  if (input === null || typeof input !== 'object') {
    return 'pr: input must be an object (repoRoot, runPrefix, tracker?, packages)';
  }
  for (const [field, value] of [
    ['repoRoot', input.repoRoot],
    ['runPrefix', input.runPrefix],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      return `pr: ${field} must be a non-empty string`;
    }
  }
  if (CONTROL_CHARS_RE.test(input.repoRoot)) {
    return 'pr: repoRoot must not contain control characters — the subprocess effects run gh with it as the working directory';
  }
  if (CONTROL_CHARS_RE.test(input.runPrefix)) {
    return 'pr: runPrefix must not contain control characters — it labels the report and the tracker body';
  }
  if (input.tracker !== undefined) {
    if (input.tracker === null || typeof input.tracker !== 'object') {
      return 'pr: tracker must be an object with a positive-integer number';
    }
    const trackerFault = prNumberFault(input.tracker.number, 'tracker.number');
    if (trackerFault !== null) return trackerFault;
  }
  if (!Array.isArray(input.packages)) {
    return 'pr: packages must be an array of { name, number }';
  }
  for (const [index, pkg] of input.packages.entries()) {
    if (pkg === null || typeof pkg !== 'object') {
      return `pr: packages[${String(index)}] must be an object with name and number`;
    }
    if (typeof pkg.name !== 'string' || pkg.name === '') {
      return `pr: packages[${String(index)}].name must be a non-empty string`;
    }
    const numberFault = prNumberFault(pkg.number, `packages[${String(index)}].number`);
    if (numberFault !== null) return numberFault;
  }
  return null;
}

/** PR numbers are positive integers (they start at 1); a fault names the field. */
function prNumberFault(value: unknown, field: string): string | null {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    return `pr: ${field} must be a positive integer (a PR number), got ${typeof value === 'number' ? String(value) : typeof value}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Settling — the effects fault boundary
// ---------------------------------------------------------------------------

/** A settled effect read: the value, or the fault message — never a throw. */
type Settled<T> = { outcome: 'settled'; value: T } | { outcome: 'fault'; message: string };

async function settled<T>(read: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { outcome: 'settled', value: await read() };
  } catch (err) {
    return { outcome: 'fault', message: messageOf(err) };
  }
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
