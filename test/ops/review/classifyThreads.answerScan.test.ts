// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import { baseState, itemsOf, restComment, review, T1, T2, T3 } from './classifyThreads.helpers.js';

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
