// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject;
// this file keeps the roots-first order shapes and the observed head-SHA
// threading (#186). Shared fixtures live in ./planMergeOrder.helpers.ts (see
// its header for the rule-by-rule map).
import { describe, expect, test } from 'vitest';
import { plan, planned } from './planMergeOrder.helpers.js';

// ---------------------------------------------------------------------------
// The graph and the order
// ---------------------------------------------------------------------------

describe('planMergeOrder — the order (roots first, parents before children)', () => {
  test('a single root: merge, depth 0, basePr null, empty ledger', () => {
    const result = plan('main', [planned(7, 'main', 'feature-a')]);
    expect(result.order).toEqual([{ pr: 7, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([]);
    expect(result.baseBranch).toBe('main');
  });

  test('a linear chain 3 deep: the root merges, its subtree defers (review-debt #153)', () => {
    // #153: merging 1 onto main closes 1 and orphans branch 'a' — 2 merged
    // into it would strand off the trunk. 2 defers with
    // stack_base_merging_this_pass and 3 cascades behind it; next pass 2
    // retargets onto main (1 is closed) and re-plans as an ordinary root.
    const result = plan('main', [
      planned(1, 'main', 'a'),
      planned(2, 'a', 'b'),
      planned(3, 'b', 'c'),
    ]);
    expect(result.order).toEqual([{ pr: 1, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([
      { pr: 2, reason: 'stack_base_merging_this_pass' },
      { pr: 3, reason: 'stack_base_needs_human' },
    ]);
  });

  test("two roots with descendants: ALL roots first (PR-number order), then each root's subtree depth-first", () => {
    // Same-pass merge roots' children defer (#153), so the ordered subtree
    // here hangs off nothing — children 3 and 4 are withheld with
    // stack_base_merging_this_pass and grandchild 5 cascades behind 3. The
    // ORDERING pins below (roots first, PR-number order) survive on the
    // retarget-self shapes, whose children still merge (see the
    // closed-ancestor describe).
    const result = plan('main', [
      planned(2, 'main', 'r2'),
      planned(1, 'main', 'r1'),
      // Child 3 hangs off root 2; child 4 (higher number, later subtree
      // start) hangs off root 1 — descendants come after ALL roots.
      planned(3, 'r2', 'c3'),
      planned(4, 'r1', 'c4'),
      planned(5, 'c3', 'g5'),
    ]);
    expect(result.order).toEqual([
      { pr: 1, action: 'merge', basePr: null, depth: 0 },
      { pr: 2, action: 'merge', basePr: null, depth: 0 },
    ]);
    expect(result.needsHuman).toEqual([
      { pr: 3, reason: 'stack_base_merging_this_pass' },
      { pr: 4, reason: 'stack_base_merging_this_pass' },
      { pr: 5, reason: 'stack_base_needs_human' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// Head-SHA threading (review-debt #186)
// ---------------------------------------------------------------------------

describe('planMergeOrder — observed head SHA threading (#186)', () => {
  test('a candidate headSha rides the planned entry verbatim', () => {
    const head = 'a'.repeat(40);
    const result = plan('main', [planned(7, 'main', 'feat-7', { headSha: head })]);
    // The executor pins `gh pr merge --match-head-commit` with this sha, so a
    // fixer push between plan and run cannot merge an unreviewed head.
    expect(result.order).toEqual([
      { pr: 7, action: 'merge', basePr: null, depth: 0, headSha: head },
    ]);
  });

  test('a candidate WITHOUT a headSha leaves the entry unpinned (field omitted, never empty-string)', () => {
    const result = plan('main', [planned(7, 'main', 'feat-7')]);
    expect(result.order).toEqual([{ pr: 7, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.order[0]).not.toHaveProperty('headSha');
  });
});
