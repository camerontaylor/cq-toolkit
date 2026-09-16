// F1 — tests for the I2 merge-acceptance decision table
// (src/ops/merge/classifyPrs.ts, ws-f scope item 1).
//
// Pinned here, in table order:
//   1. Every ROW of the I2 table (first match wins): draft → never, DIRTY →
//      conflicting, truncated → awaiting (fail closed), unknown last-commit
//      → awaiting (fail closed), unresolved external threads → has-issues,
//      no acceptable review → awaiting, explicit all-clear postdating the
//      last commit → eligible, settle window elapsed/pending →
//      eligible/awaiting.
//   2. PRECEDENCE — the rows are an order, not a menu: draft beats
//      everything, conflicting beats truncated, truncated beats has-issues,
//      has-issues beats no-review.
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
import { describe, expect, test } from 'vitest';
import {
  REVIEW_ACCEPT_SETTLE_MS,
  defaultClassifyPrConfig,
} from '../../../src/ops/merge/classify.config.js';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import type { PrCandidate } from '../../../src/ops/merge/classifyPrs.js';
import type { RestComment, ReviewSummary, ReviewThread } from '../../../src/ops/review/threads.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The candidate's last commit: T0. Settle boundary and all-clear times derive from it. */
const LAST_COMMIT = '2026-01-01T00:00:00Z';
const LAST_COMMIT_MS = Date.parse(LAST_COMMIT);
/** Exactly AT the settle window (row 8 boundary: >= → eligible). */
const SETTLED_MS = LAST_COMMIT_MS + REVIEW_ACCEPT_SETTLE_MS;
/** One ms short of the settle window (row 8 boundary: still pending). */
const PENDING_MS = SETTLED_MS - 1;
/** Half a second after the commit: postdates it, well inside the window. */
const AFTER_COMMIT = '2026-01-01T00:00:00.500Z';
const BEFORE_COMMIT = '2025-12-31T23:59:59Z';

/** An acceptable review that is NOT an all-clear, by a human non-author. */
const approved = (extra?: Partial<ReviewSummary>): ReviewSummary => ({
  id: 'PRR_1',
  authorLogin: 'alice',
  state: 'APPROVED',
  body: 'approving the cache changes',
  submittedAt: AFTER_COMMIT,
  ...extra,
});

/** An unresolved review thread by an external reviewer. */
const thread = (extra?: Partial<ReviewThread>): ReviewThread => ({
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
const comment = (extra?: Partial<RestComment>): RestComment => ({
  id: 900,
  nodeId: 'IC_900',
  authorLogin: 'bob',
  body: 'all clear',
  createdAt: AFTER_COMMIT,
  inReplyToId: null,
  ...extra,
});

/** A clean, untruncated, non-draft PR whose last commit is T0 — all rows open. */
const candidate = (extra?: Partial<PrCandidate>): PrCandidate => ({
  pr: 42,
  authorLogin: 'pr-author',
  draft: false,
  mergeState: 'CLEAN',
  truncated: false,
  threads: [],
  reviews: [],
  issueComments: [],
  lastCommitAt: LAST_COMMIT,
  ...extra,
});

/** A candidate past every blocking row: looked at, quiet, conflicts nowhere. */
const settleCandidate = (extra?: Partial<PrCandidate>): PrCandidate =>
  candidate({ reviews: [approved()], ...extra });

// ---------------------------------------------------------------------------
// The decision table, row by row (first match wins)
// ---------------------------------------------------------------------------

describe('classifyPr — one test per I2 row', () => {
  test('row 1: draft → never (is_draft)', () => {
    expect(classifyPr(candidate({ draft: true }), SETTLED_MS)).toEqual({
      verdict: 'never',
      reason: 'is_draft',
      unresolvedExternalThreads: 0,
    });
  });

  test('row 2: merge state DIRTY → conflicting (merge_conflicts)', () => {
    expect(classifyPr(settleCandidate({ mergeState: 'DIRTY' }), SETTLED_MS)).toEqual({
      verdict: 'conflicting',
      reason: 'merge_conflicts',
      unresolvedExternalThreads: 0,
    });
  });

  test('row 3: truncated review data → awaiting (review_data_truncated) — fail closed', () => {
    // Truncation means verdicts may be MISSING from the set: an empty,
    // clean-looking snapshot must never read as reviewed.
    expect(classifyPr(settleCandidate({ truncated: true }), SETTLED_MS)).toEqual({
      verdict: 'awaiting',
      reason: 'review_data_truncated',
      unresolvedExternalThreads: 0,
    });
  });

  test('row 4: last commit null → awaiting (last_commit_unknown) — fail closed', () => {
    expect(classifyPr(settleCandidate({ lastCommitAt: null }), SETTLED_MS)).toEqual({
      verdict: 'awaiting',
      reason: 'last_commit_unknown',
      unresolvedExternalThreads: 0,
    });
  });

  test('row 4 (unparseable): last commit not a timestamp → last_commit_unknown — fail closed', () => {
    expect(classifyPr(settleCandidate({ lastCommitAt: 'not-a-timestamp' }), SETTLED_MS)).toEqual({
      verdict: 'awaiting',
      reason: 'last_commit_unknown',
      unresolvedExternalThreads: 0,
    });
  });

  test('row 5: unresolved external threads → has-issues, count surfaced on the result', () => {
    const result = classifyPr(
      settleCandidate({ threads: [thread(), thread({ id: 'T2', rootDatabaseId: 200 })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('has-issues');
    expect(result.reason).toBe('unresolved_external_threads');
    expect(result.unresolvedExternalThreads).toBe(2);
  });

  test('row 6: no review at all → awaiting (no_acceptable_review)', () => {
    expect(classifyPr(candidate(), SETTLED_MS)).toEqual({
      verdict: 'awaiting',
      reason: 'no_acceptable_review',
      unresolvedExternalThreads: 0,
    });
  });

  test('row 7: explicit all-clear postdating the last commit → eligible, settle wait bypassed', () => {
    // The window has NOT elapsed (nowMs is 1ms after the commit) — the
    // all-clear alone carries it.
    const result = classifyPr(
      settleCandidate({ issueComments: [comment()] }),
      LAST_COMMIT_MS + 1,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('explicit_all_clear');
  });

  test('row 7 alt: an all-clear REVIEW body qualifies too', () => {
    const result = classifyPr(
      settleCandidate({ reviews: [approved({ body: 'LGTM' })] }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('explicit_all_clear');
  });

  test('row 8 elapsed: last commit >= settle window ago → eligible (settle_window_elapsed)', () => {
    expect(classifyPr(settleCandidate(), SETTLED_MS)).toEqual({
      verdict: 'eligible',
      reason: 'settle_window_elapsed',
      unresolvedExternalThreads: 0,
    });
  });

  test('row 8 pending: last commit < settle window ago → awaiting (settle_window_pending)', () => {
    expect(classifyPr(settleCandidate(), PENDING_MS)).toEqual({
      verdict: 'awaiting',
      reason: 'settle_window_pending',
      unresolvedExternalThreads: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Precedence — the rows are an ORDER, not a menu
// ---------------------------------------------------------------------------

describe('classifyPr — precedence (first match wins)', () => {
  test('draft beats everything (DIRTY + truncated + unresolved threads + unknown commit)', () => {
    const stacked = candidate({
      draft: true,
      mergeState: 'DIRTY',
      truncated: true,
      threads: [thread()],
      lastCommitAt: null,
    });
    expect(classifyPr(stacked, SETTLED_MS)).toEqual({
      verdict: 'never',
      reason: 'is_draft',
      unresolvedExternalThreads: 1,
    });
  });

  test('conflicting beats truncated (DIRTY wins over the truncation fail-closed)', () => {
    const result = classifyPr(
      candidate({ mergeState: 'DIRTY', truncated: true }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('conflicting');
    expect(result.reason).toBe('merge_conflicts');
  });

  test('truncated beats has-issues (the count still surfaces)', () => {
    const result = classifyPr(
      candidate({ truncated: true, threads: [thread()] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('review_data_truncated');
    expect(result.unresolvedExternalThreads).toBe(1);
  });

  test('has-issues beats no-review (an unresolved thread blocks before the first look)', () => {
    const result = classifyPr(candidate({ threads: [thread()] }), SETTLED_MS);
    expect(result.verdict).toBe('has-issues');
    expect(result.reason).toBe('unresolved_external_threads');
  });

  test('unknown last commit beats has-issues (row 4 fails closed ahead of row 5)', () => {
    const result = classifyPr(
      candidate({ lastCommitAt: null, threads: [thread()] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('last_commit_unknown');
  });
});

// ---------------------------------------------------------------------------
// The settle boundary (row 8) — injected nowMs decides, never a real clock
// ---------------------------------------------------------------------------

describe('classifyPr — the settle boundary is exact and nowMs-injected', () => {
  test('exactly AT the window is eligible (>=)', () => {
    expect(classifyPr(settleCandidate(), SETTLED_MS).reason).toBe('settle_window_elapsed');
  });

  test('one ms short is awaiting', () => {
    expect(classifyPr(settleCandidate(), PENDING_MS).reason).toBe('settle_window_pending');
  });

  test('same candidate, nowMs across the boundary: the clock alone flips the verdict', () => {
    const c = settleCandidate();
    expect(classifyPr(c, PENDING_MS).verdict).toBe('awaiting');
    expect(classifyPr(c, SETTLED_MS).verdict).toBe('eligible');
  });

  test('pure: same inputs → deep-equal output (no hidden state)', () => {
    const c = settleCandidate();
    expect(classifyPr(c, PENDING_MS)).toEqual(classifyPr(c, PENDING_MS));
  });
});

// ---------------------------------------------------------------------------
// The explicit all-clear (row 7) — strictly after, top-level, non-author,
// timestamped; anything else falls through to the settle rows
// ---------------------------------------------------------------------------

describe('classifyPr — the explicit all-clear is strict', () => {
  test('all-clear at-or-before the last commit falls through (must postdate the final code)', () => {
    const result = classifyPr(
      settleCandidate({
        issueComments: [comment({ createdAt: BEFORE_COMMIT })],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('all-clear at EXACTLY the last commit time is not strictly after — falls through', () => {
    const result = classifyPr(
      settleCandidate({ issueComments: [comment({ createdAt: LAST_COMMIT })] }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test("the author's own all-clear does not count (non-author rule)", () => {
    const result = classifyPr(
      settleCandidate({
        issueComments: [comment({ authorLogin: 'pr-author', body: 'lgtm' })],
      }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a REPLY carrying the all-clear does not count (top-level only)', () => {
    const result = classifyPr(
      settleCandidate({ issueComments: [comment({ inReplyToId: 55, body: 'lgtm' })] }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('an un-timestamped all-clear never qualifies (cannot be shown to postdate)', () => {
    const result = classifyPr(
      settleCandidate({ issueComments: [comment({ createdAt: null })] }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a caveat sentence ("looks good, but …") is not an all-clear (must END its line)', () => {
    const result = classifyPr(
      settleCandidate({
        reviews: [approved({ body: 'looks good, but fix the retry loop first' })],
      }),
      PENDING_MS,
    );
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a SPLIT-LINE caveat ("LGTM" alone on its line, objection on the next) falls through', () => {
    // The whole-body anchor (round 3): with a multiline flag, "LGTM" alone
    // on line 1 would have matched; now the next-line objection kills it.
    const result = classifyPr(
      settleCandidate({
        issueComments: [comment({ body: 'LGTM\nbut fix the retry loop first' })],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a bot skip notice is never all-clear evidence, even with a bare all-clear phrase on its own line', () => {
    // The skip guard in isAllClearAfter fires BEFORE the pattern: without
    // it, line 2 ("no further issues") is a bare line-start/end pattern
    // match, and a punted review would read as approval.
    const result = classifyPr(
      settleCandidate({
        issueComments: [
          comment({
            body: 'CodeRabbit skipped this run due to a configuration error.\nno further issues',
          }),
        ],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a comment all-clear with ZERO reviews → awaiting (row 6 precedes row 7)', () => {
    // The all-clear bypasses ONLY the settle wait — it never stands in
    // for the review-of-head requirement.
    const result = classifyPr(candidate({ issueComments: [comment()] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a DISMISSED review with an "LGTM" body is not all-clear evidence (row 7 state filter)', () => {
    // Row 6 passes on the live review; the retracted "LGTM" must not
    // bypass the settle wait — it falls through to settle logic.
    const result = classifyPr(
      settleCandidate({
        reviews: [approved(), approved({ id: 'PRR_2', state: 'DISMISSED', body: 'LGTM' })],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('settle_window_pending');
  });

  test('a CHANGES_REQUESTED review with an "LGTM" body never reaches the all-clear row — the objection row fires first', () => {
    const result = classifyPr(
      settleCandidate({
        reviews: [
          approved(),
          approved({ id: 'PRR_2', state: 'CHANGES_REQUESTED', body: 'LGTM' }),
        ],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });
});

// ---------------------------------------------------------------------------
// The temporal qualifier (DOCTRINE §I2) — evidence must cover the LAST commit
// ---------------------------------------------------------------------------

describe('classifyPr — an acceptable review must postdate the last commit (DOCTRINE §I2)', () => {
  test('a pre-commit acceptable review does NOT satisfy row 6', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ submittedAt: BEFORE_COMMIT })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('pre-commit review + post-commit comment all-clear → STILL awaiting (no post-commit review evidence)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ submittedAt: BEFORE_COMMIT })],
        issueComments: [comment()],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('pre-commit review + settle fully elapsed → STILL awaiting (settle never cures stale evidence)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ submittedAt: BEFORE_COMMIT })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a review with a null or unparseable submittedAt never qualifies (fail toward awaiting)', () => {
    for (const submittedAt of [null, 'not-a-timestamp'] as Array<string | null>) {
      const result = classifyPr(
        candidate({ reviews: [approved({ submittedAt })] }),
        SETTLED_MS,
      );
      expect(result.reason).toBe('no_acceptable_review');
    }
  });

  test('CONTROL: adding a post-commit review flips the same candidate to eligible (settle elapsed)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ submittedAt: BEFORE_COMMIT }), approved({ id: 'PRR_2' })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('CONTROL: a post-commit all-clear review flips it to eligible via row 7', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({ submittedAt: BEFORE_COMMIT }),
          approved({ id: 'PRR_2', body: 'LGTM' }),
        ],
      }),
      PENDING_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('explicit_all_clear');
  });
});

// ---------------------------------------------------------------------------
// The shipped allClearPattern — line-start anchored, negation-proof
// ---------------------------------------------------------------------------

describe('defaultClassifyPrConfig.allClearPattern — shipped data', () => {
  test.each([
    // Negation pins (round 1).
    {
      name: 'a line-leading "Not LGTM" is killed by the not-lookahead',
      body: 'Not LGTM — the retry loop is broken',
      matches: false,
    },
    {
      name: 'a mid-sentence "not all clear yet" cannot match (line-start anchor)',
      body: 'This is not all clear yet',
      matches: false,
    },
    {
      name: 'a line-leading "not lgtm-worthy" is killed by the not-lookahead',
      body: 'not lgtm-worthy',
      matches: false,
    },
    // Caveat-continuation NOs — round 2 extends end-of-line to ALL alternatives.
    {
      name: '"lgtm but fix the retry loop first" does not match (caveat continues the line)',
      body: 'lgtm but fix the retry loop first',
      matches: false,
    },
    {
      name: '"all clear, but the retry loop is still broken" does not match (caveat)',
      body: 'all clear, but the retry loop is still broken',
      matches: false,
    },
    {
      name: '"no further issues, but the tests are red" does not match (caveat)',
      body: 'no further issues, but the tests are red',
      matches: false,
    },
    {
      name: '"looks good, but fix the retry loop first" does not match (kept from round 1)',
      body: 'looks good, but fix the retry loop first',
      matches: false,
    },
    // Decided (round 2): ANY continuation — even a courteous coda — is a
    // continuation; strict end-of-line fails toward awaiting.
    {
      name: '"LGTM — ship it" does not match (a coda is a continuation)',
      body: 'LGTM — ship it',
      matches: false,
    },
    {
      name: '"all clear, thanks" does not match (a courteous coda is a continuation too)',
      body: 'all clear, thanks',
      matches: false,
    },
    // Round 3: the anchors bind the WHOLE body (no multiline flag) — a
    // caveat on the NEXT line cannot resurrect a match.
    {
      name: '"LGTM\\nbut fix the retry loop first" does not match (split-line caveat)',
      body: 'LGTM\nbut fix the retry loop first',
      matches: false,
    },
    {
      name: '"all clear\\nbut the tests are red" does not match (split-line caveat)',
      body: 'all clear\nbut the tests are red',
      matches: false,
    },
    {
      name: 'leading blank lines are admitted (^\\s* spans newlines)',
      body: '\n\nlgtm',
      matches: true,
    },
    // Bare forms and the single allowed trailing punctuation.
    {
      name: 'a bare "lgtm" matches',
      body: 'lgtm',
      matches: true,
    },
    {
      name: 'a bare "no further issues" matches',
      body: 'no further issues',
      matches: true,
    },
    {
      name: 'a bare "all clear," matches (one trailing comma is the allowed modulo)',
      body: 'all clear,',
      matches: true,
    },
    {
      name: 'a bare "all clear" matches',
      body: 'all clear',
      matches: true,
    },
    {
      name: 'a bare "looks good" ending its line matches',
      body: 'looks good',
      matches: true,
    },
  ])('$name', ({ body, matches }) => {
    expect(defaultClassifyPrConfig.allClearPattern.test(body)).toBe(matches);
  });
});

// ---------------------------------------------------------------------------
// What counts as an acceptable review (row 6) — no reviewer privileged
// ---------------------------------------------------------------------------

describe('classifyPr — acceptable-review rules (row 6)', () => {
  test('an author self-review does not satisfy row 6', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ authorLogin: 'pr-author' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a bot skip/failure notice does not satisfy row 7 (skipPatterns)', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'CodeRabbit skipped this run because of a configuration error.',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a SPLIT-LINE bot notice ("CodeRabbit" alone on its line, verb on the next) is not a review', () => {
    // Round 3: the bounded window spans line breaks ([\s\S]{0,80}, kept in
    // sync with ws-e's copy) — the split rendering does not dodge the skip
    // screen.
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'CodeRabbit\nskipped this run',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a DISMISSED review does not satisfy row 6 (voided verdict)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'DISMISSED' })] }),
      SETTLED_MS,
    );
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a non-author BOT review DOES satisfy row 6 (no reviewer privileged)', () => {
    const result = classifyPr(
      candidate({
        reviews: [
          approved({
            authorLogin: 'coderabbitai[bot]',
            state: 'COMMENTED',
            body: 'reviewed the diff and left two nitpicks.',
          }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('a null-authorLogin review DOES satisfy row 6 (external — fail toward accepting)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ authorLogin: null })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test("the author's own unresolved thread does not block (row 5 excludes the PR author)", () => {
    const result = classifyPr(
      settleCandidate({ threads: [thread({ authorLogin: 'pr-author' })] }),
      SETTLED_MS,
    );
    expect(result.unresolvedExternalThreads).toBe(0);
    expect(result.reason).toBe('settle_window_elapsed');
  });
});

// ---------------------------------------------------------------------------
// Acceptance VERDICTS (row 6) — only APPROVED/COMMENTED carry evidence
// ---------------------------------------------------------------------------

describe('classifyPr — acceptance states (row 7)', () => {
  test('a post-commit COMMENTED review IS acceptable (control: the settle flow works)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'COMMENTED' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });

  test('a null-state review never counts (fail toward awaiting)', () => {
    const result = classifyPr(candidate({ reviews: [approved({ state: null })] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });
});

// ---------------------------------------------------------------------------
// Config overrides — policy is data; the defaults stay untouched
// ---------------------------------------------------------------------------

describe('classifyPr — config overrides (the R3 seam)', () => {
  test('settleWindowMs: 1 flips pending→eligible at a nowMs where the default is still pending', () => {
    const c = settleCandidate();
    const nowMs = LAST_COMMIT_MS + 1;
    expect(classifyPr(c, nowMs).reason).toBe('settle_window_pending');
    const overridden = classifyPr(c, nowMs, { ...defaultClassifyPrConfig, settleWindowMs: 1 });
    expect(overridden.verdict).toBe('eligible');
    expect(overridden.reason).toBe('settle_window_elapsed');
  });

  test('a custom allClearPattern matches a body the default ignores', () => {
    const c = settleCandidate({ reviews: [approved({ body: 'SHIPIT' })] });
    expect(classifyPr(c, PENDING_MS).reason).toBe('settle_window_pending');
    const overridden = classifyPr(c, PENDING_MS, {
      ...defaultClassifyPrConfig,
      allClearPattern: /shipit/i,
    });
    expect(overridden.verdict).toBe('eligible');
    expect(overridden.reason).toBe('explicit_all_clear');
  });

  test('a /g-flagged allClearPattern override classifies identically across three consecutive calls', () => {
    // A /g RegExp keeps lastIndex across .test() calls; the read site must
    // strip it (evalPattern) so repeated classification stays pure. The
    // pattern keeps its `i` flag — stripping removes only g/y.
    const c = settleCandidate({ reviews: [approved({ body: 'SHIPIT' })] });
    const overridden = { ...defaultClassifyPrConfig, allClearPattern: /shipit/gi };
    const expected = {
      verdict: 'eligible',
      reason: 'explicit_all_clear',
      unresolvedExternalThreads: 0,
    };
    for (let i = 0; i < 3; i++) {
      expect(classifyPr(c, PENDING_MS, overridden)).toEqual(expected);
    }
  });

  test('an override call does not mutate defaultClassifyPrConfig', () => {
    const snapshot = (): string =>
      JSON.stringify({
        settleWindowMs: defaultClassifyPrConfig.settleWindowMs,
        allClearPattern: defaultClassifyPrConfig.allClearPattern.source,
        skipPatterns: defaultClassifyPrConfig.skipPatterns.map((p) => p.source),
      });
    const before = snapshot();
    classifyPr(settleCandidate(), PENDING_MS, {
      ...defaultClassifyPrConfig,
      settleWindowMs: 1,
      allClearPattern: /shipit/i,
    });
    expect(snapshot()).toBe(before);
    expect(defaultClassifyPrConfig.settleWindowMs).toBe(REVIEW_ACCEPT_SETTLE_MS);
  });
});

// ---------------------------------------------------------------------------
// Row 2 scope — DIRTY conflicts; UNKNOWN/BLOCKED fail closed; only
// CLEAN/BEHIND/HAS_HOOKS reach the evidence rows
// ---------------------------------------------------------------------------

describe('classifyPr — merge states (row 2)', () => {
  test.each(['BEHIND', 'CLEAN', 'HAS_HOOKS'] as const)(
    'mergeState %s reaches the evidence rows (eligible via settle, never a state row)',
    (mergeState) => {
      const result = classifyPr(settleCandidate({ mergeState }), SETTLED_MS);
      expect(result.verdict).toBe('eligible');
      expect(result.reason).toBe('settle_window_elapsed');
    },
  );

  test.each([
    { state: 'UNKNOWN', reason: 'merge_state_ambiguous' },
    { state: 'BLOCKED', reason: 'merge_state_blocked' },
  ] as const)('mergeState $state fails closed to awaiting', ({ state, reason }) => {
    // GitHub could not determine mergeability / branch protection unmet —
    // neither may ever be read as mergeable, whatever the reviews say.
    const result = classifyPr(settleCandidate({ mergeState: state }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe(reason);
  });
});

// ---------------------------------------------------------------------------
// Row 6 — an outstanding objection is not silence (NOTHING MERGES UNINVITED)
// ---------------------------------------------------------------------------

describe('classifyPr — outstanding objections (row 6, merge_objection_outstanding)', () => {
  test('post-commit CHANGES_REQUESTED + post-commit APPROVED + settle elapsed → awaiting', () => {
    // The exact mixed case: an approval cannot carry a PR that also
    // carries an open objection — the objection must be resolved first.
    const result = classifyPr(
      candidate({
        reviews: [
          approved({ state: 'CHANGES_REQUESTED', body: 'the retry loop can spin forever' }),
          approved({ id: 'PRR_2' }),
        ],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('a post-commit CHANGES_REQUESTED review alone → awaiting (merge_objection_outstanding)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'CHANGES_REQUESTED' })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('CHANGES_REQUESTED + settle fully elapsed → STILL awaiting (settle never cures an open objection)', () => {
    const result = classifyPr(
      candidate({ reviews: [approved({ state: 'CHANGES_REQUESTED' })] }),
      SETTLED_MS + REVIEW_ACCEPT_SETTLE_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('merge_objection_outstanding');
  });

  test('a CHANGES_REQUESTED submitted pre-commit does NOT trigger (same temporal screen)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ state: 'CHANGES_REQUESTED', submittedAt: BEFORE_COMMIT })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('a CHANGES_REQUESTED by the PR author does not trigger (non-author rule)', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ state: 'CHANGES_REQUESTED', authorLogin: 'pr-author' })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('withdrawn — the verdict flips to APPROVED and the objection stops blocking', () => {
    const result = classifyPr(
      candidate({
        reviews: [approved({ body: 'withdrawing my objection — resolved upstream' })],
      }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
    expect(result.reason).toBe('settle_window_elapsed');
  });
});
