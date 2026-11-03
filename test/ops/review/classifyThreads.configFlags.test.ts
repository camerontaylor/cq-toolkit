// Split provenance: test/ops/review/classifyThreads.test.ts was split into the
// classifyThreads.*.test.ts siblings in this directory; shared fixtures live in
// classifyThreads.helpers.ts.
import { describe, expect, test } from 'vitest';
import { defaultClassifyConfig } from '../../../src/ops/review/classify.config.js';
import { baseState, itemsOf, review, thread, NOW } from './classifyThreads.helpers.js';

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
        itemsOf(baseState({ threads: [thread({ id: 'TB1', isOutdated: true })] }), NOW, {
          ...defaultClassifyConfig,
          blockOnOutdatedThreads: flag,
        }),
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
        itemsOf(baseState({ threads: [thread({ id: 'TB2', authorLogin: 'pr-author' })] }), NOW, {
          ...defaultClassifyConfig,
          skipResponderAuthoredThreads: flag,
        }),
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
        itemsOf(baseState({ reviews: [review({ id: 'TB3', state: 'DISMISSED' })] }), NOW, {
          ...defaultClassifyConfig,
          skipDismissedReviews: flag,
        }),
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
    const items = itemsOf(baseState({ reviews: [review({ id: 'RA2', state: 'APPROVED' })] }));
    expect(items[0]?.verdict).toBe('actionable');
    expect(items[0]?.reason).toBe('review_summary_needs_response');
  });

  test('a null-state review with an EMPTY body → skip (empty_summary_no_state)', () => {
    const items = itemsOf(baseState({ reviews: [review({ id: 'RA3', state: null, body: '' })] }));
    expect(items[0]?.verdict).toBe('skip');
    expect(items[0]?.reason).toBe('empty_summary_no_state');
  });

  test('a null-state review WITH text → actionable', () => {
    const items = itemsOf(baseState({ reviews: [review({ id: 'RA4', state: null })] }));
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
        itemsOf(baseState({ reviews: [review({ id: 'RA5', state: 'APPROVED', body: '' })] }), NOW, {
          ...defaultClassifyConfig,
          skipApprovalReviews: flag,
        }),
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
