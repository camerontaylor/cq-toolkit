// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject;
// this file keeps the closed-rung rules — closed-ancestor retarget-self and the
// structural silence of closed PRs. Shared fixtures live in
// ./planMergeOrder.helpers.ts (see its header for the rule-by-rule map).
import { describe, expect, test } from 'vitest';
import { plan, planned } from './planMergeOrder.helpers.js';

// ---------------------------------------------------------------------------
// Closed-ancestor retarget-self
// ---------------------------------------------------------------------------

describe('planMergeOrder — closed-ancestor retarget-self', () => {
  test('an open PR stacked on a CLOSED PR is ordered as a root with action retarget-self', () => {
    const result = plan('main', [
      planned(10, 'main', 'gone', { state: 'closed' }), // the merged rung
      planned(11, 'gone', 'child-of-gone'),
      planned(5, 'main', 'plain-root'),
    ]);
    expect(result.order).toEqual([
      { pr: 5, action: 'merge', basePr: null, depth: 0 },
      { pr: 11, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'gone' },
    ]);
    expect(result.needsHuman).toEqual([]);
  });

  test('descendants of a retarget-self root merge normally once the root is retargeted', () => {
    const result = plan('main', [
      planned(9, 'main', 'merged-rung', { state: 'closed' }),
      planned(10, 'merged-rung', 'retarget-me'),
      planned(11, 'retarget-me', 'on-top'),
    ]);
    expect(result.order).toEqual([
      { pr: 10, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'merged-rung' },
      { pr: 11, action: 'merge', basePr: 10, depth: 1, baseRefName: 'retarget-me' },
    ]);
  });

  test('a gated PR parked on a closed rung is withheld by its gate — never planned as retarget-self', () => {
    const result = plan('main', [
      planned(30, 'main', 'old', { state: 'closed' }),
      // Stacked on the closed rung AND truncated: the gate fires first,
      // and the !excluded.has guard keeps it out of the retarget roots.
      planned(31, 'old', 'capped', { truncated: true }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 31, reason: 'review_data_truncated' }]);
  });
});

// ---------------------------------------------------------------------------
// Closed PRs are structural only
// ---------------------------------------------------------------------------

describe('planMergeOrder — closed PRs appear in neither bucket', () => {
  test('a closed PR is never ordered and never reported, whatever its flags', () => {
    const result = plan('main', [
      planned(20, 'main', 'already-merged', {
        state: 'closed',
        classification: null,
        truncated: true,
      }),
      planned(21, 'main', 'live'),
    ]);
    expect(result.order).toEqual([{ pr: 21, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([]);
  });
});
