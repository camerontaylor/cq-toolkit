/**
 * The ordinary-review planners `plan_open` and `plan_delta` (crq.py): given a
 * PR snapshot, decide the captured base/head range, or why there is nothing to
 * start. Inactive: nothing imports it outside tests.
 *
 * Git and the optional local-review reconciliation are injected through
 * {@link OrdinaryPlanEffects}. The planners never throw for domain refusals;
 * they return a tagged outcome so the caller maps `not-ready` and
 * `nothing-to-review` onto its own routing (Python's NotReady/NothingToReview)
 * without sharing an exception class with this module.
 */

/** The `pr_info` fields the planners read. */
export interface OrdinaryPrInfo {
  readonly state: string;
  readonly isDraft?: boolean;
  readonly headRefOid: string;
  readonly headRefName?: string | null;
  readonly baseRefName?: string;
  readonly mergeCommit?: { readonly oid: string } | null;
}

/** Items are edited in place under the caller's tick.lock, as Python edits its dict. */
export type OrdinaryItem = Record<string, unknown>;

export interface OrdinaryPlan {
  base: string;
  head: string;
  target: string;
  label: string;
  cycle: number | null;
  notes: string[];
  branch: string | null;
  review_pin: string;
  range_policy: 'full-range-once-v1';
  pr_head?: string;
  /** Added by `reconcile` (local-review profile and config digest). */
  [extra: string]: unknown;
}

export type OrdinaryOutcome =
  | { readonly outcome: 'plan'; readonly plan: OrdinaryPlan }
  | { readonly outcome: 'not-ready'; readonly reason: string }
  | { readonly outcome: 'nothing-to-review'; readonly reason: string };

export interface OrdinaryPlanEffects {
  /** `repo_registry.by_repo(...)`: the configured default branch, or null for the primary repo. */
  defaultBranch(repo: string | null): string | null;
  /** `ensure_commit`: true when the head commit is present (fetching `pull/N/head` if needed). */
  ensureCommit(pr: number, sha: string, repo: string | null): Promise<boolean>;
  /** `git merge-base target head` in the item's clone. */
  mergeBase(target: string, head: string, repo: string | null): Promise<string>;
  /**
   * `local_review_runtime.reconcile_pr`, run only when Python passes a queue
   * (the live tick does). It may add profile fields, record an equivalent
   * receipt, or refuse. Omit it for Python's `q=None` path.
   */
  reconcile?(item: OrdinaryItem, plan: OrdinaryPlan, dry: boolean): Promise<OrdinaryOutcome>;
}

const FULL_RANGE = 'full-range-once-v1';

function repoOf(item: OrdinaryItem): string | null {
  return typeof item.repo === 'string' && item.repo !== '' ? item.repo : null;
}

function cyclesOf(item: OrdinaryItem): Record<string, unknown>[] {
  return Array.isArray(item.cycles) ? (item.cycles as Record<string, unknown>[]) : [];
}

/** Python truthiness for the `run_id` the cycle record must carry. */
function hasRunId(record: Record<string, unknown>): boolean {
  return typeof record.run_id === 'string' && record.run_id !== '';
}

function notReady(reason: string): OrdinaryOutcome {
  return { outcome: 'not-ready', reason };
}

async function finish(
  item: OrdinaryItem,
  plan: OrdinaryPlan,
  dry: boolean,
  effects: OrdinaryPlanEffects,
): Promise<OrdinaryOutcome> {
  return effects.reconcile === undefined
    ? { outcome: 'plan', plan }
    : effects.reconcile(item, plan, dry);
}

/** `plan_open`: one review of the captured range of an open, non-draft PR. */
export async function planOpen(
  item: OrdinaryItem,
  info: OrdinaryPrInfo,
  dry: boolean,
  effects: OrdinaryPlanEffects,
): Promise<OrdinaryOutcome> {
  if (info.state !== 'OPEN') return notReady(`PR is ${info.state}`);
  if (info.isDraft === true) return notReady('PR is draft');
  const head = info.headRefOid;
  const repo = repoOf(item);
  const pr = item.pr as number;
  if (!(await effects.ensureCommit(pr, head, repo))) return notReady('source head unavailable');
  const configured = effects.defaultBranch(repo);
  const target = `origin/${configured ?? info.baseRefName}`;
  const pin = await effects.mergeBase(target, head, repo);
  for (const record of cyclesOf(item)) {
    if (
      record.base === pin &&
      record.head === head &&
      record.dirty_diff === 'clean tree' &&
      hasRunId(record) &&
      record.range_policy === FULL_RANGE
    ) {
      return {
        outcome: 'nothing-to-review',
        reason: 'exact captured base/head range already reviewed',
      };
    }
  }
  const notes: string[] = [];
  if (typeof item.pinned_base === 'string' && item.pinned_base !== '' && pin !== item.pinned_base) {
    notes.push('base drift: retain prior evidence; review the newly captured range once');
  }
  if (!dry) {
    item.pinned_base = pin;
    item.target_ref = target;
  }
  const plan: OrdinaryPlan = {
    base: pin,
    head,
    target,
    label: 'one review of captured range',
    cycle: cyclesOf(item).length + 1,
    notes,
    branch: info.headRefName ?? null,
    review_pin: pin,
    range_policy: FULL_RANGE,
  };
  return finish(item, plan, dry, effects);
}

/** `plan_delta`: the conservative full-range fallback when equivalent scope is unproven. */
export async function planDelta(
  item: OrdinaryItem,
  info: OrdinaryPrInfo,
  dry: boolean,
  effects: OrdinaryPlanEffects,
): Promise<OrdinaryOutcome> {
  if (info.state !== 'OPEN' && info.state !== 'MERGED') return notReady(`PR is ${info.state}`);
  const head = info.headRefOid;
  const repo = repoOf(item);
  const pr = item.pr as number;
  if (!(await effects.ensureCommit(pr, head, repo))) return notReady('source head unavailable');
  const merged = info.state === 'MERGED';
  let target: string;
  if (merged) {
    // Python indexes info['mergeCommit']['oid']; a MERGED PR without one is a planning error.
    if (info.mergeCommit === undefined || info.mergeCommit === null) {
      throw new TypeError("'NoneType' object is not subscriptable");
    }
    target = `${info.mergeCommit.oid}^1`;
  } else {
    target = `origin/${effects.defaultBranch(repo) ?? info.baseRefName}`;
  }
  const pin = await effects.mergeBase(target, head, repo);
  for (const record of cyclesOf(item)) {
    if (
      record.base === pin &&
      record.head === head &&
      record.range_policy === FULL_RANGE &&
      hasRunId(record)
    ) {
      return {
        outcome: 'nothing-to-review',
        reason: 'equivalent captured full range already reviewed',
      };
    }
  }
  const plan: OrdinaryPlan = {
    base: pin,
    head,
    pr_head: head,
    target,
    label: 'one full-range review (prior equivalent scope unproven)',
    cycle: null,
    notes: [],
    branch: merged ? null : (info.headRefName ?? null),
    review_pin: pin,
    range_policy: FULL_RANGE,
  };
  return finish(item, plan, dry, effects);
}
