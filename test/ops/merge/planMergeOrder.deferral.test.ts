// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject;
// this file keeps the same-pass merge-root deferral (review-debt #153,
// generalized in PR #234 r1). Shared fixtures live in
// ./planMergeOrder.helpers.ts (see its header for the rule-by-rule map).
import { describe, expect, test } from 'vitest';
import { classified, plan, planned } from './planMergeOrder.helpers.js';

// ---------------------------------------------------------------------------
// Same-pass merge-root deferral (review-debt #153)
// ---------------------------------------------------------------------------

describe('planMergeOrder — same-pass merge deferral (#153, generalized in PR #234 r1)', () => {
  test('a child of a same-pass merge root is withheld with stack_base_merging_this_pass', () => {
    // The F5 strand shape: 7 merges onto main THIS pass, closing 7 and
    // orphaning branch 'a' — 8 merged into 'a' would land on a dead branch
    // while the forge reports it merged. Withheld here instead.
    const result = plan('main', [planned(7, 'main', 'a'), planned(8, 'a', 'b')]);
    expect(result.order).toEqual([{ pr: 7, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([{ pr: 8, reason: 'stack_base_merging_this_pass' }]);
  });

  test('next pass the deferred child re-plans as retarget-self (convergence)', () => {
    // The pass after the deferral: 7 is now CLOSED (it merged), so base
    // resolution reads branch 'a' as a closed rung — the retarget-self
    // machinery the deferral relies on. 9 (stacked on 8) rides 8's subtree
    // once 8 is retargeted onto the trunk.
    const nextPass = plan('main', [
      planned(7, 'main', 'a', { state: 'closed' }),
      planned(8, 'a', 'b'),
      planned(9, 'b', 'c'),
    ]);
    expect(nextPass.order).toEqual([
      { pr: 8, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'a' },
      { pr: 9, action: 'merge', basePr: 8, depth: 1, baseRefName: 'b' },
    ]);
    expect(nextPass.needsHuman).toEqual([]);
  });

  test('children of a retarget-self root are NOT withheld at depth 1 — that rung stays open', () => {
    // The root's base is a CLOSED rung (retarget-self), not a same-pass
    // merge root: the retargeted PR remains OPEN and does not merge this
    // pass, so its depth-1 child still merges. Scope note (PR #234 r1):
    // this holds at DEPTH 1 ONLY — the gate's rule is general (any child
    // whose base merges earlier in the order defers), and the depth-≥2
    // strand under this exact shape is the regression test below.
    const result = plan('main', [
      planned(1, 'main', 'gone', { state: 'closed' }),
      planned(2, 'gone', 'live'),
      planned(3, 'live', 'top'),
    ]);
    expect(result.order).toEqual([
      { pr: 2, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'gone' },
      { pr: 3, action: 'merge', basePr: 2, depth: 1, baseRefName: 'live' },
    ]);
    expect(result.needsHuman).toEqual([]);
  });

  test('REGRESSION (PR #234 r1): the #153 strand recurs at depth ≥2 under a retarget-self root', () => {
    // The reviewer's shape: with a closed rung below it, 2 = retarget-self,
    // 3 = merge (into 2's branch — safe, 2 stays open), 4 = merge into 3's
    // branch. Merging 3 closes 3 and orphans branch 'top', so 4 merged
    // into it would strand off the trunk while the forge reports it
    // merged. The pre-generalization gate checked merge ROOTS only — 2 is
    // not a root-merge and 3 is not a root at all, so 4 was ordered. The
    // executor cannot catch this either: 4's base REF ('top') never
    // changes; only 3's PR status flips. Generalized, the gate withholds
    // any child whose base merges earlier in the order.
    const result = plan('main', [
      planned(1, 'main', 'gone', { state: 'closed' }),
      planned(2, 'gone', 'live'),
      planned(3, 'live', 'top'),
      planned(4, 'top', 'above'),
    ]);
    expect(result.order).toEqual([
      { pr: 2, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'gone' },
      { pr: 3, action: 'merge', basePr: 2, depth: 1, baseRefName: 'live' },
    ]);
    expect(result.needsHuman).toEqual([{ pr: 4, reason: 'stack_base_merging_this_pass' }]);
    // And the generalized gate converges like the merge-root deferral:
    // next pass 3 is CLOSED, so 4 re-plans stacked on a closed rung —
    // retarget-self onto the trunk, content reaching the base branch.
    const nextPass = plan('main', [
      planned(1, 'main', 'gone', { state: 'closed' }),
      planned(2, 'gone', 'live'),
      planned(3, 'live', 'top', { state: 'closed' }),
      planned(4, 'top', 'above'),
    ]);
    expect(nextPass.order).toEqual([
      { pr: 2, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'gone' },
      { pr: 4, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'top' },
    ]);
    expect(nextPass.needsHuman).toEqual([]);
  });

  test('gate precedence: an already-gated child of a merge root keeps its gate reason', () => {
    // First match wins — the truncation gate fired before base resolution,
    // and the #153 gate never overwrites an existing reason.
    const result = plan('main', [
      planned(1, 'main', 'a'),
      planned(2, 'a', 'b', { truncated: true }),
      planned(3, 'b', 'c'),
    ]);
    expect(result.order).toEqual([{ pr: 1, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([
      { pr: 2, reason: 'review_data_truncated' },
      { pr: 3, reason: 'stack_base_needs_human' },
    ]);
  });

  test('a NOT-eligible root defers its child through the cascade, not the #153 gate', () => {
    // Withheld roots are not merge roots: the child's reason stays
    // stack_base_needs_human (the base is held, not landing).
    const result = plan('main', [
      planned(1, 'main', 'a', { classification: classified('awaiting', 'no_acceptable_review') }),
      planned(2, 'a', 'b'),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'not_eligible' },
      { pr: 2, reason: 'stack_base_needs_human' },
    ]);
  });
});
