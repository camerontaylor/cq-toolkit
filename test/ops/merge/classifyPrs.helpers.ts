// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus this shared fixtures module. Everything below the fixtures banner moved
// unchanged; this header is the original file header, kept with the family.
//
// F1 — tests for the I2 merge-acceptance decision table
// (src/ops/merge/classifyPrs.ts, ws-f scope item 1).
//
// Pinned here, in table order:
//   1. Every ROW of the I2 table (first match wins): draft → never, DIRTY →
//      conflicting, truncated → awaiting (fail closed), unknown last-commit
//      → awaiting (fail closed), unresolved external threads → advisory count,
//      no acceptable review → awaiting, explicit all-clear postdating the
//      last commit → eligible, settle window elapsed/pending →
//      eligible/awaiting.
//   2. PRECEDENCE — the rows are an order, not a menu: draft beats
//      everything, conflicting beats truncated, truncated retains advisory thread count,
//      open threads do not replace review evidence.
//   3. THE SETTLE BOUNDARY — exactly at the window is eligible, one ms
//      short is awaiting, and the flip comes from the INJECTED nowMs (same
//      candidate, different clock reading → different verdict; the table
//      never reads a real clock).
//   4. THE ALL-CLEAR is STRICTLY AFTER the last commit, top-level,
//      non-author, and timestamped — at-or-before, replies, the author's
//      own words, and null timestamps all fall through. It bypasses ONLY
//      the settle wait: with zero reviews it never fires (row 6 first),
//      and a bot skip notice is never all-clear evidence even when
//      phrased "No further changes".
//   5. WHAT COUNTS AS A REVIEW (row 6): author self-reviews, bot
//      skip/failure notices, DISMISSED and CHANGES_REQUESTED verdicts,
//      and null/unknown states never count; non-author bot reviews and
//      null-authorLogin reviews DO (no reviewer privileged; fail toward
//      accepting evidence). Only APPROVED/COMMENTED carry evidence —
//      and row 7's review-body scan applies the same verdict filter.
//   6. THE TEMPORAL QUALIFIER (DOCTRINE §I2, canonical): an acceptable
//      review must postdate the LAST COMMIT — evidence covering an
//      earlier commit never qualifies, no matter how long the settle, and
//      no matter when it was resubmitted; a null/unparseable submittedAt
//      never qualifies. The row-7 comment all-clear cannot stand in for
//      the review-of-head requirement.
//   7. THE SHIPPED allClearPattern anchors the WHOLE body (no multiline
//      flag: `^`/`$` bind the body's start and end; `^\s*` still admits
//      leading blank lines) and is negation-proof: a leading "not" kills
//      the match, mid-sentence mentions cannot match, and any continuation
//      after the phrase — on the same line or the NEXT ("LGTM\nbut fix
//      …") — fails toward awaiting.
//   8. CONFIG OVERRIDES are honored (settleWindowMs, allClearPattern)
//      without mutating defaultClassifyPrConfig, and /g-flagged patterns
//      classify identically across consecutive calls (g/y stripped at the
//      read site).
//   9. MERGE STATES: DIRTY is the conflict lane; UNKNOWN
//      (merge_state_ambiguous) and BLOCKED (merge_state_blocked) fail
//      closed to awaiting; only BEHIND/CLEAN/HAS_HOOKS reach the evidence
//      rows.
//  10. AN OUTSTANDING OBJECTION blocks (merge_objection_outstanding): a
//      non-author post-commit CHANGES_REQUESTED must be resolved or
//      withdrawn before the settle or an all-clear can carry the PR.
//  11. A SPLIT-LINE bot notice ("CodeRabbit" alone on its line, verb on
//      the next) is still skip-screened — the bounded window spans line
//      breaks ([\s\S]{0,80}), kept in sync with ws-e's copy.
//
// Pure data tests: no I/O, no clocks — instant by construction.
import { REVIEW_ACCEPT_SETTLE_MS } from '../../../src/ops/merge/classify.config.js';
import type { PrCandidate } from '../../../src/ops/merge/classifyPrs.js';
import type { RestComment, ReviewSummary, ReviewThread } from '../../../src/ops/review/threads.js';

export const agentMarker = (
  verdict: 'PASS' | 'HOLD' | 'RETRACT',
  headSha = 'a'.repeat(40),
): string =>
  `<!-- cq-agent-review: ${JSON.stringify({
    version: 1,
    reviewerAgentId: 'reviewer-agent',
    authorAgentId: 'author-agent',
    headSha,
    verdict,
    independent: true,
  })} -->`;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The candidate's last commit: T0. Settle boundary and all-clear times derive from it. */
export const LAST_COMMIT = '2026-01-01T00:00:00Z';
export const LAST_COMMIT_MS = Date.parse(LAST_COMMIT);
/** Exactly AT the settle window (row 8 boundary: >= → eligible). */
export const SETTLED_MS = LAST_COMMIT_MS + REVIEW_ACCEPT_SETTLE_MS;
/** One ms short of the settle window (row 8 boundary: still pending). */
export const PENDING_MS = SETTLED_MS - 1;
/** Half a second after the commit: postdates it, well inside the window. */
export const AFTER_COMMIT = '2026-01-01T00:00:00.500Z';
export const BEFORE_COMMIT = '2025-12-31T23:59:59Z';
/** The reviewed head SHA — shared by `candidate()` and `approved()` so the
 * default fixture is a valid head-bound pair. Tests that exercise the
 * fail-closed missing/null head override `headRefOid` explicitly. */
export const HEAD = 'a'.repeat(40);

/** An acceptable review that is NOT an all-clear, by a human non-author. */
export const approved = (extra?: Partial<ReviewSummary>): ReviewSummary => ({
  id: 'PRR_1',
  authorLogin: 'alice',
  state: 'APPROVED',
  body: 'approving the cache changes',
  commitOid: HEAD,
  submittedAt: AFTER_COMMIT,
  ...extra,
});

/** An unresolved review thread by an external reviewer. */
export const thread = (extra?: Partial<ReviewThread>): ReviewThread => ({
  id: 'PRRT_kwDOCr1',
  rootDatabaseId: 100,
  path: 'src/a.ts',
  line: 1,
  isResolved: false,
  isOutdated: false,
  authorLogin: 'alice',
  createdAt: BEFORE_COMMIT,
  body: 'this retry loop can spin forever',
  replies: [],
  ...extra,
});

/** A top-level conversation comment, by a human non-author. The body is a
 * bare line-end all-clear (the shipped pattern requires every phrase to
 * END its line — "all clear — merging" would not match). */
export const comment = (extra?: Partial<RestComment>): RestComment => ({
  id: 900,
  nodeId: 'IC_900',
  authorLogin: 'bob',
  body: 'all clear',
  createdAt: AFTER_COMMIT,
  inReplyToId: null,
  ...extra,
});

/** A clean, untruncated, non-draft PR whose last commit is T0 — all rows open. */
export const candidate = (extra?: Partial<PrCandidate>): PrCandidate => ({
  pr: 42,
  authorLogin: 'pr-author',
  draft: false,
  mergeState: 'CLEAN',
  truncated: false,
  threads: [],
  reviews: [],
  issueComments: [],
  lastCommitAt: LAST_COMMIT,
  headRefOid: HEAD,
  ...extra,
});

/** A candidate past every blocking row: looked at, quiet, conflicts nowhere. */
export const settleCandidate = (extra?: Partial<PrCandidate>): PrCandidate =>
  candidate({ reviews: [approved()], ...extra });
