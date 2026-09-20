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
//   6. NON-ELIGIBLE VERDICT: F1's verdict is the planner's gate too — the
//      FULL acceptance decision carries to the stack level. Only
//      `eligible` is ever ordered; never / conflicting / awaiting /
//      has-issues each → needs-human, not_eligible, absent from the
//      order — and a non-eligible parent cascades its children like any
//      withheld rung.
//   7. GATE PRECEDENCE: the gates fire before base resolution and cycle
//      detection, so a gate reason is never overwritten — a truncated PR
//      with a ghost base keeps review_data_truncated (not
//      unresolved_base), and a truncated cycle MEMBER keeps its gate
//      reason while the clean partner gets stack_cycle.
//   8. DUPLICATE PR NUMBERS: the same pr number in two entries withholds
//      the OPEN entries as duplicate_pr (round-2 recorded deviation) —
//      never ordered; the count spans EVERY row with that number (an open
//      twin of a closed duplicate is withheld; closed rows never report);
//      children of a duplicated head cascade stack_base_needs_human; the
//      duplicate rows contribute NO stack edge, so swapping them cannot
//      flip the plan.
//   9. STACK CYCLE: A on B, B on A (misconfigured bases) → both cycle
//      members needs-human with stack_cycle, absent from the order;
//      independent PRs still plan; a tail leading into the cycle cascades
//      (6 → 5 → (1 ⇄ 2): 5 and 6 are stack_base_needs_human).
//  10. THE FAIL-CLOSED CASCADE: a child of any withheld PR is withheld
//      too (stack_base_needs_human) — ordering it would merge its base's
//      commits uninvited; withheld parents include unresolved_base and
//      gated rungs of every kind.
//  11. UNRESOLVED BASE: a base ref that is neither the base branch nor
//      any fetched head is not guessed — needs-human, unresolved_base.
//  12. CLOSED PRs are structural only: they appear in neither bucket,
//      even when truncated or unclassified (the gates are open-PR gates),
//      and a gated PR parked on a closed rung is withheld by its gate —
//      never planned as retarget-self.
//  13. DUPLICATE HEAD NAMES resolve deterministically: the stack head
//      resolves to the LOWER-NUMBERED open owner; an open owner outranks
//      a closed owner of the same head; the lowest-numbered closed owner
//      anchors retarget-self.
//  14. BASE-BRANCH CONFIGURABILITY: the base branch name is input, never
//      a hardcoded constant — the same stack plans identically under any
//      branch name, and the result echoes the name it was given.
//  15. DETERMINISM: same input → deep-equal plan, whatever order the
//      input array arrived in — including swapping equal-pr duplicate
//      rows — and the ledger is pr-number sorted, not gate-fire order.
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

/** A classification with a specific verdict/reason (thread count is not the
 * planner's business — any value plans identically). */
const classified = (
  verdict: PrClassification['verdict'],
  reason: PrClassification['reason'],
): PrClassification => ({
  verdict,
  reason,
  unresolvedExternalThreads: 0,
});

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

  test("two roots with descendants: ALL roots first (PR-number order), then each root's subtree depth-first", () => {
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
    const result = plan('main', [planned(6, 'main', 'never-classified', { classification: null })]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 6, reason: 'unclassified' }]);
  });

  test('truncated beats unclassified (first match wins, F1 row order)', () => {
    const result = plan('main', [
      planned(8, 'main', 'both', { classification: null, truncated: true }),
    ]);
    expect(result.needsHuman).toEqual([{ pr: 8, reason: 'review_data_truncated' }]);
  });

  test('a truncated PR with a ghost base keeps review_data_truncated (gates precede base resolution)', () => {
    const result = plan('main', [
      // Truncated AND its base matches no fetched head: the gate fires
      // first — the ledger never re-reports it as unresolved_base.
      planned(9, 'ghost-branch', 'cap-hit', { truncated: true }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 9, reason: 'review_data_truncated' }]);
  });

  test('a truncated cycle MEMBER keeps review_data_truncated; the clean partner gets stack_cycle', () => {
    const result = plan('main', [
      planned(1, 'h2', 'h1', { truncated: true }), // gated AND mutually stacked with 2
      planned(2, 'h1', 'h2'),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'review_data_truncated' },
      { pr: 2, reason: 'stack_cycle' },
    ]);
  });

  test('a `never` verdict is never ordered: needs-human, not_eligible', () => {
    const result = plan('main', [
      planned(13, 'main', 'still-draft', { classification: classified('never', 'is_draft') }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 13, reason: 'not_eligible' }]);
  });

  test('a `conflicting` verdict is never ordered: needs-human, not_eligible', () => {
    const result = plan('main', [
      planned(14, 'main', 'dirty', {
        classification: classified('conflicting', 'merge_conflicts'),
      }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 14, reason: 'not_eligible' }]);
  });

  test('an `awaiting` verdict is never ordered: needs-human, not_eligible', () => {
    const result = plan('main', [
      planned(15, 'main', 'settling', {
        classification: classified('awaiting', 'settle_window_pending'),
      }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 15, reason: 'not_eligible' }]);
  });

  test('a `has-issues` verdict is never ordered: needs-human, not_eligible', () => {
    const result = plan('main', [
      planned(16, 'main', 'threaded', {
        classification: classified('has-issues', 'unresolved_external_threads'),
      }),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([{ pr: 16, reason: 'not_eligible' }]);
  });

  test('the cascade reaches a non-eligible parent: awaiting root, eligible child → both withheld', () => {
    const result = plan('main', [
      planned(1, 'main', 'awaiting-root', {
        classification: classified('awaiting', 'settle_window_pending'),
      }),
      planned(2, 'awaiting-root', 'eligible-child'),
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'not_eligible' },
      { pr: 2, reason: 'stack_base_needs_human' },
    ]);
  });

  test('the cascade covers an unresolved_base parent: adrift rung, its child cascades', () => {
    const result = plan('main', [
      planned(1, 'ghost-branch', 'adrift'), // gate 5: base resolves to nothing
      planned(2, 'adrift', 'child'), // stacked on the adrift rung
    ]);
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 1, reason: 'unresolved_base' },
      { pr: 2, reason: 'stack_base_needs_human' },
    ]);
  });

  test('duplicate pr numbers: both entries withheld duplicate_pr, the child cascades, nothing plans', () => {
    const result = plan('main', [
      planned(5, 'main', 'x'), // pr 5, row A: a root with head 'x'
      planned(5, 'x', 'q'), // pr 5, row B: DIVERGENT refs — head 'q', stacked on 'x'
      planned(7, 'q', 'z'), // child of row B's head
    ]);
    // The plan cannot tell which row-5 is real, so pr 5 is withheld once
    // (one ledger line per PR, first gate wins) and pr 7 — whose base 'q'
    // is the withheld duplicate's head — cascades. Nothing plans.
    expect(result.order).toEqual([]);
    expect(result.needsHuman).toEqual([
      { pr: 5, reason: 'duplicate_pr' },
      { pr: 7, reason: 'stack_base_needs_human' },
    ]);
  });

  test('a duplicated CLOSED row never reports; its open twin is withheld (count spans all rows)', () => {
    const result = plan('main', [
      planned(5, 'main', 'x', { state: 'closed' }), // closed row of the pair
      planned(5, 'main', 'x'), // open twin — same pr number
      planned(6, 'main', 'independent'),
    ]);
    // The pr count spans BOTH rows, so the open half is withheld; the
    // closed half stays structural silence (never in needsHuman).
    expect(result.order).toEqual([{ pr: 6, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([{ pr: 5, reason: 'duplicate_pr' }]);
  });

  test('a lone pair of duplicated closed rows is structural silence — nothing anywhere', () => {
    const result = plan('main', [
      planned(5, 'main', 'x', { state: 'closed' }),
      planned(5, 'q', 'y', { state: 'closed' }),
      planned(6, 'main', 'independent'),
    ]);
    expect(result.order).toEqual([{ pr: 6, action: 'merge', basePr: null, depth: 0 }]);
    expect(result.needsHuman).toEqual([]);
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
    // dangling edge or a guessed split).
    expect(result.order).toEqual([
      { pr: 1, action: 'merge', basePr: null, depth: 0 },
      { pr: 2, action: 'merge', basePr: null, depth: 0 },
      { pr: 3, action: 'merge', basePr: 1, depth: 1 },
    ]);
    expect(result.needsHuman).toEqual([]);
  });

  test('an open owner outranks a closed owner of the same head (closed is structural)', () => {
    const result = plan('main', [
      planned(10, 'main', 'shared', { state: 'closed' }),
      planned(11, 'main', 'shared'),
      planned(12, 'shared', 'child'),
    ]);
    // The child stacks onto the LIVE owner 11 — the closed 10 does not
    // turn the rung into a retarget-self.
    expect(result.order).toEqual([
      { pr: 11, action: 'merge', basePr: null, depth: 0 },
      { pr: 12, action: 'merge', basePr: 11, depth: 1 },
    ]);
    expect(result.needsHuman).toEqual([]);
  });

  test('two closed owners sharing a head: retarget-self still fires (lowest anchors)', () => {
    const result = plan('main', [
      planned(20, 'main', 'old', { state: 'closed' }),
      planned(21, 'main', 'old', { state: 'closed' }),
      planned(22, 'old', 'child'),
    ]);
    // Both closed owners claim 'old'; the lowest-numbered one anchors, and
    // the child's plan is the same either way: retarget-self at root depth.
    expect(result.order).toEqual([{ pr: 22, action: 'retarget-self', basePr: null, depth: 0 }]);
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
