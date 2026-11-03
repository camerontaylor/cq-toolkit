// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  baseState,
  itemsOf,
  restComment,
  review,
  said,
  thread,
  T1,
  T2,
} from './classifyThreads.helpers.js';

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
