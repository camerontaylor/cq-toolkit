/**
 * Local-review v1 admission (`review_admission.py`), as lossless queue edits.
 *
 * The caller holds the runner's `tick.lock` and persists the returned queue
 * before replying. Git resolution, receipt integrity and the stored profile
 * proof belong to the caller: a completed PR cycle supplied here must already
 * have verified scope and profile.
 *
 * Every mutation is copy-on-write over `JsonObject`, so the queue keeps its
 * unknown fields, key order and int-vs-float lexemes when one request touches
 * one entry.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { withObjectKeys } from './queueDoc.js';
import { receiptJsonDigest } from './pythonJson.js';

/** Item states that still hold the request as an observer. */
export const ACTIVE_STATES = new Set(['pending', 'reviewing']);
/** Wire state names for one local-review item state. */
export const ITEM_STATES: Readonly<Record<string, string>> = {
  pending: 'queued',
  reviewing: 'running',
  done: 'completed',
  cancelled: 'cancelled',
};
/** `operation.KIND`. */
export const LOCAL_REVIEW_KIND = 'local-review';

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;

/** The subset of one queue item this module reads. */
export interface ReviewItemFields {
  readonly id: string;
  readonly state: string;
  readonly generation: bigint;
  readonly receiptId: string | null;
  readonly scopeAdequate: boolean;
  readonly outcome: string | null;
  readonly waitReason: string | null;
  readonly lastError: string | null;
}

/** A refusal the transport maps to `invalid-input`. */
export class ValueError extends Error {
  override readonly name: string = 'ValueError';
}

function asObject(value: unknown): JsonObject | null {
  return value instanceof JsonObject ? value : null;
}

function objectOrEmpty(value: unknown): JsonObject {
  return value instanceof JsonObject ? value : new JsonObject([]);
}

function arrayOrEmpty(value: unknown): JsonValue[] {
  return Array.isArray(value) ? (value as JsonValue[]) : [];
}

function stringField(value: JsonObject, key: string): string | null {
  const found = value.get(key);
  return typeof found === 'string' ? found : null;
}

function intField(value: JsonObject, key: string, fallback: bigint): bigint {
  const found = value.get(key);
  if (found instanceof JsonNumber && found.kind === 'int' && found.integer !== null) {
    return found.integer;
  }
  return fallback;
}

function nullableString(value: JsonObject, key: string): string | null {
  const found = value.get(key);
  return typeof found === 'string' && found.length > 0 ? found : null;
}

export function itemFields(item: JsonObject): ReviewItemFields {
  return {
    id: stringField(item, 'id') ?? '',
    state: stringField(item, 'state') ?? '',
    generation: intField(item, 'generation', 1n),
    receiptId: nullableString(item, 'receipt_id'),
    scopeAdequate: item.get('scope_adequate') === true,
    outcome: stringField(item, 'outcome'),
    waitReason: nullableString(item, 'wait_reason'),
    lastError: nullableString(item, 'last_error'),
  };
}

/** `operation.identity`: the receipt-canonical digest of resolved inputs. */
export function reviewIdentity(resolved: JsonObject): string {
  return receiptJsonDigest(resolved);
}

/** `operation.equivalent`: pinned facts with a known profile. */
export function equivalentIdentityInputs(left: JsonObject, right: JsonObject): boolean {
  const fields = [
    'repo',
    'base_commit',
    'head_commit',
    'scope',
    'projection',
    'config_digest',
  ] as const;
  if (!fields.every((field) => left.get(field) === right.get(field))) return false;
  return pythonDeepEqual(left.get('profile'), right.get('profile'));
}

function pythonDeepEqual(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  if (left === right) return true;
  if (left instanceof JsonObject && right instanceof JsonObject) {
    if (left.entries.length !== right.entries.length) return false;
    return left.entries.every(
      ([key, value]) => right.has(key) && pythonDeepEqual(value, right.get(key)),
    );
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => pythonDeepEqual(value, right[index]))
    );
  }
  return false;
}

/** `admission.key_digest`: the stored request identity, repeat included. */
export function keyDigest(inputs: JsonValue, repeat: boolean): string {
  return receiptJsonDigest(
    new JsonObject([
      ['inputs', inputs],
      ['repeat', repeat],
    ]),
  );
}

/** `admission.adequate`: a completed item that can back exact reuse. */
export function adequate(item: JsonObject): boolean {
  const fields = itemFields(item);
  return fields.state === 'done' && fields.scopeAdequate && fields.receiptId !== null;
}

function requestFor(queue: JsonObject, requestId: string): JsonObject | null {
  return asObject(objectOrEmpty(queue.get('review_requests')).get(requestId));
}

function itemFor(queue: JsonObject, itemId: string): JsonObject | null {
  for (const entry of arrayOrEmpty(queue.get('items'))) {
    const item = asObject(entry);
    if (item !== null && item.get('id') === itemId) return item;
  }
  return null;
}

/** Replace one item by id, preserving its array position. */
export function replaceItem(queue: JsonObject, item: JsonObject): JsonObject {
  const items = arrayOrEmpty(queue.get('items'));
  const id = item.get('id');
  return withObjectKeys(queue, [
    ['items', items.map((entry) => (asObject(entry)?.get('id') === id ? item : entry))],
  ]);
}

/** Replace (or, with `null`, delete) one request binding. */
export function replaceRequest(
  queue: JsonObject,
  requestId: string,
  request: JsonObject | null,
): JsonObject {
  const requests = objectOrEmpty(queue.get('review_requests'));
  const next =
    request === null
      ? new JsonObject(requests.entries.filter(([key]) => key !== requestId))
      : withObjectKeys(requests, [[requestId, request]]);
  return withObjectKeys(queue, [['review_requests', next]]);
}

export function readRequest(queue: JsonObject, requestId: string): JsonObject | null {
  return requestFor(queue, requestId);
}

/** `admission.status`: the client projection of one request. */
export function reviewStatus(queue: JsonObject, requestId: string): JsonObject {
  const request = requestFor(queue, requestId);
  if (request === null) throw new ValueError('unknown review request');
  let result = new JsonObject([
    ['v', JsonNumber.int(1)],
    ['request_id', requestId],
    ['action', 'observed'],
    ['identity', request.get('identity') ?? null],
  ]);
  const notifyStatus = request.get('notify_status');
  if (notifyStatus !== undefined) result = withObjectKeys(result, [['notify', notifyStatus]]);
  const itemId = request.get('item');
  const item = typeof itemId === 'string' ? itemFor(queue, itemId) : null;
  if (item === null) throw new ValueError('unknown review item');
  const fields = itemFields(item);
  if (fields.outcome === 'no-changes') {
    return withObjectKeys(result, [
      ['action', 'no-changes'],
      ['state', 'completed'],
    ]);
  }
  result = withObjectKeys(result, [
    ['item', fields.id],
    ['generation', JsonNumber.int(fields.generation)],
    ['state', ITEM_STATES[fields.state] ?? 'failed'],
  ]);
  if (fields.receiptId !== null)
    result = withObjectKeys(result, [['receipt_id', fields.receiptId]]);
  if (!ACTIVE_STATES.has(fields.state) && !adequate(item)) {
    result = withObjectKeys(result, [['next_action', 'resubmit']]);
  }
  const reason = fields.waitReason ?? fields.lastError;
  if (reason !== null) result = withObjectKeys(result, [['reason', reason]]);
  return result;
}

/** `admission.retry`: replay one request id before resolving any object. */
export function retryRequest(queue: JsonObject, requestId: string, key: string): JsonObject | null {
  if (!REQUEST_ID.test(requestId)) throw new ValueError('invalid request id');
  const old = requestFor(queue, requestId);
  if (old === null) return null;
  if (old.get('key_digest') !== key) throw new ValueError('request id has different inputs');
  return reviewStatus(queue, requestId);
}

export interface AdmitInput {
  readonly requestId: string;
  readonly inputs: JsonObject;
  readonly resolved: JsonObject;
  readonly profile: JsonObject;
  /** `runner.iso()` at admission time. */
  readonly at: string;
  readonly repeat: boolean;
  readonly supersedes?: string;
  readonly notify?: JsonObject;
  readonly ancestryRepeat: boolean;
  /** `verify_receipt`: the disk receipt proves this item's retained result. */
  readonly verifyReceipt: (item: JsonObject) => boolean;
}

/** `admission.admit`: create, join, reuse or observe the matching item. */
export function admit(
  queue: JsonObject,
  input: AdmitInput,
): { readonly queue: JsonObject; readonly result: JsonObject } {
  const key = keyDigest(input.inputs, input.repeat);
  const old = retryRequest(queue, input.requestId, key);
  if (old !== null) return { queue, result: old };

  const identity = reviewIdentity(input.resolved);
  const candidates = arrayOrEmpty(queue.get('items'))
    .map(asObject)
    .filter((item): item is JsonObject => item !== null && item.get('kind') === LOCAL_REVIEW_KIND);
  const equivalent = candidates.filter((item) =>
    equivalentIdentityInputs(objectOrEmpty(item.get('identity_inputs')), input.resolved),
  );
  let generation = 0n;
  for (const candidate of equivalent) {
    const next = intField(candidate, 'generation', 0n);
    if (next > generation) generation = next;
  }
  generation += 1n;

  let binding = new JsonObject([
    ['v', JsonNumber.int(1)],
    ['key_digest', key],
    ['identity', identity],
    ['created_at', input.at],
  ]);
  if (input.supersedes !== undefined) {
    binding = withObjectKeys(binding, [['supersedes', input.supersedes]]);
  }
  if (input.notify !== undefined) binding = withObjectKeys(binding, [['notify', input.notify]]);

  let item: JsonObject | null = null;
  let action = 'created';
  if (!input.repeat) {
    const reversed = [...equivalent].reverse();
    item =
      reversed.find((candidate) => adequate(candidate) && input.verifyReceipt(candidate)) ?? null;
    if (item !== null) action = 'reused';
    else {
      item = reversed.find((candidate) => ACTIVE_STATES.has(itemFields(candidate).state)) ?? null;
      if (item !== null) action = 'joined';
      else if (equivalent.length > 0) {
        item = equivalent[equivalent.length - 1] ?? null;
        action = 'observed';
      }
    }
  }
  if (item === null) {
    let order = 0n;
    for (const entry of arrayOrEmpty(queue.get('items'))) {
      const candidate = asObject(entry);
      if (candidate === null) continue;
      const value = intField(candidate, 'order', 0n);
      if (value > order) order = value;
    }
    item = new JsonObject([
      ['id', `lr-${identity.slice(0, 12)}-g${generation.toString()}`],
      ['kind', LOCAL_REVIEW_KIND],
      ['repo', input.resolved.get('repo') ?? null],
      ['identity', identity],
      ['target', input.inputs.get('target') ?? null],
      ['identity_inputs', input.resolved],
      ['profile', input.profile],
      ['generation', JsonNumber.int(generation)],
      ['repeat_requested', input.repeat],
      ['ancestry_repeat', input.ancestryRepeat],
      ['observers', []],
      ['notify', []],
      ['state', 'pending'],
      ['pr', null],
      ['created_at', input.at],
      ['order', JsonNumber.int(order + 1n)],
      ['cycles', []],
      ['attempts', []],
      ['failures', JsonNumber.int(0)],
      ['depends_on', []],
    ]);
    queue = withObjectKeys(queue, [['items', [...arrayOrEmpty(queue.get('items')), item]]]);
    // A base tree equal to the head tree has no diff to review.
    if (input.resolved.get('base_tree') === input.resolved.get('head_tree')) {
      item = withObjectKeys(item, [
        ['state', 'done'],
        ['outcome', 'no-changes'],
      ]);
      queue = replaceItem(queue, item);
    }
  }

  const itemId = item.get('id');
  if (typeof itemId !== 'string') throw new ValueError('review item has no id');
  binding = withObjectKeys(binding, [
    ['item', itemId],
    ['admission_action', action],
  ]);
  queue = replaceRequest(queue, input.requestId, binding);
  if (ACTIVE_STATES.has(itemFields(item).state)) {
    item = withObjectKeys(item, [
      ['observers', [...arrayOrEmpty(item.get('observers')), input.requestId]],
    ]);
    queue = replaceItem(queue, item);
  }

  let result = reviewStatus(queue, input.requestId);
  if (action === 'observed' && adequate(item) && !input.verifyReceipt(item)) {
    result = withObjectKeys(result, [
      ['next_action', 'resubmit'],
      ['reason', 'receipt-unavailable'],
    ]);
  }
  if (result.get('action') !== 'no-changes') result = withObjectKeys(result, [['action', action]]);
  return { queue, result };
}

/** `admission.cancel`: drop this observer and cancel an unobserved pending item. */
export function cancelRequest(
  queue: JsonObject,
  requestId: string,
  withdrawNotify: (queue: JsonObject, requestId: string) => JsonObject,
): { readonly queue: JsonObject; readonly result: JsonObject } {
  const request = requestFor(queue, requestId);
  if (request === null) throw new ValueError('unknown review request');
  const itemId = request.get('item');
  const item = typeof itemId === 'string' ? itemFor(queue, itemId) : null;
  if (item === null) throw new ValueError('unknown review item');
  let next = withObjectKeys(item, [
    ['observers', arrayOrEmpty(item.get('observers')).filter((entry) => entry !== requestId)],
  ]);
  if (request.has('notify_status') || request.has('notify')) {
    queue = withdrawNotify(queue, requestId);
  }
  if (arrayOrEmpty(next.get('observers')).length === 0 && next.get('state') === 'pending') {
    next = withObjectKeys(next, [['state', 'cancelled']]);
  }
  queue = replaceItem(queue, next);
  return { queue, result: reviewStatus(queue, requestId) };
}
