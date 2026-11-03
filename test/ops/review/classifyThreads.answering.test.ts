// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import { defaultClassifyConfig } from '../../../src/ops/review/classify.config.js';
import {
  baseState,
  itemsOf,
  restComment,
  review,
  said,
  thread,
  NOW,
  T1,
  T2,
  T3,
} from './classifyThreads.helpers.js';

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
        restIssueComments: [
          restComment({ id: 522, authorLogin: 'pr-author', createdAt: 'not-a-date' }),
        ],
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
          thread({
            id: 'RW5',
            replies: [said('pr-author', null, 'fixed'), said('reviewer', T2, 'bumping')],
          }),
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
