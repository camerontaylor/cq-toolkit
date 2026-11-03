// Split provenance: test/ops/merge/planMergeOrder.test.ts was split by subject
// into planMergeOrder.order.test.ts, planMergeOrder.closed.test.ts,
// planMergeOrder.deferral.test.ts, planMergeOrder.gates.test.ts,
// planMergeOrder.cycles.test.ts, planMergeOrder.heads.test.ts and
// planMergeOrder.determinism.test.ts. This module is the single shared-fixture
// home; it declares no tests.
//
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
//      base branch); its depth-1 descendants still merge normally (that
//      rung does not merge this pass), while deeper rungs defer under
//      the generalized #153 gate — a base that merges earlier in the
//      pass holds its children.
//   4. TRUNCATED FAIL-CLOSED (UC §3 row 42): a truncated fetch is never
//      ordered for merge — needs-human, review_data_truncated — and beats
//      the unclassified gate (first match wins, F1's row order).
//   5. UNCLASSIFIED: classification null → needs-human, unclassified.
//   6. NON-ELIGIBLE VERDICT: F1's verdict is the planner's gate too — the
//      FULL acceptance decision carries to the stack level. Only
//      `eligible` is ever ordered; never / conflicting /
//      awaiting each → needs-human, not_eligible, absent from the
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
export const classified = (
  verdict: PrClassification['verdict'],
  reason: PrClassification['reason'],
): PrClassification => ({
  verdict,
  reason,
  unresolvedExternalThreads: 0,
});

/** An open, classified, untruncated PR — all gates open. */
export const planned = (
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

export const plan = (baseBranch: string, prs: PlannedPr[]): PlanMergeResult =>
  planMergeOrder({ baseBranch, prs } satisfies PlanMergeInput);
