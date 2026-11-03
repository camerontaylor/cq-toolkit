// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject;
// this file keeps the stack-cycle rules (mutual cycles, self-cycles and the
// tail cascade). Shared fixtures live in ./planMergeOrder.helpers.ts (see its
// header for the rule-by-rule map).
import { describe, expect, test } from 'vitest';
import { plan, planned } from './planMergeOrder.helpers.js';

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

describe('planMergeOrder — stack cycles go to a human', () => {
  test('A on B, B on A: both needs-human (stack_cycle), independent PRs still plan', () => {
    const result = plan('main', [
      planned(1, 'b-head', 'a-head'), // stacks on 2
      planned(2, 'a-head', 'b-head'), // stacks on 1 — the cycle
      planned(7, 'main', 'independent'),
    ]);
    expect(result.order).toEqual([{ pr: 7, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'stack_cycle' },
      { pr: 2, reason: 'stack_cycle' },
    ]);
  });

  test('a PR stacked on itself is a length-1 cycle; children of a cycle cascade', () => {
    const result = plan('main', [
      planned(3, 'self', 'self'), // baseRefName === headRefName
      planned(4, 'self', 'child-of-cycle'),
      planned(5, 'main', 'independent'),
    ]);
    expect(result.order).toEqual([{ pr: 5, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([
      { pr: 3, reason: 'stack_cycle' },
      { pr: 4, reason: 'stack_base_needs_human' },
    ]);
  });

  test('a tail leading into a cycle cascades: 6 → 5 → (1 ⇄ 2), independent PR still plans', () => {
    const result = plan('main', [
      planned(1, 'h2', 'h1'), // ─ the mutual cycle
      planned(2, 'h1', 'h2'), // ┘
      planned(5, 'h1', 'tail-1'), // stacks onto cycle member 1
      planned(6, 'tail-1', 'tail-2'), // stacks onto the tail
      planned(7, 'main', 'independent'),
    ]);
    expect(result.order).toEqual([{ pr: 7, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'stack_cycle' },
      { pr: 2, reason: 'stack_cycle' },
      { pr: 5, reason: 'stack_base_needs_human' },
      { pr: 6, reason: 'stack_base_needs_human' },
    ]);
  });
});
