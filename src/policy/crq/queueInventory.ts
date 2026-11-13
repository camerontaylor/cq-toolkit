/**
 * Queue-v1 interval inventory (`queue_transport._inventory`).
 *
 * The operation projects the trusted, validated reconciliation checkpoint onto
 * the visible queue state for one principal. It performs no forge read, no queue
 * save, no adoption and no dispatch: every row is derived from bytes that were
 * already verified and from the caller's own client entries. Cursors bind the
 * principal, interval, filter, checkpoint and selected-row digest, so a state
 * change refuses a stale continuation instead of silently mixing snapshots.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { compareCodePoints, receiptJsonDigest } from './pythonJson.js';
import {
  MAX_RECEIPT_BYTES,
  QUEUE_RECEIPT_POLICY,
  ReceiptSnapshot,
  clientStatusProjection,
  receiptStatus,
  remediationFixed,
  remediationSummary,
  refuseQueue,
  reusableNoncountedTerminal,
  type ReceiptStatus,
} from './queueReceipt.js';
import { reusableCurrent } from './receiptIdentity.js';
import {
  fromPlainJson,
  isJsonRecord,
  pyTruthy,
  pythonValueEqual,
  recordGet,
  type JsonRecordLike,
} from './queueDoc.js';
import { DISCOVERY_SELECTOR } from './reconcileCheckpoint.js';
import { vendorRateLimit, vendorRateLimitReason } from './queueRetry.js';
import type { QueueInventoryBinding } from './queueWire.js';

/** The two byte-level receipt effects inventory needs; both are fail-closed. */
export interface InventoryReceiptEffects {
  /** `<receiptRoot>/<id>.json` size; absent or unreadable refuses the request. */
  statSize(receiptId: string): Promise<number>;
  /** Verify and parse one receipt with the supplied per-request byte budget. */
  snapshot(receiptId: string, maxBytes: number): Promise<ReceiptSnapshot>;
}

export interface InventoryInput {
  readonly queue: JsonObject;
  /** The validated wrapper checkpoint (`load_checkpoint(..., allow_complete=True)`). */
  readonly checkpoint: JsonObject;
  readonly binding: QueueInventoryBinding;
  readonly principal: string;
  readonly states: readonly string[] | null;
  readonly cursor: string | null;
  readonly limit: number;
  readonly projectFixed: boolean;
  readonly effects: InventoryReceiptEffects;
}

export type InventoryResult = JsonObject;

const REASON_NO_RECEIPT = {
  source: 'queue',
  category: 'unknown',
  code: 'no-receipt',
} as const;
const REASON_UNCLASSIFIED = {
  source: 'queue',
  category: 'unknown',
  code: 'unclassified',
} as const;
const REASON_RECEIPT_SOURCE = {
  source: 'queue',
  category: 'identity',
  code: 'receipt-source',
} as const;
const REASON_SCAN_BLOCK = {
  source: 'queue',
  category: 'scan',
  code: 'blocked-secret-scan',
} as const;
const REASON_RECEIPT_BUDGET = {
  source: 'queue',
  category: 'capacity',
  code: 'inventory-receipt-budget',
} as const;

const TERMINAL_COUNTED = new Set(['terminal-clean', 'terminal-with-findings', 'partial-scope']);
const NONCOUNTED_OUTCOMES = new Set(['no-current-code', 'partial-scope', 'unsupported']);

function refuse(message: string): never {
  refuseQueue(message);
}

function copyWithItems(queue: JsonObject, items: readonly JsonValue[]): JsonObject {
  const mutable = [...items];
  return new JsonObject(
    queue.entries.map(([key, value]) => [key, key === 'items' ? mutable : value] as const),
  );
}

function numberOrZero(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? Number(value.integer as bigint) : (value.float as number);
  }
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  return 0;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/**
 * Project one checkpoint interval onto the caller's visible queue state.
 *
 * The caller owns the wrapper generation checks around this projection.
 */
export async function projectInventory(input: InventoryInput): Promise<InventoryResult> {
  const binding = input.binding;
  const queue = input.queue;
  const checkpoint = input.checkpoint;
  const complete = checkpoint.get('complete');
  const dryRun = checkpoint.get('dry_run');
  if (complete !== true || dryRun !== false) refuse('complete durable inventory required');
  const inventory = checkpoint.get('inventory');
  if (!Array.isArray(inventory)) refuse('invalid inventory checkpoint');
  const checkpointDigest = checkpoint.get('digest');
  if (typeof checkpointDigest !== 'string') refuse('invalid inventory checkpoint');
  const completeThrough = checkpoint.get('before');
  if (typeof completeThrough !== 'string') refuse('invalid inventory checkpoint');

  const entriesValue = queue.get('queue_client_requests');
  const entries = entriesValue === undefined ? new JsonObject([]) : entriesValue;
  const mappingsValue = queue.get('merged_current_requests');
  const mappings = mappingsValue === undefined ? new JsonObject([]) : mappingsValue;
  const queueItems = queue.get('items');
  if (
    !(entries instanceof JsonObject) ||
    !(mappings instanceof JsonObject) ||
    !Array.isArray(queueItems) ||
    queueItems.some((item) => !isJsonRecord(item))
  ) {
    refuse('invalid reconciled queue mappings/items');
  }

  const sortedMappings = mappings.entries
    .map(([requestId, mapping]) => ({ requestId, mapping }))
    .sort((left, right) => {
      const leftOwn = recordGet(entries, left.requestId);
      const rightOwn = recordGet(entries, right.requestId);
      const leftPrincipal = isJsonRecord(leftOwn) ? recordGet(leftOwn, 'principal') : undefined;
      const rightPrincipal = isJsonRecord(rightOwn) ? recordGet(rightOwn, 'principal') : undefined;
      const leftOwned = pyTruthy(leftOwn) && leftPrincipal === input.principal;
      const rightOwned = pyTruthy(rightOwn) && rightPrincipal === input.principal;
      // Python sorts `(principal != mine, request_id)`: own entries first.
      if (leftOwned !== rightOwned) return leftOwned ? -1 : 1;
      return compareCodePoints(left.requestId, right.requestId);
    });

  const bySubject = new Map<string, Array<{ requestId: string; mapping: JsonValue }>>();
  for (const { requestId, mapping } of sortedMappings) {
    if (!isJsonRecord(mapping)) continue;
    const digest = receiptJsonDigest(recordGet(mapping, 'binding') as JsonValue);
    const bucket = bySubject.get(digest);
    if (bucket === undefined) bySubject.set(digest, [{ requestId, mapping }]);
    else bucket.push({ requestId, mapping });
  }

  const itemsById = new Map<string, JsonObject[]>();
  for (const item of queueItems) {
    const object = item as JsonObject;
    const id = object.get('id');
    if (typeof id !== 'string') continue;
    const bucket = itemsById.get(id);
    if (bucket === undefined) itemsById.set(id, [object]);
    else bucket.push(object);
  }

  type Row = {
    pr: JsonValue;
    mergeSha: JsonValue;
    requestId: string | null;
    itemId: string | null;
    state: string;
    reason: JsonValue;
    reviewed?: boolean;
    consumed?: boolean;
    fixed?: boolean;
    remediation?: JsonValue;
  };
  const rows: Row[] = [];
  let receiptBudget = MAX_RECEIPT_BYTES;
  let budgetExhausted = false;

  for (const source of inventory) {
    if (!isJsonRecord(source)) continue;
    const pr = source.get('pr') as JsonValue;
    const mergeSha = source.get('merge_sha') as JsonValue;
    const row: Row = {
      pr: pr ?? null,
      mergeSha: mergeSha ?? null,
      requestId: null,
      itemId: null,
      state: 'missing',
      reason: null,
      ...(input.projectFixed ? { reviewed: false, consumed: false, fixed: false } : {}),
    };
    const subject = new JsonObject([
      ['repo', binding.repo],
      ['pr', row.pr],
      ['merge_sha', row.mergeSha],
      ['target_selector', binding.targetSelector],
      ['policy', QUEUE_RECEIPT_POLICY],
    ]);
    const candidates = bySubject.get(receiptJsonDigest(subject)) ?? [];
    for (const { requestId, mapping } of candidates) {
      if (!isJsonRecord(mapping)) continue;
      if (!pythonValueEqual(recordGet(mapping, 'binding'), subject)) continue;
      const ownEntry = entries.get(requestId);
      if (
        ownEntry !== undefined &&
        isJsonRecord(ownEntry) &&
        recordGet(ownEntry, 'principal') !== input.principal
      ) {
        continue;
      }
      const itemId = `current-${receiptJsonDigest(subject).slice(0, 32)}`;
      const matches = itemsById.get(itemId) ?? [];
      const expectedMapping = new JsonObject([
        ['binding', subject],
        ['item', itemId],
      ]);
      if (
        !pythonValueEqual(mapping, expectedMapping) ||
        matches.length !== 1 ||
        !pythonValueEqual((matches[0] as JsonObject).get('subject'), subject) ||
        (matches[0] as JsonObject).get('kind') !== 'merged-current' ||
        !pythonValueEqual((matches[0] as JsonObject).get('pr'), row.pr) ||
        !pythonValueEqual((matches[0] as JsonObject).get('merge_commit'), row.mergeSha)
      ) {
        refuse('reconciled request/source mismatch');
      }
      const item = matches[0] as JsonObject;
      const status: ReceiptStatus = receiptStatus(copyWithItems(queue, [item]), requestId);
      row.requestId = requestId;
      row.itemId = status.item_id;
      row.state = 'pending';
      const entryReason = isJsonRecord(ownEntry) ? recordGet(ownEntry, 'reason') : undefined;
      if (isJsonRecord(ownEntry) && pyTruthy(entryReason)) {
        const persisted = clientStatusProjection(queue, requestId, ownEntry);
        row.state = 'blocked';
        row.reason = persisted.reason;
      } else if (typeof status.receipt_id === 'string' && status.receipt_id.length > 0) {
        const receiptId = status.receipt_id;
        if ((await input.effects.statSize(receiptId)) > receiptBudget) {
          row.state = 'blocked';
          row.reason = fromPlainJson(REASON_RECEIPT_BUDGET);
          budgetExhausted = true;
          break;
        }
        const snapshot = await input.effects.snapshot(receiptId, receiptBudget);
        receiptBudget -= snapshot.data.length;
        const document = snapshot.document;
        const receiptSource = recordGet(document, 'source');
        const sourceMatches =
          isJsonRecord(receiptSource) &&
          recordGet(receiptSource, 'repo') === binding.repo &&
          recordGet(receiptSource, 'target_selector') === binding.targetSelector;
        const equivalent =
          pyTruthy(status.reused_from) &&
          reusable(document, (item.get('capture') as JsonValue) ?? null);
        if (!sourceMatches || (!pythonValueEqual(receiptSource, subject) && !equivalent)) {
          row.state = 'blocked';
          row.reason = fromPlainJson(REASON_RECEIPT_SOURCE);
        } else if (countedTerminal(document)) {
          const consumedId = isJsonRecord(ownEntry) ? recordGet(ownEntry, 'consumed') : undefined;
          const consumed = pythonValueEqual(consumedId, receiptId);
          row.state = consumed ? 'consumed' : pyTruthy(status.reused_from) ? 'reused' : 'reviewed';
          if (input.projectFixed) {
            row.consumed = consumed;
            row.reviewed = true;
            row.fixed = remediationFixed(item, document, receiptId);
            if (row.fixed) {
              row.remediation = remediationSummary(item);
              if (!consumed) row.state = 'fixed';
            }
          }
        } else if (NONCOUNTED_OUTCOMES.has(String(recordGet(document, 'outcome')))) {
          row.state = String(recordGet(document, 'outcome'));
        } else if (recordGet(document, 'outcome') === 'blocked-secret-scan') {
          row.state = 'blocked';
          row.reason = fromPlainJson(REASON_SCAN_BLOCK);
        } else {
          row.state = 'blocked';
          row.reason = fromPlainJson(
            vendorRateLimit(document) ? vendorRateLimitReason() : REASON_UNCLASSIFIED,
          );
        }
      } else if (status.state !== 'pending' && status.state !== 'reviewing') {
        row.state = 'blocked';
        row.reason = fromPlainJson(REASON_NO_RECEIPT);
      }
      break;
    }
    rows.push(row);
    if (budgetExhausted) break;
  }

  rows.sort((left, right) => {
    const prs = numberOrZero(left.pr) - numberOrZero(right.pr);
    if (prs !== 0) return prs;
    return compareCodePoints(stringOrEmpty(left.mergeSha), stringOrEmpty(right.mergeSha));
  });

  const selected = rows.filter(
    (row) =>
      input.states === null ||
      input.states.includes(row.state) ||
      (['reviewed', 'consumed', 'fixed'] as const).some(
        (fact) => row[fact] === true && input.states?.includes(fact) === true,
      ),
  );

  const digest = receiptJsonDigest({
    principal: input.principal,
    binding: input.binding as unknown as JsonValue,
    checkpoint: checkpointDigest,
    states: (input.states ?? null) as unknown as JsonValue,
    entries: selected as unknown as JsonValue,
  });
  let start = 0;
  if (input.cursor !== null) {
    const pattern = new RegExp(`^${escapeRegExp(digest)}:(0|[1-9][0-9]{0,5})$`);
    const match = pattern.exec(input.cursor);
    if (match === null || Number(match[1]) >= selected.length) {
      return new JsonObject([
        [
          'error',
          new JsonObject([
            ['code', 'stale-cursor'],
            ['retryable', false],
            ['restart', true],
          ]),
        ],
      ]);
    }
    start = Number(match[1]);
  }
  const end = Math.min(start + input.limit, selected.length);
  return new JsonObject([
    ['entries', selected.slice(start, end) as unknown as JsonValue],
    ['terminal', end === selected.length],
    ['nextCursor', end === selected.length ? null : `${digest}:${String(end)}`],
    ['snapshot', digest],
    [
      'proof',
      new JsonObject([
        ['checkpoint', checkpointDigest],
        ['completeThrough', completeThrough],
        ['count', JsonNumber.int(rows.length)],
        ['digest', digest],
        ['selectedCount', JsonNumber.int(selected.length)],
        ['intervalConvention', '(after,before]'],
      ]),
    ],
  ]);
}

function countedTerminal(document: JsonRecordLike): boolean {
  const classification = recordGet(document, 'classification');
  const outcome = recordGet(document, 'outcome');
  return (
    recordGet(document, 'counted') === true &&
    isJsonRecord(classification) &&
    recordGet(classification, 'counted') === true &&
    recordGet(classification, 'outcome') === 'completed' &&
    typeof outcome === 'string' &&
    TERMINAL_COUNTED.has(outcome)
  );
}

function reusable(document: JsonRecordLike, capture: JsonValue): boolean {
  // `reusable_current or reusable_noncounted_terminal`; equivalence is checked
  // by the shared receipt predicates so a partial scope never earns credit.
  return reusableCurrent(document, capture) || reusableNoncountedTerminal(document, capture);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** `_inventory`'s wrapper storage key for one frozen interval. */
export function inventoryWrapperKey(binding: QueueInventoryBinding): string {
  return receiptJsonDigest({
    repo: binding.repo,
    base: DISCOVERY_SELECTOR,
    after: binding.after,
    before: binding.before,
  });
}
