// F2 — tests for the stacked-PR merge plan
// (src/ops/merge/planMergeOrder.ts, ws-f scope item 2).
//
// Pinned here, rule by rule (every rule the module doc states has a test):
//   1. THE STACK GRAPH: X stacks on Y when X.baseRefName === Y.headRefName
//      (both open); a PR whose baseRefName === input.baseBranch is a ROOT.
//   2. THE ORDER — ROOTS FIRST: roots form the plan's prefix in PR-number
//      order; then each root's descendants depth-first, children in
//      PR-number order; a PR never appears before its base PR; depths
//      increment per rung.
//   3. CLOSED-ANCESTOR RETARGET: an open PR whose base head is owned by a
//      CLOSED PR is planned AS A ROOT — depth 0, basePr null — with
//      action 'retarget-self' (the caller retargets its base onto the
//      base branch); its own descendants still merge normally.
//   4. TRUNCATED FAIL-CLOSED (UC §3 row 42): a truncated fetch is never
//      ordered for merge — needs-human, review_data_truncated — and beats
//      the unclassified gate (first match wins, F1's row order).
//   5. UNCLASSIFIED: classification null → needs-human, unclassified.
//   6. STACK CYCLE: A on B, B on A (misconfigured bases) → both cycle
//      members needs-human with stack_cycle, absent from the order;
//      independent PRs still plan.
//   7. THE FAIL-CLOSED CASCADE: a child of any withheld PR is withheld
//      too (stack_base_needs_human) — ordering it would merge its base's
//      commits uninvited.
//   8. UNRESOLVED BASE: a base ref that is neither the base branch nor
//      any fetched head is not guessed — needs-human, unresolved_base.
//   9. CLOSED PRs are structural only: they appear in neither bucket,
//      even when truncated or unclassified (the gates are open-PR gates).
//  10. BASE-BRANCH CONFIGURABILITY: the base branch name is input, never
//      a hardcoded constant — the same stack plans identically under any
//      branch name, and the result echoes the name it was given.
//  11. DETERMINISM: same input → deep-equal plan, whatever order the
//      input array arrived in.
//
// Pure data tests: no I/O, no clocks — instant by construction.
import { describe, expect, test } from 'vitest';
import { planMergeOrder } from '../../../src/ops/merge/planMergeOrder.js';
import type {
  PlanMergeInput,
  PlanMergeResult,
  PlannedPr,
} from '../../../src/ops/merge/planMergeOrder.js';
import type { PrClassification } from '../../../src/ops/merge/classifyPrs.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** F1's happy verdict — the classification an ordinary mergeable PR carries. */
const ELIGIBLE: PrClassification = {
  verdict: 'eligible',
  reason: 'settle_window_elapsed',
  unresolvedExternalThreads: 0,
};

/** An open, classified, untruncated PR — all gates open. */
const planned = (
  pr: number,
  baseRefName: string,
  headRefName: string,
  extra: Partial<PlannedPr> = {},
): PlannedPr => ({
  pr,
  headRefName,
  baseRefName,
  state: 'open',
  authorLogin: null,
  classification: ELIGIBLE,
  truncated: false,
  ...extra,
});

const plan = (baseBranch: string, prs: PlannedPr[]): PlanMergeResult =>
  planMergeOrder({ baseBranch, prs } satisfies PlanMergeInput);

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

  test('a linear chain 3 deep: order follows the stack, depth increments', () => {
    const result = plan('main', [
      planned(1, 'main', 'a'),
      planned(2, 'a', 'b'),
      planned(3, 'b', 'c'),
    ]);
    expect(result.order).toEqual([
      { pr: 1, action: 'merge', basePr: null, depth: 0 },
      { pr: 2, action: 'merge', basePr: 1, depth: 1 },
      { pr: 3, action: 'merge', basePr: 2, depth: 2 },
    ]);
    expect(result.needsHuman).toEqual([]);
  });

  test('two roots with descendants: ALL roots first (PR-number order), then each root\'s subtree depth-first', () => {
    const result = plan('main', [
      planned(2, 'main', 'r2'),
      planned(1, 'main', 'r1'),
      // Child 3 hangs off root 2; child 4 (higher number, later subtree
      // start) hangs off root 1 — descendants come after ALL roots.
      planned(3, 'r2', 'c3'),
      planned(4, 'r1', 'c4'),
      planned(5, 'c3', 'g5'),
    ]);
    expect(result.order.map((entry) => entry.pr)).toEqual([1, 2, 4, 3, 5]);
    // Depths: roots 0, children 1, grandchild 2.
    expect(result.order.map((entry) => entry.depth)).toEqual([0, 0, 1, 1, 2]);
    expect(result.needsHuman).toEqual([]);
  });
});

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
      { pr: 11, action: 'retarget-self', basePr: null, depth: 0 },
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
      { pr: 10, action: 'retarget-self', basePr: null, depth: 0 },
      { pr: 11, action: 'merge', basePr: 10, depth: 1 },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The fail-closed gates
// ---------------------------------------------------------------------------

describe('planMergeOrder — fail-closed gates (nothing merges uninvited)', () => {
  test('a truncated PR is never ordered: needs-human, review_data_truncated (UC row 42)', () => {
    const result = plan('main', [
      planned(4, 'main', 'cap-hit', { truncated: true }),
      planned(2, 'main', 'fine'),
    ]);
    expect(result.order).toEqual([{ pr: 2, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([{ pr: 4, reason: 'review_data_truncated' }]);
  });

  test('an unclassified PR is never ordered: needs-human, unclassified', () => {
    const result = plan('main', [
      planned(6, 'main', 'never-classified', { classification: null }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 6, reason: 'unclassified' }]);
  });

  test('truncated beats unclassified (first match wins, F1 row order)', () => {
    const result = plan('main', [
      planned(8, 'main', 'both', { classification: null, truncated: true }),
    ]);
    expect(result.needsHuman).toEqual([{ pr: 8, reason: 'review_data_truncated' }]);
  });

  test('a base ref that resolves to nothing is not guessed: unresolved_base', () => {
    const result = plan('main', [planned(12, 'ghost-branch', 'adrift')]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 12, reason: 'unresolved_base' }]);
  });

  test('the cascade: a child of a withheld PR is withheld too (stack_base_needs_human)', () => {
    const result = plan('main', [
      planned(1, 'main', 'cap-hit', { truncated: true }),
      planned(2, 'cap-hit', 'child'),
      planned(3, 'child', 'grandchild'),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'review_data_truncated' },
      { pr: 2, reason: 'stack_base_needs_human' },
      { pr: 3, reason: 'stack_base_needs_human' },
    ]);
  });
});

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
    expect(trunkResult.order).toEqual([
      { pr: 1, action: 'merge', basePr: null, depth: 0 },
      { pr: 3, action: 'retarget-self', basePr: null, depth: 0 },
      { pr: 2, action: 'merge', basePr: 1, depth: 1 },
    ]);
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
});
