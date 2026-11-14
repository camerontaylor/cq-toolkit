/** Inactive merged-discovery transaction seam. The caller holds tick.lock. */
import { JsonNumber, JsonObject, type JsonValue } from '../policy/crq/jsonValue.js';
import { isJsonInt, jsonIntValue, withObjectKeys } from '../policy/crq/queueDoc.js';
import {
  normalizeInterval,
  normalizeTimestamp,
  type ReconcileInterval,
} from '../policy/crq/reconcileCheckpoint.js';
import { InventoryCapExceeded, PageFailed } from '../policy/crq/reconcileInventory.js';
import { ReconcileRefused } from '../policy/crq/reconcileCheckpoint.js';

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

const MAX_SPAN = 400 * 86_400;
function hints(active: unknown): { span?: number; overlap?: string } {
  if (!(active instanceof JsonObject)) return {};
  const rawSpan = active.get('span');
  const value = isJsonInt(rawSpan) ? jsonIntValue(rawSpan) : 0n;
  const span = value > 0n && value <= BigInt(MAX_SPAN) ? Number(value) : undefined;
  const rawOverlap = active.get('overlap_from');
  let overlap: string | undefined;
  try {
    if (typeof rawOverlap === 'string') overlap = normalizeTimestamp('overlap_from', rawOverlap);
  } catch {
    /* invalid hints are ignored */
  }
  return { ...(span === undefined ? {} : { span }), ...(overlap === undefined ? {} : { overlap }) };
}

function record(
  bounds: ReconcileInterval,
  complete: boolean,
  carried: { span?: number; overlap?: string },
  reason?: string,
): JsonObject {
  const entries: [string, JsonValue][] = [
    ['after', bounds.after],
    ['before', bounds.before],
    ['complete', complete],
  ];
  if (carried.span !== undefined) entries.push(['span', JsonNumber.int(carried.span)]);
  if (carried.overlap !== undefined) entries.push(['overlap_from', carried.overlap]);
  if (reason !== undefined) entries.push(['reason', reason]);
  return new JsonObject(entries);
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
  if (watermark !== undefined && watermark !== null && typeof watermark !== 'string') {
    throw new Error('invalid merged watermark');
  }
  let after = validatedFloor;
  if (typeof watermark === 'string' && watermark !== '') {
    const parsed = Date.parse(watermark);
    if (!Number.isFinite(parsed)) throw new Error('invalid merged watermark');
    after = [after, iso(new Date(parsed - 300_000))].sort().at(-1)!;
    const carried = hints(active);
    if (carried.overlap !== undefined)
      after = [after, [carried.overlap, watermark].sort()[0]!].sort().at(-1)!;
    if (carried.span !== undefined)
      before = [
        [before, iso(new Date(parsed + carried.span * 1000))].sort()[0]!,
        iso(new Date(Date.parse(after) + 1000)),
      ]
        .sort()
        .at(-1)!;
  }
  return normalizeInterval(after, before);
}

/**
 * Crash ordering: bounds, checkpoint/enrollment, summary, watermark, prune
 * stamp. A storage failure aborts; no failure may advance the watermark.
 * Reconciliation reloads the saved queue, avoiding stale enrollment overwrite.
 * Invalid or empty intervals are refused rather than Python's no-op return:
 * this seam requires validated frozen bounds and does not claim an empty scan.
 */
export async function discoverRolling(
  interval: ReconcileInterval,
  effects: DiscoveryEffects,
): Promise<{ queue: JsonObject; summary: JsonObject; pruned: number }> {
  const bounds = normalizeInterval(interval.after, interval.before);
  let queue = await effects.loadQueue();
  const active = queue.get('merged_discovery');
  const carried = hints(active);
  const same =
    active instanceof JsonObject &&
    active.get('after') === bounds.after &&
    active.get('before') === bounds.before;
  if (!same || (active instanceof JsonObject && (active.has('error') || active.has('reason')))) {
    const complete = same && active instanceof JsonObject && active.get('complete') === true;
    queue = withObjectKeys(queue, [
      [
        'merged_discovery',
        record(
          bounds,
          complete,
          carried,
          carried.span && !complete ? 'inventory-cap-partitioned' : undefined,
        ),
      ],
    ]);
    await effects.saveQueue(queue);
  }
  let summary: JsonObject;
  try {
    summary = await effects.reconcile(bounds);
  } catch (error) {
    if (!(error instanceof ReconcileRefused) && !(error instanceof PageFailed)) throw error;
    queue = await effects.loadQueue();
    let nextBounds = bounds;
    let nextHints = carried;
    let partitioned = false;
    if (error instanceof InventoryCapExceeded) {
      const watermark = queue.get('merged_watermark');
      const low =
        typeof watermark === 'string' && watermark > bounds.after ? watermark : bounds.after;
      const seconds = Math.floor((Date.parse(bounds.before) - Date.parse(low)) / 1000);
      if (seconds >= 2) {
        const span = Math.floor(seconds / 2);
        nextBounds = { after: bounds.after, before: iso(new Date(Date.parse(low) + span * 1000)) };
        nextHints = { ...carried, span };
        partitioned = true;
      } else if (bounds.after < low && low < bounds.before) {
        nextBounds = { after: low, before: bounds.before };
        nextHints = { span: seconds, overlap: low };
        partitioned = true;
      }
    }
    const reason =
      error instanceof PageFailed
        ? error.reason
        : partitioned
          ? 'inventory-cap-partitioned'
          : 'reconcile-refused';
    const debt = withObjectKeys(record(nextBounds, false, nextHints, reason), [
      ['error', error.message.slice(0, 200)],
    ]);
    queue = withObjectKeys(queue, [['merged_discovery', debt]]);
    await effects.saveQueue(queue);
    return {
      queue,
      summary: new JsonObject([
        ['complete', false],
        ['reason', reason],
      ]),
      pruned: 0,
    };
  }
  const complete = summary.get('complete');
  if (typeof complete !== 'boolean') throw new Error('invalid discovery completeness');
  queue = await effects.loadQueue();
  if (complete) {
    if (carried.span !== undefined) carried.span = Math.min(carried.span * 2, MAX_SPAN);
    if (bounds.before >= iso(new Date(effects.now().getTime() - 721_000))) delete carried.span;
    if ((carried.overlap ?? '') <= iso(new Date(Date.parse(bounds.before) - 300_000)))
      delete carried.overlap;
  }
  queue = withObjectKeys(queue, [['merged_discovery', record(bounds, complete, carried)]]);
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
