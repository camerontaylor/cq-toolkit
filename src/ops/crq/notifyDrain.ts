/**
 * The publisher's notification drain (`backfill_publisher.main`'s
 * `review_notify.drain(c)`): bounded at-least-once completion delivery that
 * runs before publication and never holds `tick.lock` across a send.
 *
 * Python parity, kept exactly:
 *
 * - The whole drain runs under the persistent `review-notify.lock` inode, so a
 *   publisher run and a manual drain serialise independently of `tick.lock`.
 * - Selection and each queue write run under the caller's `tick.lock` with
 *   `lock_wait=1`; a busy lock skips that step (and a busy selection returns 0
 *   rows) rather than blocking or failing the unit.
 * - Each selected row is re-checked byte-for-byte against a fresh queue read
 *   before the send, and again inside the reconcile lock, so a withdrawn or
 *   replaced row is never delivered and a concurrent update is never reverted.
 * - A send failure is a row attempt, never a unit failure: undelivered rows
 *   stay `pending` with exponential backoff until `MAX_ATTEMPTS`.
 *
 * The transport is injected; the production binding is `paseo send --no-wait`
 * by argv only (`src/adapters/crq/notifySource.ts`).
 */
import { join } from 'node:path';
import { withLock } from '../../adapters/crq/lock.js';
import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { ledgerValueEqual } from '../../policy/crq/ledger.js';
import {
  notifyBackoffMinutes,
  notifyDestination,
  notifyMessage,
  reconcileNotifyAttempt,
  selectNotifyRows,
  type NotifyRow,
} from '../../policy/crq/notifyDrain.js';
import { parseQueueBytes } from './publishRun.js';

/** The drain's injected effects. Every path is explicit. */
export interface NotifyDrainEffects {
  /** Absolute state root (`state/`), holding `queue.json` and the lock. */
  readonly stateRoot: string;
  /** The runner's parsed `config.json` (`notify.hosts`, `error_backoff_min`). */
  readonly config: JsonValue;
  /** Clock reading in UTC microseconds (Python's `datetime.now(timezone.utc)`). */
  nowMicros(): bigint;
  /** Read `queue.json` bytes (Python `load_queue`'s read). */
  readQueue(): Promise<Uint8Array>;
  /** Atomically persist the queue document (Python `save_queue`). */
  writeQueue(queue: JsonObject): Promise<void>;
  /**
   * Python's `with_lock(fn, lock_wait=...)` around `tick.lock`: the callback's
   * return value when it ran, null when the lock stayed busy.
   */
  withTickLock<T>(fn: () => Promise<T>, options: { readonly lockWait: number }): Promise<T | null>;
  /** The argv-only delivery transport; `paseo_send` 0 means delivered. */
  notify(destination: JsonObject, text: string): Promise<{ readonly paseo_send?: number | string }>;
}

/** The `review-notify.lock` inode Python holds for a whole drain. */
export function notifyLockPath(stateRoot: string): string {
  return join(stateRoot, 'review-notify.lock');
}

async function readQueueDocument(effects: NotifyDrainEffects): Promise<JsonObject> {
  const value = parseQueueBytes(await effects.readQueue());
  if (!(value instanceof JsonObject)) throw new TypeError('queue must be an object');
  return value;
}

function outboxRow(queue: JsonObject, key: string): JsonValue | undefined {
  const outbox = queue.get('review_notify_outbox');
  return outbox instanceof JsonObject ? outbox.get(key) : undefined;
}

/**
 * `review_notify.drain`: deliver up to `LIMIT` due rows, returning how many
 * were selected (0 when the queue lock stayed busy or nothing was due).
 */
export async function drainNotifications(effects: NotifyDrainEffects): Promise<number> {
  const now = effects.nowMicros();
  const errorBackoffMin = notifyBackoffMinutes(effects.config);
  return withLock(notifyLockPath(effects.stateRoot), { wait: true }, async () => {
    const selected: NotifyRow[] = [];
    const selection = await effects.withTickLock(
      async () => {
        const queue = await readQueueDocument(effects);
        selected.push(
          ...selectNotifyRows(queue.get('review_notify_outbox'), queue.get('review_events'), now),
        );
        return true;
      },
      { lockWait: 1 },
    );
    if (selection !== true) return 0;
    for (const entry of selected) {
      // The row must still be the queue's current value before any send.
      const stillCurrent = await effects.withTickLock(
        async () => {
          const value = outboxRow(await readQueueDocument(effects), entry.key);
          return value instanceof JsonObject && ledgerValueEqual(value, entry.row);
        },
        { lockWait: 1 },
      );
      if (stillCurrent !== true) continue;
      const accepted = notifyDestination(entry.row.get('destination'), effects.config);
      let success = false;
      try {
        const sent =
          accepted === undefined
            ? undefined
            : await effects.notify(accepted, notifyMessage(entry.row, entry.event));
        success = sent !== undefined && sent.paseo_send === 0;
      } catch {
        // A runtime failure is one recorded attempt, never a thrown drain.
        success = false;
      }
      // The reconcile result is deliberately unobserved: a busy lock leaves the
      // row pending, and the next run retries the same message.
      await effects.withTickLock(
        async () => {
          const queue = await readQueueDocument(effects);
          const updated = reconcileNotifyAttempt(queue, entry.key, entry.row, {
            success,
            unsupported: accepted === undefined,
            nowMicros: now,
            errorBackoffMin,
          });
          if (updated !== queue) await effects.writeQueue(updated);
          return true;
        },
        { lockWait: 1 },
      );
    }
    return selected.length;
  });
}
