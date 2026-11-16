/** Durable pre-vendor refusal and replay, caller holds tick.lock throughout.
 * Never call this for a child exit or missing PID: neither proves no spawn.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { LedgerIntegrityError, LedgerTypeError } from '../../../policy/crq/ledger.js';
import { cancelBeforeVendor } from '../../../policy/crq/backfillJobs.js';
import { terminalBackfill } from '../../../policy/crq/backfillTerminal.js';
import {
  pyTruthy,
  pythonValueEqual,
  withObjectKeys,
  withoutObjectKey,
} from '../../../policy/crq/queueDoc.js';

export interface BackfillRefusalEffects {
  now(): string;
  /** Durable idempotent state-event spool, returning its replacement queue. */
  stateEvent(queue: JsonObject, item: JsonObject, at: string, reason: string): Promise<JsonObject>;
  /** Reload the durable queue while the caller holds tick.lock. */
  loadQueue(): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
}
const REASON = 'launch refused before vendor binding';
function itemAt(queue: JsonObject, index: number): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items) || !(items[index] instanceof JsonObject))
    throw new LedgerTypeError('missing backfill item');
  return items[index];
}
function putItem(queue: JsonObject, index: number, item: JsonObject): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  return withObjectKeys(queue, [['items', items.map((value, i) => (i === index ? item : value))]]);
}
function pending(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerTypeError('invalid refusal event marker');
  return value;
}
/** Replay a durable marker without reapplying failure accounting.
 * stateEvent must be idempotent across crash-after-spool/before-save.
 */
export async function replayBackfillRefusal(
  queue: JsonObject,
  index: number,
  effects: BackfillRefusalEffects,
): Promise<JsonObject> {
  const initialItem = itemAt(queue, index);
  const marker = initialItem.get('refusal_state_event');
  queue = await effects.loadQueue();
  const item = itemAt(queue, index);
  if (
    item.get('id') !== initialItem.get('id') ||
    item.get('attempt_id') !== initialItem.get('attempt_id') ||
    !pythonValueEqual(item.get('refusal_state_event') ?? null, marker ?? null)
  )
    throw new LedgerIntegrityError('refusal replay owner or marker changed');
  if (!pyTruthy(marker)) return queue;
  const event = pending(marker);
  const at = event.get('at');
  const reason = event.get('reason');
  if (typeof at !== 'string' || typeof reason !== 'string')
    throw new LedgerTypeError('invalid refusal event marker');
  let next = await effects.stateEvent(queue, item, at, reason);
  const updated = itemAt(next, index);
  if (
    updated.get('id') !== item.get('id') ||
    updated.get('attempt_id') !== item.get('attempt_id') ||
    !pythonValueEqual(updated.get('refusal_state_event') ?? null, marker ?? null)
  )
    throw new LedgerIntegrityError('refusal event owner changed');
  next = putItem(next, index, withoutObjectKey(updated, 'refusal_state_event'));
  await effects.saveQueue(next);
  return next;
}

/** Cancel only with caller's positive pre-spawn evidence. Child exit.json,
 * absent/ambiguous PID or a recorded run are not positive evidence.
 * Any thrown IO requires the caller to reload the durable queue before retry.
 */
export async function recordPreVendorRefusal(
  queue: JsonObject,
  index: number,
  evidence: {
    readonly kind: 'verified-pre-spawn-refusal';
    readonly itemId: string;
    readonly attemptId: string;
  },
  effects: BackfillRefusalEffects,
): Promise<JsonObject> {
  const original = itemAt(queue, index);
  if (original.get('id') !== evidence.itemId || original.get('attempt_id') !== evidence.attemptId)
    throw new LedgerIntegrityError('pre-vendor refusal owner changed');
  queue = await effects.loadQueue();
  const item = itemAt(queue, index);
  if (
    evidence.kind !== 'verified-pre-spawn-refusal' ||
    item.get('id') !== evidence.itemId ||
    item.get('attempt_id') !== evidence.attemptId ||
    (item.get('run') !== undefined && item.get('run') !== null) ||
    item.get('kind') !== 'backfill' ||
    item.get('vendor_state') !== 'unknown' ||
    pyTruthy(item.get('refusal_state_event'))
  )
    throw new LedgerIntegrityError('pre-vendor refusal requires exact unbound pre-spawn evidence');
  const holds = queue.get('backfill_reservations');
  const hold = holds instanceof JsonObject ? holds.get(evidence.attemptId) : undefined;
  if (
    !(hold instanceof JsonObject) ||
    hold.get('item') !== evidence.itemId ||
    hold.get('quota_state') !== 'reserved' ||
    pyTruthy(hold.get('vendor_run_id'))
  )
    throw new LedgerIntegrityError('pre-vendor refusal requires the matching unbound reservation');
  const cancelled = cancelBeforeVendor(queue, index);
  const reason = item.get('last_error');
  const at = effects.now();
  const terminal = terminalBackfill(
    cancelled.queue,
    index,
    at,
    'secret-scan',
    true,
    0,
    typeof reason === 'string' ? reason : 'launch refused',
  );
  const marker = new JsonObject([
    ['at', at],
    ['reason', REASON],
  ]);
  const marked = putItem(
    terminal.queue,
    index,
    withObjectKeys(terminal.item, [['refusal_state_event', marker]]),
  );
  await effects.saveQueue(marked);
  return replayBackfillRefusal(marked, index, effects);
}
