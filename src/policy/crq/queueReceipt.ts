/**
 * Queue-v1 receipt wire contract and queue-state projection (`review_receipt`).
 *
 * This is the receipt half the read-only status projection deliberately left
 * out (`receiptIdentity` documents that gap): the bounded manifest/chunk pages,
 * enrollment of a merged-current request, the status projection and the
 * receipt-bound remediation predicate. Bytes and queue documents are supplied
 * by the caller; nothing here reads a file, a clock or the environment.
 */
import {
  JsonObject,
  JsonNumber,
  parseJsonValue,
  toPlainJsonRetainingNumbers,
  type JsonValue,
} from './jsonValue.js';
import { receiptJsonDigest, sha256Hex } from './pythonJson.js';
import {
  MERGED_CURRENT_KIND,
  RECEIPT_VERSION,
  ReceiptIdentityError,
  currentEquivalence,
} from './receiptIdentity.js';
import {
  fromPlainJson,
  isJsonRecord,
  jsonIntValue,
  pyTruthy,
  pythonValueEqual,
  recordGet,
  withObjectKeys,
  type JsonRecordLike,
} from './queueDoc.js';

/** `review_receipt.CHUNK_BYTES`: raw receipt bytes per wire chunk. */
export const RECEIPT_CHUNK_BYTES = 3072;
/** `queue_transport.MAX_RECEIPT_BYTES`: the largest supported receipt. */
export const MAX_RECEIPT_BYTES = 64 * 1024 * 1024;
/** `review_receipt.POLICY`. */
export const QUEUE_RECEIPT_POLICY = 'affected-current-additions-v1';
/**
 * `review_receipt.SELECTORS`: selector names are metadata aliases for the same
 * Git ref, never distinct refs.
 */
export const QUEUE_SELECTORS = ['promoted-main', 'merge-queue'] as const;
export type QueueSelector = (typeof QUEUE_SELECTORS)[number];

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,79}$/;
const REPOSITORY = /^[\p{L}\p{N}_.-]+\/[\p{L}\p{N}_.-]+$/u;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** `queue_transport`'s refusal: a Python `ValueError` for the dispatcher. */
export class QueueRefused extends Error {
  override readonly name = 'QueueRefused';
  readonly pythonError = 'ValueError';

  constructor(message: string) {
    super(message);
  }
}

export function refuseQueue(message: string): never {
  throw new QueueRefused(message);
}

/** A verified immutable receipt snapshot: bytes, document and page count. */
export class ReceiptSnapshot {
  readonly data: Uint8Array;
  readonly document: JsonRecordLike;
  readonly receiptId: string;
  readonly count: number;

  constructor(receiptId: string, data: Uint8Array, maxBytes: number = MAX_RECEIPT_BYTES) {
    if (!DIGEST.test(receiptId)) refuseQueue('invalid receipt id');
    if (data.length > maxBytes) refuseQueue('receipt exceeds supported client capacity');
    if (sha256Hex(data) !== receiptId) refuseQueue('receipt digest mismatch');
    let parsed: JsonValue;
    try {
      parsed = parseJsonValue(new TextDecoder('utf-8', { fatal: true }).decode(data), {
        duplicates: 'error',
      });
    } catch {
      refuseQueue('invalid receipt document');
    }
    if (!(parsed instanceof JsonObject)) refuseQueue('invalid receipt document');
    this.data = data;
    this.document = parsed;
    this.receiptId = receiptId;
    this.count = Math.max(1, Math.ceil(data.length / RECEIPT_CHUNK_BYTES));
  }

  /** `_ReceiptSnapshot.page`: a manifest, or one digest-bound chunk. */
  page(cursor?: string | null): JsonObject {
    const common: Array<readonly [string, JsonValue]> = [
      ['version', JsonNumber.int(RECEIPT_VERSION)],
      ['receipt_id', this.receiptId],
      ['sha256', this.receiptId],
      ['bytes', JsonNumber.int(this.data.length)],
      ['chunks', JsonNumber.int(this.count)],
      ['encoding', 'base64-utf8-json'],
    ];
    if (cursor === undefined || cursor === null) {
      return new JsonObject([...common, ['kind', 'manifest'], ['cursor', `${this.receiptId}:0`]]);
    }
    if (typeof cursor !== 'string') refuseQueue('invalid or mixed-snapshot cursor');
    const match = new RegExp(`^${escapeRegExp(this.receiptId)}:(0|[1-9][0-9]{0,9})$`).exec(cursor);
    if (match === null || Number(match[1]) >= this.count) {
      refuseQueue('invalid or mixed-snapshot cursor');
    }
    const index = Number(match[1]);
    const chunk = this.data.subarray(
      index * RECEIPT_CHUNK_BYTES,
      (index + 1) * RECEIPT_CHUNK_BYTES,
    );
    return new JsonObject([
      ...common,
      ['kind', 'chunk'],
      ['index', JsonNumber.int(index)],
      ['chunk_sha256', sha256Hex(chunk)],
      ['data', Buffer.from(chunk).toString('base64')],
      ['next_cursor', index + 1 < this.count ? `${this.receiptId}:${String(index + 1)}` : null],
    ]);
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export interface EnrollInput {
  readonly repo: string;
  readonly pr: number;
  readonly mergeSha: string;
  readonly requestId: string;
  readonly at: string;
  readonly targetSelector?: QueueSelector;
}

export interface EnrollResult {
  readonly queue: JsonObject;
  readonly version: number;
  readonly created: boolean;
  readonly item: JsonObject;
  readonly itemId: string;
}

/** Python's `max` over optional integer `order` values, `default=0`. */
function highestOrder(items: readonly JsonValue[]): bigint {
  let highest = 0n;
  for (const item of items) {
    if (!isJsonRecord(item)) refuseQueue('invalid queue item');
    const value = recordGet(item, 'order');
    if (value === undefined) continue;
    if (typeof value === 'boolean') {
      const integer = value ? 1n : 0n;
      if (integer > highest) highest = integer;
      continue;
    }
    if (!(value instanceof JsonNumber)) refuseQueue('invalid queue item order');
    if (value.kind !== 'int') {
      // Python `max` keeps a float and `+ 1` yields a float; the queue schema
      // requires an integer order, so a non-integral order is corrupt state.
      refuseQueue('invalid queue item order');
    }
    const integer = jsonIntValue(value);
    if (integer > highest) highest = integer;
  }
  return highest;
}

/**
 * `review_receipt.enroll`: bind a request id permanently; equal provenance
 * shares one pending item. Forge validation belongs to the authorized caller.
 */
export function enrollMergedCurrent(queue: JsonObject, input: EnrollInput): EnrollResult {
  const selector = input.targetSelector ?? 'promoted-main';
  if (!REQUEST_ID.test(input.requestId)) refuseQueue('invalid request id');
  if (!REPOSITORY.test(input.repo)) refuseQueue('invalid repository');
  if (!Number.isInteger(input.pr) || input.pr <= 0 || !SHA.test(input.mergeSha)) {
    refuseQueue('invalid source PR/merge SHA');
  }
  if (!(QUEUE_SELECTORS as readonly string[]).includes(selector)) {
    refuseQueue('unsupported target selector');
  }
  const subject = new JsonObject([
    ['repo', input.repo],
    ['pr', JsonNumber.int(input.pr)],
    ['merge_sha', input.mergeSha],
    ['target_selector', selector],
    ['policy', QUEUE_RECEIPT_POLICY],
  ]);
  const requests = queue.get('merged_current_requests');
  const mappings = requests instanceof JsonObject ? requests : new JsonObject([]);
  const previous = mappings.get(input.requestId);
  if (pyTruthy(previous)) {
    if (!isJsonRecord(previous) || !pythonValueEqual(recordGet(previous, 'binding'), subject)) {
      refuseQueue('request id has a different binding');
    }
  }
  const priorItem = pyTruthy(previous) ? recordGet(previous as JsonRecordLike, 'item') : undefined;
  const itemId =
    typeof priorItem === 'string'
      ? priorItem
      : `current-${receiptJsonDigest(subject).slice(0, 32)}`;
  const items = queue.get('items');
  if (!Array.isArray(items)) refuseQueue('invalid queue items');
  const existingIndex = items.findIndex(
    (item) => isJsonRecord(item) && recordGet(item, 'id') === itemId,
  );
  const created = existingIndex < 0;
  let item: JsonObject;
  if (created) {
    item = new JsonObject([
      ['id', itemId],
      ['kind', MERGED_CURRENT_KIND],
      ['pr', JsonNumber.int(input.pr)],
      ['merge_commit', input.mergeSha],
      ['subject', subject],
      ['request_id', input.requestId],
      ['state', 'pending'],
      ['created_at', input.at],
      ['order', JsonNumber.int(highestOrder(items) + 1n)],
      ['cycles', []],
      ['attempts', []],
      ['failures', JsonNumber.int(0)],
      ['depends_on', []],
    ]);
    items.push(item);
  } else {
    const existing = items[existingIndex] as JsonValue;
    if (!(existing instanceof JsonObject)) refuseQueue('invalid queue item');
    item = existing;
  }
  const entry = new JsonObject([
    ['binding', subject],
    ['item', itemId],
  ]);
  const nextQueue = withObjectKeys(queue, [
    ['items', items],
    ['merged_current_requests', withObjectKeys(mappings, [[input.requestId, entry]])],
  ]);
  return { queue: nextQueue, version: RECEIPT_VERSION, created, item, itemId };
}

export interface ReceiptStatus {
  readonly version: number;
  readonly request_id: string;
  readonly item_id: string;
  readonly subject: JsonValue;
  readonly state: JsonValue;
  readonly capture: JsonValue;
  readonly receipt_id: JsonValue;
  readonly reused_from: JsonValue;
  readonly reason: JsonValue;
  readonly remediation?: JsonValue;
}

/**
 * `review_receipt.status`: the stored request/item facts for one request id.
 * The caller owns the lock and never persists this projection.
 */
export function receiptStatus(
  queue: JsonObject,
  requestId: string,
  projectFixed = false,
): ReceiptStatus {
  const mappings = queue.get('merged_current_requests');
  const request = mappings instanceof JsonObject ? mappings.get(requestId) : undefined;
  if (!isJsonRecord(request)) refuseQueue('unknown merged-current request');
  const binding = recordGet(request, 'binding');
  const itemId = recordGet(request, 'item');
  if (binding === undefined || typeof itemId !== 'string') {
    refuseQueue('invalid merged-current request mapping');
  }
  const items = queue.get('items');
  if (!Array.isArray(items)) refuseQueue('invalid queue items');
  const item = items.find((entry) => isJsonRecord(entry) && recordGet(entry, 'id') === itemId);
  if (!isJsonRecord(item)) refuseQueue('unknown merged-current item');
  const state = recordGet(item, 'state');
  if (state === undefined) refuseQueue('invalid merged-current item state');
  const reason = pyTruthy(recordGet(item, 'last_error'))
    ? recordGet(item, 'last_error')
    : nullish(recordGet(item, 'wait_reason'));
  return {
    version: RECEIPT_VERSION,
    request_id: requestId,
    item_id: itemId,
    subject: binding as JsonValue,
    state: state as JsonValue,
    capture: nullish(recordGet(item, 'capture')),
    receipt_id: nullish(recordGet(item, 'receipt_id')),
    reused_from: nullish(recordGet(item, 'reused_from')),
    reason: nullish(reason),
    ...(projectFixed ? { remediation: nullish(recordGet(item, 'remediation')) } : {}),
  };
}

export interface ClientStatusProjection {
  readonly state: string;
  readonly pr: JsonValue;
  readonly mergeSha: JsonValue;
  readonly itemId: string | null;
  readonly receiptId: JsonValue;
  readonly consumed: boolean;
  readonly reviewed: false;
  readonly fixed: false;
  readonly reason: JsonValue;
  readonly enqueued: boolean;
  readonly reusedFrom: JsonValue;
  readonly receiptSource: null;
  readonly receiptEquivalence: null;
}

const FORGE_IDENTITY_REASON = {
  source: 'queue',
  category: 'identity',
  code: 'forge-identity',
} as const;
const PERSISTED_REASON = {
  source: 'queue',
  category: 'unknown',
  code: 'persisted-reason',
} as const;

/**
 * `queue_transport._status`: the bounded client projection for one request id.
 *
 * Terminal truth is read from the immutable receipt by the caller, never from a
 * `done` label here. A persisted forge-identity reason keeps its exact typed
 * code; every other persisted reason projects as `persisted-reason`.
 */
export function clientStatusProjection(
  queue: JsonObject,
  requestId: string,
  entry: JsonRecordLike,
): ClientStatusProjection {
  const mappings = queue.get('merged_current_requests');
  const current = mappings instanceof JsonObject ? mappings.get(requestId) : undefined;
  const item = pyTruthy(current) ? receiptStatus(queue, requestId) : null;
  const rawState = recordGet(entry, 'state');
  if (typeof rawState !== 'string') refuseQueue('invalid queue client entry state');
  let state: string = rawState;
  const receiptId = item === null ? null : item.receipt_id;
  if (item !== null) {
    state =
      (
        { pending: 'pending', reviewing: 'reviewing', blocked: 'blocked' } as Record<string, string>
      )[String(item.state)] ?? 'blocked';
    if (pyTruthy(item.reused_from)) state = 'reused';
  }
  let reason: JsonValue = nullish(recordGet(entry, 'reason'));
  if (reason !== null) {
    reason = fromPlainJson(
      pythonValueEqual(reason, FORGE_IDENTITY_REASON) ? FORGE_IDENTITY_REASON : PERSISTED_REASON,
    );
    state = 'blocked';
  }
  return {
    state,
    pr: nullish(recordGet(entry, 'pr')),
    mergeSha: nullish(recordGet(entry, 'mergeSha')),
    itemId: item === null ? null : item.item_id,
    receiptId,
    consumed: receiptId !== null && pythonValueEqual(recordGet(entry, 'consumed'), receiptId),
    reviewed: false,
    fixed: false,
    reason: nullish(reason),
    enqueued: item !== null,
    reusedFrom: item === null ? null : item.reused_from,
    receiptSource: null,
    receiptEquivalence: null,
  };
}

/**
 * The shared identity predicates (`receiptIdentity.ts`) read plain properties,
 * while every document here is a lossless `JsonObject`. Convert at the seam so
 * a valid captured equivalence is compared as Python's dicts would be.
 */
export function identityInput(value: unknown): unknown {
  return value instanceof JsonObject || value instanceof JsonNumber || Array.isArray(value)
    ? toPlainJsonRetainingNumbers(value as JsonValue)
    : value;
}

/**
 * `review_receipt.reusable_noncounted_terminal`: equivalent terminal scope
 * evidence that grants no review credit (`classification` is null when no
 * review was dispatched).
 */
export function reusableNoncountedTerminal(document: unknown, capture: unknown): boolean {
  try {
    if (!isJsonRecord(document)) return false;
    const retained = currentEquivalence(identityInput(recordGet(document, 'capture')));
    const classification = recordGet(document, 'classification');
    const retainedCapture = recordGet(document, 'capture');
    return (
      pythonValueEqual(recordGet(document, 'version'), RECEIPT_VERSION) &&
      currentEquivalence(identityInput(capture)) === retained &&
      isJsonRecord(retainedCapture) &&
      recordGet(retainedCapture, 'equivalence') === retained &&
      (recordGet(document, 'outcome') === 'no-current-code' ||
        recordGet(document, 'outcome') === 'unsupported') &&
      recordGet(document, 'counted') === false &&
      (classification === null ||
        (isJsonRecord(classification) && recordGet(classification, 'counted') === false)) &&
      recordGet(document, 'independent_acceptance') === false
    );
  } catch (error) {
    if (error instanceof ReceiptIdentityError) return false;
    throw error;
  }
}

/**
 * `review_receipt.remediation_fixed`: tick-verified merge evidence bound to this
 * exact subject, receipt and capture. Never a verdict inference.
 */
export function remediationFixed(
  item: JsonRecordLike,
  document: JsonRecordLike,
  receiptId: string,
): boolean {
  const evidence = recordGet(item, 'remediation');
  const findings = recordGet(document, 'findings');
  const classification = recordGet(document, 'classification');
  if (
    !isJsonRecord(evidence) ||
    !Array.isArray(findings) ||
    findings.length === 0 ||
    recordGet(document, 'outcome') !== 'terminal-with-findings' ||
    recordGet(document, 'counted') !== true ||
    !isJsonRecord(classification) ||
    recordGet(classification, 'outcome') !== 'completed' ||
    recordGet(classification, 'counted') !== true
  ) {
    return false;
  }
  const digests = findings.map((finding) => receiptJsonDigest(fromPlainJson(finding))).sort();
  const evidenceDigests = recordGet(evidence, 'findings');
  const fixPr = recordGet(evidence, 'fix_pr');
  return (
    recordGet(evidence, 'receipt_id') === receiptId &&
    receiptJsonDigest(fromPlainJson(document)) === receiptId &&
    pythonValueEqual(recordGet(evidence, 'subject'), recordGet(item, 'subject')) &&
    pythonValueEqual(recordGet(item, 'subject'), recordGet(document, 'source')) &&
    pythonValueEqual(
      recordGet(evidence, 'capture_digest'),
      receiptJsonDigest(fromPlainJson(nullish(recordGet(document, 'capture')))),
    ) &&
    pythonValueEqual(
      receiptJsonDigest(fromPlainJson(nullish(recordGet(document, 'capture')))),
      receiptJsonDigest(fromPlainJson(nullish(recordGet(item, 'capture')))),
    ) &&
    Array.isArray(evidenceDigests) &&
    pythonValueEqual(evidenceDigests, digests) &&
    fixPr instanceof JsonNumber &&
    fixPr.kind === 'int' &&
    jsonIntValue(fixPr) > 0n &&
    ['merge', 'head', 'target'].every((key) => {
      const value = recordGet(evidence, key);
      return typeof value === 'string' && SHA.test(value);
    })
  );
}

/** `review_receipt.remediation_summary`: the compact status reference. */
export function remediationSummary(item: JsonRecordLike): JsonObject {
  const evidence = recordGet(item, 'remediation');
  if (!isJsonRecord(evidence)) refuseQueue('remediation unavailable');
  return new JsonObject([
    ['receiptId', requireField(evidence, 'receipt_id')],
    ['captureDigest', requireField(evidence, 'capture_digest')],
    ['fixPr', requireField(evidence, 'fix_pr')],
    ['mergeSha', requireField(evidence, 'merge')],
    ['headSha', requireField(evidence, 'head')],
    ['targetSha', requireField(evidence, 'target')],
  ]);
}

function requireField(record: JsonRecordLike, key: string): JsonValue {
  const value = recordGet(record, key);
  return value === undefined ? refuseQueue(`missing ${key}`) : (value as JsonValue);
}

function nullish(value: unknown): JsonValue {
  return value === undefined ? null : (value as JsonValue);
}
