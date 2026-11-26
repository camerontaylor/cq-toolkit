/**
 * The three backfill seams of `CoverageEffects` that have a faithful TS module:
 * `rank4Gate` (`backfill_runtime.rank4_gate`), `bindRun` and
 * `cancelBeforeVendor` (`backfill_jobs.bind_run` / `cancel_before_vendor`).
 * Inactive: nothing routes them, and `LIVE_UNIT_COMMANDS` is untouched.
 *
 * The coverage pass edits one plain mutable queue in place and relies on item
 * identity, while the ported gate and job policies are immutable over
 * `JsonObject`. Each seam converts the plain queue in, runs the port, and
 * {@link syncInto} writes the result back into the SAME queue and item objects.
 * The int/float distinction survives only where `fromPlainJson` can see it (an
 * integral float reads as an int), the same documented limit as `bindStartOne`.
 *
 * What stays injected ({@link Rank4Collaborators}): the clock, ordinary
 * eligibility, the live usage refresh, the state-event outbox and the queue
 * writer. They are the real effects the Python gate reaches through `c`, and an
 * unbound one must throw, never succeed.
 */
import { rank4Gate } from '../../ops/crq/internal/backfillGate.js';
import { bindRun, cancelBeforeVendor } from '../../policy/crq/backfillJobs.js';
import { LedgerTypeError } from '../../policy/crq/ledger.js';
import { JsonObject, toPlainJson } from '../../policy/crq/jsonValue.js';
import { fromPlainJson } from '../../policy/crq/queueDoc.js';
import type { CoverageEffects, Item, Queue } from '../../queue-runner/coverageUsage.js';
import { keepUnsafeFloats } from '../../queue-runner/startOneEffects.js';

/** The effects `rank4_gate` reaches through the Python `c` module. */
export interface Rank4Collaborators {
  /** `c.iso()`. */
  iso(): string;
  /** `c.ordinary_review_eligible(queue)`. */
  ordinaryEligible(queue: Queue): boolean;
  /** `c.refresh_backfill_usage(queue)`: edits the queue in place; absent when the module has none. */
  refreshUsage?: (queue: Queue) => Promise<boolean>;
  /** `backfill_runtime.state_event(c, queue, item, at, reason)`: edits the queue in place. */
  stateEvent(queue: Queue, item: Item, at: string, reason: string): Promise<void>;
  /** `c.save_queue(queue)`. */
  saveQueue(queue: Queue): Promise<void>;
}

type Plain = Record<string, unknown>;
const isPlain = (v: unknown): v is Plain =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof JsonObject);

/** Make `target` hold exactly `source`, reusing nested objects and arrays by position/key. */
export function syncInto(target: unknown, source: unknown): unknown {
  if (Array.isArray(target) && Array.isArray(source)) {
    for (let i = 0; i < source.length; i++) target[i] = syncInto(target[i], source[i]);
    target.length = source.length;
    return target;
  }
  if (isPlain(target) && isPlain(source)) {
    for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
    for (const key of Object.keys(source))
      Object.defineProperty(target, key, {
        value: syncInto(target[key], source[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return target;
  }
  return source;
}

const toJson = (queue: Queue): JsonObject => fromPlainJson(keepUnsafeFloats(queue)) as JsonObject;
const pull = (queue: Queue, json: JsonObject): void => {
  syncInto(queue, toPlainJson(json, { bigints: true }));
};

function indexOfItem(queue: Queue, item: Item): number {
  const items: unknown = queue.items;
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  const index = items.indexOf(item);
  if (index < 0) throw new LedgerTypeError('item is not in the queue');
  return index;
}

/** `CoverageEffects.rank4Gate` over the plain queue. */
export function bindRank4Gate(c: Rank4Collaborators): CoverageEffects['rank4Gate'] {
  return async (queue, item, dry) => {
    const index = indexOfItem(queue, item);
    const ordinary = c.ordinaryEligible(queue);
    const result = await rank4Gate(toJson(queue), index, ordinary, dry, {
      now: () => c.iso(),
      ...(c.refreshUsage === undefined
        ? {}
        : {
            refreshUsage: async (json: JsonObject) => {
              pull(queue, json);
              const successful = await (c.refreshUsage as (q: Queue) => Promise<boolean>)(queue);
              return { queue: toJson(queue), successful };
            },
          }),
      stateEvent: async (json, _row, at, reason) => {
        pull(queue, json);
        const live = queue.items[index];
        await c.stateEvent(queue, live as Item, at, reason);
        return toJson(queue);
      },
      saveQueue: async (json) => {
        pull(queue, json);
        await c.saveQueue(queue);
      },
    });
    pull(queue, result.queue);
    return result.admitted;
  };
}

/** `CoverageEffects.bindRun`: `backfill_jobs.bind_run` over the plain queue. */
export const bindBindRun: CoverageEffects['bindRun'] = (queue, item, runId) => {
  const result = bindRun(toJson(queue), indexOfItem(queue, item), runId);
  pull(queue, result.queue);
};

/** `CoverageEffects.cancelBeforeVendor`: `backfill_jobs.cancel_before_vendor` over the plain queue. */
export const bindCancelBeforeVendor: CoverageEffects['cancelBeforeVendor'] = (queue, item) => {
  const result = cancelBeforeVendor(toJson(queue), indexOfItem(queue, item));
  pull(queue, result.queue);
};
