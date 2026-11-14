/** Post-launch backfill bookkeeping only. Caller owns tick.lock and launch.
 * The durable admission and launch identity must already exist on entry.
 * No pre-vendor cancellation or terminal transition is exposed here.
 */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import { LedgerIntegrityError, LedgerTypeError } from '../../../policy/crq/ledger.js';
import { bindRun } from '../../../policy/crq/backfillJobs.js';
import { withObjectKeys } from '../../../policy/crq/queueDoc.js';

export interface BackfillBindingEffects {
  now(): string;
  /** Spool state event durably and return any queue replacement. */
  stateEvent(queue: JsonObject, item: JsonObject, at: string, reason: string): Promise<JsonObject>;
  /** Reload durable state under tick.lock before recovering a failed launch. */
  loadQueue(): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
}
function itemAt(queue: JsonObject, index: number): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items) || !(items[index] instanceof JsonObject))
    throw new LedgerTypeError('missing backfill item');
  return items[index];
}

/** Bind an already recorded run, then spool its state event and save.
 * On event failure, save the bound queue before propagating the failure, as
 * select's exception handler does after setting run_bound. A save failure is
 * also retried once by that handler. No reservation is released on failure.
 */
export async function bindBackfillLaunch(
  queue: JsonObject,
  index: number,
  runId: string,
  effects: BackfillBindingEffects,
): Promise<JsonObject> {
  let bound = queue;
  let runBound = false;
  try {
    const item = itemAt(queue, index);
    const run: JsonValue | undefined = item.get('run');
    if (
      item.get('state') !== 'reviewing' ||
      !(run instanceof JsonObject) ||
      !runId ||
      run.get('run_id') !== runId
    )
      throw new LedgerIntegrityError('binding requires the recorded reviewing run identity');
    bound = bindRun(queue, index, runId).queue;
    runBound = true;
    bound = await effects.stateEvent(
      bound,
      itemAt(bound, index),
      effects.now(),
      'vendor identity bound',
    );
    await effects.saveQueue(bound);
  } catch (error) {
    if (runBound) await effects.saveQueue(bound);
    else {
      const original = itemAt(queue, index);
      const id = original.get('id');
      const attempt = original.get('attempt_id');
      if (typeof id !== 'string' || typeof attempt !== 'string') throw error;
      try {
        await saveUnknownBackfillLaunch(id, attempt, effects);
      } catch (recoveryError) {
        if (error instanceof Error && Object.isExtensible(error)) {
          Object.defineProperty(error, 'recoveryError', { value: recoveryError });
        } else {
          throw new AggregateError([error, recoveryError], 'binding and recovery failed', {
            cause: error,
          });
        }
      }
    }
    throw error;
  }
  return bound;
}

/** Reload under tick.lock after an exceptional launch, then preserve ownership.
 * Never save the caller's stale pre-spawn queue over a durable run identity.
 */
export async function saveUnknownBackfillLaunch(
  id: string,
  attemptId: string,
  effects: Pick<BackfillBindingEffects, 'loadQueue' | 'saveQueue'>,
): Promise<JsonObject> {
  const queue = await effects.loadQueue();
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  const matches = items
    .map((value, i) => ({ value, i }))
    .filter(({ value }) => value instanceof JsonObject && value.get('id') === id);
  if (matches.length !== 1) throw new LedgerIntegrityError('cannot identify launch owner');
  const index = matches[0]!.i;
  const item = itemAt(queue, index);
  if (item.get('attempt_id') !== attemptId)
    throw new LedgerIntegrityError('launch attempt changed');
  if (item.get('vendor_state') === 'live' || item.get('vendor_state') === 'terminal')
    throw new LedgerIntegrityError('launch ownership already resolved');
  const unknown = withObjectKeys(item, [
    ['state', 'launch-unknown'],
    ['vendor_state', 'unknown'],
  ]);
  const result = withObjectKeys(queue, [
    ['items', items.map((value, i) => (i === index ? unknown : value))],
  ]);
  await effects.saveQueue(result);
  return result;
}
