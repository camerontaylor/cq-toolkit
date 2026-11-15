/** Bounded backfill harvest of a counted (completed) vendor run. Caller holds
 * tick.lock and supplies independently verified terminal liveness. Content
 * store, git and the publication outbox/inbox are injected seams.
 */
import { completionEvent, type BackfillRepo } from '../../../policy/crq/backfillCompletion.js';
import { terminalBackfill } from '../../../policy/crq/backfillTerminal.js';
import { JsonNumber, JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';
import {
  ledgerCanonicalBytes,
  ledgerDigestOf,
  ledgerLoads,
  ledgerTimestamp,
  LedgerIntegrityError,
  LedgerTypeError,
} from '../../../policy/crq/ledger.js';
import { withObjectKeys } from '../../../policy/crq/queueDoc.js';
import { finishHarvest } from './backfillHarvest.js';

export interface BackfillCountedArtifacts {
  readonly meta: Uint8Array;
  readonly exit: Uint8Array;
  readonly review: Uint8Array;
  /** `submission.json` bytes when the run has one, else null. */
  readonly submission: Uint8Array | null;
}
export interface BackfillCountedHarvestEffects {
  readArtifacts(runId: string): Promise<BackfillCountedArtifacts>;
  /** `store.put`: immutable content reference. */
  put(bytes: Uint8Array): JsonValue;
  repo: BackfillRepo;
  /** `ledger.atomic(rdir/review-event.json, canonical(event))`. */
  writeReviewEvent(runId: string, bytes: Uint8Array): Promise<void>;
  /** `outbox.spool(event)`. */
  spool(event: JsonObject): Promise<void>;
  /** `finding_delivery.Inbox.ingest(event)`. */
  ingest(event: JsonObject): Promise<void>;
  stateEvent(queue: JsonObject, item: JsonObject, at: string, reason: string): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
  cleanup(meta: JsonObject): Promise<void>;
}

/** Python's `except (ValueError, KeyError)`: everything but TypeError. */
const PYTHON_VALUE_ERRORS = new Set([
  'IntegrityError',
  'KeyError',
  'ValueError',
  'JSONDecodeError',
  'UnicodeDecodeError',
]);
const caughtByPython = (error: unknown): boolean => {
  const named = (error as { pythonError?: unknown } | null)?.pythonError;
  return typeof named === 'string' && PYTHON_VALUE_ERRORS.has(named);
};
function obj(value: JsonValue | undefined, label: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new LedgerTypeError(`${label} must be an object`);
  return value;
}
function text(value: JsonValue | undefined, label: string): string {
  if (typeof value !== 'string' || !value)
    throw new LedgerTypeError(`${label} must be a nonempty string`);
  return value;
}

/** Complete one counted run: build and publish the review event, or quarantine
 * as unsupported when its scope cannot be verified. Both retain evidence. After
 * any effect failure the caller reloads the durable queue and retries; spool and
 * ingest are idempotent on the event id.
 */
export async function harvestBackfillCounted(
  initial: JsonObject,
  index: number,
  proof: { readonly runId: string; readonly exitCode: number; readonly terminalVerified: true },
  effects: BackfillCountedHarvestEffects,
  classification: JsonObject,
): Promise<{ queue: JsonObject; status: 'completed' | 'unsupported' }> {
  if (classification.get('counted') !== true)
    throw new LedgerIntegrityError('counted harvest needs a counted classification');
  const outcome = text(classification.get('outcome'), 'outcome');
  const items = initial.get('items');
  if (!Array.isArray(items)) throw new LedgerTypeError('items must be an array');
  const item = obj(items[index], 'item');
  const run = obj(item.get('run'), 'run');
  const attempt = text(item.get('attempt_id'), 'attempt_id');
  const hold = obj(obj(initial.get('backfill_reservations'), 'reservations').get(attempt), 'hold');
  if (
    item.get('kind') !== 'backfill' ||
    item.get('state') !== 'reviewing' ||
    item.get('vendor_state') !== 'live' ||
    proof.terminalVerified !== true ||
    !proof.runId ||
    run.get('run_id') !== proof.runId ||
    hold.get('item') !== item.get('id') ||
    hold.get('vendor_run_id') !== proof.runId
  )
    throw new LedgerIntegrityError('backfill terminal ownership not verified');
  const artifacts = await effects.readArtifacts(proof.runId);
  const meta = obj(ledgerLoads(artifacts.meta), 'run metadata');
  const exit = obj(ledgerLoads(artifacts.exit), 'exit');
  if (
    meta.get('run_id') !== proof.runId ||
    meta.get('item_id') !== item.get('id') ||
    obj(meta.get('backfill'), 'backfill metadata').get('attempt_id') !== attempt ||
    !(exit.get('exit') instanceof JsonNumber) ||
    (exit.get('exit') as JsonNumber).kind !== 'int' ||
    (exit.get('exit') as JsonNumber).integer !== BigInt(proof.exitCode)
  )
    throw new LedgerIntegrityError('backfill terminal artifact identity mismatch');
  const endedAt = text(exit.get('ended_at'), 'ended_at');
  ledgerTimestamp(endedAt);
  effects.put(artifacts.review);
  const exitRef = effects.put(artifacts.exit);
  let event: JsonObject;
  try {
    const submission =
      artifacts.submission === null ? null : obj(ledgerLoads(artifacts.submission), 'submission');
    event = completionEvent(
      effects.repo,
      { put: (bytes) => effects.put(bytes) },
      item,
      artifacts.review,
      exit.get('exit') as JsonValue,
      meta,
      endedAt,
      submission,
    );
  } catch (error) {
    if (!caughtByPython(error)) throw error;
    const result = terminalBackfill(
      initial,
      index,
      endedAt,
      'unsupported',
      true,
      0,
      'unverified scope: ' + (error as Error).message,
    );
    const queue = await effects.stateEvent(
      result.queue,
      result.item,
      endedAt,
      'terminal scope unverified',
    );
    await effects.saveQueue(queue);
    await effects.cleanup(meta);
    return { queue, status: 'unsupported' };
  }
  const payload = obj(event.get('payload'), 'payload');
  const artifactRefs = payload.get('artifacts');
  if (!Array.isArray(artifactRefs)) throw new LedgerTypeError('artifacts must be an array');
  const withExit = withObjectKeys(event, [
    ['payload', withObjectKeys(payload, [['artifacts', [...artifactRefs, exitRef]]])],
  ]);
  const value = withObjectKeys(withExit, [
    ['id', ledgerDigestOf(new JsonObject(withExit.entries.filter(([key]) => key !== 'id')))],
  ]);
  await effects.writeReviewEvent(proof.runId, ledgerCanonicalBytes(value));
  await effects.spool(value);
  const stamped = withObjectKeys(item, [['publication_event_id', value.get('id') as string]]);
  const result = terminalBackfill(
    withObjectKeys(initial, [['items', items.map((v, i) => (i === index ? stamped : v))]]),
    index,
    endedAt,
    'completed',
    true,
  );
  await effects.ingest(value);
  const queue = await finishHarvest(
    result,
    index,
    attempt,
    proof.runId,
    run,
    endedAt,
    outcome,
    effects,
  );
  await effects.saveQueue(queue);
  await effects.cleanup(meta);
  return { queue, status: 'completed' };
}
