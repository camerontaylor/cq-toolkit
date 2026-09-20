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
//     searched (by head branch AND base) first, created as a draft when
//     absent, and only then are per-package PRs attempted. A tracker
//     search/creation fault fails the whole op with ZERO package PRs
//     attempted (fail before any package PR exists — a fleet must never
//     outlive its tracker). The LATER manifest-edit fault also fails the
//     op, but by then the package PRs exist: the failure text NAMES every
//     PR already ensured instead of claiming none was attempted.
//   - NEVER A SECOND TRACKER: an existing tracker PR (same head branch) is
//     REUSED — its number is reported with `created: false` and its body is
//     refreshed in place via editPrBody; createPr is never called for the
//     tracker head when a PR already sits there.
//   - PER-ROW PACKAGE FAULTS: a per-package search/create/adoption fault
//     lands on that package's report row (`fault`) and never fails the
//     others — the fleet run collects all results (I9); only a TRACKER
//     fault fails the op.
//   - No throws across the op seam: every effects rejection is folded into
//     a `failed` result or a per-row fault; every input contract violation
//     is a `failed` result naming the field (the worktreeFor boundary
//     style).
import { join } from 'node:path';
import type { Op } from '../../kernel/types.js';
import { makeGitMutex } from '../sweep/gitMutex.js';
import type { GitMutexConfig } from '../sweep/gitMutex.js';

/**
 * The injected `gh` seam — the ONE place this family touches GitHub. All
 * effects are lazy per call (no caching of PR state between calls); tests
 * inject recording fakes, production binds {@link makeSubprocessPrEffects}.
 *
 * NO MERGE EFFECT BY CONSTRUCTION: the seam is the family's whole GitHub
 * vocabulary — search, create, body read/edit, comment, and the ONE
 * consolidated readiness snapshot — and it deliberately admits no
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
  /**
   * The PR's CURRENT body — the read half of the section compose protocol
   * (r2): both tracker writers compose their own section into the body this
   * returns, so the manifest writer and the readiness writer never clobber
   * each other's sections.
   */
  getPrBody(number: number): Promise<string>;
  /** Append a comment to a PR (reserved for tracker annotations). */
  comment(number: number, body: string): Promise<void>;
  /**
   * ONE consolidated readiness snapshot per PR (final, jNTyS): checks,
   * review decision, and meta (draft/lifecycle/mergeability) come from a
   * single `gh pr view` JSON document — one subprocess, inherently coherent
   * evidence. The run report's whole fold reads THIS.
   */
  getPrReadiness(number: number): Promise<PrReadinessSnapshot>;
}

/** A PR's lifecycle state, as the search reports it. */
export type PrState = 'open' | 'closed' | 'merged' | 'unknown';

/** The search's hit: number, URL when reported, lifecycle state, fork flag. */
export interface PrSearchResult {
  number: number;
  url?: string;
  state: PrState;
  /**
   * true when the PR lives in a FOREIGN repo (a fork whose same-branch-name
   * PR must never be adopted as this fleet's member — final jNTyU).
   */
  isCrossRepository: boolean;
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

/**
 * The meta half of the merge-readiness evidence: `isDraft` — GitHub cannot
 * merge a draft, whatever the checks say; the lifecycle `state` — which
 * lifecycle-guards the tracker writers (a non-open tracker is a landed
 * record, never rewritten) and blocks readiness on a non-open PR;
 * `mergeable` — a PR with merge conflicts is not mergeable however green
 * its checks; and `mergeStateStatus` — gh's mergeability verdict
 * (branch-protection requirements and the like), folded AFTER `mergeable`
 * and unknown-tolerant.
 */
export type PrMergeable = 'mergeable' | 'conflicting' | 'unknown';

/**
 * gh's mergeStateStatus, mapped conservatively (final jNTyP): CLEAN → clean,
 * BLOCKED/BEHIND (and DIRTY-class words) → blocked/behind; anything the
 * checks/review halves already cover (UNSTABLE, DRAFT) or cannot resolve
 * (UNKNOWN, missing) → `unknown` — the fold tolerates it.
 */
export type PrMergeStateStatus = 'clean' | 'blocked' | 'behind' | 'unknown';

export interface PrMeta {
  isDraft: boolean;
  state: PrState;
  mergeable: PrMergeable;
  mergeStateStatus: PrMergeStateStatus;
}

/** ONE coherent readiness snapshot off a single `gh pr view` document (final jNTyS). */
export interface PrReadinessSnapshot {
  checks: PrChecks;
  review: PrReviewState;
  meta: PrMeta;
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
  /**
   * One entry per package; `branch` must start `<runPrefix>/`. An entry's
   * `body` travels over STDIN (`--body-file -`) straight to the PR body —
   * it is never interpolated into the tracker manifest — so multiline
   * markdown is fine (Cc-refused fields are only the interpolated ones:
   * names, titles, branches).
   */
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
 *
 * The tracker manifest upsert (read body → compose section → edit body) runs
 * inside a tracker-scoped {@link TrackerBodyLock} (review-debt #171): the run
 * report writes the readiness section of the SAME body, and two concurrent
 * read-modify-write spans would otherwise restore a stale copy of the
 * other's section. The lock defaults to the repo-rooted, tracker-number-
 * scoped artifact; a caller with its own serialization strategy injects one.
 */
export function makeAssemblePrs(
  gh: PrEffects,
  trackerLock?: TrackerBodyLock,
): Op<AssemblePrsInput, AssemblePrsReport> {
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
        if (existing.isCrossRepository) {
          return {
            status: 'failed',
            error: `pr: tracker branch '${input.tracker.branch}' resolves to a FOREIGN fork's PR #${String(existing.number)} (cross-repository) — refusing adoption: a fork's same-branch-name PR must never become this run's tracker`,
          };
        }
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
          body: manifestSection(input, input.packages.map(pendingRowOf)),
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
    // report row omits (the manifest bullet names it). Adoption is
    // STATE-AWARE (PR-165 r2#1): a MERGED or CLOSED PR on the head+base is
    // history, not a live fleet member — it is refused as a ROW fault
    // naming the state (mirroring the tracker refusal), never adopted with
    // created:false for runReport to fold into a fabricated ready.
    const rows: AssemblePrsPackageReport[] = [];
    const manifestRows: ManifestRow[] = [];
    for (const pkg of input.packages) {
      try {
        const existing = await gh.searchPrByHead(pkg.branch, input.base);
        if (existing !== null) {
          if (existing.isCrossRepository) {
            const fault = `PR #${String(existing.number)} for branch '${pkg.branch}' comes from a FOREIGN fork (cross-repository) — refusing adoption: a fork's same-branch-name PR must never become a fleet member`;
            rows.push({ name: pkg.name, created: false, fault });
            manifestRows.push({ name: pkg.name, branch: pkg.branch, fault });
            continue;
          }
          if (existing.state !== 'open') {
            const fault = `PR #${String(existing.number)} for branch '${pkg.branch}' is in state '${existing.state}' — refusing adoption: a non-open PR is a landed record, never a live fleet member`;
            rows.push({ name: pkg.name, created: false, fault });
            manifestRows.push({ name: pkg.name, branch: pkg.branch, fault });
            continue;
          }
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

    // UPDATE-IN-PLACE (the compose protocol, r2#4): the tracker's body is
    // the run's live manifest. The op reads the CURRENT body and upserts
    // ONLY the manifest section, preserving the readiness section the run
    // report owns — the two tracker writers never clobber each other. For a
    // reused tracker this edit is the whole update (never a second tracker);
    // for a created tracker it replaces the pending skeleton with the actual
    // numbers. A read-or-edit fault fails the op — a stale tracker manifest
    // is a silently lying merge-readiness artifact — and the error names
    // every package PR already ensured so the caller can find them.
    try {
      const lock = trackerLock ?? makeTrackerBodyLock(input.repoRoot);
      await lock.withLock(trackerNumber, async () => {
        const current = await gh.getPrBody(trackerNumber);
        await gh.editPrBody(
          trackerNumber,
          composeSection(current, manifestSection(input, manifestRows)),
        );
      });
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

// THE SECTION COMPOSE PROTOCOL (PR-165 r2#4, end markers per final jMrm3):
// the tracker PR's body hosts TWO sections owned by two different writers —
// the assembler owns the manifest section, the run report owns the
// readiness section — and each writer replaces ONLY its own section: from
// its START marker to ITS OWN END marker (both written by the builders),
// creating both when absent. Lines outside a managed span — user prose
// above, between, or below the sections — are ALWAYS preserved verbatim;
// neither writer can clobber the other or the caller's prose.

/** The assembler's section START marker — the fleet-run manifest lives under it. */
export const MANIFEST_SECTION_MARKER = '<!-- cq:manifest -->';

/** The assembler's section END marker (final jMrm3): bounds the managed span. */
export const MANIFEST_SECTION_END_MARKER = '<!-- /cq:manifest -->';

/** The run report's section START marker — the merge-readiness report lives under it. */
export const READINESS_SECTION_MARKER = '<!-- cq:readiness -->';

/** The run report's section END marker (final jMrm3): bounds the managed span. */
export const READINESS_SECTION_END_MARKER = '<!-- /cq:readiness -->';

/**
 * Upsert ONE section into `existing`. The section's FIRST line is its
 * START marker and its LAST line is its END marker; the span REPLACED in
 * `existing` runs from a line exactly matching the START marker to a line
 * exactly matching the derived END marker (start replaced inclusively, end
 * marker replaced by the new section's own):
 *   - absent/empty existing → the section alone;
 *   - START present → the managed span is replaced; prose and sibling
 *     sections outside the span survive byte-for-byte (final jMrm3 — a
 *     missing END marker owns the tail, the legacy-body migration path);
 *   - START absent → the section is appended after the existing content.
 * Markdown-safe by construction: the section builders already escaped
 * their interpolations.
 */
export function composeSection(existing: string | undefined, section: string): string {
  const sectionLines = section.trimEnd().split('\n');
  const startMarker = (sectionLines[0] ?? '').trim();
  const endMarker = startMarker.replace('<!-- cq:', '<!-- /cq:');
  if (existing === undefined || existing.trim() === '') {
    return `${section.trimEnd()}\n`;
  }
  const existingLines = existing.split('\n');
  const start = existingLines.findIndex((line) => line.trim() === startMarker);
  if (start === -1) {
    return `${existing.trimEnd()}\n\n${section.trimEnd()}\n`;
  }
  let end = existingLines.length; // no END marker → the span owns the tail (legacy bodies)
  for (let index = start + 1; index < existingLines.length; index += 1) {
    if (existingLines[index]?.trim() === endMarker) {
      end = index;
      break;
    }
  }
  return [
    ...existingLines.slice(0, start),
    ...sectionLines,
    // Owning the tail (a legacy START without an END) still ends the body
    // with a newline, matching every other compose outcome.
    ...(end < existingLines.length ? existingLines.slice(end + 1) : ['']),
  ].join('\n');
}

/**
 * Markdown-safe interpolation (r2#7; backtick substitution per final
 * jN7cZ): backticks are REPLACED with the typographic apostrophe U+2019 —
 * never backslash-escaped, because CommonMark does not process backslash
 * escapes inside code spans, so a `\`` would still close the generated
 * span and inject formatting. Replacement makes closing it impossible.
 * Angle brackets are stripped so nothing interpolated can smuggle HTML
 * into the tracker body.
 */
function mdSafe(text: string): string {
  return text.replace(/`/g, '’').replace(/[<>]/g, '');
}

/** Flatten a fault message to one safe markdown line (Cc runs become spaces). */
function singleLine(text: string): string {
  return text
    .split(/[\p{Cc}]/u)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The fleet-run manifest SECTION (under {@link MANIFEST_SECTION_MARKER}):
 * plain markdown, one bullet per package with its PR number, its pending
 * state, or its fault. Written by createPr (all rows pending) and upserted
 * by editPrBody (numbers/faults). Fault text is flattened to one line — gh
 * fault messages carry stderr newlines that would corrupt the bullet
 * framing — and every interpolation is markdown-safe.
 */
function manifestSection(input: AssemblePrsInput, rows: readonly ManifestRow[]): string {
  const lines: string[] = [
    MANIFEST_SECTION_MARKER,
    `<!-- cq-toolkit fleet-run manifest: runPrefix ${mdSafe(input.runPrefix)} (generated; updated in place, never duplicated) -->`,
    `# Fleet run \`${mdSafe(input.runPrefix)}\``,
    '',
    `Tracker PR for the fleet run against \`${mdSafe(input.base)}\`. Per-package PRs carry branches under \`${mdSafe(input.runPrefix)}/\`; this manifest is updated in place as packages assemble.`,
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
          ? `FAULT: ${mdSafe(singleLine(row.fault))}`
          : 'pending';
    lines.push(`- \`${mdSafe(row.name)}\` — ${where} (\`${row.branch}\`)`);
  }
  lines.push(MANIFEST_SECTION_END_MARKER);
  return lines.join('\n');
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
  const prefixFault = runPrefixFault(input.runPrefix);
  if (prefixFault !== null) return prefixFault;
  if (input.tracker === null || typeof input.tracker !== 'object') {
    return 'pr: tracker must be an object with non-empty title and branch';
  }
  if (typeof input.tracker.title !== 'string' || input.tracker.title.trim() === '') {
    return 'pr: tracker.title must be a non-empty (not whitespace-only) string';
  }
  if (CONTROL_CHARS_RE.test(input.tracker.title)) {
    return 'pr: tracker.title must not contain control characters — it feeds gh pr create --title';
  }
  const trackerBranchFault = prBranchFaultOf(
    input.tracker.branch,
    input.runPrefix,
    'tracker.branch',
  );
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
    const branchFault = prBranchFaultOf(
      pkg.branch,
      input.runPrefix,
      `packages[${String(index)}].branch`,
    );
    if (branchFault !== null) return branchFault;
    // The body is the ONE free-form field: it travels over STDIN
    // (`--body-file -`) straight to the PR body and is never interpolated
    // into the tracker manifest, so control characters and multiline
    // markdown are fine (PR-165 r2 / codex jMJpG — the old Cc refusal made
    // normal markdown impractical). Only its TYPE is contract.
    if (pkg.body !== undefined && typeof pkg.body !== 'string') {
      return `pr: packages[${String(index)}].body must be a string (it feeds the PR body over stdin; multiline markdown is fine)`;
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
  const collision = input.packages.findIndex((pkg) => pkg.branch === input.tracker.branch);
  if (collision !== -1) {
    return `pr: packages[${String(collision)}].branch '${input.tracker.branch}' is the tracker's own branch — a package PR and the tracker cannot share a head`;
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
 * THE RUN-PREFIX RULE (round-3 boundary parity): both family ops label
 * tracker bodies and reports with the run prefix, and it feeds git
 * refnames — so it must be '/'-joined safe segments (${SEGMENT_RE.source}
 * per segment), never a '..' run or a '.lock' suffix. ONE definition,
 * shared by assemblePrs and runReport, so the boundary cannot drift.
 */
export function runPrefixFault(prefix: string): string | null {
  for (const segment of prefix.split('/')) {
    if (!SEGMENT_RE.test(segment) || refnameUnsafeSegment(segment)) {
      return `pr: runPrefix '${prefix}' must be '/'-joined safe segments (${SEGMENT_RE.source}) — no separators beyond the '/', no leading dash, never a '..' run or a '.lock' suffix (it feeds a git refname)`;
    }
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
export function prBranchFaultOf(branch: string, runPrefix: string, field: string): string | null {
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

// ---------------------------------------------------------------------------
// The tracker-body read-modify-write LOCK (review-debt #171)
// ---------------------------------------------------------------------------
//
// The tracker PR body hosts two independently owned sections: this module's
// fleet manifest and runReport.ts's readiness report. Each writer reads the
// CURRENT body, replaces ONLY its own section, and issues a full-body edit —
// safe only when the read-modify-write span is not interleaved with the other
// writer's. Two concurrent writers would each read the same pre-image and the
// later full-body edit would restore a stale copy of the other's section,
// silently discarding either the new manifest or the new readiness report.
//
// The lock is the makeGitMutex idiom (the sweep family's git-mutation mutex:
// proper-lockfile, stale recovery, bounded acquire retries, a non-throwing
// onCompromised) with the lockPath derived from the REPO ROOT and the TRACKER
// NUMBER, so two separately constructed ops (makeAssemblePrs and
// makeRunReport) — in one process or in different processes on the machine —
// contend on the SAME on-disk artifact. It is TRACKER-SCOPED: different
// trackers never block one another. A caller that already owns a
// serialization strategy injects one; the default derives the repo-rooted
// artifact. The artifact is `<lockPath>.lock` and lives under
// `<repoRoot>/.cq/tracker-body/`, removed on release.

/**
 * Serializes one tracker PR's body read-modify-write span. Both tracker
 * writers acquire this around their `getPrBody` → `composeSection` →
 * `editPrBody` span; a tracker-scoped key means unrelated trackers never
 * contend.
 */
export interface TrackerBodyLock {
  /**
   * Run `fn` while holding the tracker's lock. Concurrent holders — in this
   * process or another — serialize on the on-disk artifact; a caller whose
   * acquire retries run out REJECTS (never runs unlocked). The fn's value is
   * returned; fn throwing releases best-effort and rethrows the fault.
   */
  withLock<T>(trackerNumber: number, fn: () => T | Promise<T>): Promise<T>;
}

/**
 * The tracker-scoped lockPath (the artifact proper-lockfile derives is
 * `<lockPath>.lock`). Derived from the repo root so every op and process
 * guarding the same tracker agrees on one artifact; the tracker number
 * scopes it so unrelated trackers never serialize.
 */
export function trackerBodyLockPath(repoRoot: string, trackerNumber: number): string {
  return join(repoRoot, '.cq', 'tracker-body', String(trackerNumber));
}

/**
 * Build a tracker-body lock over one repo root. Timings default to the
 * git-mutex shipped values; a caller may override them (the same config
 * surface, minus `lockPath`, which this factory owns).
 */
export function makeTrackerBodyLock(
  repoRoot: string,
  timings?: Pick<GitMutexConfig, 'staleMs' | 'retries' | 'retryBaseMs' | 'onEvent'>,
): TrackerBodyLock {
  return {
    async withLock<T>(trackerNumber: number, fn: () => T | Promise<T>): Promise<T> {
      const mutex = makeGitMutex({
        lockPath: trackerBodyLockPath(repoRoot, trackerNumber),
        ...timings,
      });
      return mutex.withLock(fn);
    },
  };
}
