/** Inactive merged-discovery transaction seam. The caller holds tick.lock. */
import { JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { withObjectKeys } from '../policy/crq/queueDoc.js';
import { normalizeInterval, type ReconcileInterval } from '../policy/crq/reconcileCheckpoint.js';

export interface DiscoveryEffects {
  loadQueue(): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
  /** Must save checkpoint and enrollment before returning; failures propagate. */
  reconcile(interval: ReconcileInterval): Promise<JsonObject>;
  /** Best effort; called only after the watermark is durable. */
  prune(queue: JsonObject, cutoff: string): Promise<number>;
  now(): Date;
}

function iso(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Resume valid unfinished bounds rather than letting each tick slide them. */
export function rollingInterval(queue: JsonObject, floor: unknown, now: Date): ReconcileInterval {
  let before = iso(new Date(now.getTime() - 1000));
  const validatedFloor = normalizeInterval(floor, before).after;
  const active = queue.get('merged_discovery');
  if (active instanceof JsonObject && active.get('complete') !== true) {
    const after = active.get('after');
    const end = active.get('before');
    if (
      typeof after === 'string' &&
      typeof end === 'string' &&
      after >= validatedFloor &&
      end < before &&
      after < end
    ) {
      return normalizeInterval(after, end);
    }
  }
  const watermark = queue.get('merged_watermark');
  let after = validatedFloor;
  if (typeof watermark === 'string' && watermark !== '') {
    const parsed = Date.parse(watermark);
    if (!Number.isFinite(parsed)) throw new Error('invalid merged watermark');
    after = [after, iso(new Date(parsed - 300_000))].sort().at(-1)!;
    // Partition hints must not silently widen an inventory-cap retry.
    if (active instanceof JsonObject) {
      const overlap = active.get('overlap_from');
      if (typeof overlap === 'string')
        after = [after, [overlap, watermark].sort()[0]!].sort().at(-1)!;
      const span = active.get('span');
      // Lossless JSON integers are handled by the eventual partition policy;
      // refuse rather than discard a hint while that policy is incomplete.
      if (span !== undefined && span !== null) throw new Error('partition span is not implemented');
    }
  }
  return normalizeInterval(after, before);
}

/**
 * Crash ordering: bounds, checkpoint/enrollment, summary, watermark, prune
 * stamp. A storage failure aborts; no failure may advance the watermark.
 * Reconciliation reloads the saved queue, avoiding stale enrollment overwrite.
 */
export async function discoverRolling(
  interval: ReconcileInterval,
  effects: DiscoveryEffects,
): Promise<{ queue: JsonObject; summary: JsonObject; pruned: number }> {
  const bounds = normalizeInterval(interval.after, interval.before);
  let queue = await effects.loadQueue();
  const active = queue.get('merged_discovery');
  if (active instanceof JsonObject && (active.has('span') || active.has('overlap_from'))) {
    throw new Error('partition hints are not implemented');
  }
  const same =
    active instanceof JsonObject &&
    active.get('after') === bounds.after &&
    active.get('before') === bounds.before;
  if (!same || (active instanceof JsonObject && (active.has('error') || active.has('reason')))) {
    // Do not discard partition state that the current seam cannot implement.
    const record = new JsonObject([
      ['after', bounds.after],
      ['before', bounds.before],
      ['complete', same && active instanceof JsonObject && active.get('complete') === true],
    ]);
    queue = withObjectKeys(queue, [['merged_discovery', record]]);
    await effects.saveQueue(queue);
  }
  const summary = await effects.reconcile(bounds);
  const complete = summary.get('complete');
  if (typeof complete !== 'boolean') throw new Error('invalid discovery completeness');
  queue = await effects.loadQueue();
  const record = new JsonObject([
    ['after', bounds.after],
    ['before', bounds.before],
    ['complete', complete],
  ]);
  queue = withObjectKeys(queue, [['merged_discovery', record]]);
  await effects.saveQueue(queue);
  let pruned = 0;
  if (complete) {
    const previous = queue.get('merged_watermark');
    const watermark =
      typeof previous === 'string' && previous > bounds.before ? previous : bounds.before;
    queue = withObjectKeys(queue, [['merged_watermark', watermark]]);
    await effects.saveQueue(queue);
    const now = effects.now();
    const last = queue.get('merged_wrappers_pruned_at');
    const parsed = typeof last === 'string' ? Date.parse(last) : NaN;
    const age = now.getTime() - parsed;
    if (!Number.isFinite(parsed) || age < 0 || age >= 3_600_000) {
      pruned = await effects.prune(queue, iso(new Date(now.getTime() - 7 * 86_400_000)));
      queue = withObjectKeys(queue, [
        ['merged_wrappers_pruned_at', iso(effects.now()) as JsonValue],
      ]);
      await effects.saveQueue(queue);
    }
  }
  return { queue, summary, pruned };
}
