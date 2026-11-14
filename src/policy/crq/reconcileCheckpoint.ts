/**
 * Read-only reconciliation checkpoint validation (`merged_reconcile` +
 * `crq._read_reconcile_wrapper`).
 *
 * The queue-v1 `inventory` operation trusts a stored reconcile wrapper only
 * after the runner has re-derived its source identity, wrapper digest and every
 * checkpoint invariant. This module is that verifier: it parses and refuses; it
 * never fetches, mutates, persists or reports a budget. Fetching, page folding
 * and per-run reporting stay with the S2 reconcile slice.
 *
 * Numeric and JSON rules mirror the Python oracle exactly: counters are Python
 * `int` (a `1.0` lexeme is refused), digests are receipt-canonical SHA-256, and
 * the interval is the reconciler's frozen `(after, before]` pair.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import { receiptJsonDigest } from './pythonJson.js';
import {
  isJsonBool,
  isJsonInt,
  jsonIntValue,
  jsonIntText,
  isJsonRecord,
  pythonValueEqual,
  recordEntries,
  recordGet,
  type JsonRecordLike,
} from './queueDoc.js';

/** `merged_reconcile.VERSION`. */
export const RECONCILE_VERSION = 1;
/** `merged_reconcile.CHECKPOINT_SCHEMA`: schema 1 cannot prove coverage. */
export const CHECKPOINT_SCHEMA = 2;
export const MAX_PAGE_BUDGET = 200;
export const MAX_INVENTORY = 5000;
export const MAX_PAGES = 1000;
export const MAX_CURSOR_BYTES = 4096;
export const MAX_REPOSITORY_NUMBER = 20000;
export const NUMBER_WINDOW = 50;
/** `runtime_target.DISCOVERY_SELECTOR`: the merged-interval base query. */
export const DISCOVERY_SELECTOR = 'main-or-merge-queue';

const TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$/;
const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;

/** `merged_reconcile.ReconcileRefused`: no complete-inventory claim is possible. */
export class ReconcileRefused extends Error {
  override readonly name = 'ReconcileRefused';
  readonly pythonError = 'ReconcileRefused';

  constructor(message: string) {
    super(message);
  }
}

/** `_timestamp`: ASCII-digit UTC form, then component validation (`strptime`). */
export function normalizeTimestamp(name: string, value: unknown): string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) {
    throw new ReconcileRefused(`${name} must be an exact UTC timestamp YYYY-MM-DDTHH:MM:SSZ`);
  }
  const [year, month, day, hour, minute, second] = value
    .slice(0, -1)
    .split(/[-T:]/)
    .map((part) => Number(part)) as [number, number, number, number, number, number];
  if (
    !validDate(year, month, day) ||
    hour > 23 ||
    minute > 59 ||
    second > 61 // Python's %S accepts a leap second
  ) {
    throw new ReconcileRefused(`${name} is not a valid UTC timestamp`);
  }
  return value;
}

function validDate(year: number, month: number, day: number): boolean {
  if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1) return false;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lengths = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (lengths[month - 1] as number);
}

export interface ReconcileInterval {
  readonly after: string;
  readonly before: string;
}

/** `merged_reconcile.normalize_interval`: a frozen, non-empty `(after, before]`. */
export function normalizeInterval(after: unknown, before: unknown): ReconcileInterval {
  const start = normalizeTimestamp('after', after);
  const end = normalizeTimestamp('before', before);
  if (start >= end) throw new ReconcileRefused('after must be strictly earlier than before');
  return { after: start, before: end };
}

/** `merged_reconcile.normalize_page_budget`. */
export function normalizePageBudget(budget: unknown): number {
  if (
    !isJsonInt(budget) ||
    jsonIntValue(budget) < 1n ||
    jsonIntValue(budget) > BigInt(MAX_PAGE_BUDGET)
  ) {
    throw new ReconcileRefused(
      `page budget must be a positive integer capped at ${String(MAX_PAGE_BUDGET)}`,
    );
  }
  return Number(jsonIntValue(budget));
}

/** `_cursor`: `None`, or a bounded non-empty string. */
export function isCursor(value: unknown): boolean {
  return (
    value === null ||
    (typeof value === 'string' &&
      value.length > 0 &&
      Buffer.byteLength(value, 'utf8') <= MAX_CURSOR_BYTES)
  );
}

/** Refuse non-finite floats exactly as `allow_nan=False` does before hashing. */
function assertCanonicalNumbers(value: unknown): void {
  if (value instanceof JsonNumber) {
    if (value.kind === 'float' && !Number.isFinite(value.float as number)) {
      throw new ReconcileRefused('checkpoint is not canonical JSON');
    }
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new ReconcileRefused('checkpoint is not canonical JSON');
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) assertCanonicalNumbers(entry);
    return;
  }
  if (isJsonRecord(value)) {
    for (const [, entry] of recordEntries(value)) assertCanonicalNumbers(entry);
  }
}

/** `merged_reconcile.checkpoint_digest`: a JSON snapshot without its own digest. */
export function checkpointDigest(checkpoint: JsonRecordLike): string {
  const payload = Object.fromEntries(
    recordEntries(checkpoint).filter(([key]) => key !== 'digest'),
  ) as Record<string, unknown>;
  assertCanonicalNumbers(payload);
  return receiptJsonDigest(payload);
}

/**
 * `merged_reconcile.record_identity`: one page record reduced to the frozen
 * merged-current identity. Malformed records become typed `unsupported` rows
 * instead of failing the page.
 */
export function recordIdentity(pageRecord: unknown): JsonObject {
  if (!isJsonRecord(pageRecord)) {
    return new JsonObject([
      ['disposition', 'unsupported'],
      ['reason', 'page record is not an object'],
    ]);
  }
  const pr = recordGet(pageRecord, 'number');
  if (!isJsonInt(pr) || jsonIntValue(pr) <= 0n) {
    return new JsonObject([
      ['disposition', 'unsupported'],
      ['reason', 'malformed PR number'],
    ]);
  }
  let mergedAt: unknown;
  try {
    mergedAt = normalizeTimestamp('mergedAt', recordGet(pageRecord, 'mergedAt'));
  } catch {
    return new JsonObject([
      ['disposition', 'unsupported'],
      ['pr', pr],
      ['reason', 'missing or malformed mergedAt'],
    ]);
  }
  const merge = recordGet(pageRecord, 'mergeCommit');
  const oid = isJsonRecord(merge) ? recordGet(merge, 'oid') : undefined;
  if (typeof oid !== 'string' || !SHA.test(oid)) {
    return new JsonObject([
      ['disposition', 'unsupported'],
      ['pr', pr],
      ['merged_at', mergedAt as string],
      ['reason', 'missing or malformed merge commit identity'],
    ]);
  }
  const head = recordGet(pageRecord, 'headRefOid');
  if (head === undefined || typeof head !== 'string' || !SHA.test(head)) {
    return new JsonObject([
      ['disposition', 'unsupported'],
      ['pr', pr],
      ['merged_at', mergedAt as string],
      ['reason', 'source head gone or malformed'],
    ]);
  }
  const subject = new JsonObject([
    ['repo', null],
    ['pr', pr],
    ['merge_sha', oid],
    ['target_selector', 'promoted-main'],
    ['policy', 'affected-current-additions-v1'],
  ]);
  return new JsonObject([
    ['disposition', 'intent'],
    ['pr', pr],
    ['merged_at', mergedAt as string],
    ['merge_sha', oid],
    ['head', head],
    ['subject', subject],
  ]);
}

/** `merged_reconcile.new_checkpoint`: the exact schema-2 shape (empty). */
export function newCheckpoint(
  interval: ReconcileInterval,
  pageBudget: number,
  repo: string,
  base: string,
): JsonObject {
  return new JsonObject([
    ['schema_version', JsonNumber.int(CHECKPOINT_SCHEMA)],
    ['after', interval.after],
    ['before', interval.before],
    ['page_budget', JsonNumber.int(pageBudget)],
    ['repo', repo],
    ['base', base],
    ['cursor', null],
    ['pages_read', JsonNumber.int(0)],
    ['seen', new JsonObject([])],
    ['inventory', []],
    ['record_keys', []],
    ['cursor_history', []],
    ['duplicates_seen', JsonNumber.int(0)],
    ['outside_window', JsonNumber.int(0)],
    ['records_read', JsonNumber.int(0)],
    ['transient_failures', JsonNumber.int(0)],
    ['complete', false],
    ['steps', []],
    ['dry_run', false],
  ]);
}

/** `merged_reconcile.summarize`: the bounded progress projection. */
export function summarize(checkpoint: JsonRecordLike): JsonObject {
  const inventory = recordGet(checkpoint, 'inventory');
  const rows = Array.isArray(inventory) ? inventory : [];
  const intents = rows.filter(
    (row) => isJsonRecord(row) && recordGet(row, 'disposition') === 'intent',
  ).length;
  const steps = recordGet(checkpoint, 'steps');
  const stepRows: JsonValue[] = Array.isArray(steps) ? (steps as JsonValue[]) : [];
  const last = stepRows.at(-1);
  const lastOutcome = isJsonRecord(last) ? recordGet(last, 'outcome') : undefined;
  const complete = recordGet(checkpoint, 'complete');
  const entries: Array<readonly [string, JsonValue]> = [
    ['version', JsonNumber.int(RECONCILE_VERSION)],
    ['after', asJson(recordGet(checkpoint, 'after'))],
    ['before', asJson(recordGet(checkpoint, 'before'))],
    ['pages_read', asJson(recordGet(checkpoint, 'pages_read'))],
    ['transient_failures', asJson(recordGet(checkpoint, 'transient_failures'))],
  ];
  if (lastOutcome === 'budget-exhausted' || lastOutcome === 'transport-failure') {
    entries.push(['reason', lastOutcome]);
  }
  entries.push(
    ['complete', asJson(complete)],
    ['next_cursor', asJson(recordGet(checkpoint, 'cursor'))],
    ['complete_through', complete === true ? asJson(recordGet(checkpoint, 'before')) : null],
    ['represented', JsonNumber.int(rows.length)],
    ['intents', JsonNumber.int(intents)],
    ['unsupported', JsonNumber.int(rows.length - intents)],
    ['duplicates_seen', asJson(recordGet(checkpoint, 'duplicates_seen'))],
    ['outside_window', asJson(recordGet(checkpoint, 'outside_window'))],
    ['records_read', asJson(recordGet(checkpoint, 'records_read'))],
    ['reviewed', JsonNumber.int(0)],
    ['pending_review', JsonNumber.int(intents)],
  );
  return new JsonObject(entries);
}

function asJson(value: unknown): JsonValue {
  if (value === undefined) return null;
  return value as JsonValue;
}

function refuse(message: string): never {
  throw new ReconcileRefused(message);
}

function requireArray(checkpoint: JsonRecordLike, key: string): unknown[] {
  const value = recordGet(checkpoint, key);
  if (!Array.isArray(value)) refuse(`checkpoint state malformed: ${key}`);
  return value;
}

function requireCounter(checkpoint: JsonRecordLike, key: string): bigint {
  const value = recordGet(checkpoint, key);
  if (!isJsonInt(value) || jsonIntValue(value) < 0n) {
    refuse(`checkpoint counter malformed: ${key}`);
  }
  return jsonIntValue(value);
}

/**
 * `merged_reconcile.load_checkpoint`: full schema-2 validation against one
 * frozen interval, page budget and repository/base query.
 */
export function loadCheckpoint(
  raw: unknown,
  interval: ReconcileInterval,
  pageBudget: number,
  repo: string,
  base: string,
  allowComplete = false,
): JsonObject {
  if (
    !(raw instanceof JsonObject) ||
    !isJsonInt(raw.get('schema_version')) ||
    jsonIntValue(raw.get('schema_version') as JsonNumber) !== BigInt(CHECKPOINT_SCHEMA)
  ) {
    refuse('checkpoint schema unsupported; restart inventory');
  }
  const checkpoint = raw as JsonObject;
  if (
    recordGet(checkpoint, 'after') !== interval.after ||
    recordGet(checkpoint, 'before') !== interval.before
  ) {
    refuse('checkpoint belongs to a different frozen interval');
  }
  const budget = recordGet(checkpoint, 'page_budget');
  if (!isJsonInt(budget) || Number(jsonIntValue(budget)) !== pageBudget) {
    refuse('checkpoint was taken with a different page budget');
  }
  if (recordGet(checkpoint, 'repo') !== repo || recordGet(checkpoint, 'base') !== base) {
    refuse('checkpoint belongs to a different repository/base query');
  }
  const required = newCheckpoint(interval, pageBudget, repo, base);
  for (const [key] of required.entries) {
    if (!checkpoint.has(key)) refuse('checkpoint missing required fields');
  }
  if (!pythonValueEqual(recordGet(checkpoint, 'digest'), checkpointDigest(checkpoint))) {
    refuse('checkpoint digest mismatch');
  }
  for (const field of [
    'pages_read',
    'duplicates_seen',
    'outside_window',
    'records_read',
    'transient_failures',
  ]) {
    requireCounter(checkpoint, field);
  }
  const complete = recordGet(checkpoint, 'complete');
  const dryRun = recordGet(checkpoint, 'dry_run');
  const cursor = recordGet(checkpoint, 'cursor');
  const seen = recordGet(checkpoint, 'seen');
  if (!isJsonBool(complete) || !isJsonBool(dryRun) || !isCursor(cursor) || !isJsonRecord(seen)) {
    refuse('checkpoint state malformed');
  }
  const inventory = requireArray(checkpoint, 'inventory');
  const recordKeys = requireArray(checkpoint, 'record_keys');
  const cursorHistory = requireArray(checkpoint, 'cursor_history');
  requireArray(checkpoint, 'steps');
  const pagesRead = Number(requireCounter(checkpoint, 'pages_read'));
  if (inventory.length > MAX_INVENTORY || pagesRead > MAX_PAGES) {
    refuse('checkpoint resource cap exceeded; partition the interval');
  }
  if (
    recordKeys.some((key) => typeof key !== 'string' || !DIGEST.test(key)) ||
    new Set(recordKeys).size !== recordKeys.length ||
    recordKeys.length !== inventory.length ||
    cursorHistory.some((entry) => entry === null || !isCursor(entry)) ||
    new Set(cursorHistory).size !== cursorHistory.length ||
    cursorHistory.length !== pagesRead - (complete === true ? 1 : 0) ||
    (complete !== true && !pythonValueEqual(cursor, cursorHistory.at(-1) ?? null)) ||
    (complete === true && (cursor !== null || pagesRead === 0)) ||
    !pythonValueEqual(
      recordGet(checkpoint, 'records_read'),
      JsonNumber.int(
        BigInt(recordKeys.length) +
          requireCounter(checkpoint, 'duplicates_seen') +
          requireCounter(checkpoint, 'outside_window'),
      ),
    )
  ) {
    refuse('checkpoint progress inconsistent');
  }
  const seenEntries: Array<readonly [string, JsonValue]> = [];
  for (const entry of inventory) {
    if (!isJsonRecord(entry)) refuse('checkpoint inventory malformed');
    const disposition = recordGet(entry, 'disposition');
    if (disposition !== 'intent' && disposition !== 'unsupported') {
      refuse('checkpoint inventory malformed');
    }
    if (disposition === 'intent') {
      const reconstructed = recordIdentity({
        number: recordGet(entry, 'pr'),
        mergedAt: recordGet(entry, 'merged_at'),
        mergeCommit: { oid: recordGet(entry, 'merge_sha') },
        headRefOid: recordGet(entry, 'head'),
      });
      const mergedAt = recordGet(entry, 'merged_at');
      if (
        !pythonValueEqual(entry, reconstructed) ||
        typeof mergedAt !== 'string' ||
        !(interval.after < mergedAt && mergedAt <= interval.before)
      ) {
        refuse('checkpoint intent malformed');
      }
      const pr = recordGet(entry, 'pr');
      seenEntries.push([
        jsonIntText(pr as JsonNumber),
        new JsonObject([
          ['merge_sha', asJson(recordGet(entry, 'merge_sha'))],
          ['merged_at', mergedAt],
        ]),
      ]);
    } else {
      const reason = recordGet(entry, 'reason');
      if (typeof reason !== 'string' || reason.length === 0) {
        refuse('checkpoint unsupported reason missing');
      }
    }
  }
  const expected = new JsonObject(seenEntries);
  if (
    !pythonValueEqual(seen, expected) ||
    !pythonValueEqual(recordGet(checkpoint, 'summary'), summarize(checkpoint))
  ) {
    refuse('checkpoint registry/summary inconsistent');
  }
  if (complete === true && !allowComplete) {
    refuse('checkpoint is already complete; nothing to resume');
  }
  return new JsonObject(checkpoint.entries.map(([key, value]) => [key, value] as const));
}

const WRAPPER_KEYS = new Set(['source', 'checkpoint', 'digest']);
const SOURCE_KEYS = new Set([
  'version',
  'method',
  'repo',
  'base',
  'repository_id',
  'ceiling',
  'window',
]);

/**
 * `crq._read_reconcile_wrapper`: re-derive the stored wrapper's identity.
 *
 * The caller has already read the same path; a second read here is the
 * generation check the inventory operation relies on.
 */
export function readReconcileWrapper(
  text: string,
  interval: ReconcileInterval,
  pageBudget: unknown,
  repo: string,
): JsonObject {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    refuse('wrapper-decode: invalid JSON');
  }
  if (!(parsed instanceof Object) || Array.isArray(parsed)) {
    refuse('wrapper-schema: required fields malformed');
  }
  const wrapper = plainToObject(parsed as Record<string, unknown>);
  const keys = new Set(wrapper.entries.map(([key]) => key));
  if (keys.size !== WRAPPER_KEYS.size || [...keys].some((key) => !WRAPPER_KEYS.has(key))) {
    refuse('wrapper-schema: required fields malformed');
  }
  const sourceValue = wrapper.get('source');
  if (!(sourceValue instanceof JsonObject)) {
    refuse('wrapper-schema: required fields malformed');
  }
  const source = sourceValue as JsonObject;
  const sourceKeys = new Set(source.entries.map(([key]) => key));
  const version = source.get('version');
  const ceiling = source.get('ceiling');
  if (
    sourceKeys.size !== SOURCE_KEYS.size ||
    [...sourceKeys].some((key) => !SOURCE_KEYS.has(key)) ||
    !isJsonInt(version) ||
    jsonIntValue(version) !== 1n ||
    source.get('method') !== 'all-number-slots-v1' ||
    source.get('repo') !== repo ||
    source.get('base') !== DISCOVERY_SELECTOR ||
    !isJsonInt(source.get('window')) ||
    jsonIntValue(source.get('window') as JsonNumber) !== BigInt(NUMBER_WINDOW) ||
    typeof source.get('repository_id') !== 'string' ||
    (source.get('repository_id') as string).length === 0 ||
    !isJsonInt(ceiling) ||
    jsonIntValue(ceiling) < 0n ||
    jsonIntValue(ceiling) > BigInt(MAX_REPOSITORY_NUMBER)
  ) {
    refuse('wrapper-schema: source identity malformed');
  }
  if (!pythonValueEqual(wrapper.get('digest'), checkpointDigest(wrapper))) {
    refuse('source/checkpoint wrapper digest mismatch');
  }
  const checkpoint = wrapper.get('checkpoint');
  if (checkpoint === null) return wrapper;
  const validated = loadCheckpoint(
    checkpoint,
    interval,
    normalizePageBudget(pageBudget),
    repo,
    DISCOVERY_SELECTOR,
    true,
  );
  return new JsonObject(
    wrapper.entries.map(([key, value]) => [key, key === 'checkpoint' ? validated : value] as const),
  );
}

function plainToObject(value: Record<string, unknown>): JsonObject {
  return new JsonObject(Object.keys(value).map((key) => [key, plainToJson(value[key])] as const));
}

function plainToJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) refuse('wrapper-decode: invalid JSON');
    return Number.isInteger(value) ? JsonNumber.int(value) : JsonNumber.float(value);
  }
  if (Array.isArray(value)) return value.map((entry) => plainToJson(entry));
  if (typeof value === 'object') return plainToObject(value as Record<string, unknown>);
  refuse('wrapper-decode: invalid JSON');
}
