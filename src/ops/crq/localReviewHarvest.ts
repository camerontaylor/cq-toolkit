import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../policy/crq/jsonValue.js';
import { withObjectKeys, withoutObjectKey, pyTruthy } from '../../policy/crq/queueDoc.js';
import { receiptJsonDigest, sha256Hex } from '../../policy/crq/pythonJson.js';

/** Effects run under the caller's existing tick.lock. Receipt publication precedes queue persistence. */
export interface LocalHarvestEffects {
  readReview(runId: string): Promise<Uint8Array>;
  readReport(runId: string): Promise<Uint8Array | null>;
  validateReceipt(document: JsonObject): void;
  writeReceipt(document: JsonObject): Promise<string>;
  saveQueue(queue: JsonObject): Promise<void>;
  republish(queue: JsonObject, item: JsonObject): Promise<JsonObject>;
}

function object(value: JsonValue | undefined): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error('expected queue object');
  return value;
}
function required(value: JsonObject, key: string): JsonValue {
  const result = value.get(key);
  if (result === undefined) throw new Error(`missing ${key}`);
  return result;
}
function splitLines(text: string): string[] {
  const separators = [10, 11, 12, 13, 28, 29, 30, 133, 0x2028, 0x2029];
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (!separators.includes(text.charCodeAt(i))) continue;
    lines.push(text.slice(start, i));
    if (text.charCodeAt(i) === 13 && text.charCodeAt(i + 1) === 10) i++;
    start = i + 1;
  }
  lines.push(text.slice(start));
  return lines;
}

/** Complete an existing local-review run. Classification is supplied by the runner's classifier. */
export async function completeLocalReview(
  queue: JsonObject,
  item: JsonObject,
  runId: string,
  classification: JsonObject,
  endedAt: string,
  exitCode: number | null,
  effects: LocalHarvestEffects,
): Promise<{ queue: JsonObject; item: JsonObject; receiptId: string }> {
  const bytes = await effects.readReview(runId);
  const raw = Buffer.from(bytes).toString('utf8');
  const findings: JsonValue[] = [];
  for (const line of splitLines(raw)) {
    try {
      const event = parseJsonValue(line);
      if (event instanceof JsonObject && event.get('type') === 'finding') findings.push(event);
    } catch {
      // Python ignores malformed lines when extracting findings.
    }
  }
  const adequate =
    classification.get('counted') === true && classification.get('outcome') === 'completed';
  const report = await effects.readReport(runId);
  const document = new JsonObject([
    ['v', JsonNumber.int(1)],
    ['kind', 'local-review-full-diff'],
    ['identity', required(item, 'identity')],
    ['identity_inputs', required(item, 'identity_inputs')],
    ['profile', required(item, 'profile')],
    ['run_id', runId],
    ['outcome', adequate ? (findings.length ? 'findings' : 'clean') : 'no-verdict'],
    ['scope_adequate', adequate],
    ['findings', findings],
    [
      'report',
      report === null ? raw : Buffer.from(report).toString('utf8').replace(/\r\n?/g, '\n'),
    ],
    [
      'observed',
      new JsonObject([
        ['cli_version', null],
        ['model_version', null],
        ['reason', 'not-observed'],
        ['classification', classification],
        ['exit_code', exitCode === null ? null : JsonNumber.int(exitCode)],
        ['artifacts', new JsonObject([['review.ndjson', sha256Hex(bytes)]])],
      ]),
    ],
    ['independent_acceptance', false],
  ]);
  effects.validateReceipt(document);
  const receiptId = await effects.writeReceipt(document);
  if (receiptId !== receiptJsonDigest(document)) throw new Error('receipt identity mismatch');
  const id = required(item, 'id');
  const eventId = receiptJsonDigest(
    new JsonObject([
      ['item', id],
      ['run', runId],
      ['receipt', receiptId],
    ]),
  );
  const events =
    queue.get('review_events') === undefined
      ? new JsonObject([])
      : object(queue.get('review_events'));
  const event = new JsonObject([
    ['item', id],
    ['run_id', runId],
    ['receipt_id', receiptId],
    ['occurred_at', endedAt],
    ['state', adequate ? 'completed' : 'failed'],
  ]);
  let outbox =
    queue.get('review_notify_outbox') === undefined
      ? new JsonObject([])
      : object(queue.get('review_notify_outbox'));
  const requests =
    queue.get('review_requests') instanceof JsonObject
      ? object(queue.get('review_requests'))
      : new JsonObject([]);
  const observers = item.get('observers');
  for (const requestId of Array.isArray(observers) ? observers : []) {
    const request = typeof requestId === 'string' ? requests.get(requestId) : undefined;
    const destination = request instanceof JsonObject ? request.get('notify') : undefined;
    if (destination === undefined || !pyTruthy(destination)) continue;
    const key = receiptJsonDigest([requestId, eventId, destination]);
    if (!outbox.has(key))
      outbox = withObjectKeys(outbox, [
        [
          key,
          new JsonObject([
            ['v', JsonNumber.int(1)],
            ['request_id', requestId],
            ['event_id', eventId],
            ['destination', destination],
            ['state', 'pending'],
            ['receipt_id', receiptId],
          ]),
        ],
      ]);
  }
  const run = item.get('run') instanceof JsonObject ? object(item.get('run')) : new JsonObject([]);
  const existing = item.get('attempts');
  const attempts = Array.isArray(existing) ? existing : [];
  const nextAttempts = attempts.some((a) => a instanceof JsonObject && a.get('run_id') === runId)
    ? attempts
    : [
        ...attempts,
        new JsonObject([
          ['run_id', runId],
          ['outcome', required(classification, 'outcome')],
          ['counted', adequate],
          ['at', endedAt],
          ['receipt_id', receiptId],
          ['band', run.get('band') ?? 'background'],
          ['started_at', run.get('started_at') ?? null],
        ]),
      ];
  let updated = withObjectKeys(item, [
    ['state', adequate ? 'done' : 'failed'],
    ['scope_adequate', adequate],
    ['receipt_id', receiptId],
    ['run', null],
    ['publication_pending', true],
    ['local_run_id', runId],
    ['completed_at', endedAt],
    ['last_error', classification.get('message') ?? null],
    ['wait_reason', null],
    ['attempts', nextAttempts],
  ]);
  updated = withoutObjectKey(withoutObjectKey(updated, 'not_before'), 'reconcile_failures');
  const items = queue.get('items');
  if (!Array.isArray(items)) throw new Error('missing queue items');
  const index = items.indexOf(item);
  if (index < 0) throw new Error('item not in queue');
  const nextItems = [...items];
  nextItems[index] = updated;
  let result = withObjectKeys(queue, [
    ['review_events', withObjectKeys(events, [[eventId, event]])],
    ['items', nextItems],
  ]);
  if (outbox.entries.length > 0 || queue.has('review_notify_outbox'))
    result = withObjectKeys(result, [['review_notify_outbox', outbox]]);
  await effects.saveQueue(result);
  const published = await effects.republish(result, updated);
  const publishedItems = published.get('items');
  const publishedItem = Array.isArray(publishedItems) ? publishedItems[index] : undefined;
  if (!(publishedItem instanceof JsonObject)) throw new Error('item missing after publication');
  return { queue: published, item: publishedItem, receiptId };
}
