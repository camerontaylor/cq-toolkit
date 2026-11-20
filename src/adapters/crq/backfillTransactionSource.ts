import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { atomicWrite } from './atomic.js';
import { withLock } from './lock.js';
import { queueBytes } from './queueEffects.js';
import { loadInventoryQueue } from './backfillQueueLoad.js';
import { readBackfillRollout } from './backfillRollout.js';
import { backfillStateEventWriter } from './backfillStateEvent.js';
import { SlotBusyError } from '../lock/slotLock.js';
import type {
  InventoryTransactionEffects,
  PreparedInventory,
} from '../../ops/crq/internal/backfillTransaction.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { ledgerCanonicalBytes, ledgerSubscript } from '../../policy/crq/ledger.js';

/** Live transaction effects. Preparation remains caller-owned and runs outside tick.lock. */
export function createBackfillTransactionEffects(options: {
  readonly stateRoot: string;
  readonly prepare: (queue: JsonObject, enqueue: boolean) => Promise<PreparedInventory>;
}): InventoryTransactionEffects {
  const root = options.stateRoot;
  const backfill = join(root, 'backfill');
  const stateEvent = backfillStateEventWriter(root);
  return {
    clock: () => performance.now() / 1000,
    async withLock(waitSeconds, action) {
      const deadline = performance.now() + waitSeconds * 1000;
      for (;;) {
        let entered = false;
        try {
          return await withLock(join(root, 'tick.lock'), { wait: false }, async () => {
            entered = true;
            return action();
          });
        } catch (error) {
          if (entered || !(error instanceof SlotBusyError)) throw error;
          const remaining = deadline - performance.now();
          if (remaining <= 0) return null;
          await new Promise<void>((resolve) => setTimeout(resolve, Math.min(25, remaining)));
        }
      }
    },
    loadQueue: () => loadInventoryQueue(join(root, 'queue.json')),
    settings: () => readBackfillRollout(root),
    prepare: options.prepare,
    // Async so an unreadable `created_at` rejects (Python evaluates it before the publication check).
    stateEvent: async (queue, item) =>
      stateEvent(queue, item, ledgerSubscript(item, 'created_at'), 'inventory enqueue'),
    async writeRanked(value) {
      await mkdir(backfill, { recursive: true });
      await atomicWrite(
        join(backfill, 'latest-ranked.json'),
        ledgerCanonicalBytes(value as JsonValue),
      );
    },
    async writeReport(value) {
      await mkdir(backfill, { recursive: true });
      await atomicWrite(
        join(backfill, 'latest-report.json'),
        ledgerCanonicalBytes(value as JsonValue),
      );
    },
    clearHalt(queue) {
      return queue.get('backfill_halt_operation') === 'inventory'
        ? new JsonObject(
            queue.entries.filter(
              ([key]) => key !== 'backfill_halted' && key !== 'backfill_halt_operation',
            ),
          )
        : queue;
    },
    saveQueue: (queue) => atomicWrite(join(root, 'queue.json'), queueBytes(queue)),
  };
}
