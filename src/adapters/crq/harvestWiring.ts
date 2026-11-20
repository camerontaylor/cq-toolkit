/**
 * Binds the plain-record harvest modules (`harvestReview`, `harvestLoop`,
 * `collectFinished`) to the tick's lossless `JsonObject` phase interface.
 * Inactive: nothing imports this until the live route is wired.
 *
 * The plain modules edit one queue and its items in place, and `harvestLoop`
 * holds a snapshot of the item objects, so a local-review harvest (which is an
 * immutable `JsonObject` port) is bridged back by index and its result is
 * copied into the same plain objects. Numbers stay `JsonNumber` through the
 * round trip; only a number a harvest computes becomes a fresh integer or float.
 * Integer-like object keys reorder in the plain form, which no queue key is.
 *
 * Nothing here supplies a default for an unported step: the repair harvest and
 * every filesystem, registry and coverage effect arrive as required seams.
 */
import { JsonObject, toPlainJsonRetainingNumbers } from '../../policy/crq/jsonValue.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import { liveItems } from '../../policy/crq/tickSchedule.js';
import {
  collectFinished,
  type CollectFinishedEffects,
} from '../../queue-runner/collectFinished.js';
import {
  harvestLoop,
  type HarvestLoopEffects,
  type Item,
  type Queue,
} from '../../queue-runner/harvestDelivery.js';
import { harvestReview, type HarvestReviewEffects } from '../../queue-runner/harvestReview.js';
import type { PhaseResult, TickPhases } from '../../queue-runner/tickOrchestrator.js';

/** The existing immutable local-review ports (`createLocalReviewHarvestCaller` and friends). */
export interface LocalReviewJsonSeams {
  /** `local_review_runtime.KIND` */
  readonly kind: string;
  harvest(
    queue: JsonObject,
    item: JsonObject,
    dry: boolean,
  ): Promise<{ queue: JsonObject; message: string | null }>;
  /** `republishLocalReview(queue, index, ...)` */
  republish(queue: JsonObject, index: number): Promise<JsonObject>;
  /** `local_review_runtime.reconcile_completed(module, q)` */
  reconcileCompleted(queue: JsonObject): Promise<JsonObject>;
}

export interface HarvestWiringDeps {
  readonly local: LocalReviewJsonSeams;
  /** `review_receipt.KIND` */
  readonly reviewReceiptKind: string;
  /** Every effect `harvest_review` needs for the non-local kinds. */
  readonly review: HarvestReviewEffects;
  /** `repair_tick.harvest(module, q, item)`: the S6-b step; supplied, never defaulted. */
  repairHarvest(q: Queue, item: Item): Promise<string[]>;
}

export type HarvestPhases = Pick<TickPhases, 'harvestItems' | 'reconcileCompleted'> & {
  /** `collect_finished(q, log)` for the slot. */
  collectFinished(queue: JsonObject): Promise<PhaseResult>;
};

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Replace the contents of `target` with `source`'s keys, in source order, keeping the object. */
function replaceContents(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const key of Object.keys(target)) delete target[key];
  for (const key of Object.keys(source)) define(target, key, source[key]);
}

/**
 * Copy an updated plain queue into `target` without replacing the queue, its
 * `items` array or any item object, so the caller's snapshot stays valid.
 */
function syncInPlace(target: Queue, source: Queue): void {
  const items = target.items;
  const next = source.items;
  if (!Array.isArray(items) || !Array.isArray(next) || items.length !== next.length)
    throw new Error('local-review harvest changed the queue items');
  next.forEach((value, index) => replaceContents(items[index] as Item, value as Item));
  replaceContents(target, { ...source, items });
}

const toPlain = (queue: JsonObject): Queue => toPlainJsonRetainingNumbers(queue) as Queue;

async function viaPlain(
  queue: JsonObject,
  work: (plain: Queue) => Promise<void>,
): Promise<JsonObject> {
  const plain = toPlain(queue);
  await work(plain);
  return fromPlainJson(plain) as JsonObject;
}

export function createHarvestPhases(deps: HarvestWiringDeps): HarvestPhases {
  const { local, review } = deps;
  const live = (q: Queue): Item[] => liveItems(q) as Item[];

  /** Run an immutable local-review port against the plain queue and sync the result back. */
  async function viaLocal<T extends { queue: JsonObject }>(
    plain: Queue,
    item: Item,
    work: (queue: JsonObject, index: number) => Promise<T>,
  ): Promise<T> {
    const index = plain.items.indexOf(item);
    if (index < 0) throw new Error('item not in queue');
    const result = await work(fromPlainJson(plain) as JsonObject, index);
    syncInPlace(plain, toPlain(result.queue));
    return result;
  }

  async function harvestOne(plain: Queue, item: Item, dry: boolean): Promise<string | null> {
    if (item.kind !== local.kind) return harvestReview(plain, item, dry, review);
    const { message } = await viaLocal(plain, item, async (json, index) => {
      const jsonItems = json.get('items');
      if (!Array.isArray(jsonItems) || !(jsonItems[index] instanceof JsonObject))
        throw new Error('missing local review item');
      return local.harvest(json, jsonItems[index], dry);
    });
    return message;
  }

  const republish = async (plain: Queue, item: Item): Promise<void> => {
    await viaLocal(plain, item, async (json, index) => ({
      queue: await local.republish(json, index),
    }));
  };

  const reconcileLocal = (queue: JsonObject): Promise<JsonObject> =>
    local.reconcileCompleted(queue);

  const loop: HarvestLoopEffects = {
    liveItems: live,
    localReviewKind: local.kind,
    reviewReceiptKind: deps.reviewReceiptKind,
    republish,
    harvestReview: harvestOne,
    repairHarvest: deps.repairHarvest,
  };
  const collect: CollectFinishedEffects = {
    liveItems: live,
    localReviewKind: local.kind,
    republish,
    exitFileExists: (runId) => review.exitFileExists(runId),
    runLiveness: (runId, item, run) => review.runLiveness(runId, item, run, true),
    harvestReview: (plain, item) => harvestOne(plain, item, false),
    async reconcileCompleted(plain) {
      syncInPlace(plain, toPlain(await reconcileLocal(fromPlainJson(plain) as JsonObject)));
    },
  };

  return {
    async harvestItems(queue, dry) {
      const log: string[] = [];
      const next = await viaPlain(queue, (plain) => harvestLoop(plain, log, dry, loop));
      return { queue: next, log };
    },
    reconcileCompleted: reconcileLocal,
    async collectFinished(queue) {
      const log: string[] = [];
      const next = await viaPlain(queue, (plain) => collectFinished(plain, log, collect));
      return { queue: next, log };
    },
  };
}
