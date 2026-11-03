// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject;
// this file keeps the duplicate-head-name resolution rules. Shared fixtures
// live in ./planMergeOrder.helpers.ts (see its header for the rule-by-rule
// map).
import { describe, expect, test } from 'vitest';
import { plan, planned } from './planMergeOrder.helpers.js';

// ---------------------------------------------------------------------------
// Duplicate head names resolve deterministically
// ---------------------------------------------------------------------------

describe('planMergeOrder — duplicate head names', () => {
  test('two open PRs sharing a head: the stack resolves to the lower-numbered owner', () => {
    const result = plan('main', [
      planned(1, 'main', 'shared'),
      planned(2, 'main', 'shared'),
      planned(3, 'shared', 'child'),
    ]);
    // The child stacks onto owner 1 — never onto 2 (and never into a
    // dangling edge or a guessed split). Owner 1 is a same-pass merge
    // root, so the child defers with the #153 gate (merging into 1's
    // branch after 1 lands would strand it).
    expect(result.order).toEqual([
      { pr: 1, action: 'merge', basePr: null, depth: 0 },
      { pr: 2, action: 'merge', basePr: null, depth: 0 },
    ]);
    expect(result.needsHuman).toEqual([{ pr: 3, reason: 'stack_base_merging_this_pass' }]);
  });

  test('an open owner outranks a closed owner of the same head (closed is structural)', () => {
    const result = plan('main', [
      planned(10, 'main', 'shared', { state: 'closed' }),
      planned(11, 'main', 'shared'),
      planned(12, 'shared', 'child'),
    ]);
    // The child stacks onto the LIVE owner 11 — the closed 10 does not
    // turn the rung into a retarget-self. 11 is a same-pass merge root,
    // so 12 defers per review-debt #153.
    expect(result.order).toEqual([{ pr: 11, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([{ pr: 12, reason: 'stack_base_merging_this_pass' }]);
  });

  test('two closed owners sharing a head: retarget-self still fires (lowest anchors)', () => {
    const result = plan('main', [
      planned(20, 'main', 'old', { state: 'closed' }),
      planned(21, 'main', 'old', { state: 'closed' }),
      planned(22, 'old', 'child'),
    ]);
    // Both closed owners claim 'old'; the lowest-numbered one anchors, and
    // the child's plan is the same either way: retarget-self at root depth.
    expect(result.order).toEqual([
      { pr: 22, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'old' },
    ]);
    expect(result.needsHuman).toEqual([]);
  });
});
