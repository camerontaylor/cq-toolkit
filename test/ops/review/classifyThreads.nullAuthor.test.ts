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
  T2,
} from './classifyThreads.helpers.js';

// ---------------------------------------------------------------------------
// Null authorLogin is never the responder (fails toward actionable)
// ---------------------------------------------------------------------------

describe('null authorLogin is never the responder (fails toward actionable)', () => {
  test('a null-author thread is external — actionable, not skipped', () => {
    expect(itemsOf(baseState({ threads: [thread({ id: 'TA1', authorLogin: null })] }))).toEqual([
      {
        kind: 'thread',
        id: 'TA1',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
    ]);
  });

  test("a null-author last reply is not the responder's word — actionable, not responded", () => {
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
      {
        kind: 'thread',
        id: 'TA3',
        verdict: 'actionable',
        path: 'src/a.ts',
        reason: 'thread_needs_response',
      },
      {
        kind: 'comment',
        id: '612',
        verdict: 'actionable',
        path: null,
        reason: 'top_level_summary',
      },
    ]);
  });

  test('a null-author review is external — actionable, not skipped', () => {
    const items = itemsOf(baseState({ reviews: [review({ id: 'TA4', authorLogin: null })] }));
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });
});
