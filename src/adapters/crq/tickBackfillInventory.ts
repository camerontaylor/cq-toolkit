/**
 * Inventory inside the tick (S6-d). Inactive: nothing imports this from a
 * runtime entry point. It binds `TickPhases.backfillInventoryMode` and
 * `TickPhases.backfillInventory` to Python's `run_inventory(c, q)` as `crq.tick`
 * calls it:
 *
 *   rollout = backfill_runtime.settings(STATE)
 *   if rollout and rollout.get("inventory_mode") == "integrated" and not only:
 *       backfill_runtime.run_inventory(sys.modules[__name__], q)
 *
 * The caller already holds tick.lock, so this never takes it (unlike the
 * operator route's `inventoryTransaction`, which snapshots, prepares off lock and
 * merges under two short holds). The tick's queue is the live queue, so the
 * preparation result is final: retire and enqueue events spool in Python's order,
 * the ranked and report artifacts are written, an `inventory` halt is cleared
 * and the queue is saved. A rollout that disappears mid-run aborts before
 * publication, so the save never outruns the spooled events.
 */
import type { PreparedInventory } from '../../ops/crq/internal/backfillTransaction.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { LedgerIntegrityError, ledgerSubscript } from '../../policy/crq/ledger.js';
import { pythonValueEqual } from '../../policy/crq/queueDoc.js';
import type { InventoryPreparationOptions } from './backfillPreparation.js';
import { backfillInventoryMode, readBackfillRollout } from './backfillRollout.js';
import { prepareBackfillInventory } from './backfillSource.js';
import { backfillStateEventWriter } from './backfillStateEvent.js';
import { createBackfillTransactionEffects } from './backfillTransactionSource.js';

/** `backfill_runtime.INVENTORY_ENQUEUE_LIMIT`. */
export const INVENTORY_ENQUEUE_LIMIT = 32;

export interface TickBackfillInventoryOptions {
  readonly stateRoot: string;
  /** `CONFIG["clone"]`: the repository the inventory fetches and captures. */
  readonly cloneRoot: string;
  /** Test seam; defaults to the file-backed preparation over `cloneRoot`. */
  readonly prepare?: (
    queue: JsonObject,
    enqueue: boolean,
    options: InventoryPreparationOptions,
  ) => Promise<PreparedInventory>;
}

export interface TickBackfillInventory {
  inventoryMode(): Promise<string | null>;
  inventory(queue: JsonObject): Promise<JsonObject>;
}

function itemById(queue: JsonObject, id: JsonValue): JsonObject {
  const rows = queue.get('items');
  const found = Array.isArray(rows)
    ? rows.find((row) => row instanceof JsonObject && pythonValueEqual(row.get('id') ?? null, id))
    : undefined;
  if (!(found instanceof JsonObject))
    throw new LedgerIntegrityError('inventory event item missing');
  return found;
}

export function tickBackfillInventory(
  options: TickBackfillInventoryOptions,
): TickBackfillInventory {
  const { stateRoot } = options;
  const prepare =
    options.prepare ??
    ((queue, enqueue, prepareOptions) =>
      prepareBackfillInventory(
        { stateRoot, cloneRoot: options.cloneRoot },
        queue,
        enqueue,
        prepareOptions,
      ));
  const writer = backfillStateEventWriter(stateRoot);
  // Reuses the operator transaction's artifact, halt and queue writers verbatim.
  const files = createBackfillTransactionEffects({
    stateRoot,
    async prepare() {
      throw new Error('unexpected operator inventory preparation inside the tick');
    },
  });
  return {
    inventoryMode: () => backfillInventoryMode(stateRoot),
    async inventory(queue) {
      const config = await readBackfillRollout(stateRoot);
      if (config === null)
        throw new LedgerIntegrityError(
          'operator rollout configuration required for inventory publication',
        );
      if (config.get('enabled') !== true)
        throw new LedgerIntegrityError('operator rollout must be enabled before inventory enqueue');
      const prepared = await prepare(queue, true, {
        retire: true,
        enqueueLimit: INVENTORY_ENQUEUE_LIMIT,
      });
      let current = prepared.queue;
      for (const { id, at } of prepared.retired ?? [])
        current = await writer(current, itemById(current, id), at, 'superseded by inventory');
      for (const id of prepared.eventItems) {
        const item = itemById(current, id);
        current = await writer(
          current,
          item,
          ledgerSubscript(item, 'created_at'),
          'inventory enqueue',
        );
      }
      // The event writer spools nothing when the rollout file is gone, so
      // re-read it before publishing: aborting here (the operator route's
      // stale-settings refusal under the merge lock) keeps retired and
      // enqueued jobs from being saved without their spooled events; a
      // present-but-disabled rollout still spooled, so the save stays
      // consistent and the writer's behavior is preserved.
      if ((await readBackfillRollout(stateRoot)) === null)
        throw new LedgerIntegrityError(
          'operator rollout removed during inventory; queue not saved',
        );
      await files.writeRanked(prepared.ranked);
      await files.writeReport(prepared.report);
      current = files.clearHalt(current);
      await files.saveQueue(current);
      return current;
    },
  };
}
