// E2 slice 1 — tests for the classifyThreads pure decision table
// (src/ops/review/classifyThreads.ts + classify.config.ts), round 1.
//
// Pinned here:
//   1. The FULL decision table, one test per row (rows 1–14 of the module
//      doc): threads (resolved / responder-authored / bot-skip / outdated /
//      responder-last-word / fallback), reviews (responder-authored /
//      bot-skip / dismissed / already-answered / fallback), top-level
//      comments (responder-authored / bot-skip / fallback).
//   2. Row-order precedence: threads (resolved beats outdated 1 > 4;
//      responder-authored beats bot-skip and outdated 2 > 3, 2 > 4) and
//      reviews (responder-authored beats bot-skip and dismissed 7 > 8, 7 > 9;
//      bot-skip beats dismissed 8 > 9; dismissed beats answered 9 > 10).
//   3. Truncation propagation: truncated/truncatedBecause are copied
//      VERBATIM from the fetched state — consumers must consult the flag
//      before dispatching batches (a reviewThreads.lag fetch means fresh
//      threads are missing from the verdict set; fail closed downstream).
//   4. Null handling: null/unparseable timestamps fall back per
//      config.treatNullCreatedAtAs (both values) where timestamps ORDER
//      things; a null authorLogin is never the responder (fails toward
//      actionable); a null responder matches nobody.
//   5. Answering needs a REAL reply timestamp: a null/unparseable reply
//      never answers a review (fails toward actionable), under either
//      treatNullCreatedAtAs value — and the answer may live in EITHER
//      comment collection (restReviewComments or restIssueComments).
//   6. nowMs is the ONLY clock: moving the injected nowMs moves the
//      null-submittedAt fallback and thread last-word ordering.
//   7. Both-values coverage for the flip-able config flags
//      (blockOnOutdatedThreads, skipResponderAuthoredThreads,
//      skipDismissedReviews), mirroring the timestamp pair style.
//   8. Every default skipPattern fires on its bot-anchored phrasing class
//      and none fires on a human sentence ("review failed to consider").
//   9. A single state exercises all five frozen verdicts.
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
// The decision table — rows 1–14, one test each
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
    name: 'row 10 — a responder reply postdates the review → skip (review_already_answered)',
    state: baseState({
      reviews: [review({ id: 'R10', body: 'Please change X', submittedAt: T1 })],
      restReviewComments: [restComment({ id: 501, authorLogin: 'pr-author', createdAt: T2 })],
    }),
    expected: [
      { kind: 'review', id: 'R10', verdict: 'skip', path: null, reason: 'review_already_answered' },
    ],
  },
  {
    name: 'row 11 — a plain review summary → actionable (review_summary_needs_response)',
    state: baseState({ reviews: [review({ id: 'R11', body: 'Please add a test' })] }),
    expected: [
      { kind: 'review', id: 'R11', verdict: 'actionable', path: null, reason: 'review_summary_needs_response' },
    ],
  },
  {
    name: 'row 12 — a conversation comment the responder authored → skip (responder_authored)',
    state: baseState({
      restIssueComments: [restComment({ id: 601, authorLogin: 'pr-author' })],
    }),
    expected: [{ kind: 'comment', id: '601', verdict: 'skip', path: null, reason: 'responder_authored' }],
  },
  {
    name: 'row 13 — a conversation comment matching a skip pattern → skip (bot_skip_notice)',
    state: baseState({
      restIssueComments: [restComment({ id: 602, body: 'Skipping review for this draft' })],
    }),
    expected: [{ kind: 'comment', id: '602', verdict: 'skip', path: null, reason: 'bot_skip_notice' }],
  },
  {
    name: 'row 14 — a plain top-level comment → actionable (top_level_summary)',
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
  test('truncated/truncatedBecause are copied VERBATIM from the fetched state', () => {
    const state = baseState({ truncated: true, truncatedBecause: ['reviewThreads.lag'] });
    const result = classifyThreads(state, NOW);
    expect(result.truncated).toBe(true);
    expect(result.truncatedBecause).toEqual(['reviewThreads.lag']);
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
    // more strongly than a reply does.
    expect(
      itemsOf(
        baseState({
          reviews: [review({ id: 'RP4', state: 'DISMISSED', submittedAt: T1 })],
          restReviewComments: [restComment({ id: 511, authorLogin: 'pr-author', createdAt: T2 })],
        }),
      ),
    ).toEqual([{ kind: 'review', id: 'RP4', verdict: 'skip', path: null, reason: 'review_dismissed' }]);
  });
});

// ---------------------------------------------------------------------------
// Null timestamps fall back per treatNullCreatedAtAs (ordering uses)
// ---------------------------------------------------------------------------

describe('null timestamps fall back per treatNullCreatedAtAs', () => {
  test("default 'nowMs': a null-createdAt reply counts as the newest — responder last word → responded", () => {
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'TN1', replies: [said('reviewer', T2), said('pr-author', null)] })],
      }),
    );
    expect(items[0]?.verdict).toBe('responded');
    expect(items[0]?.reason).toBe('responder_last_word');
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

  test("default 'nowMs': an unparseable createdAt behaves like null — responder last word → responded", () => {
    const items = itemsOf(
      baseState({
        threads: [thread({ id: 'TN3', replies: [said('reviewer', T2), said('pr-author', 'not-a-date')] })],
      }),
    );
    expect(items[0]?.verdict).toBe('responded');
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
        restReviewComments: [restComment({ id: 512, authorLogin: 'pr-author', createdAt: T1 })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test("'epochMs': null review submittedAt is 0, so the same reply DOES postdate it → skip", () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RN2', submittedAt: null })],
        restReviewComments: [restComment({ id: 513, authorLogin: 'pr-author', createdAt: T1 })],
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
        restReviewComments: [restComment({ id: 514, authorLogin: 'pr-author', createdAt: T1 })],
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
      restReviewComments: [restComment({ id: 521, authorLogin: 'pr-author', createdAt: null })],
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
        restReviewComments: [restComment({ id: 522, authorLogin: 'pr-author', createdAt: 'not-a-date' })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test("'epochMs': an unparseable/null reply falls to 0 — likewise never postdates a past review → actionable", () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RW3', submittedAt: T1 })],
        restReviewComments: [restComment({ id: 523, authorLogin: 'pr-author', createdAt: null })],
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
        restReviewComments: [restComment({ id: 524, authorLogin: 'pr-author', createdAt: T3 })],
      }),
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('review_already_answered');
  });
});

// ---------------------------------------------------------------------------
// The answer may live in EITHER comment collection (row 10)
// ---------------------------------------------------------------------------

describe('the answer scan covers both comment collections', () => {
  test('a responder answer in restIssueComments ONLY → the review skips (review_already_answered)', () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RC1', submittedAt: T1 })],
        restIssueComments: [restComment({ id: 641, authorLogin: 'pr-author', createdAt: T2 })],
      }),
    );
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('review_already_answered');
  });

  test('a postdating comment by SOMEONE ELSE in either collection → still actionable', () => {
    const items = itemsOf(
      baseState({
        reviews: [review({ id: 'RC2', submittedAt: T1 })],
        restReviewComments: [restComment({ id: 642, authorLogin: 'bystander', createdAt: T2 })],
        restIssueComments: [restComment({ id: 643, authorLogin: 'passerby', createdAt: T3 })],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
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
// skipPatterns — bot-anchored patterns fire; human phrasing never matches
// ---------------------------------------------------------------------------

describe('default skipPatterns', () => {
  test.each([
    ['CodeRabbit skipped', 'CodeRabbit skipped this PR because the diff was empty'],
    ['bot-anchored failure', 'coderabbitai failed to post the review: error 500'],
    ['configuration problem skip', 'configuration problem detected — skipping this run'],
    ['skipping review', 'Skipping review for this draft PR'],
    ['not reviewing', 'Not reviewing until the CI settles'],
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
