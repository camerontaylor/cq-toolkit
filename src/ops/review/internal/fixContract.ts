// fixContract — the shared parse of the fix worker's structured-output
// contract (THE FIX OUTCOME CONTRACT below). Extracted from fixReviewItem
// (crq C1 slice, 2026-11-10) so a second op can read the WORKER'S CONTRACT
// DISPOSITION from typed fields instead of the review.fixItem needs-human
// reason prose. `reason` here is presentation-only: it is the exact text
// review.fixItem appends after NO_OUTCOME_REASON, kept byte-identical so
// existing consumers cannot drift, and machine callers must branch on
// `kind`/`disposition`/`evidenceMissing` — never on the prose.
//
// THE FIX OUTCOME CONTRACT (PR #336 incident, 2026-10-17/18; PR #343). A
// worker that answered on its FIRST turn, before reading anything, handed
// back a schema-valid `{changed:false}` whose summary was a preamble
// ("Reading the anchored code first."), and the loop posted it on every run.
// Free-text classification of the summary failed in both directions, so the
// worker now states its OUTCOME as an explicit disposition, plus the
// evidence that disposition requires:
//   - `fixed`: at least one commit (the loop verifies each against git);
//   - `unchanged_with_reason`: no commits, a summary giving the reason, and
//     at least one `evidence` entry `{path, line}` citing the code that
//     shows it (the loop verifies each against the worktree before posting);
//   - `needs_human`: no commits; the summary says what a human must decide;
//   - `no_outcome`: no commits; the worker could not finish.
// Only `fixed` and `unchanged_with_reason` are an outcome. The rest, and a
// well-formed contract whose disposition lacks its evidence, are
// NO-OUTCOME rows: review.fixItem folds them to `needs-human` with a reason
// opening NO_OUTCOME_REASON. They post nothing, so the thread stays
// unsettled. Their commits are known to be none, so they do not withhold
// siblings. A malformed contract, or commits on any disposition but `fixed`,
// stays `invalid`: what the worker committed is then unknown.
//
// The parse is STRUCTURAL: it reads the contract keys and the disposition,
// commits and evidence values, never the summary's wording. The summary is
// only validated (non-empty) and head-capped; every classification below
// follows from the parsed shape alone.
import { z } from 'zod';

/**
 * Head-truncate text to maxChars and report whether the cap fired. The
 * length is JavaScript string length, i.e. UTF-16 code units — the same
 * unit the crq repair driver budgets its item body in
 * (`apps/crq-python/crq_repair/drivers/cq.py` counts
 * `utf-16-le` bytes / 2). Do not replace this with code points.
 */
export const headCapped = (text: string, maxChars: number): { text: string; truncated: boolean } =>
  text.length > maxChars
    ? { text: text.slice(0, maxChars), truncated: true }
    : { text, truncated: false };

/** The four dispositions the fix contract defines. */
export const FIX_DISPOSITIONS = [
  'fixed',
  'unchanged_with_reason',
  'needs_human',
  'no_outcome',
] as const;

/** One disposition value of {@link FIX_DISPOSITIONS}. */
export type FixDisposition = (typeof FIX_DISPOSITIONS)[number];

/** The reason prefix of a NO-OUTCOME row (module doc above). */
export const NO_OUTCOME_REASON = 'fixReviewItem: no outcome to post';

/**
 * Head-cap for the worker SUMMARY, in chars — the reply body is composed
 * from the summary, so an unbounded one could blow the gh argv (finding:
 * round-2 item 5+7). An empty summary is a contract violation outright
 * (there is nothing honest to post); an oversized one is head-capped and
 * feeds the existing `truncated` flag.
 */
export const MAX_SUMMARY_CHARS = 1_000;

/** At most this many evidence entries; each path at most MAX_EVIDENCE_PATH_CHARS. */
export const MAX_EVIDENCE = 10;
export const MAX_EVIDENCE_PATH_CHARS = 300;

/** One evidence citation: a worktree-relative file path and a 1-based line in it. */
export interface FixEvidence {
  path: string;
  line: number;
}

/**
 * A worktree-relative path the loop can resolve through git: no absolute
 * path, no `..` or `.` segment, no backslash, no control character. The same
 * rule renders into the invocation contract (JSON Schema `pattern`), so the
 * lane and {@link parseFixContract} agree on it.
 */
const RELATIVE_REPO_PATH_RE =
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the rule's point
  /^(?!\/)(?!.*\\)(?!.*[\u0000-\u001f])(?!\.{1,2}(?:\/|$))(?!.*\/\.{1,2}(?:\/|$))[^/]+(?:\/[^/]+)*$/;

const isRelativeRepoPath = (path: string): boolean =>
  path.length <= MAX_EVIDENCE_PATH_CHARS && RELATIVE_REPO_PATH_RE.test(path);

/**
 * The commits array's dispatch-boundary bounds (round-3 item 2): at most
 * ten shas per fix, each a string of at most 64 chars — the loop verifies
 * them against git anyway, so these bounds only cap the worker's claim
 * surface and the composed reply.
 */
export const MAX_FIX_COMMITS = 10;

/** A full git commit sha — the only commit-reference shape the contract accepts. */
export const COMMIT_SHA_RE = /^[0-9a-f]{40}$/i;

/**
 * The structured-output contract the INVOCATION carries (ADR-0002 §2.3 —
 * rendered once as plain data via toOutputSchema; the lane must settle a
 * schema-valid contract object or an 'output-invalid' error, Codex 2j).
 * parseFixContract stays as defense in depth (exact keys,
 * disposition↔evidence requirements, bounds) — the schema is the
 * vendor-boundary contract, the parse is the loop's own gate. The schema
 * carries the SAME bounds the parse enforces (blank summary, full shas and
 * MAX_FIX_COMMITS, MAX_EVIDENCE of git-resolvable paths with a positive
 * line), so a repairable answer is caught at the lane instead of becoming a
 * terminal contract violation.
 */
export const FixOutputContractSchema = z
  .object({
    disposition: z.enum(FIX_DISPOSITIONS),
    summary: z.string().regex(/\S/),
    commits: z.array(z.string().regex(COMMIT_SHA_RE)).max(MAX_FIX_COMMITS),
    evidence: z
      .array(
        z
          .object({
            path: z.string().max(MAX_EVIDENCE_PATH_CHARS).regex(RELATIVE_REPO_PATH_RE),
            line: z.number().int().positive(),
          })
          .strict(),
      )
      .max(MAX_EVIDENCE),
  })
  .strict();

/** A well-formed outcome: the only two dispositions that post. */
export interface FixOutcome {
  disposition: 'fixed' | 'unchanged_with_reason';
  /** The worker's one-sentence account of what it fixed, or the reason nothing changed. */
  summary: string;
  /** Present (true) only when the worker SUMMARY hit its own head-cap. */
  summaryTruncated: boolean;
  /** Full shas of the commits the worker created, in worker-reported order. */
  commits: string[];
  /** The code the worker cites; at least one entry for `unchanged_with_reason`. */
  evidence: FixEvidence[];
}

/**
 * A well-formed contract that is NOT an outcome: nothing to post. The
 * contract fields are retained so a caller reads the worker's stated
 * disposition and evidence directly, without parsing prose.
 */
export interface FixNoOutcome {
  /** `contract` is the v2 form; `legacy` is the v1 {changed,summary,commits} form. */
  form: 'contract' | 'legacy';
  /**
   * The disposition the worker stated. Null ONLY for the legacy form, which
   * states none. The (folded) `needs-human` OpResult status never erases it.
   */
  disposition: FixDisposition | null;
  /** True exactly when the disposition is `unchanged_with_reason` with zero evidence entries. */
  evidenceMissing: boolean;
  /** The head-capped, non-empty worker summary. */
  summary: string;
  /** Always empty: the disposition↔commits tie refuses commits on a non-`fixed` disposition. */
  commits: string[];
  /** Parsed evidence, when the worker supplied it (may be non-empty for needs_human/no_outcome). */
  evidence: FixEvidence[];
  /**
   * PRESENTATION ONLY — the reason text review.fixItem appends after
   * NO_OUTCOME_REASON. Byte-compatible with the pre-extraction op and its
   * `worker disposition <x>:` consumer token. Machine callers must not
   * classify from this string; use `disposition`/`evidenceMissing`.
   */
  reason: string;
}

/** The parse verdict over one worker structured output. */
export type FixContractParse =
  | { kind: 'invalid' }
  | ({ kind: 'no-outcome' } & FixNoOutcome)
  | ({ kind: 'outcome' } & FixOutcome);

const CONTRACT_KEYS = ['disposition', 'summary', 'commits', 'evidence'] as const;
const LEGACY_KEYS = ['changed', 'summary', 'commits'] as const;

const sameKeys = (record: Record<string, unknown>, keys: readonly string[]): boolean => {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, i) => key === expected[i]);
};

/** Element-wise sha validation (round-3 items 2 and 15): full 40-hex, bounded. */
const parseCommits = (commits: unknown): string[] | null => {
  if (!Array.isArray(commits) || commits.length > MAX_FIX_COMMITS) {
    return null;
  }
  const shas: string[] = [];
  for (const entry of commits as unknown[]) {
    if (typeof entry !== 'string' || !COMMIT_SHA_RE.test(entry)) {
      return null;
    }
    shas.push(entry);
  }
  return shas;
};

const parseEvidence = (evidence: unknown): FixEvidence[] | null => {
  if (!Array.isArray(evidence) || evidence.length > MAX_EVIDENCE) {
    return null;
  }
  const entries: FixEvidence[] = [];
  for (const entry of evidence as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    const record = entry as Record<string, unknown>;
    if (!sameKeys(record, ['path', 'line'])) {
      return null;
    }
    const { path, line } = record;
    if (typeof path !== 'string' || !isRelativeRepoPath(path)) {
      return null;
    }
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
      return null;
    }
    entries.push({ path, line });
  }
  return entries;
};

/**
 * Parse the fix contract (module doc on THE FIX OUTCOME CONTRACT). A string
 * input is parsed first (a worker that cannot bind structured output may
 * answer one JSON line). Three verdicts:
 *   - `invalid`: not exactly the contract keys and value shapes, a
 *     malformed commit or evidence entry, an empty summary, commits on any
 *     disposition but `fixed`, or a `fixed` naming no commit — what the
 *     worker committed is unknown;
 *   - `no-outcome`: well-formed, no commits, but not an outcome:
 *     `needs_human`, `no_outcome`, or `unchanged_with_reason` without
 *     evidence (typed `evidenceMissing: true`);
 *   - `outcome`: `fixed` with its commits, or `unchanged_with_reason` with
 *     its evidence.
 * LEGACY v1 (`{changed, summary, commits}`), minimal and fail-closed:
 * `changed:true` with commits reads as `fixed`, because its commits are
 * still verified; `changed:false` carries no disposition or evidence, so it
 * is `no-outcome` with `form: 'legacy'` and `disposition: null`. The same
 * tie and summary rules apply.
 */
export function parseFixContract(raw: unknown): FixContractParse {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { kind: 'invalid' };
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { kind: 'invalid' };
  }
  const record = value as Record<string, unknown>;
  if (typeof record['summary'] !== 'string') {
    return { kind: 'invalid' };
  }
  const commits = parseCommits(record['commits']);
  if (commits === null) {
    return { kind: 'invalid' };
  }
  const legacy = sameKeys(record, LEGACY_KEYS);
  let disposition: FixDisposition;
  let evidence: FixEvidence[] = [];
  if (sameKeys(record, CONTRACT_KEYS)) {
    const claimed = record['disposition'];
    const parsedEvidence = parseEvidence(record['evidence']);
    if (
      typeof claimed !== 'string' ||
      !(FIX_DISPOSITIONS as readonly string[]).includes(claimed) ||
      parsedEvidence === null
    ) {
      return { kind: 'invalid' };
    }
    disposition = claimed as FixDisposition;
    evidence = parsedEvidence;
  } else if (legacy) {
    if (typeof record['changed'] !== 'boolean') {
      return { kind: 'invalid' };
    }
    disposition = record['changed'] ? 'fixed' : 'no_outcome';
  } else {
    return { kind: 'invalid' };
  }
  // The disposition↔commits tie, both ways: commits on anything but `fixed`,
  // or a `fixed` that names none, is a lying worker whose commits are
  // unknown. An empty summary is a definitive violation too.
  if ((disposition === 'fixed') !== commits.length > 0) {
    return { kind: 'invalid' };
  }
  const summary = headCapped(record['summary'], MAX_SUMMARY_CHARS);
  if (summary.text.trim() === '') {
    return { kind: 'invalid' };
  }
  // A legacy `changed:true` (with its commits) is `fixed` and falls through
  // to the outcome; only the no-change form is a no-outcome row.
  if (legacy && disposition === 'no_outcome') {
    return {
      kind: 'no-outcome',
      form: 'legacy',
      disposition: null,
      evidenceMissing: false,
      summary: summary.text,
      commits,
      evidence,
      reason: 'a legacy no-change contract carries no disposition or evidence',
    };
  }
  if (disposition === 'needs_human' || disposition === 'no_outcome') {
    return {
      kind: 'no-outcome',
      form: 'contract',
      disposition,
      evidenceMissing: false,
      summary: summary.text,
      commits,
      evidence,
      reason: `worker disposition ${disposition}: ${summary.text}`,
    };
  }
  if (disposition === 'unchanged_with_reason' && evidence.length === 0) {
    return {
      kind: 'no-outcome',
      form: 'contract',
      disposition,
      evidenceMissing: true,
      summary: summary.text,
      commits,
      evidence,
      reason: 'disposition unchanged_with_reason cites no evidence',
    };
  }
  return {
    kind: 'outcome',
    disposition,
    summary: summary.text,
    summaryTruncated: summary.truncated,
    commits,
    evidence,
  };
}
