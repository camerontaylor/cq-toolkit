import { JsonObject, type JsonValue } from '../../policy/crq/jsonValue.js';
import { withObjectKeys } from '../../policy/crq/queueDoc.js';
import { ledgerDigestOf, ledgerEvent } from '../../policy/crq/ledger.js';
import { receiptJsonBytes } from '../../policy/crq/pythonJson.js';

/** The caller holds tick.lock. All storage and publication request effects are real bindings. */
export interface LocalReviewPublishEffects {
  enabled(): Promise<boolean>;
  readReceipt(id: string): Promise<JsonObject>;
  putArtifact(bytes: Uint8Array): Promise<JsonObject>;
  spool(event: JsonObject): Promise<void>;
  hasAck(eventId: string): Promise<boolean>;
  requestPublish(queue: JsonObject): Promise<JsonObject>;
  saveQueue(queue: JsonObject): Promise<void>;
}
function text(value: JsonValue | undefined): string {
  if (typeof value !== 'string') throw new Error('expected string');
  return value;
}
function obj(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected object');
  return value;
}
function update(queue: JsonObject, index: number, item: JsonObject): JsonObject {
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new Error('missing queue items');
  const changed = [...items];
  changed[index] = item;
  return withObjectKeys(queue, [['items', changed]]);
}

/** Spool the Python author-queue unverified full-diff event, then request background publication. */
export async function republishLocalReview(
  queue: JsonObject,
  index: number,
  runnerRepo: string,
  effects: LocalReviewPublishEffects,
): Promise<JsonObject> {
  const items = queue.get('items');
  if (!Array.isArray(items) || !(items[index] instanceof JsonObject))
    throw new Error('missing local review item');
  let item = obj(items[index]);
  const facts = obj(item.get('identity_inputs'));
  const repo = text(facts.get('repo'));
  if (repo.toLowerCase() !== runnerRepo.toLowerCase()) {
    item = withObjectKeys(item, [
      ['publication_pending', false],
      ['publication_reason', 'multi-repo publication unsupported'],
    ]);
    const next = update(queue, index, item);
    await effects.saveQueue(next);
    return next;
  }
  let result = queue;
  try {
    if (!(await effects.enabled())) {
      item = withObjectKeys(item, [['publication_reason', 'publication-disabled']]);
      result = update(queue, index, item);
      await effects.saveQueue(result);
      return result;
    }
    const document = await effects.readReceipt(text(item.get('receipt_id')));
    const stored = await effects.putArtifact(receiptJsonBytes(document));
    const reference = withObjectKeys(stored, [['kind', 'local-review-full-diff']]);
    const run = text(item.get('local_run_id'));
    const head = text(facts.get('head_commit'));
    const tree = text(facts.get('head_tree'));
    const observed = obj(document.get('observed'));
    const payload = new JsonObject([
      ['repo', runnerRepo],
      ['subject_id', item.get('identity') ?? null],
      ['job_id', run],
      ['attempt_id', run],
      [
        'source',
        new JsonObject([
          ['repo', runnerRepo],
          ['producer', 'author-queue'],
          ['type', 'author-queue'],
          ['id', run],
          ['authenticated', true],
        ]),
      ],
      ['base', facts.get('base_commit') ?? null],
      ['head', head],
      ['head_tree', tree],
      ['target', head],
      ['target_tree', tree],
      ['policy_digest', facts.get('config_digest') ?? null],
      ['scope_digest', ledgerDigestOf([])],
      ['paths', []],
      ['requested_scope', []],
      ['input_scope', []],
      ['reviewed_scope', []],
      [
        'completion',
        new JsonObject([
          ['terminal', true],
          ['skipped', false],
          ['scope_verified', false],
          ['exit_code', observed.get('exit_code') ?? null],
          ['errors', ['per-line scope unverified: full-diff adapter supplies no line-scope proof']],
        ]),
      ],
      ['outcome', 'unverified'],
      ['artifacts', [reference]],
      ['findings', []],
    ]);
    const event = ledgerEvent(
      'review',
      `${runnerRepo}:author-queue:${run}`,
      text(item.get('completed_at')),
      payload,
    );
    const id = text(event.get('id'));
    await effects.spool(event);
    const pending = !(await effects.hasAck(id));
    item = withObjectKeys(item, [
      ['publication_pending', pending],
      ['publication_event_id', id],
      ['publication_reason', pending ? 'publication-spooled' : null],
    ]);
    result = update(result, index, item);
    if (pending) result = await effects.requestPublish(result);
  } catch (error) {
    item = withObjectKeys(item, [
      ['publication_pending', true],
      [
        'publication_reason',
        [...(error instanceof Error ? error.message : String(error))].slice(0, 300).join(''),
      ],
    ]);
    result = update(result, index, item);
  }
  await effects.saveQueue(result);
  return result;
}
