import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { pyTruthy, pythonValueEqual, withObjectKeys } from '../../../policy/crq/queueDoc.js';

/** Seconds, matching backfill.inventory_unlocked. */
export const SNAPSHOT_LOCK_WAIT = 180;
export const MERGE_LOCK_WAIT = 600;
export const RUN_BUDGET_S = 2400;
export const MIN_MERGE_WAIT_S = 60;

export class BackfillTransactionError extends Error {
  override readonly name = 'BackfillTransactionError';
}

export interface PreparedInventory {
  readonly queue: JsonObject;
  readonly ranked: unknown;
  readonly report: unknown;
  readonly eventItems: readonly JsonValue[];
}

/** All queue and filesystem effects are supplied by the caller. A null lock result means busy. */
export interface InventoryTransactionEffects {
  clock(): number;
  withLock<T>(waitSeconds: number, action: () => Promise<T>): Promise<T | null>;
  loadQueue(): Promise<JsonObject>;
  settings(): Promise<unknown>;
  prepare(queue: JsonObject, enqueue: boolean): Promise<PreparedInventory>;
  stateEvent(queue: JsonObject, item: JsonObject): Promise<JsonObject>;
  writeRanked(ranked: unknown): Promise<void>;
  writeReport(report: unknown): Promise<void>;
  clearHalt(queue: JsonObject): JsonObject;
  saveQueue(queue: JsonObject): Promise<void>;
}

function clone(value: JsonValue): JsonValue {
  if (value instanceof JsonObject)
    return new JsonObject(value.entries.map(([key, v]) => [key, clone(v)]));
  if (Array.isArray(value)) return value.map(clone);
  return value;
}

function cloneSettings(value: unknown): unknown {
  if (value instanceof JsonNumber) return value;
  if (value instanceof JsonObject) return clone(value);
  if (Array.isArray(value)) return value.map(cloneSettings);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, cloneSettings(entry)]),
    );
  }
  return value;
}

const guardedKeys = [
  'backfill_families',
  'backfill_scope_failures',
  'backfill_path_lineages',
  'backfill_last_manifest',
  'legacy_coverage_releases',
];
const itemKeys = [
  'id',
  'kind',
  'target',
  'scope',
  'scope_digest',
  'path_lineages',
  'state',
  'vendor_state',
  'run',
  'job_id',
  'inventory_subject_id',
  'subject_id',
  'generation',
];

function items(queue: JsonObject): JsonObject[] {
  const value = queue.get('items') ?? [];
  if (!Array.isArray(value) || value.some((item) => !(item instanceof JsonObject))) {
    throw new BackfillTransactionError('inventory queue items must be objects');
  }
  return value as JsonObject[];
}

/** The narrow planning guard deliberately excludes unrelated scheduler changes. */
export function inventoryGuard(queue: JsonObject): JsonObject {
  const guardedItems = items(queue)
    .filter(
      (item) =>
        pyTruthy(item.get('scope')) ||
        pyTruthy(item.get('subject_id')) ||
        item.get('kind') === 'backfill',
    )
    .map(
      (item) =>
        new JsonObject(
          itemKeys.filter((key) => item.has(key)).map((key) => [key, item.get(key) as JsonValue]),
        ),
    );
  return new JsonObject([
    ...guardedKeys.map((key) => [key, queue.get(key) ?? null] as const),
    ['items', guardedItems],
  ]);
}

function id(item: JsonObject): JsonValue {
  const value = item.get('id');
  if (value === undefined) throw new BackfillTransactionError('inventory item missing id');
  return value;
}

function containsId(list: readonly JsonObject[], value: JsonValue): boolean {
  return list.some((item) => pythonValueEqual(id(item), value));
}

/** Merge only the prepared delta, retaining fresh scheduler-owned queue fields. */
export function mergeInventory(
  original: JsonObject,
  current: JsonObject,
  prepared: JsonObject,
): JsonObject {
  let merged = current;
  for (const [key, value] of prepared.entries) {
    if (key === 'items') {
      const oldItems = items(original);
      const currentItems = items(current);
      const additions = items(prepared).filter((item) => !containsId(oldItems, id(item)));
      if (additions.some((item) => containsId(currentItems, id(item))))
        throw new BackfillTransactionError('inventory job identity collision; retry inventory');
      merged = withObjectKeys(merged, [['items', [...currentItems, ...additions]]]);
    } else if (!original.has(key) || !pythonValueEqual(value, original.get(key))) {
      merged = withObjectKeys(merged, [[key, value]]);
    }
  }
  return merged;
}

export async function inventoryTransaction(
  effects: InventoryTransactionEffects,
  options: { readonly reportOnly: boolean },
): Promise<unknown> {
  const started = effects.clock();
  const taken = await effects.withLock(SNAPSHOT_LOCK_WAIT, async () => ({
    queue: clone(await effects.loadQueue()) as JsonObject,
    config: cloneSettings(await effects.settings()),
  }));
  if (taken === null)
    return { inventory: 'skipped', reason: 'queue lock busy before snapshot; next run retries' };
  const original = taken.queue;
  const prepared = await effects.prepare(clone(original) as JsonObject, !options.reportOnly);
  const wait = Math.min(MERGE_LOCK_WAIT, RUN_BUDGET_S - (effects.clock() - started));
  if (wait < MIN_MERGE_WAIT_S)
    return {
      inventory: 'skipped',
      reason: 'run budget spent before merge; nothing saved, next run retries',
    };
  const merged = await effects.withLock(wait, async () => {
    let current = await effects.loadQueue();
    if (
      !pythonValueEqual(inventoryGuard(current), inventoryGuard(original)) ||
      !pythonValueEqual(await effects.settings(), taken.config)
    )
      throw new BackfillTransactionError('inventory snapshot stale; retry inventory');
    current = mergeInventory(original, current, prepared.queue);
    for (const ident of prepared.eventItems) {
      const item = items(current).find((entry) => pythonValueEqual(id(entry), ident));
      if (item === undefined) throw new BackfillTransactionError('inventory event item missing');
      current = await effects.stateEvent(current, item);
    }
    await effects.writeRanked(prepared.ranked);
    await effects.writeReport(prepared.report);
    current = effects.clearHalt(current);
    await effects.saveQueue(current);
    return { report: prepared.report };
  });
  if (merged === null)
    return {
      inventory: 'skipped',
      reason: 'queue lock busy at merge; nothing saved, next run retries',
    };
  return merged.report;
}
