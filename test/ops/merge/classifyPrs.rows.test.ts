// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries the I2
// decision table row by row, its precedence order, and the row-2 merge-state
// scope.
import { describe, expect, test } from 'vitest';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import {
  LAST_COMMIT_MS,
  PENDING_MS,
  SETTLED_MS,
  approved,
  candidate,
  comment,
  settleCandidate,
  thread,
} from './classifyPrs.helpers.js';

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

  test('unresolved threads are advisory, count surfaced on the result', () => {
    const result = classifyPr(
      settleCandidate({ threads: [thread(), thread({ id: 'T2', rootDatabaseId: 200 })] }),
      SETTLED_MS,
    );
    expect(result.verdict).toBe('eligible');
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
    const result = classifyPr(settleCandidate({ issueComments: [comment()] }), LAST_COMMIT_MS + 1);
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
    const result = classifyPr(candidate({ mergeState: 'DIRTY', truncated: true }), SETTLED_MS);
    expect(result.verdict).toBe('conflicting');
    expect(result.reason).toBe('merge_conflicts');
  });

  test('truncated retains advisory thread count (the count still surfaces)', () => {
    const result = classifyPr(candidate({ truncated: true, threads: [thread()] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('review_data_truncated');
    expect(result.unresolvedExternalThreads).toBe(1);
  });

  test('open threads do not substitute for review', () => {
    const result = classifyPr(candidate({ threads: [thread()] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('no_acceptable_review');
  });

  test('unknown last commit retains advisory thread count', () => {
    const result = classifyPr(candidate({ lastCommitAt: null, threads: [thread()] }), SETTLED_MS);
    expect(result.verdict).toBe('awaiting');
    expect(result.reason).toBe('last_commit_unknown');
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
