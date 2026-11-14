import { JsonNumber, JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { withObjectKeys, withoutObjectKey } from '../../policy/crq/queueDoc.js';

/** The reconcile caller supplies the actual prepare operation and one Python-compatible clock. */
export interface CompletedReconcileEffects {
  nowIso(): string;
  prepareCompleted(queue: JsonObject, item: JsonObject): Promise<JsonObject>;
}

/** Retry receipt-only reuse even when new invocations are paused or cooled down. */
export async function reconcileCompletedLocalReviews(
  queue: JsonObject,
  errorBackoffMinutes: number,
  effects: CompletedReconcileEffects,
): Promise<JsonObject> {
  let result = queue;
  const original = queue.get('items');
  if (!Array.isArray(original)) throw new Error('missing queue items');
  for (let index = 0; index < original.length; index++) {
    const currentItems = result.get('items');
    if (!Array.isArray(currentItems)) throw new Error('missing queue items');
    const item = currentItems[index];
    if (
      !(item instanceof JsonObject) ||
      item.get('kind') !== 'local-review' ||
      item.get('state') !== 'pending'
    )
      continue;
    const now = effects.nowIso();
    const at = Date.parse(now);
    if (!Number.isFinite(at)) throw new Error('invalid current time');
    try {
      const notBefore = item.get('not_before');
      if (typeof notBefore === 'string' && notBefore.length > 0) {
        const until = Date.parse(notBefore);
        if (!Number.isFinite(until)) throw new Error('invalid not_before');
        if (until > at) continue;
      }
      result = await effects.prepareCompleted(result, item);
      const nextItems = result.get('items');
      if (!Array.isArray(nextItems)) throw new Error('item missing after prepare');
      const nextItem = nextItems[index];
      if (!(nextItem instanceof JsonObject)) throw new Error('item missing after prepare');
      let updated = withoutObjectKey(
        withoutObjectKey(nextItem, 'reconcile_failures'),
        'not_before',
      );
      const reason = updated.get('wait_reason');
      if (typeof reason === 'string' && reason.startsWith('completed-evidence-unavailable:'))
        updated = withObjectKeys(updated, [['wait_reason', null]]);
      const changed = [...nextItems];
      changed[index] = updated;
      result = withObjectKeys(result, [['items', changed]]);
    } catch (error) {
      const previous = item.get('reconcile_failures');
      const oldCount =
        previous instanceof JsonNumber && previous.kind === 'int' && previous.integer !== null
          ? previous.integer
          : 0n;
      const count = oldCount + 1n;
      const exponent = Number(count > 9n ? 8n : count - 1n);
      const minutes = Math.min(240, errorBackoffMinutes * 2 ** Math.max(0, exponent));
      const failure =
        error instanceof Error ? `${error.name}: ${error.message}` : `Error: ${String(error)}`;
      const updated = withObjectKeys(item, [
        ['reconcile_failures', JsonNumber.int(count)],
        ['not_before', new Date(at + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, 'Z')],
        ['wait_reason', `completed-evidence-unavailable: ${failure}`.slice(0, 300)],
      ]);
      const changed: JsonValue[] = [...currentItems];
      changed[index] = updated;
      result = withObjectKeys(result, [['items', changed]]);
    }
  }
  return result;
}
