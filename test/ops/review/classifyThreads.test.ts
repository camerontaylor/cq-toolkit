// E2 slice 1 — tests for the classifyThreads pure decision table
// (src/ops/review/classifyThreads.ts + classify.config.ts), round 1.
//
// Pinned here:
//   1. The FULL decision table, one test per row (rows 1–15 of the module
//      doc): threads (resolved / responder-authored / bot-skip / outdated /
//      responder-last-word / fallback), reviews (responder-authored /
//      bot-skip / dismissed / already-answered / empty-body triple —
//      approval_no_body | commented_no_body | empty_summary_no_state — /
//      fallback), top-level comments (responder-authored / bot-skip /
//      fallback).
//   2. Row-order precedence: threads (resolved beats outdated 1 > 4;
//      responder-authored beats bot-skip and outdated 2 > 3, 2 > 4) and
//      reviews (responder-authored beats bot-skip and dismissed 7 > 8, 7 > 9;
//      bot-skip beats dismissed 8 > 9; dismissed beats answered 9 > 10;
//      dismissed beats the approval/empty row 9 > 11).
//   3. Truncation propagation: truncated/truncatedBecause are copied
//      VERBATIM (defensively cloned) from the fetched state — consumers
//      must consult the flag before dispatching batches (a
//      reviewThreads.lag fetch means fresh threads are missing from the
//      verdict set; fail closed downstream).
//   4. Null handling: null/unparseable timestamps fall back per
//      config.treatNullCreatedAtAs (both values) where timestamps ORDER
//      things; a null authorLogin is never the responder (fails toward
//      actionable); a null responder matches nobody.
//   5. Two verdicts demand a REAL reply timestamp: ANSWERING a review
//      (row 10) and a thread's LAST WORD (row 5) — a null/unparseable
//      reply never speaks (fails toward actionable), under either
//      treatNullCreatedAtAs value. Summary-answer evidence is TOP-LEVEL
//      issue comments ONLY (restIssueComments): thread replies
//      (restReviewComments) answer threads via row 5 and never void a
//      review summary.
//   6. nowMs is the ONLY clock: moving the injected nowMs moves the
//      null-submittedAt fallback and thread last-word ordering.
//   7. Both-values coverage for the flip-able config flags
//      (blockOnOutdatedThreads, skipResponderAuthoredThreads,
//      skipDismissedReviews, skipApprovalReviews), mirroring the timestamp
//      pair style.
//   8. config.responderIs is REAL: the 'pr-author' value selects
//      state.authorLogin via the exhaustive switch.
//   9. Every default skipPattern fires on its bot-anchored phrasing class
//      and none fires on human sentences ("review failed to consider",
//      "I'm not reviewing the migrations this pass").
//  10. A single state exercises all five frozen verdicts.
//
// Pure data tests: no gh, no I/O, no clocks — instant by construction.
import { describe, expect, test } from 'vitest';
import { defaultClassifyConfig } from '../../../src/ops/review/classify.config.js';
import { classifyThreads } from '../../../src/ops/review/classifyThreads.js';
import type { ClassifiedItem } from '../../../src/ops/review/classifyThreads.js';
import type { FetchedReviewState } from '../../../src/ops/review/fetchReviewState.js';
import type { RestComment, ReviewSummary, ReviewThread } from '../../../src/ops/review/threads.js';

// ---------------------------------------------------------------------------
// Fixtures + helpers
// ---------------------------------------------------------------------------

/** The injected clock: 2026-06-01T00:00:00Z. */
const NOW = Date.parse('2026-06-01T00:00:00Z');
const T0 = '2026-01-01T00:00:00Z';
const T1 = '2026-02-01T00:00:00Z';
const T2 = '2026-03-01T00:00:00Z';
const T3 = '2026-04-01T00:00:00Z';

/** A minimal FetchedReviewState: responder is 'pr-author', all else empty. */
const baseState = (extra?: Partial<FetchedReviewState>): FetchedReviewState => ({
  repo: { owner: 'octo', name: 'repo' },
  pr: 7,
  authorLogin: 'pr-author',
  headRefName: 'feature',
  headRefOid: 'abc123',
  threads: [],
  reviews: [],
  restReviewComments: [],
  restIssueComments: [],
  truncated: false,
  truncatedBecause: [],
  ...extra,
});

/** An unresolved, fresh, external-reviewer thread, overridable per field. */
const thread = (extra?: Partial<ReviewThread>): ReviewThread => ({
  id: 'PRRT_1',
  rootDatabaseId: 100,
  path: 'src/a.ts',
  line: 1,
  isResolved: false,
  isOutdated: false,
  authorLogin: 'reviewer',
  createdAt: T0,
  body: 'Please fix this',
  replies: [],
  ...extra,
});

/** A standalone review summary, overridable per field. */
const review = (extra?: Partial<ReviewSummary>): ReviewSummary => ({
  id: 'PRR_1',
  authorLogin: 'reviewer',
  state: 'COMMENTED',
  body: 'Please adjust the approach',
  submittedAt: T1,
  ...extra,
});

/** A REST comment (review or issue collection), overridable per field. */
const restComment = (extra?: Partial<RestComment>): RestComment => ({
  id: 500,
  nodeId: 'PRRC_500',
  authorLogin: 'maintainer',
  body: 'A conversation comment',
  createdAt: T1,
  inReplyToId: null,
  ...extra,
});

/** The replies array literal type threads carry. */
const said = (author: string | null, at: string | null, body = 'a reply') => ({
  authorLogin: author,
  body,
  createdAt: at,
});

/** Items-only view of the classify result — the assertion workhorse. The
 * truncation flag is asserted separately (see the truncation describe). */
const itemsOf = (
  state: FetchedReviewState,
  nowMs: number = NOW,
  config?: ClassifyConfigOf,
): ClassifiedItem[] => classifyThreads(state, nowMs, config).items;

/** Keep the config type import-free at the call sites. */
type ClassifyConfigOf = Parameters<typeof classifyThreads>[2];

// ---------------------------------------------------------------------------
// The decision table — rows 1–15, one test each (16 cases: row 11 carries
// two case flavors, APPROVED and null-state; COMMENTED/CHANGES_REQUESTED
// arms live in the approval describe below)
// ---------------------------------------------------------------------------

interface RowCase {
  name: string;
  state: FetchedReviewState;
  expected: ClassifiedItem[];
}

const ROW_CASES: RowCase[] = [
  {
    name: 'row 1 — a resolved thread → resolved (thread_resolved)',
    state: baseState({ threads: [thread({ id: 'T1', isResolved: true })] }),
    expected: [
      { kind: 'thread', id: 'T1', verdict: 'resolved', path: 'src/a.ts', reason: 'thread_resolved' },
    ],
  },
  {
    name: 'row 2 — a thread the responder authored → skip (responder_authored)',
    state: baseState({ threads: [thread({ id: 'T2', authorLogin: 'pr-author' })] }),
    expected: [
      { kind: 'thread', id: 'T2', verdict: 'skip', path: 'src/a.ts', reason: 'responder_authored' },
    ],
  },
  {
    name: 'row 3 — a thread whose root body is a bot skip notice → skip (bot_skip_notice)',
    state: baseState({ threads: [thread({ id: 'T3', body: 'CodeRabbit skipped this run' })] }),
    expected: [
      { kind: 'thread', id: 'T3', verdict: 'skip', path: 'src/a.ts', reason: 'bot_skip_notice' },
    ],
  },
  {
    name: 'row 4 — an outdated unresolved thread → blocked (outdated_unresolved)',
    state: baseState({ threads: [thread({ id: 'T4', isOutdated: true })] }),
    expected: [
      { kind: 'thread', id: 'T4', verdict: 'blocked', path: 'src/a.ts', reason: 'outdated_unresolved' },
    ],
  },
  {
    name: 'row 5 — the responder holds the last reply → responded (responder_last_word)',
    state: baseState({
      threads: [
        thread({
          id: 'T5',
          replies: [said('reviewer', T1, 'question'), said('pr-author', T2, 'fixed')],
        }),
      ],
    }),
    expected: [
      { kind: 'thread', id: 'T5', verdict: 'responded', path: 'src/a.ts', reason: 'responder_last_word' },
    ],
  },
  {
    name: 'row 6 — an unresolved external thread → actionable (thread_needs_response)',
    state: baseState({ threads: [thread({ id: 'T6' })] }),
    expected: [
      { kind: 'thread', id: 'T6', verdict: 'actionable', path: 'src/a.ts', reason: 'thread_needs_response' },
    ],
  },
  {
    name: 'row 7 — a review authored by the responder → skip (responder_authored)',
    state: baseState({ reviews: [review({ id: 'R7', authorLogin: 'pr-author' })] }),
    expected: [{ kind: 'review', id: 'R7', verdict: 'skip', path: null, reason: 'responder_authored' }],
  },
  {
    name: 'row 8 — a review whose body is a bot failure notice → skip (bot_skip_notice)',
    state: baseState({
      reviews: [review({ id: 'R8', body: 'CodeRabbit failed to complete: error after 3 attempts' })],
    }),
    expected: [{ kind: 'review', id: 'R8', verdict: 'skip', path: null, reason: 'bot_skip_notice' }],
  },
  {
    name: 'row 9 — a DISMISSED review → skip (review_dismissed)',
    state: baseState({ reviews: [review({ id: 'R9', state: 'DISMISSED' })] }),
    expected: [{ kind: 'review', id: 'R9', verdict: 'skip', path: null, reason: 'review_dismissed' }],
  },
  {
    name: 'row 10 — a responder TOP-LEVEL issue comment postdates the review → skip (review_already_answered)',
    state: baseState({
      reviews: [review({ id: 'R10', body: 'Please change X', submittedAt: T1 })],
      restIssueComments: [restComment({ id: 501, authorLogin: 'pr-author', createdAt: T2 })],
    }),
    expected: [
      { kind: 'review', id: 'R10', verdict: 'skip', path: null, reason: 'review_already_answered' },
      // The answer itself also classifies (row 13: the responder's own
      // comment is not feedback).
      { kind: 'comment', id: '501', verdict: 'skip', path: null, reason: 'responder_authored' },
    ],
  },
  {
    name: 'row 11 (APPROVED) — an approval with an EMPTY body → skip (approval_no_body)',
    state: baseState({ reviews: [review({ id: 'R11a', state: 'APPROVED', body: '' })] }),
    expected: [
      { kind: 'review', id: 'R11a', verdict: 'skip', path: null, reason: 'approval_no_body' },
    ],
  },
  {
    name: 'row 11 (null state) — a stateless review with an EMPTY body → skip (empty_summary_no_state)',
    state: baseState({ reviews: [review({ id: 'R11b', state: null, body: '   ' })] }),
    expected: [
      { kind: 'review', id: 'R11b', verdict: 'skip', path: null, reason: 'empty_summary_no_state' },
    ],
  },
  {
    name: 'row 12 — a plain review summary → actionable (review_summary_needs_response)',
    state: baseState({ reviews: [review({ id: 'R12', body: 'Please add a test' })] }),
    expected: [
      { kind: 'review', id: 'R12', verdict: 'actionable', path: null, reason: 'review_summary_needs_response' },
    ],
  },
  {
    name: 'row 13 — a conversation comment the responder authored → skip (responder_authored)',
    state: baseState({
      restIssueComments: [restComment({ id: 601, authorLogin: 'pr-author' })],
    }),
    expected: [{ kind: 'comment', id: '601', verdict: 'skip', path: null, reason: 'responder_authored' }],
  },
  {
    name: 'row 14 — a conversation comment matching a skip pattern → skip (bot_skip_notice)',
    state: baseState({
      restIssueComments: [restComment({ id: 602, body: 'CodeRabbit is skipping this draft' })],
    }),
    expected: [{ kind: 'comment', id: '602', verdict: 'skip', path: null, reason: 'bot_skip_notice' }],
  },
  {
    name: 'row 15 — a plain top-level comment → actionable (top_level_summary)',
    state: baseState({
      restIssueComments: [restComment({ id: 603, body: 'Overall: please split this module' })],
    }),
    expected: [
      { kind: 'comment', id: '603', verdict: 'actionable', path: null, reason: 'top_level_summary' },
    ],
  },
];

describe('classifyThreads decision table', () => {
  test.each(ROW_CASES)('$name', ({ state, expected }) => {
    expect(itemsOf(state)).toEqual(expected);
  });
});

// ---------------------------------------------------------------------------
// Truncation propagation (fail closed before dispatching batches)
// ---------------------------------------------------------------------------

describe('truncation flag propagation', () => {
  test('truncated/truncatedBecause are copied VERBATIM (defensively cloned) from the fetched state', () => {
    const state = baseState({ truncated: true, truncatedBecause: ['reviewThreads.lag'] });
    const result = classifyThreads(state, NOW);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBecause).toEqual(['reviewThreads.lag']);
    // Verbatim content, but a defensive CLONE — mutating the copy cannot
    // corrupt the fetched state's own flag.
    expect(result.truncatedBecause).not.toBe(state.truncatedBecause);
    // The items themselves are unaffected — the flag is the consumer's
    // cue that they may be INCOMPLETE (fresh threads missing).
    expect(result.items).toEqual([]);
  });

  test('a clean fetch carries truncated=false and no reasons', () => {
    const result = classifyThreads(baseState(), NOW);
    expect(result.truncated).toBe(false);
    expect(result.truncatedBecause).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Row-order precedence
// ---------------------------------------------------------------------------

describe('row-order precedence — threads', () => {
  test('row 1 beats row 4 — a resolved outdated thread → resolved, not blocked', () => {
    expect(itemsOf(baseState({ threads: [thread({ id: 'TP1', isResolved: true, isOutdated: true })] }))).toEqual([
      { kind: 'thread', id: 'TP1', verdict: 'resolved', path: 'src/a.ts', reason: 'thread_resolved' },
    ]);
  });

  test('row 2 beats row 4 — an outdated responder-authored thread → skip, not blocked', () => {
    expect(
      itemsOf(baseState({ threads: [thread({ id: 'TP2', authorLogin: 'pr-author', isOutdated: true })] })),
    ).toEqual([
      { kind: 'thread', id: 'TP2', verdict: 'skip', path: 'src/a.ts', reason: 'responder_authored' },
    ]);
  });

  test('row 2 beats row 3 — a responder-authored bot-skip body → responder_authored', () => {
    expect(
      itemsOf(
        baseState({
          threads: [thread({ id: 'TP3', authorLogin: 'pr-author', body: 'CodeRabbit skipped this run' })],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TP3', verdict: 'skip', path: 'src/a.ts', reason: 'responder_authored' },
    ]);
  });

  test('row 5 only fires when the responder holds the LAST word — reviewer last → actionable', () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({ id: 'TP4', replies: [said('pr-author', T1, 'fixed'), said('reviewer', T2, 'still broken')] }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TP4', verdict: 'actionable', path: 'src/a.ts', reason: 'thread_needs_response' },
    ]);
  });

  test('row 3 beats row 4 — a bot-notice body on an OUTDATED thread → skip, not blocked', () => {
    expect(
      itemsOf(
        baseState({
          threads: [thread({ id: 'TP5', isOutdated: true, body: 'CodeRabbit skipped this run' })],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TP5', verdict: 'skip', path: 'src/a.ts', reason: 'bot_skip_notice' },
    ]);
  });

  test('row 4 beats row 5 — an OUTDATED thread where the responder holds the last word → blocked, not responded', () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({ id: 'TP6', isOutdated: true, replies: [said('reviewer', T1), said('pr-author', T2)] }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TP6', verdict: 'blocked', path: 'src/a.ts', reason: 'outdated_unresolved' },
    ]);
  });
});

describe('row-order precedence — reviews (documented ordering)', () => {
  test('row 7 precedes rows 8–9 — a DISMISSED responder-authored review → responder_authored', () => {
    // Documented call: authorship settles it first — the responder's own
    // review is not outstanding feedback no matter what it carries.
    expect(
      itemsOf(
        baseState({ reviews: [review({ id: 'RP1', authorLogin: 'pr-author', state: 'DISMISSED' })] }),
      ),
    ).toEqual([{ kind: 'review', id: 'RP1', verdict: 'skip', path: null, reason: 'responder_authored' }]);
  });

  test('row 7 precedes row 8 — a responder-authored review with a bot-notice body → responder_authored', () => {
    expect(
      itemsOf(
        baseState({
          reviews: [review({ id: 'RP2', authorLogin: 'pr-author', body: 'CodeRabbit skipped this run' })],
        }),
      ),
    ).toEqual([{ kind: 'review', id: 'RP2', verdict: 'skip', path: null, reason: 'responder_authored' }]);
  });

  test('row 8 precedes row 9 — a DISMISSED review with a bot-notice body → bot_skip_notice', () => {
    expect(
      itemsOf(
        baseState({
          reviews: [review({ id: 'RP3', state: 'DISMISSED', body: 'CodeRabbit skipped this run' })],
        }),
      ),
    ).toEqual([{ kind: 'review', id: 'RP3', verdict: 'skip', path: null, reason: 'bot_skip_notice' }]);
  });

  test('row 9 precedes row 10 — a dismissed review with a postdating responder reply → review_dismissed', () => {
    // Documented call: a voided review stays void regardless of reply
    // timing — dismissal answers the "should anyone act on this" question
    // more strongly than a reply does. (The reply is real row-10 evidence
    // — a top-level issue comment — so the precedence is genuinely
    // exercised.)
    expect(
      itemsOf(
        baseState({
          reviews: [review({ id: 'RP4', state: 'DISMISSED', submittedAt: T1 })],
          restIssueComments: [restComment({ id: 511, authorLogin: 'pr-author', createdAt: T2 })],
        }),
      ),
    ).toEqual([
      { kind: 'review', id: 'RP4', verdict: 'skip', path: null, reason: 'review_dismissed' },
      // The evidence comment itself classifies too (row 13).
      { kind: 'comment', id: '511', verdict: 'skip', path: null, reason: 'responder_authored' },
    ]);
  });

  test('row 9 precedes row 11 — a dismissed EMPTY-body review → review_dismissed, not empty_summary_no_state', () => {
    // Dismissal is the stronger void: it answers "should anyone act on
    // this" before the emptiness check (row 11) is ever consulted.
    expect(
      itemsOf(
        baseState({ reviews: [review({ id: 'RP5', state: 'DISMISSED', body: '' })] }),
      ),
    ).toEqual([{ kind: 'review', id: 'RP5', verdict: 'skip', path: null, reason: 'review_dismissed' }]);
  });

  test('row 11 sits before the fallback — a NON-empty APPROVED body → actionable, not skipped', () => {
    // Fails toward action: an approver may have noted follow-ups in the
    // body, so a text-carrying approval stays on the content rows.
    expect(
      itemsOf(
        baseState({ reviews: [review({ id: 'RP6', state: 'APPROVED', body: 'Approved — but please tighten the retry cap next time.' })] }),
      ),
    ).toEqual([
      {
        kind: 'review',
        id: 'RP6',
        verdict: 'actionable',
        path: null,
        reason: 'review_summary_needs_response',
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Null timestamps fall back per treatNullCreatedAtAs (ordering uses)
// ---------------------------------------------------------------------------

describe('null timestamps fall back per treatNullCreatedAtAs', () => {
  test("default 'nowMs': a null-createdAt responder reply is NO ONE'S word — actionable (flips the old responded pin)", () => {
    // The null reply still ORDERS last (nowMs fallback), but a last word
    // needs a REAL parsed timestamp (row 5) — so it falls through.
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'TN1', replies: [said('reviewer', T2), said('pr-author', null)] })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('thread_needs_response');
  });

  test("'epochMs': the same null-createdAt reply counts as ancient — reviewer last word → actionable", () => {
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'TN2', replies: [said('reviewer', T2), said('pr-author', null)] })],
      }),
      NOW,
      { ...defaultClassifyConfig, treatNullCreatedAtAs: 'epochMs' },
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('thread_needs_response');
  });

  test("default 'nowMs': an unparseable last reply is equally NO ONE'S word — actionable", () => {
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'TN3', replies: [said('reviewer', T2), said('pr-author', 'not-a-date')] })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('thread_needs_response');
  });

  test("'epochMs': an unparseable createdAt behaves like null — reviewer last word → actionable", () => {
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'TN4', replies: [said('reviewer', T2), said('pr-author', 'not-a-date')] })],
      }),
      NOW,
      { ...defaultClassifyConfig, treatNullCreatedAtAs: 'epochMs' },
    );
    expect(items[0]?.verdict).toBe('actionable');
  });

  test("default 'nowMs': null review submittedAt is NOW, so a past responder reply does NOT answer it → actionable", () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RN1', submittedAt: null })],
        restIssueComments: [restComment({ id: 512, authorLogin: 'pr-author', createdAt: T1 })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test("'epochMs': null review submittedAt is 0, so the same reply DOES postdate it → skip", () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RN2', submittedAt: null })],
        restIssueComments: [restComment({ id: 513, authorLogin: 'pr-author', createdAt: T1 })],
      }),
      NOW,
      { ...defaultClassifyConfig, treatNullCreatedAtAs: 'epochMs' },
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('review_already_answered');
  });

  test('strictly-greater rule — equal timestamps do not count as answered', () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RN3', submittedAt: T1 })],
        restIssueComments: [restComment({ id: 514, authorLogin: 'pr-author', createdAt: T1 })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });
});

// ---------------------------------------------------------------------------
// Answering requires a REAL reply timestamp (fails toward actionable)
// ---------------------------------------------------------------------------

describe('answering requires a real reply timestamp', () => {
  test('a null-createdAt reply NEVER answers — the same state stays actionable whatever nowMs is', () => {
    const state = baseState({
      reviews: [review({ id: 'RW1', body: 'Please change X', submittedAt: T2 })],
      restIssueComments: [restComment({ id: 521, authorLogin: 'pr-author', createdAt: null })],
    });
    // nowMs after the review: the ordering fallback alone would have made
    // this "answered" under the old code — flipped: an un-timestamped
    // reply is no answer.
    const after = itemsOf(state, Date.parse(T3));
    expect(after[0]).toEqual({
      kind: 'review',
      id: 'RW1',
      verdict: 'actionable',
      path: null,
      reason: 'review_summary_needs_response',
    });
    // nowMs before the review: equally actionable.
    const before = itemsOf(state, Date.parse(T1));
    expect(before[0]?.reason).toBe('review_summary_needs_response');
  });

  test('an unparseable reply createdAt does not answer → actionable', () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RW2', submittedAt: T1 })],
        restIssueComments: [restComment({ id: 522, authorLogin: 'pr-author', createdAt: 'not-a-date' })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test("'epochMs': an unparseable/null reply falls to 0 — likewise never postdates a past review → actionable", () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RW3', submittedAt: T1 })],
        restIssueComments: [restComment({ id: 523, authorLogin: 'pr-author', createdAt: null })],
      }),
      NOW,
      { ...defaultClassifyConfig, treatNullCreatedAtAs: 'epochMs' },
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test('a REAL postdating reply still answers — the control case → skip', () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RW4', submittedAt: T2 })],
        restIssueComments: [restComment({ id: 524, authorLogin: 'pr-author', createdAt: T3 })],
      }),
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('review_already_answered');
  });

  test('row 5 mirror — a null-timestamp responder reply plus an earlier REAL reviewer reply → actionable', () => {
    // The responder's null-createdAt reply even ORDERS last under 'nowMs'
    // — but without a real parsed timestamp it is no one's word (row 5),
    // so the thread fails through to actionable.
    const items = itemsOf(
      baseState({
        threads: [
          thread({ id: 'RW5', replies: [said('pr-author', null, 'fixed'), said('reviewer', T2, 'bumping')] }),
        ],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('thread_needs_response');
  });

  test('row 5 control — a REAL responder last reply still → responded', () => {
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'RW6', replies: [said('reviewer', T1), said('pr-author', T2)] })],
      }),
    );
    expect(items[0]?.verdict).toBe('responded');
    expect(items[0]?.reason).toBe('responder_last_word');
  });
});

// ---------------------------------------------------------------------------
// Summary-answer evidence is TOP-LEVEL issue comments ONLY (row 10):
// thread replies (restReviewComments) address threads via row 5 and never
// void a review summary — otherwise one late reply would fail-open every
// older unaddressed summary.
// ---------------------------------------------------------------------------

describe('the answer scan covers TOP-LEVEL issue comments only', () => {
  test('a responder answer in restIssueComments → the review skips (review_already_answered)', () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RC1', submittedAt: T1 })],
        restIssueComments: [restComment({ id: 641, authorLogin: 'pr-author', createdAt: T2 })],
      }),
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('review_already_answered');
  });

  test('a postdating comment by SOMEONE ELSE in the issue collection → still actionable', () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RC2', submittedAt: T1 })],
        restIssueComments: [restComment({ id: 643, authorLogin: 'passerby', createdAt: T3 })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test('multi-round — a late responder THREAD reply does NOT void the older unaddressed summary', () => {
    // Review A is older and unaddressed; review B is newer. The only
    // responder activity is a THREAD reply (restReviewComments), which
    // answers its thread (row 5's business) — under the old either-
    // collection scope it would have voided BOTH summaries (fail-open).
    const items = itemsOf(
      baseState({
        reviews: [
          review({ id: 'R-old', body: 'Please fix X', submittedAt: T1 }),
          review({ id: 'R-new', body: 'Please fix Y', submittedAt: T3 }),
        ],
        restReviewComments: [restComment({ id: 644, authorLogin: 'pr-author', createdAt: T3 })],
      }),
    );
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    // A: stays actionable — thread replies are not summary evidence.
    expect(byId.get('R-old')?.verdict).toBe('actionable');
    expect(byId.get('R-old')?.reason).toBe('review_summary_needs_response');
    // B: judged on its OWN evidence — none postdates it either → actionable.
    expect(byId.get('R-new')?.verdict).toBe('actionable');
    expect(byId.get('R-new')?.reason).toBe('review_summary_needs_response');
  });

  test('multi-round control — a responder TOP-LEVEL issue comment postdating review A → A skips', () => {
    const items = itemsOf(
      baseState({
        reviews: [
          review({ id: 'R-old2', body: 'Please fix X', submittedAt: T1 }),
          review({ id: 'R-new2', body: 'Please fix Y', submittedAt: T3 }),
        ],
        restIssueComments: [restComment({ id: 645, authorLogin: 'pr-author', createdAt: T2 })],
      }),
    );
    const byId = new Map(items.map((entry) => [entry.id, entry]));
    // A: the postdating top-level answer is real evidence → skip.
    expect(byId.get('R-old2')?.verdict).toBe('skip');
    expect(byId.get('R-old2')?.reason).toBe('review_already_answered');
    // B: submitted after the answer → per its own evidence, outstanding.
    expect(byId.get('R-new2')?.verdict).toBe('actionable');
    expect(byId.get('R-new2')?.reason).toBe('review_summary_needs_response');
  });
});

// ---------------------------------------------------------------------------
// Null authorLogin is never the responder (fails toward actionable)
// ---------------------------------------------------------------------------

describe('null authorLogin is never the responder (fails toward actionable)', () => {
  test('a null-author thread is external — actionable, not skipped', () => {
    expect(itemsOf(baseState({ threads: [thread({ id: 'TA1', authorLogin: null })] }))).toEqual([
      { kind: 'thread', id: 'TA1', verdict: 'actionable', path: 'src/a.ts', reason: 'thread_needs_response' },
    ]);
  });

  test('a null-author last reply is not the responder\'s word — actionable, not responded', () => {
    const items = itemsOf(
      baseState({ threads: [thread({ id: 'TA2', replies: [said(null, T2)] })] }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('thread_needs_response');
  });

  test('a null-author conversation comment is external — actionable, not skipped', () => {
    const items = itemsOf(
      baseState({ restIssueComments: [restComment({ id: 611, authorLogin: null })] }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('top_level_summary');
  });

  test('a null responder (deleted PR author) matches nobody — everything stays actionable', () => {
    expect(
      itemsOf(
        baseState({
          authorLogin: null,
          threads: [thread({ id: 'TA3', authorLogin: null })],
          restIssueComments: [restComment({ id: 612, authorLogin: null })],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TA3', verdict: 'actionable', path: 'src/a.ts', reason: 'thread_needs_response' },
      { kind: 'comment', id: '612', verdict: 'actionable', path: null, reason: 'top_level_summary' },
    ]);
  });

  test('a null-author review is external — actionable, not skipped', () => {
    const items = itemsOf(
      baseState({ reviews: [review({ id: 'TA4', authorLogin: null })] }),
    );
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });
});

// ---------------------------------------------------------------------------
// Both-values config coverage (mirrors the timestamp pair style)
// ---------------------------------------------------------------------------

describe('both-values config coverage', () => {
  test.each([
    { flag: true, verdict: 'blocked', reason: 'outdated_unresolved' },
    { flag: false, verdict: 'actionable', reason: 'thread_needs_response' },
  ])(
    'blockOnOutdatedThreads=$flag — an outdated unresolved thread → $verdict ($reason)',
    ({ flag, verdict, reason }) => {
      expect(
        itemsOf(
          baseState({ threads: [thread({ id: 'TB1', isOutdated: true })] }),
          NOW,
          { ...defaultClassifyConfig, blockOnOutdatedThreads: flag },
        ),
      ).toEqual([{ kind: 'thread', id: 'TB1', verdict, path: 'src/a.ts', reason }]);
    },
  );

  test.each([
    { flag: true, verdict: 'skip', reason: 'responder_authored' },
    { flag: false, verdict: 'actionable', reason: 'thread_needs_response' },
  ])(
    'skipResponderAuthoredThreads=$flag — a responder-authored thread → $verdict ($reason)',
    ({ flag, verdict, reason }) => {
      expect(
        itemsOf(
          baseState({ threads: [thread({ id: 'TB2', authorLogin: 'pr-author' })] }),
          NOW,
          { ...defaultClassifyConfig, skipResponderAuthoredThreads: flag },
        ),
      ).toEqual([{ kind: 'thread', id: 'TB2', verdict, path: 'src/a.ts', reason }]);
    },
  );

  test.each([
    { flag: true, verdict: 'skip', reason: 'review_dismissed' },
    { flag: false, verdict: 'actionable', reason: 'review_summary_needs_response' },
  ])(
    'skipDismissedReviews=$flag — a DISMISSED review → $verdict ($reason)',
    ({ flag, verdict, reason }) => {
      expect(
        itemsOf(
          baseState({ reviews: [review({ id: 'TB3', state: 'DISMISSED' })] }),
          NOW,
          { ...defaultClassifyConfig, skipDismissedReviews: flag },
        ),
      ).toEqual([{ kind: 'review', id: 'TB3', verdict, path: null, reason }]);
    },
  );
});

// ---------------------------------------------------------------------------
// Approval / empty-summary reviews (row 11) — both config values
// ---------------------------------------------------------------------------

describe('approval and empty-summary reviews (row 11)', () => {
  test('an APPROVED review with an EMPTY body → skip (approval_no_body)', () => {
    const items = itemsOf(
      baseState({ reviews: [review({ id: 'RA1', state: 'APPROVED', body: '' })] }),
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('approval_no_body');
  });

  test('an APPROVED review with a NON-EMPTY body → actionable (the approver may have noted follow-ups)', () => {
    const items = itemsOf(
      baseState({ reviews: [review({ id: 'RA2', state: 'APPROVED' })] }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test('a null-state review with an EMPTY body → skip (empty_summary_no_state)', () => {
    const items = itemsOf(
      baseState({ reviews: [review({ id: 'RA3', state: null, body: '' })] }),
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('empty_summary_no_state');
  });

  test('a null-state review WITH text → actionable', () => {
    const items = itemsOf(
      baseState({ reviews: [review({ id: 'RA4', state: null })] }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test('a COMMENTED review with an EMPTY body → skip (commented_no_body)', () => {
    const items = itemsOf(
      baseState({ reviews: [review({ id: 'RA6', state: 'COMMENTED', body: '  \n' })] }),
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('commented_no_body');
  });

  test('an EMPTY-body review with state CHANGES_REQUESTED stays ACTIONABLE — the state itself is signal', () => {
    // Documented row-11 choice: requested changes are outstanding work
    // even without accompanying prose — only APPROVED/COMMENTED/null
    // empty bodies skip.
    const items = itemsOf(
      baseState({ reviews: [review({ id: 'RA7', state: 'CHANGES_REQUESTED', body: '' })] }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test.each([
    { flag: true, verdict: 'skip', reason: 'approval_no_body' },
    { flag: false, verdict: 'actionable', reason: 'review_summary_needs_response' },
  ])(
    'skipApprovalReviews=$flag — an empty-body APPROVED review → $verdict ($reason)',
    ({ flag, verdict, reason }) => {
      expect(
        itemsOf(
          baseState({ reviews: [review({ id: 'RA5', state: 'APPROVED', body: '' })] }),
          NOW,
          { ...defaultClassifyConfig, skipApprovalReviews: flag },
        ),
      ).toEqual([{ kind: 'review', id: 'RA5', verdict, path: null, reason }]);
    },
  );

  test.each([
    { flag: true, verdict: 'skip', reason: 'commented_no_body' },
    { flag: false, verdict: 'actionable', reason: 'review_summary_needs_response' },
  ])(
    'skipApprovalReviews=$flag — an empty-body COMMENTED review → $verdict ($reason)',
    ({ flag, verdict, reason }) => {
      expect(
        itemsOf(
          baseState({ reviews: [review({ id: 'RA8', state: 'COMMENTED', body: '' })] }),
          NOW,
          { ...defaultClassifyConfig, skipApprovalReviews: flag },
        ),
      ).toEqual([{ kind: 'review', id: 'RA8', verdict, path: null, reason }]);
    },
  );
});

// ---------------------------------------------------------------------------
// config.responderIs is real (exhaustive switch in the table)
// ---------------------------------------------------------------------------

describe('config.responderIs', () => {
  test("'pr-author' (the only value) selects state.authorLogin as the responder", () => {
    expect(itemsOf(baseState({ threads: [thread({ id: 'TRI1', authorLogin: 'pr-author' })] }))).toEqual([
      { kind: 'thread', id: 'TRI1', verdict: 'skip', path: 'src/a.ts', reason: 'responder_authored' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// skipPatterns — bot-anchored patterns fire; human phrasing never matches
// ---------------------------------------------------------------------------

describe('default skipPatterns', () => {
  test.each([
    ['CodeRabbit skipped', 'CodeRabbit skipped this PR because the diff was empty'],
    ['bot-anchored failure', 'coderabbitai failed to post the review: error 500'],
    ['configuration problem skip', 'configuration problem detected — skipping this run'],
    ['bot self-skip (skipping)', 'CodeRabbit is skipping this PR — no reviewable diff'],
    ['bot self-skip (not reviewing)', 'chatgpt-codex-connector: not reviewing this run'],
  ])('bot-anchored pattern (%s) fires → bot_skip_notice', (_label, body) => {
    expect(itemsOf(baseState({ restIssueComments: [restComment({ id: 621, body })] }))).toEqual([
      { kind: 'comment', id: '621', verdict: 'skip', path: null, reason: 'bot_skip_notice' },
    ]);
  });

  test('a HUMAN sentence containing "review failed to consider" must NOT skip → actionable', () => {
    expect(
      itemsOf(
        baseState({
          threads: [thread({ id: 'TH1', body: 'The review failed to consider the null case — please handle it.' })],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TH1', verdict: 'actionable', path: 'src/a.ts', reason: 'thread_needs_response' },
    ]);
  });

  test('a HYPHENATED tool-name mention ("Codex-style tooling failed us here") must NOT skip → actionable', () => {
    // Round-3 pattern fix: the identity requires a trailing \b AND must
    // not run into a hyphen — \b alone is satisfied before '-', which
    // would read this human sentence as the tool's own failure notice.
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({ id: 'TH3', body: 'Codex-style tooling failed us here — please fix the harness manually.' }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TH3', verdict: 'actionable', path: 'src/a.ts', reason: 'thread_needs_response' },
    ]);
  });

  test("a HUMAN \"I'm not reviewing the migrations this pass, but …\" must NOT skip → actionable", () => {
    expect(
      itemsOf(
        baseState({
          threads: [
            thread({
              id: 'TH2',
              body: "I'm not reviewing the migrations this pass, but the API layer needs a null guard.",
            }),
          ],
        }),
      ),
    ).toEqual([
      { kind: 'thread', id: 'TH2', verdict: 'actionable', path: 'src/a.ts', reason: 'thread_needs_response' },
    ]);
  });

  test('an UNANCHORED bare self-skip sentence (no bot identity) no longer skips → actionable', () => {
    // Pinned round 2: "skipping review"/"not reviewing" phrasing only
    // skips when a bot/tool identity LEADS the line.
    expect(
      itemsOf(
        baseState({ restIssueComments: [restComment({ id: 623, body: 'Skipping review for this draft PR' })] }),
      ),
    ).toEqual([
      { kind: 'comment', id: '623', verdict: 'actionable', path: null, reason: 'top_level_summary' },
    ]);
  });

  test('a normal review body matches no default pattern → stays actionable', () => {
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'TS1', body: 'Please extract this loop into a helper and add a regression test.' })],
        reviews: [review({ id: 'TS2', body: 'The null-handling branch is untested; please add a case.' })],
        restIssueComments: [restComment({ id: 622, body: 'Overall this looks close — one blocking nit below.' })],
      }),
    );
    expect(items.map((item) => item.verdict)).toEqual(['actionable', 'actionable', 'actionable']);
    expect(items.map((item) => item.reason)).toEqual([
      'thread_needs_response',
      'review_summary_needs_response',
      'top_level_summary',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Skip-pattern evaluation is stateless (CodeRabbit thread on this file):
// a config RegExp carrying the `g` or `y` flag mutates lastIndex across
// .test() calls, so a stateful implementation would alternate between
// match and no-match on identical bodies — the table must stay pure.
// ---------------------------------------------------------------------------

describe('skip-pattern evaluation is stateless vs lastIndex', () => {
  /** One shared pattern OBJECT reused across calls — exactly the shape a
   * config-supplied pattern takes, and the shape that goes stateful. */
  const gConfig = { ...defaultClassifyConfig, skipPatterns: [/skipped/g] };
  const yConfig = { ...defaultClassifyConfig, skipPatterns: [/skipped/y] };
  const state = baseState({ threads: [thread({ id: 'TG1', body: 'CodeRabbit skipped this run' })] });
  const expected = [
    { kind: 'thread' as const, id: 'TG1', verdict: 'skip' as const, path: 'src/a.ts', reason: 'bot_skip_notice' },
  ];

  test('a /g config pattern classifies the same body identically across three consecutive calls', () => {
    const runs = [
      itemsOf(state, NOW, gConfig),
      itemsOf(state, NOW, gConfig),
      itemsOf(state, NOW, gConfig),
    ];
    // Without the fresh-expression fix, lastIndex makes the verdicts
    // alternate skip / actionable / skip — every run must be identical.
    expect(runs[0]).toEqual(expected);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });

  test('a /y config pattern classifies the same body identically across three consecutive calls', () => {
    const runs = [
      itemsOf(state, NOW, yConfig),
      itemsOf(state, NOW, yConfig),
      itemsOf(state, NOW, yConfig),
    ];
    // Sticky alone would anchor at lastIndex and never match from an
    // advanced position; stripped, it must behave exactly like the /g case.
    expect(runs[0]).toEqual(expected);
    expect(runs[1]).toEqual(runs[0]);
    expect(runs[2]).toEqual(runs[0]);
  });
});

// ---------------------------------------------------------------------------
// Full verdict coverage in one state
// ---------------------------------------------------------------------------

describe('verdict census', () => {
  test('one state exercises all five frozen verdicts, in threads → reviews → comments order', () => {
    const items = itemsOf(
      baseState({
        threads: [
          thread({ id: 'V-resolved', isResolved: true }),
          thread({ id: 'V-blocked', isOutdated: true }),
          thread({ id: 'V-skip', authorLogin: 'pr-author' }),
          thread({ id: 'V-responded', replies: [said('reviewer', T1), said('pr-author', T2)] }),
          thread({ id: 'V-actionable' }),
        ],
        reviews: [review({ id: 'V-review-actionable', body: 'Please restructure' })],
        restIssueComments: [restComment({ id: 631, body: 'CodeRabbit skipped this run' })],
      }),
    );
    expect(items.map((item) => item.id)).toEqual([
      'V-resolved',
      'V-blocked',
      'V-skip',
      'V-responded',
      'V-actionable',
      'V-review-actionable',
      '631',
    ]);
    // Order-independent census: the five frozen verdicts all occur.
    const verdicts = new Set(items.map((item) => item.verdict));
    expect(verdicts.size).toBe(5);
    for (const verdict of ['actionable', 'responded', 'resolved', 'blocked', 'skip'] as const) {
      expect(verdicts.has(verdict)).toBe(true);
    }
  });
});
