// planMergeOrder — the stacked-PR merge plan (goal F2, ws-f scope item 2;
// UC §3 row 42: fetch caps mark the data truncated → the plan fails closed,
// the same carry F1's table applies per PR, here applied to the STACK:
// "fetch caps mark truncated → classify fails closed"). Pure and
// deterministic: plain data in, a plain plan out, no I/O, no gh calls, NO
// CLOCK — ordering needs no time, so nothing is injected and nothing is
// stolen from the ambient clock. Same input → deep-equal plan, always.
//
// THE STACK GRAPH: an open PR X stacks on an open PR Y when
// X.baseRefName === Y.headRefName (the branch X proposes to merge into IS
// Y's branch); a PR whose baseRefName === input.baseBranch is a ROOT. The
// base branch name comes from the CALLER — configuration at the call site,
// never a hardcoded queue-branch name here (acceptance-critical: any
// branch name must plan identically; test pins a custom name).
//
// THE ORDER — ROOTS FIRST, then each root's descendants depth-first, all
// levels in PR-number order, and a PR never appears before its base PR.
// All iterations run over PR-number-sorted data, so input array order
// never leaks into the plan.
//
// EVERY open PR lands in exactly one of two buckets — the order, or
// needsHuman — under NOTHING MERGES UNINVITED (I2): where the stack data
// is ambiguous or incomplete, the plan refuses to order the merge and
// names a human. The fail-closed rules, in the order they fire:
//   1. the same pr number arrives in
//      more than one entry (the fetch
//      layer cannot say which row is
//      real)                            → `duplicate_pr`
//   2. truncated fetch data            → `review_data_truncated`  (UC row 42)
//   3. no F1 classification            → `unclassified`
//   4. F1 verdict is not `eligible`    → `not_eligible`
//      (never / conflicting / awaiting / has-issues — a PR F1 judged not
//      mergeable is not re-graded into the order by the planner)
//   5. base ref resolves to nothing    → `unresolved_base`
//      (neither the base branch nor any fetched headRefName — a stack
//      position that cannot be computed is a stack position that must not
//      be guessed)
//   6. a stack cycle (X on Y, Y on X —
//      possible via misconfigured bases;
//      a PR stacked on itself counts)   → `stack_cycle`
//   7. base PR held by any rule above   → `stack_base_needs_human`
//      (fail-closed CASCADE: merging a stacked PR merges its base's
//      commits with it — ordering the child while the parent is held
//      would merge the parent UNINVITED, so the child is held too,
//      transitively)
// Rules 1–7 are FIRST MATCH WINS and strictly ordered: the gates (1–4)
// all run before base resolution (5) and cycle detection (6), so a PR's
// gate reason is never overwritten by a later rule — a truncated PR with
// a ghost base stays `review_data_truncated`, and a truncated cycle
// member keeps its gate reason while the clean partner reads as
// `stack_cycle`.
// Rules 2–4 are F1's per-PR acceptance decision carried to the stack
// level WHOLE — truncation, nullness, AND the verdict: only a PR F1 said
// `eligible` is ever ordered for immediate merge (truncated first).
//
// CLOSED-ANCESTOR RETARGET (`retarget-self`): an open PR whose base head
// is owned by a CLOSED PR (the rung it stacked on was already merged or
// closed) is planned AS IF IT WERE A ROOT — depth 0, basePr null — and
// its entry carries `action: 'retarget-self'` instead of `'merge'`: the
// fix is the caller's retarget of that PR's base ref onto the base
// branch, not a merge. Roots keep `action: 'merge'`. Base resolution is
// deterministic on duplicate head names: the lowest-numbered owner wins,
// and an OPEN owner always outranks a closed one (a live stack rung is
// the stack; the closed one is history).
//
// CLOSED PRs are structural only: they never merge, so they never appear
// in the order; they need nothing from a human, so they never appear in
// needsHuman; their headRefNames still anchor the retarget-self rule.
// The truncation and classification gates apply to open PRs only — a
// closed PR's absent classification is expected, not a failure.
import type { PrClassification } from './classifyPrs.js';

/**
 * One candidate PR as the fetch layer delivered it, carried to the plan
 * verbatim. `classification` is F1's verdict (null when the PR was never
 * classified); `truncated` is the fail-closed fetch flag — when true, the
 * data any verdict would rest on is incomplete and the PR is never
 * ordered for merge (UC §3 row 42). Closed PRs appear as stack structure
 * only (the merged rung a child stacked on).
 */
export interface PlannedPr {
  /** The PR number. */
  pr: number;
  /** The PR's head branch (git ref name). */
  headRefName: string;
  /** The branch the PR proposes to merge into — its stack position. */
  baseRefName: string;
  /**
   * The observed head SHA the candidate carried (review-debt #186), when
   * one was observed: the plan threads it to executeMerges so the
   * server-side merge pins `--match-head-commit`. OPTIONAL so callers that
   * never observed a head (test fixtures, structural plans) are unchanged;
   * the self-host fetch always observes one.
   */
  headSha?: string;
  /** Whether the PR is open or closed. */
  state: 'open' | 'closed';
  /** The PR author's GitHub login, or null when unavailable. Carried for
   * callers; the ordering itself is author-blind. */
  authorLogin: string | null;
  /** F1's classification, or null when the PR was never classified. */
  classification: PrClassification | null;
  /** The fail-closed truncation flag from the fetch layer (UC row 42). */
  truncated: boolean;
}

/** The plan's input: the configured base branch name (config at the call
 * site — never hardcoded here) and the candidate PRs. */
export interface PlanMergeInput {
  /** The branch a ROOT stacks onto; retarget-self points children of
   * closed rungs back at this branch. */
  baseBranch: string;
  /** The candidate PRs, in any array order — the plan sorts internally. */
  prs: PlannedPr[];
}

/**
 * WHY a PR was withheld from the order — stable snake_case, one value per
 * fail-closed rule (safe to log, group, and assert on), mirroring F1's
 * reason discipline. The vocabulary is frozen the same way: adding,
 * removing, or renaming a reason is a recorded deviation.
 */
export type PlanBlockReason =
  // Round-2 recorded deviation (PR131 r2): the duplicate-pr guard's
  // addition to this frozen vocabulary.
  | 'duplicate_pr'
  | 'review_data_truncated'
  | 'unclassified'
  // Round-1 recorded deviation (PR131 r1): the verdict gate's addition to
  // this frozen vocabulary.
  | 'not_eligible'
  | 'unresolved_base'
  | 'stack_cycle'
  | 'stack_base_needs_human';

/** One merge action in the plan. `merge`: merge this PR now (its base is
 * already merged or earlier in the order). `retarget-self`: do NOT merge —
 * retarget this PR's base ref onto the base branch first (its stack rung
 * was closed); it re-enters a future plan as an ordinary root. */
export interface PlannedMergeEntry {
  /** The PR number. */
  pr: number;
  /** `merge` for roots and stacked children; `retarget-self` for a PR
   * whose stack rung was closed (planned at root position instead). */
  action: 'merge' | 'retarget-self';
  /** The PR this one stacks on, or null for a root-position entry (true
   * roots and retarget-self entries alike). */
  basePr: number | null;
  /** Stack depth: roots are 0, a child is its base's depth + 1. */
  depth: number;
  /**
   * The observed head SHA the candidate carried (review-debt #186), when
   * one was observed: executeMerges pins the merge with
   * `--match-head-commit <headSha>`, so a fixer push between plan and run
   * cannot merge an unreviewed head.
   * Present only when the fetch observed one.
   */
  headSha?: string;
}

/** The plan: the merge order (roots first, depth-first, parents before
 * children), the withheld PRs with reasons (PR-number order), and the base
 * branch the plan was built against (echoed for the caller's report). */
export interface PlanMergeResult {
  /** PRs cleared to merge — every gate open, F1 verdict `eligible` — in
   * execution order. */
  order: PlannedMergeEntry[];
  /** Open PRs withheld from the order, each with exactly one reason,
   * in PR-number order. */
  needsHuman: Array<{ pr: number; reason: PlanBlockReason }>;
  /** The base branch the plan was built against (input echo). */
  baseBranch: string;
}

/**
 * Plan the merge order for a stack of PRs. Pure and deterministic: same
 * input → deep-equal result. See the module doc for the graph, the
 * roots-first ordering, and the seven fail-closed rules; the base branch
 * name is configuration arriving on `input` — no queue-branch name is
 * hardcoded anywhere in this family.
 */
export function planMergeOrder(input: PlanMergeInput): PlanMergeResult {
  const baseBranch = input.baseBranch;

  // Every pass below walks PR-number-sorted data: the input array's order
  // must never leak into the plan (determinism is the contract).
  const sorted = [...input.prs].sort((a, b) => a.pr - b.pr);

  // The needsHuman ledger and the set of PRs excluded from the order —
  // one entry per open PR, guarded so no PR is ever reported twice.
  const needsHuman: Array<{ pr: number; reason: PlanBlockReason }> = [];
  const excluded = new Set<number>();
  const withhold = (pr: number, reason: PlanBlockReason): void => {
    if (excluded.has(pr)) return;
    excluded.add(pr);
    needsHuman.push({ pr, reason });
  };

  // Gate 1 — duplicate pr numbers: the fetch layer handed the SAME pr
  // number more than once (possibly with divergent refs), so no rule can
  // tell which row is real. Every duplicate OPEN entry is withheld, and
  // this guard runs AHEAD of every other rule: a duplicated number never
  // plans, never roots, never retargets. The count spans EVERY row with
  // that pr number — an open twin of a closed duplicate is withheld —
  // but the ledger reports open entries only (closed rows never appear
  // in needsHuman). (The entries still lend their head names to the
  // open-owner map built below, so a child of a duplicated head resolves
  // its edge and cascades off the withheld set in the usual way.)
  const prCount = new Map<number, number>();
  for (const candidate of sorted) {
    prCount.set(candidate.pr, (prCount.get(candidate.pr) ?? 0) + 1);
  }
  for (const candidate of sorted) {
    if (candidate.state !== 'open') continue;
    if ((prCount.get(candidate.pr) ?? 0) !== 1) {
      withhold(candidate.pr, 'duplicate_pr');
    }
  }

  // Closed PRs: structural only — never merged, never reported; their
  // head names anchor the retarget-self rule (lowest number wins on
  // duplicate heads).
  const closedOwnerOfHead = new Map<string, number>();
  for (const candidate of sorted) {
    if (candidate.state === 'closed' && !closedOwnerOfHead.has(candidate.headRefName)) {
      closedOwnerOfHead.set(candidate.headRefName, candidate.pr);
    }
  }

  // Gates 2–4 (F1's carry, first match wins): truncated fetch
  // data means the classification's evidence may be missing — the PR is
  // never ordered for merge (UC row 42); a missing classification means
  // the acceptance decision was never made; a classification that came
  // back anything but `eligible` means F1 judged the PR not mergeable —
  // the planner re-grades nothing, it carries the verdict. Open PRs
  // only: a closed PR's absent classification is expected, not a failure.
  for (const candidate of sorted) {
    if (candidate.state !== 'open') continue;
    if (candidate.truncated) {
      withhold(candidate.pr, 'review_data_truncated');
    } else if (candidate.classification === null) {
      withhold(candidate.pr, 'unclassified');
    } else if (candidate.classification.verdict !== 'eligible') {
      withhold(candidate.pr, 'not_eligible');
    }
  }

  // The open candidates (ALL of them — gated ones included, so a child's
  // stack edge can resolve to a withheld parent and cascade off it) and
  // their heads. Duplicate head names resolve to the lowest-numbered open
  // owner (deterministic).
  const open = sorted.filter((candidate) => candidate.state === 'open');
  const openOwnerOfHead = new Map<string, number>();
  for (const candidate of open) {
    if (!openOwnerOfHead.has(candidate.headRefName)) {
      openOwnerOfHead.set(candidate.headRefName, candidate.pr);
    }
  }

  // Resolve each candidate's stack position: root (merge), root
  // (retarget-self — its rung was closed), stacked (edge to its base), or
  // unresolved (gate 5). An OPEN owner of the base head always outranks a
  // closed one: a live rung is the stack, a closed one is history. Gated
  // candidates keep their gate reason (withhold ignores re-firings) but
  // still contribute their edge — their children must cascade off them.
  const baseOf = new Map<number, number>();
  const mergeRoots: number[] = [];
  const retargetRoots: number[] = [];
  for (const candidate of open) {
    if (candidate.baseRefName === baseBranch) {
      if (!excluded.has(candidate.pr)) mergeRoots.push(candidate.pr);
      continue;
    }
    const openBase = openOwnerOfHead.get(candidate.baseRefName);
    if (openBase !== undefined) {
      // Gate-1 duplicates contribute NO edge: for equal-pr rows the last
      // write would win (the stable sort keeps input order, so array
      // position would become a hidden tie-breaker) and a live PR whose
      // chain walks through the duplicate could flip between cyclic and
      // cascaded — a determinism leak. Their head names still anchor
      // children: the open-owner map above is built from ALL open rows,
      // so child resolution and cascades are unchanged. A self-reference
      // (headRefName === baseRefName) on a live row stays an edge — the
      // cycle walk below reads it as the length-1 cycle it is.
      if (prCount.get(candidate.pr) === 1) {
        baseOf.set(candidate.pr, openBase);
      }
      continue;
    }
    if (closedOwnerOfHead.has(candidate.baseRefName)) {
      if (!excluded.has(candidate.pr)) retargetRoots.push(candidate.pr);
      continue;
    }
    withhold(candidate.pr, 'unresolved_base');
  }

  // Gate 6 — stack cycles: a candidate is ON a cycle exactly when walking
  // its base chain returns to it (covers length-1 self-loops and any
  // misconfigured mutual stacking). Cycle members are withheld, not
  // ordered — a cycle has no root to merge from. Already-withheld
  // candidates keep their first (gate) reason; the walk still passes
  // through their edges.
  for (const pr of baseOf.keys()) {
    if (excluded.has(pr)) continue;
    const seen = new Set<number>([pr]);
    let current = baseOf.get(pr);
    let cyclic = false;
    while (current !== undefined) {
      if (current === pr) {
        cyclic = true;
        break;
      }
      if (seen.has(current)) break; // the walk merged into ground outside this cycle
      seen.add(current);
      current = baseOf.get(current);
    }
    if (cyclic) withhold(pr, 'stack_cycle');
  }

  // Children of each base, in PR-number order (baseOf was filled from the
  // PR-number-sorted `open`, so buckets inherit that order).
  const childrenOf = new Map<number, number[]>();
  for (const [child, base] of baseOf) {
    if (excluded.has(child)) continue; // cycle members need no edges
    const bucket = childrenOf.get(base);
    if (bucket === undefined) {
      childrenOf.set(base, [child]);
    } else {
      bucket.push(child);
    }
  }

  // Gate 7 — the fail-closed cascade: a child of any withheld PR is
  // withheld too (merging it would merge its parent's commits
  // UNINVITED), transitively down the stack.
  const cascade = (pr: number): void => {
    const kids = childrenOf.get(pr);
    if (kids === undefined) return;
    for (const kid of kids) {
      if (excluded.has(kid)) continue;
      withhold(kid, 'stack_base_needs_human');
      cascade(kid);
    }
  };
  for (const pr of [...excluded]) cascade(pr);

  // The order: ALL roots first (merge and retarget-self together) in
  // PR-number order — the roots are the plan's PREFIX — then each root's
  // descendants depth-first, children in PR-number order, a PR never
  // before its base. Roots merge or retarget-self; every deeper entry is
  // an ordinary merge (a child of a retarget-self root merges normally
  // once the root's base is retargeted — its commits land only on the
  // root's branch, never on the base branch; the I2-safe reading, which is
  // the executor's tested behavior).
  const order: PlannedMergeEntry[] = [];
  const retargetSet = new Set(retargetRoots);
  const roots = [...mergeRoots, ...retargetRoots].sort((a, b) => a - b);
  // PR-number → candidate (review-debt #186): the plan threads the observed
  // head SHA onto every entry so executeMerges can pin the
  // merge and re-check the base. Duplicate numbers resolve last-wins here,
  // but duplicates are withheld by gate 1 and never ordered.
  const plannedByPr = new Map(sorted.map((candidate) => [candidate.pr, candidate]));
  const entryFor = (
    pr: number,
    action: 'merge' | 'retarget-self',
    basePr: number | null,
    depth: number,
  ): PlannedMergeEntry => {
    const candidate = plannedByPr.get(pr);
    const headSha = candidate?.headSha;
    return {
      pr,
      action,
      basePr,
      depth,
      // Only a 40-hex head rides (the consumer's schema admits no other) —
      // an unobserved/garbage head is omitted rather than emitted invalid.
      ...(headSha !== undefined && /^[0-9a-f]{40}$/i.test(headSha) ? { headSha } : {}),
    };
  };
  for (const pr of roots) {
    order.push(entryFor(pr, retargetSet.has(pr) ? 'retarget-self' : 'merge', null, 0));
  }
  const emitSubtree = (pr: number, basePr: number, depth: number): void => {
    order.push(entryFor(pr, 'merge', basePr, depth));
    const kids = childrenOf.get(pr);
    if (kids === undefined) return;
    for (const kid of kids) emitSubtree(kid, pr, depth + 1);
  };
  for (const pr of roots) {
    const kids = childrenOf.get(pr);
    if (kids === undefined) continue;
    for (const kid of kids) emitSubtree(kid, pr, 1);
  }

  // The ledger, in PR-number order (stable — prs are unique keys).
  needsHuman.sort((a, b) => a.pr - b.pr);

  return { order, needsHuman, baseBranch };
}
