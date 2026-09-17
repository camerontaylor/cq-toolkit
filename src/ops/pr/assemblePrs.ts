// PR lane (ws-d item 4, goal D3; UC §1 row 22) — the TRACKER-FIRST PR
// assembler: one tracker PR per fleet run, opened BEFORE any per-package PR
// and updated IN PLACE forever after (never a second tracker), with the
// per-package PRs carrying branches under the run prefix. The DECISION core
// is effects-only: zero child_process here — every gh touch arrives through
// the injected {@link PrEffects} seam, and the production binding is
// {@link makeSubprocessPrEffects} (ghEffects.ts, the registry importer's).
//
// Invariants honored here:
//   - UC row 22, TRACKER-FIRST: the effects calls ORDER — the tracker PR is
//     searched (by head branch) first, created as a draft when absent, and
//     only then are per-package PRs attempted. A tracker search/creation
//     fault fails the whole op with ZERO package PRs attempted (fail before
//     any package PR exists — a fleet must never outlive its tracker).
//   - NEVER A SECOND TRACKER: an existing tracker PR (same head branch) is
//     REUSED — its number is reported with `created: false` and its body is
//     refreshed in place via editPrBody; createPr is never called for the
//     tracker head when a PR already sits there.
//   - PER-ROW PACKAGE FAULTS: a per-package search/create fault lands on
//     that package's report row (`fault`) and never fails the others — the
//     fleet run collects all results (I9); only a TRACKER fault fails the
//     op.
//   - No throws across the op seam: every effects rejection is folded into
//     a `failed` result or a per-row fault; every input contract violation
//     is a `failed` result naming the field (the worktreeFor boundary
//     style).
import type { Op } from '../../kernel/types.js';

/**
 * The injected `gh` seam — the ONE place this family touches GitHub. All
 * effects are lazy per call (no caching of PR state between calls); tests
 * inject recording fakes, production binds {@link makeSubprocessPrEffects}.
 *
 * NO MERGE EFFECT BY CONSTRUCTION: the seam is the family's whole GitHub
 * vocabulary — search, create, edit-body, comment, and the readiness reads
 * (checks, review decision, draft status) — and it deliberately admits no
 * merge/rebase/close member. The fleet run report (runReport.ts) is a
 * merge-READINESS artifact; merging is the merge family's guarded business
 * (MergeEffects + safeArgs), never this seam's. The key-set pin in
 * test/ops/pr/runReport.test.ts fails the build the moment a merge-class
 * member is added.
 */
export interface PrEffects {
  /**
   * The PR whose head branch is `head` targeting `base` (any state), or
   * null when none exists. `base` is part of the identity: a PR from an
   * earlier run targeting a different base must never be adopted as this
   * fleet's member.
   */
  searchPrByHead(head: string, base: string): Promise<PrSearchResult | null>;
  /** Open a new PR; `draft` is the caller's explicit choice (the op's default is true). */
  createPr(request: PrCreateRequest): Promise<PrCreateResult>;
  /** Replace a PR's body — the tracker's update-in-place mechanism. */
  editPrBody(number: number, body: string): Promise<void>;
  /** Append a comment to a PR (reserved for tracker annotations). */
  comment(number: number, body: string): Promise<void>;
  /** The check-rollup verdict for one PR (three-valued sources; runReport). */
  getPrChecks(number: number): Promise<PrChecks>;
  /** The review-decision verdict for one PR (runReport). */
  getPrReviewState(number: number): Promise<PrReviewState>;
  /**
   * The PR's draft flag (runReport): a draft PR can carry green checks and
   * an approval, yet GitHub cannot merge it — the report must not call it
   * ready. A dedicated single-purpose read (kept apart from
   * getPrChecks/getPrReviewState so every seam member answers exactly one
   * question).
   */
  getPrMeta(number: number): Promise<PrMeta>;
}

/** A PR's lifecycle state, as the search reports it. */
export type PrState = 'open' | 'closed' | 'merged' | 'unknown';

/** The search's hit: number, URL when reported, lifecycle state. */
export interface PrSearchResult {
  number: number;
  url?: string;
  state: PrState;
}

/** Request of {@link PrEffects.createPr}: open one PR head onto base. */
export interface PrCreateRequest {
  head: string;
  base: string;
  title: string;
  body?: string;
  draft: boolean;
}

/** The result of a successful create: the new PR's number and, when the forge reported it, its URL. */
export interface PrCreateResult {
  number: number;
  url?: string;
}

/** The check half of the merge-readiness evidence, read off one PR. */
export interface PrChecks {
  /** `none` = no checks configured; `pending` = some check not concluded. */
  state: 'pass' | 'fail' | 'pending' | 'none';
  /** Names of the failed checks, when `state` is `fail`. */
  failing?: string[];
}

/**
 * The review half of the merge-readiness evidence, read off one PR.
 * `none` and `required` are OPPOSITES that a naive mapping collapses:
 *   - `none`    — the forge reports NO review policy on the PR (a null
 *                 decision): nobody is waiting on a review, so it counts
 *                 toward ready.
 *   - `required`— the forge reports a review IS required and none has been
 *                 given (gh's REVIEW_REQUIRED): calling that ready would
 *                 fabricate merge-readiness on every required-review repo.
 */
export interface PrReviewState {
  state: 'approved' | 'changes-requested' | 'none' | 'required' | 'unknown';
}

/** The draft half of the merge-readiness evidence: GitHub cannot merge a draft, whatever the checks say. */
export interface PrMeta {
  isDraft: boolean;
}

/** JSON-serializable input of the `pr.assemblePrs` op: one fleet run's PR plan. */
export interface AssemblePrsInput {
  /** Repository the PRs target (the subprocess effects bind `gh` to it). */
  repoRoot: string;
  /** The run's reserved branch prefix (e.g. `cq/09-16a`); every PR head — tracker included — must carry it. */
  runPrefix: string;
  /** The PRs' target branch (e.g. merge-queue). */
  base: string;
  /** The tracker PR's dedicated branch and title, both under the run prefix. */
  tracker: { title: string; branch: string };
  /** One entry per package; `branch` must start `<runPrefix>/`. */
  packages: Array<{ name: string; branch: string; title: string; body?: string }>;
  /** Open every PR as a draft; DEFAULT TRUE — a fleet run assembles quietly. */
  draft?: boolean;
}

/** The tracker row of {@link AssemblePrsReport}: number, provenance, URL. */
export interface AssemblePrsTrackerReport {
  number: number;
  /** true only when this op created the tracker; false = reused in place. */
  created: boolean;
  url?: string;
}

/** One per-package row of {@link AssemblePrsReport}; `fault` isolates the failure to this row. */
export interface AssemblePrsPackageReport {
  name: string;
  number?: number;
  created: boolean;
  url?: string;
  fault?: string;
}

/** The op's report: the tracker plus one row per package. Plain JSON. */
export interface AssemblePrsReport {
  tracker: AssemblePrsTrackerReport;
  packages: AssemblePrsPackageReport[];
}

/**
 * Control characters (Unicode Cc: C0, DEL, C1) — newline/carriage-return
 * above all: the strings this op feeds gh become PR titles, bodies, and
 * branch names, and a control character in any of them corrupts the
 * markdown framing of the tracker manifest (and gh's own argv hygiene).
 */
const CONTROL_CHARS_RE = /[\p{Cc}]/u;

/**
 * A safe branch segment: starts with a letter/digit, then letters, digits,
 * dots, dashes, underscores. No leading dash (a branch is a positional gh
 * argument, never a flag — the subprocess adapter passes args as an ARRAY,
 * and this keeps even a hostile config from trying), no separators beyond
 * the explicit '/' join.
 */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Refname hardening on top of SEGMENT_RE (the sweep family's rule, kept
 * verbatim): a '..' run walks refs and a '.lock' suffix collides with the
 * loose-ref lock file — every branch this op feeds gh is a git refname.
 */
function refnameUnsafeSegment(segment: string): boolean {
  return segment.includes('..') || segment.endsWith('.lock');
}

/**
 * Build the `pr.assemblePrs` op over injected gh effects. Per call, in
 * order: (a) TRACKER-FIRST — search by the tracker's head branch AND base;
 * reuse the hit's number only when it is OPEN (a non-open tracker is a
 * landed record — refused, never rewritten), else create the draft tracker
 * with a pending-fleet manifest body; any fault here is a whole-op `failed`
 * BEFORE any package PR is attempted (UC row 22). (b) PER-PACKAGE — the
 * same base-threaded search-then-create per package branch, in input order;
 * a fault lands on that row alone. (c)
 * UPDATE-IN-PLACE — editPrBody on the tracker with the refreshed fleet
 * manifest (per-package numbers, or the row faults); this is the ONLY way a
 * reused tracker is touched, so a run never duplicates its tracker. The
 * refreshed body is written for created trackers too — the create body
 * lists the fleet as pending, the edit records the actual numbers.
 */
export function makeAssemblePrs(gh: PrEffects): Op<AssemblePrsInput, AssemblePrsReport> {
  return async (input) => {
    const fault = inputFaultOf(input);
    if (fault !== null) return { status: 'failed', error: fault };
    const draft = input.draft ?? true;

    // TRACKER-FIRST (UC row 22): the tracker exists before the first
    // per-package PR. Search by head branch AND base across ALL states —
    // but only an OPEN tracker may be adopted: a merged or closed tracker
    // from an earlier pass is history, and rewriting its body would corrupt
    // a landed record; the caller picks a fresh run prefix instead. The
    // refusal happens BEFORE any package PR is attempted.
    let trackerNumber: number;
    let trackerUrl: string | undefined;
    let trackerCreated: boolean;
    try {
      const existing = await gh.searchPrByHead(input.tracker.branch, input.base);
      if (existing !== null) {
        if (existing.state !== 'open') {
          return {
            status: 'failed',
            error: `pr: a tracker PR for branch '${input.tracker.branch}' already exists in state '${existing.state}' (PR #${String(existing.number)}) — refusing adoption: a non-open tracker is a landed record, never rewritten; pick a fresh run prefix (UC row 22: one tracker per run, never a second)`,
          };
        }
        trackerNumber = existing.number;
        if (existing.url !== undefined) trackerUrl = existing.url;
        trackerCreated = false;
      } else {
        const created = await gh.createPr({
          head: input.tracker.branch,
          base: input.base,
          title: input.tracker.title,
          body: manifestBody(input, input.packages.map(pendingRowOf)),
          draft,
        });
        trackerNumber = created.number;
        if (created.url !== undefined) trackerUrl = created.url;
        trackerCreated = true;
      }
    } catch (err) {
      return {
        status: 'failed',
        error: `pr: tracker-first failed — no package PR was attempted for run '${input.runPrefix}' — ${messageOf(err)}`,
      };
    }

    // PER-PACKAGE: search-then-create per branch, in input order; a fault
    // isolates to its row (I9 — the fleet run collects all results).
    // manifestRows parallels rows index-for-index and carries the branch the
    // report row omits (the manifest bullet names it).
    const rows: AssemblePrsPackageReport[] = [];
    const manifestRows: ManifestRow[] = [];
    for (const pkg of input.packages) {
      try {
        const existing = await gh.searchPrByHead(pkg.branch, input.base);
        if (existing !== null) {
          rows.push(
            withUrl({ name: pkg.name, number: existing.number, created: false }, existing.url),
          );
          manifestRows.push({ name: pkg.name, branch: pkg.branch, number: existing.number });
          continue;
        }
        const created = await gh.createPr({
          head: pkg.branch,
          base: input.base,
          title: pkg.title,
          ...(pkg.body !== undefined ? { body: pkg.body } : {}),
          draft,
        });
        rows.push(withUrl({ name: pkg.name, number: created.number, created: true }, created.url));
        manifestRows.push({ name: pkg.name, branch: pkg.branch, number: created.number });
      } catch (err) {
        const fault = messageOf(err);
        rows.push({ name: pkg.name, created: false, fault });
        manifestRows.push({ name: pkg.name, branch: pkg.branch, fault });
      }
    }

    // UPDATE-IN-PLACE: the tracker's body is the run's live manifest. For a
    // reused tracker this edit is the whole update (never a second tracker);
    // for a created tracker it replaces the pending skeleton with the actual
    // numbers. A body-edit fault fails the op — a stale tracker manifest is
    // a silently lying merge-readiness artifact — and the error names every
    // package PR already ensured so the caller can find them.
    try {
      await gh.editPrBody(trackerNumber, manifestBody(input, manifestRows));
    } catch (err) {
      const ensured = rows
        .filter((row) => row.number !== undefined)
        .map((row) => `#${String(row.number)}`)
        .join(', ');
      return {
        status: 'failed',
        error: `pr: could not update tracker PR #${String(trackerNumber)} with the fleet manifest — ${messageOf(err)}; package PRs already ensured: ${ensured === '' ? '(none)' : ensured}`,
      };
    }

    return {
      status: 'ok',
      value: {
        tracker: {
          number: trackerNumber,
          created: trackerCreated,
          ...(trackerUrl !== undefined ? { url: trackerUrl } : {}),
        },
        packages: rows,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Fleet-manifest body — the tracker PR's plain-markdown payload
// ---------------------------------------------------------------------------

/** A manifest row: a package with its PR number when known, else pending/fault. */
interface ManifestRow {
  name: string;
  branch: string;
  number?: number;
  fault?: string;
}

/** The pending manifest row of a package whose PR does not exist yet. */
function pendingRowOf(pkg: { name: string; branch: string }): ManifestRow {
  return { name: pkg.name, branch: pkg.branch };
}

/**
 * The fleet-run manifest: plain markdown, one bullet per package with its PR
 * number, its pending state, or its fault. Written by createPr (all rows
 * pending) and refreshed by editPrBody (numbers/faults). Fault text is
 * flattened to one line — gh fault messages carry stderr newlines that
 * would corrupt the bullet framing.
 */
function manifestBody(input: AssemblePrsInput, rows: readonly ManifestRow[]): string {
  const lines: string[] = [
    `<!-- cq-toolkit fleet-run manifest: runPrefix ${input.runPrefix} (generated; updated in place, never duplicated) -->`,
    `# Fleet run \`${input.runPrefix}\``,
    '',
    `Tracker PR for the fleet run against \`${input.base}\`. Per-package PRs carry branches under \`${input.runPrefix}/\`; this manifest is updated in place as packages assemble.`,
    '',
    '## Packages',
  ];
  if (rows.length === 0) {
    lines.push('- (no per-package PRs in this run)');
  }
  for (const row of rows) {
    const where =
      row.number !== undefined
        ? `#${String(row.number)}`
        : row.fault !== undefined
          ? `FAULT: ${singleLine(row.fault)}`
          : 'pending';
    lines.push(`- \`${row.name}\` — ${where} (\`${row.branch}\`)`);
  }
  return `${lines.join('\n')}\n`;
}

/** Flatten a fault message to one safe markdown line (Cc runs become spaces). */
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

/**
 * Library-level input contract (the registry schema mirrors the plain-JSON
 * shape; THIS is the library boundary): non-empty strings, the run-prefix
 * rule on every PR head (tracker included — the fleet lives under one
 * prefix), non-whitespace-only titles, a boolean draft, and control-char
 * refusals on every string fed to gh. Returns null when the input is clean.
 */
function inputFaultOf(input: AssemblePrsInput): string | null {
  // TOP-LEVEL GUARD FIRST: a null/non-object input from an untyped caller
  // past any schema is a `failed` result here, never a TypeError at the
  // field reads.
  if (input === null || typeof input !== 'object') {
    return 'pr: input must be an object (repoRoot, runPrefix, base, tracker, packages)';
  }
  for (const [field, value] of [
    ['repoRoot', input.repoRoot],
    ['runPrefix', input.runPrefix],
    ['base', input.base],
  ] as const) {
    if (typeof value !== 'string' || value === '') {
      return `pr: ${field} must be a non-empty string`;
    }
  }
  if (CONTROL_CHARS_RE.test(input.repoRoot)) {
    return 'pr: repoRoot must not contain control characters — the subprocess effects run gh with it as the working directory';
  }
  if (CONTROL_CHARS_RE.test(input.runPrefix)) {
    return 'pr: runPrefix must not contain control characters — it feeds branch names and the tracker manifest';
  }
  if (CONTROL_CHARS_RE.test(input.base)) {
    return 'pr: base must not contain control characters — it is a positional gh argument and the manifest names it';
  }
  if (input.base.startsWith('-')) {
    return `pr: base '${input.base}' must not start with '-' — it is a positional gh argument, never a flag`;
  }
  for (const segment of input.runPrefix.split('/')) {
    if (!SEGMENT_RE.test(segment) || refnameUnsafeSegment(segment)) {
      return `pr: runPrefix '${input.runPrefix}' must be '/'-joined safe segments (${SEGMENT_RE.source}) — no separators beyond the '/', no leading dash, never a '..' run or a '.lock' suffix (it feeds a git refname)`;
    }
  }
  if (input.tracker === null || typeof input.tracker !== 'object') {
    return 'pr: tracker must be an object with non-empty title and branch';
  }
  if (typeof input.tracker.title !== 'string' || input.tracker.title.trim() === '') {
    return 'pr: tracker.title must be a non-empty (not whitespace-only) string';
  }
  if (CONTROL_CHARS_RE.test(input.tracker.title)) {
    return 'pr: tracker.title must not contain control characters — it feeds gh pr create --title';
  }
  const trackerBranchFault = branchFaultOf(input.tracker.branch, input.runPrefix, 'tracker.branch');
  if (trackerBranchFault !== null) return trackerBranchFault;
  if (!Array.isArray(input.packages)) {
    return 'pr: packages must be an array of { name, branch, title }';
  }
  for (const [index, pkg] of input.packages.entries()) {
    if (pkg === null || typeof pkg !== 'object') {
      return `pr: packages[${String(index)}] must be an object with name, branch and title`;
    }
    if (typeof pkg.name !== 'string' || pkg.name === '') {
      return `pr: packages[${String(index)}].name must be a non-empty string`;
    }
    if (CONTROL_CHARS_RE.test(pkg.name)) {
      return `pr: packages[${String(index)}].name must not contain control characters — the name is written into the tracker manifest`;
    }
    if (typeof pkg.title !== 'string' || pkg.title.trim() === '') {
      return `pr: packages[${String(index)}].title must be a non-empty (not whitespace-only) string`;
    }
    if (CONTROL_CHARS_RE.test(pkg.title)) {
      return `pr: packages[${String(index)}].title must not contain control characters — it feeds gh pr create --title`;
    }
    const branchFault = branchFaultOf(
      pkg.branch,
      input.runPrefix,
      `packages[${String(index)}].branch`,
    );
    if (branchFault !== null) return branchFault;
    if (pkg.body !== undefined) {
      if (typeof pkg.body !== 'string' || CONTROL_CHARS_RE.test(pkg.body)) {
        return `pr: packages[${String(index)}].body must be a string without control characters — it feeds the PR body`;
      }
    }
  }
  if (input.draft !== undefined && typeof input.draft !== 'boolean') {
    return `pr: draft (${String(input.draft)}) must be a boolean (absent means true)`;
  }
  // THE BRANCH NAMESPACE IS 1:1 (UC row 22): two packages sharing a branch
  // would search-adopt the SAME PR into two fleet rows, and a package on
  // the tracker's own branch would race the tracker-first ordering (the
  // package search would adopt the tracker PR as a fleet member). Both are
  // refused at the boundary, naming the colliding entries.
  if (input.tracker.branch !== undefined) {
    const collision = input.packages.findIndex((pkg) => pkg.branch === input.tracker.branch);
    if (collision !== -1) {
      return `pr: packages[${String(collision)}].branch '${input.tracker.branch}' is the tracker's own branch — a package PR and the tracker cannot share a head`;
    }
  }
  const branchOwners = new Map<string, number>();
  for (const [index, pkg] of input.packages.entries()) {
    const firstOwner = branchOwners.get(pkg.branch);
    if (firstOwner !== undefined) {
      return `pr: packages[${String(firstOwner)}] and packages[${String(index)}] share branch '${pkg.branch}' — each package PR needs its own head under the run prefix`;
    }
    branchOwners.set(pkg.branch, index);
  }
  return null;
}

/**
 * The run-prefix rule on one PR head branch (UC row 22's namespace): the
 * branch must start `<runPrefix>/` — the fleet lives under one prefix, so a
 * stray branch is refused naming the field — and every '/'-segment is held
 * to the safe-segment rule (leading dash, '..' runs and '.lock' suffixes
 * refused; they feed a git refname).
 */
function branchFaultOf(branch: string, runPrefix: string, field: string): string | null {
  if (typeof branch !== 'string' || branch === '') {
    return `pr: ${field} must be a non-empty string`;
  }
  if (CONTROL_CHARS_RE.test(branch)) {
    return `pr: ${field} must not contain control characters — it feeds gh --head and the tracker manifest`;
  }
  if (!branch.startsWith(`${runPrefix}/`)) {
    return `pr: ${field} '${branch}' must start with the run prefix '${runPrefix}/' — the fleet's PR branches live under the run prefix`;
  }
  for (const segment of branch.split('/')) {
    if (!SEGMENT_RE.test(segment) || refnameUnsafeSegment(segment)) {
      return `pr: ${field} '${branch}' must be '/'-joined safe segments (${SEGMENT_RE.source}) — no leading dash, never a '..' run or a '.lock' suffix (it feeds a git refname)`;
    }
  }
  return null;
}

/** Attach a URL to a report row only when the effect reported one (exactOptionalPropertyTypes). */
function withUrl(
  row: { name: string; number: number; created: boolean },
  url: string | undefined,
): { name: string; number: number; created: boolean; url?: string } {
  return url === undefined ? row : { ...row, url };
}

/** Error message of an unknown throwable, for `failed` results. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
