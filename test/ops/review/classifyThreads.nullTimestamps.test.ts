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
} from './classifyThreads.helpers.js';

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
        threads: [
          thread({ id: 'TN3', replies: [said('reviewer', T2), said('pr-author', 'not-a-date')] }),
        ],
      }),
    );
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('thread_needs_response');
  });

  test("'epochMs': an unparseable createdAt behaves like null — reviewer last word → actionable", () => {
    const items = itemsOf(
      baseState({
        threads: [
          thread({ id: 'TN4', replies: [said('reviewer', T2), said('pr-author', 'not-a-date')] }),
        ],
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
