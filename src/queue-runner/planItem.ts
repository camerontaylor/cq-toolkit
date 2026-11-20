/**
 * The planner dispatch inside `crq.start_one`'s `try:` block: which per-kind
 * planner an item goes to and how each planner's answer becomes a
 * {@link PlanOutcome}. Inactive: nothing binds it to a tick, slot or unit.
 *
 * Python signals "cannot start yet" and "nothing to review" with exceptions;
 * the TS planners answer with tagged outcomes, so this module re-raises them
 * as {@link StartNotReady} / {@link StartNothingToReview} for `startOne` to
 * route exactly as Python's `except` clauses do. A prepare pass that returns
 * Python's `None` becomes `none`, with the "(no vendor start)" log line only
 * for the receipt and push-current kinds.
 */
import {
  prInfo,
  quietReason,
  type PrInfoEffects,
  type QuietReasonEffects,
} from './preparePasses.js';
import {
  prepareCurrent,
  prepareLocalReview,
  preparePushCurrent,
  type PrepareCurrentEffects,
  type PrepareLocalReviewEffects,
  type PreparePushEffects,
  type PrepareOutcome,
} from './preparePasses.js';
import { planAuthor, planMerged, type MergedAuthorPlanEffects } from './mergedAuthorPlan.js';
import { planDelta, planOpen, type OrdinaryPlanEffects } from './ordinaryPlan.js';
import {
  StartNotReady,
  StartNothingToReview,
  type PlanOutcome,
  type StartPlan,
} from './startOne.js';
import type { Queue } from './preparePasses.js';
import { PUSH_KIND } from './launch.js';
import { AUTHOR_KIND, LOCAL_REVIEW_KIND, REVIEW_RECEIPT_KIND } from '../policy/crq/tickSchedule.js';

export interface PlanItemDeps {
  /** The live queue the prepare passes read. */
  readonly queue: Queue;
  readonly dry: boolean;
  /** `start_one(..., ignore_quiet)`: skips the quiet-age gate, never the active-agent gate. */
  readonly ignoreQuiet: boolean;
  /** `item_repo(item)`: the item's repository, defaulting to the primary one. */
  itemRepo(item: Record<string, unknown>): string;
  readonly prInfo: PrInfoEffects;
  readonly quiet: QuietReasonEffects;
  readonly ordinary: OrdinaryPlanEffects;
  readonly mergedAuthor: MergedAuthorPlanEffects;
  readonly current: PrepareCurrentEffects;
  readonly push: PreparePushEffects;
  readonly localReview: PrepareLocalReviewEffects;
}

type Item = Record<string, unknown>;

function asPlan(plan: unknown): StartPlan {
  return plan as StartPlan;
}

/** A tagged planner answer that can also mean Python's `None`. */
function fromPrepare<P>(outcome: PrepareOutcome<P>, logNoStart: boolean): PlanOutcome {
  if (outcome.outcome === 'not-ready') throw new StartNotReady(outcome.reason);
  if (outcome.outcome === 'nothing-to-review') return { outcome: 'none', logNoStart };
  return { outcome: 'plan', plan: asPlan(outcome.plan) };
}

/** A planner that raises Python's `NotReady` / `NothingToReview`. */
function fromPlanner<P>(
  outcome:
    | { readonly outcome: 'plan'; readonly plan: P }
    | { readonly outcome: 'not-ready'; readonly reason: string }
    | { readonly outcome: 'nothing-to-review'; readonly reason: string },
): PlanOutcome {
  if (outcome.outcome === 'not-ready') throw new StartNotReady(outcome.reason);
  if (outcome.outcome === 'nothing-to-review') throw new StartNothingToReview(outcome.reason);
  return { outcome: 'plan', plan: asPlan(outcome.plan) };
}

export async function planItem(item: Item, deps: PlanItemDeps): Promise<PlanOutcome> {
  const { dry, queue } = deps;
  switch (item.kind) {
    case LOCAL_REVIEW_KIND:
      // A `None` here is silent: Python `continue`s without a log line.
      return fromPrepare(await prepareLocalReview(queue, item, dry, deps.localReview), false);
    case AUTHOR_KIND:
      // Author items bind their own base/head/target: no PR, no quiet gate.
      return fromPlanner(await planAuthor(item, dry, deps.mergedAuthor));
    case REVIEW_RECEIPT_KIND:
      return fromPrepare(await prepareCurrent(queue, item, dry, deps.current), true);
    case PUSH_KIND:
      return fromPrepare(await preparePushCurrent(queue, item, dry, deps.push), true);
    case 'merged':
      return fromPlanner(await planMerged(item, dry, deps.mergedAuthor));
    default: {
      const info = await prInfo(item.pr as number, deps.itemRepo(item), deps.prInfo);
      const state = info.state;
      if (typeof state !== 'string') throw new Error("pr_info has no string 'state'");
      const postMerge = item.kind === 'delta' && state === 'MERGED';
      if (state !== 'OPEN' && !postMerge)
        return {
          outcome: 'skipped',
          state: 'skipped',
          lastError: `PR ${state.toLowerCase()} before review`,
          log: `PR ${state} → skipped`,
        };
      // Merged heads are immutable and get no addressing agent: no busy/quiet gate.
      const quiet = postMerge ? null : await quietReason(item, info, deps.ignoreQuiet, deps.quiet);
      if (quiet !== null && quiet !== '') return { outcome: 'wait', waitReason: quiet };
      const plan = (item.kind === 'open' ? planOpen : planDelta)(
        item,
        info as unknown as Parameters<typeof planOpen>[1],
        dry,
        deps.ordinary,
      );
      return fromPlanner(await plan);
    }
  }
}
