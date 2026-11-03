// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject;
// this file keeps the input-derived contract — base-branch configurability and
// determinism (shuffles, duplicate rows, ledger order). Shared fixtures live in
// ./planMergeOrder.helpers.ts (see its header for the rule-by-rule map).
import { describe, expect, test } from 'vitest';
import type { PlannedPr } from '../../../src/ops/merge/planMergeOrder.js';
import { plan, planned } from './planMergeOrder.helpers.js';

// ---------------------------------------------------------------------------
// Base-branch configurability
// ---------------------------------------------------------------------------

describe('planMergeOrder — the base branch is config, not a constant', () => {
  test('a custom base branch name plans identically to any other name', () => {
    const prs = [
      planned(1, 'trunk', 'a'),
      planned(2, 'a', 'b'),
      planned(3, 'merged-rung', 'c'),
      planned(30, 'trunk', 'merged-rung', { state: 'closed' as const }),
    ];
    const trunkResult = plan('trunk', prs);
    // Same stack, other base-branch name: only the ROOT bases translate;
    // stack rung names ('a', 'merged-rung') are branch data, untouched.
    const mainPrs = prs.map((p) => ({
      ...p,
      baseRefName: p.baseRefName === 'trunk' ? 'main' : p.baseRefName,
    }));
    const mainResult = plan('main', mainPrs);

    expect(trunkResult.baseBranch).toBe('trunk');
    // 2 is a child of same-pass merge root 1, so it defers (#153); the
    // retarget-self entry is unaffected (its rung is already closed).
    expect(trunkResult.order).toEqual([
      { pr: 1, action: 'merge', basePr: null, depth: 0 },
      { pr: 3, action: 'retarget-self', basePr: null, depth: 0, baseRefName: 'merged-rung' },
    ]);
    expect(trunkResult.needsHuman).toEqual([{ pr: 2, reason: 'stack_base_merging_this_pass' }]);
    // Same graph, other name: identical plan shape — only the echoed
    // baseBranch differs. Whatever the queue branch is called, the plan
    // is built from input, never from a hardcoded literal.
    expect({ ...trunkResult, baseBranch: 'main' }).toEqual(mainResult);
  });

  test('an empty candidate list plans to an empty plan', () => {
    expect(plan('main', [])).toEqual({ order: [], needsHuman: [], baseBranch: 'main' });
  });
});

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('planMergeOrder — deterministic', () => {
  test('same input (shuffled differently) → deep-equal plan, twice over', () => {
    const prs = [
      planned(1, 'main', 'a'),
      planned(2, 'a', 'b'),
      planned(3, 'b', 'c'),
      planned(4, 'main', 'r4'),
      planned(5, 'cap', 'truncated-child', { truncated: true }),
      planned(6, 'c', 'd'),
      planned(7, 'main', 'merged-rung', { state: 'closed' }),
      planned(8, 'merged-rung', 'retarget-me'),
      planned(9, 'h10', 'h9'), // stacks on 10
      planned(10, 'h9', 'h10'), // stacks on 9 — the cycle
    ];
    const first = plan('main', prs);
    const second = plan('main', [...prs].reverse());
    expect(first).toEqual(second);
    expect(first).toEqual(plan('main', prs));
  });

  test('duplicate rows contribute no stack edge: swapping the two equal-pr rows cannot flip the plan', () => {
    const rows: [PlannedPr, PlannedPr, PlannedPr, PlannedPr, PlannedPr] = [
      planned(1, 'main', 'x'), // root
      planned(5, 'r9', 'q'), // dup row A: base is pr 9's head
      planned(5, 'x', 'q'), // dup row B: base is pr 1's head — pre-fix, the
      // LAST of these two writes won baseOf[5] (the stable sort keeps input
      // order, so array position was a hidden tie-breaker).
      planned(7, 'q', 'c7'), // child of the duplicated head
      planned(9, 'q', 'r9'), // its chain walks THROUGH the duplicate's edge
    ];
    const first = plan('main', rows);
    // The same rows, the two pr-5 entries swapped: pre-fix, pr 9's chain
    // walked through a DIFFERENT phantom edge (baseOf[5] = 1 vs 9) and its
    // reason flipped between stack_base_needs_human and stack_cycle.
    const swapped = plan('main', [rows[0], rows[2], rows[1], rows[3], rows[4]]);
    expect(swapped).toEqual(first);
    // Reasons stable in both runs: 5 is the duplicate; 7 and 9 cascade.
    expect(first.needsHuman).toEqual([
      { pr: 5, reason: 'duplicate_pr' },
      { pr: 7, reason: 'stack_base_needs_human' },
      { pr: 9, reason: 'stack_base_needs_human' },
    ]);
    expect(first.order).toEqual([{ pr: 1, action: 'merge', basePr: null, depth: 0 }]);
  });

  test('the ledger is pr-number sorted, not gate-fire order: {2 cascaded} before {9 truncated}', () => {
    const result = plan('main', [
      planned(9, 'main', 'cap-hit', { truncated: true }), // high number, gated first
      planned(2, 'cap-hit', 'child'), // low number, cascades off it later
    ]);
    expect(result.order).toEqual([]);
    // Gate fire order would put 9 first; the pr-number sort is load-bearing.
    expect(result.needsHuman).toEqual([
      { pr: 2, reason: 'stack_base_needs_human' },
      { pr: 9, reason: 'review_data_truncated' },
    ]);
  });
});
