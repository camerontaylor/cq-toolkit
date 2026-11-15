/**
 * The `plan_merged` and `plan_author` planners (crq.py:1807, 1823). Inactive:
 * nothing imports this outside tests.
 *
 * Git, the author lease check, the author binding and the synthetic-projection
 * builder are injected through {@link MergedAuthorPlanEffects}. Domain
 * refusals return a tagged outcome (as in the ordinary planners) rather than
 * sharing an exception class; anything the injected pieces throw (an
 * AuthorRefused, a missing `merge_commit`) propagates unchanged, because
 * Python routes those through the generic planning-error branch.
 */

export type PlanItem = Record<string, unknown>;

export interface MergedPlan {
  base: string;
  head: string;
  target: string;
  label: string;
  cycle: null;
  branch: null;
  notes: string[];
}

/** `author_quota.plan`'s output; the binding is already validated. */
export interface AuthorPlan {
  base: string;
  head: string;
  target: string;
  cycle: number;
  branch: null;
  notes: string[];
  label: string;
}

export type PlanOutcome<P> =
  | { readonly outcome: 'plan'; readonly plan: P }
  | { readonly outcome: 'not-ready'; readonly reason: string }
  | { readonly outcome: 'nothing-to-review'; readonly reason: string };

export interface MergedAuthorPlanEffects {
  /** `DEFAULT_REF` (e.g. `origin/main`). */
  readonly defaultRef: string;
  /** `git rev-parse <ref>^{commit}`; throws on failure. */
  revParseCommit(ref: string): Promise<string>;
  /** `git merge-base --is-ancestor ancestor descendant` in the primary clone. */
  isAncestor(ancestor: string, descendant: string): Promise<boolean>;
  /** `build_synthetic`: the projection base/head and the PR-touched path count. */
  buildSynthetic(
    item: PlanItem,
    target: string,
  ): Promise<{ base: string; head: string; paths: number }>;
  /** `author_lease.check_queue(item, at=iso())`; throws AuthorRefused. */
  checkAuthorLease(item: PlanItem): void;
  /** `author_quota.normalize_binding(...)` over `item.author`; throws AuthorRefused. */
  authorBinding(item: PlanItem): {
    base: string;
    head: string;
    target: string;
    cycle: number;
  };
  /** `git cat-file -e <sha>^{commit}` in the primary clone. */
  objectPresent(sha: string): Promise<boolean>;
  /** `fetch()`: refresh the primary clone. */
  fetch(): Promise<void>;
  /** `git diff --name-only base head` is non-empty; false when git fails (check=False). */
  diffHasPaths(base: string, head: string): Promise<boolean>;
}

export async function planMerged(
  item: PlanItem,
  dry: boolean,
  effects: MergedAuthorPlanEffects,
): Promise<PlanOutcome<MergedPlan>> {
  if (dry) {
    return {
      outcome: 'plan',
      plan: {
        base: '(synthetic)',
        head: '(synthetic)',
        target: effects.defaultRef,
        label: 'post-merge synthetic review',
        cycle: null,
        notes: [],
        branch: null,
      },
    };
  }
  const target = await effects.revParseCommit(`${effects.defaultRef}^{commit}`);
  // Python indexes item["merge_commit"]; a missing key is a planning error.
  if (typeof item.merge_commit !== 'string') throw new TypeError("KeyError: 'merge_commit'");
  if (!(await effects.isAncestor(item.merge_commit, target))) {
    return {
      outcome: 'not-ready',
      reason: 'not-yet-promoted: merge commit is not an ancestor of origin/main',
    };
  }
  const { base, head, paths } = await effects.buildSynthetic(item, target);
  return {
    outcome: 'plan',
    plan: {
      base,
      head,
      target,
      cycle: null,
      branch: null,
      label: `post-merge current projection (${paths} PR-touched paths at promoted main)`,
      notes: [],
    },
  };
}

/** Python `str[:n]` on the 40-hex shas the binding validator guarantees. */
const short = (sha: string, n: number): string => sha.slice(0, n);

export async function planAuthor(
  item: PlanItem,
  dry: boolean,
  effects: MergedAuthorPlanEffects,
): Promise<PlanOutcome<AuthorPlan>> {
  effects.checkAuthorLease(item);
  const binding = effects.authorBinding(item);
  const plan: AuthorPlan = {
    base: binding.base,
    head: binding.head,
    target: binding.target,
    cycle: binding.cycle,
    branch: null,
    notes: [],
    label:
      `author review — cycle ${binding.cycle} ` +
      `${short(binding.base, 12)}..${short(binding.head, 12)} → ${binding.target}`,
  };
  if (dry) return { outcome: 'plan', plan };
  const present = async (): Promise<boolean> =>
    (await effects.objectPresent(plan.base)) && (await effects.objectPresent(plan.head));
  if (!(await present())) {
    await effects.fetch();
    if (!(await present())) {
      return {
        outcome: 'not-ready',
        reason: `author binding not fetchable (${short(plan.base, 10)}..${short(plan.head, 10)})`,
      };
    }
  }
  if (!(await effects.diffHasPaths(plan.base, plan.head))) {
    return { outcome: 'nothing-to-review', reason: 'author binding has an empty diff' };
  }
  return { outcome: 'plan', plan };
}
