/**
 * Pure finding identity and recovery-row transitions for the crq finding inbox.
 *
 * Ports `finding_delivery.occurrence`, `normalize` and the row mutation in
 * `Inbox._recover_event`. It performs no I/O, clock, environment or spawn read.
 * The caller supplies the retained event and the row already read through the
 * inbox seam.
 *
 * `transitionFindingRow` deliberately keeps Python's access order and loose
 * `get` / `in` semantics. The event is not revalidated and its id is not
 * recomputed, because Python trusts retained records at this point.
 */
import { JsonObject, type JsonValue } from './jsonValue.js';
import {
  LedgerTypeError,
  ledgerDigestOf,
  ledgerPythonTypeName,
  ledgerSubscript,
  ledgerValueEqual,
} from './ledger.js';
import { pythonTruthy } from './repairBinding.js';

const CONTENT_KEYS = ['path', 'blob', 'intervals', 'title', 'body'] as const;
const NORMALIZED_KEYS = ['severity', ...CONTENT_KEYS] as const;

/** Python `AttributeError` from `.get` on a non-dict JSON value. */
export class FindingDeliveryAttributeError extends Error {
  override readonly name: string = 'FindingDeliveryAttributeError';
  /** The Python exception class the differential compares. */
  readonly pythonError = 'AttributeError';

  constructor(message: string) {
    super(message);
  }
}

/** Python `dict.get` on the exact JSON model. */
function pythonGet(object: JsonValue, key: string): JsonValue | undefined {
  if (!(object instanceof JsonObject)) {
    throw new FindingDeliveryAttributeError(
      `'${ledgerPythonTypeName(object)}' object has no attribute 'get'`,
    );
  }
  return object.get(key);
}

function setKeys(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(updates);
  const entries: Array<readonly [string, JsonValue]> = object.entries.map(([key, value]) => [
    key,
    replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
  ]);
  for (const [key, value] of updates) {
    if (!object.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

function removeKey(object: JsonObject, key: string): JsonObject {
  if (!object.has(key)) return object;
  return new JsonObject(object.entries.filter(([name]) => name !== key));
}

/**
 * `finding_delivery.occurrence`: producer, run id and either the vendor id or
 * the five content fields, hashed with Python canonical JSON.
 */
export function findingOccurrence(producer: string, runId: string, finding: JsonValue): string {
  const vendor = pythonGet(finding, 'source_id');
  const identity: Array<readonly [string, JsonValue]> = [
    ['producer', producer],
    ['run_id', runId],
  ];
  if (pythonTruthy(vendor)) {
    identity.push(['vendor_id', vendor as JsonValue]);
  } else {
    for (const key of CONTENT_KEYS) identity.push([key, ledgerSubscript(finding, key)]);
  }
  return ledgerDigestOf(new JsonObject(identity));
}

/**
 * `finding_delivery.normalize`: the immutable finding shape plus the occurrence
 * id. `source_id` is always present, with JSON null when the input omitted it.
 */
export function normalizeFinding(producer: string, runId: string, finding: JsonValue): JsonObject {
  const content: Array<readonly [string, JsonValue]> = [];
  for (const key of NORMALIZED_KEYS) content.push([key, ledgerSubscript(finding, key)]);
  const base = new JsonObject(content);
  const anchorStatus =
    pythonTruthy(base.get('path')) &&
    pythonTruthy(base.get('blob')) &&
    pythonTruthy(base.get('intervals'))
      ? 'verified'
      : 'unverified';
  const value = new JsonObject([
    ...base.entries,
    ['source_id', pythonGet(finding, 'source_id') ?? null],
    ['status', 'untriaged'],
    ['anchor_status', anchorStatus],
  ]);
  return new JsonObject([...value.entries, ['id', findingOccurrence(producer, runId, value)]]);
}

/**
 * The pure half of `_recover_event`.
 *
 * Python reads `event.payload`, then the row's `previous_event_id`, then
 * `event.id`, then `payload.previous_event_id`, then `payload.action` and
 * `payload.evidence`. The order matters for malformed inputs: a missing
 * `finding_id` fails in the driver before the row read, while a missing event
 * `id` fails here after the row exists.
 */
export type FindingRowTransition =
  | { readonly kind: 'apply'; readonly row: JsonObject; readonly eventId: JsonValue }
  | { readonly kind: 'already-applied'; readonly eventId: JsonValue }
  | { readonly kind: 'predecessor-mismatch'; readonly eventId: JsonValue };

export function transitionFindingRow(row: JsonValue, event: JsonValue): FindingRowTransition {
  const payload = ledgerSubscript(event, 'payload');
  const previous = ledgerSubscript(row, 'previous_event_id');
  const eventId = ledgerSubscript(event, 'id');
  if (ledgerValueEqual(previous, eventId)) {
    return { kind: 'already-applied', eventId };
  }
  const eventPrevious = ledgerSubscript(payload, 'previous_event_id');
  if (!ledgerValueEqual(previous, eventPrevious)) {
    return { kind: 'predecessor-mismatch', eventId };
  }

  const action = ledgerSubscript(payload, 'action');
  const evidence = ledgerSubscript(payload, 'evidence');
  if (!(evidence instanceof JsonObject)) {
    throw new FindingDeliveryAttributeError(
      `'${ledgerPythonTypeName(evidence)}' object has no attribute 'get'`,
    );
  }

  let next = setKeys(row as JsonObject, [
    ['status', action],
    ['previous_event_id', eventId],
    ['failure_class', evidence.get('failure_class') ?? null],
  ]);
  next = removeKey(next, 'context_error');

  if (pythonTruthy(evidence.get('recovered_anchor'))) {
    next = setKeys(next, [['recovered_anchor', ledgerSubscript(evidence, 'recovered_anchor')]]);
  }

  if (action === 'delivered') {
    next = setKeys(next, [['receipt', evidence]]);
  } else if (evidence.has('target')) {
    const mappedIntervals = evidence.has('mapped_intervals')
      ? (evidence.get('mapped_intervals') as JsonValue)
      : [];
    next = setKeys(next, [
      ['target_current', ledgerSubscript(evidence, 'target')],
      ['mapped_path', evidence.get('mapped_path') ?? null],
      ['mapped_intervals', mappedIntervals],
    ]);
    // Python's duplicate update is inside this elif. A duplicate event with no
    // target must leave canonical_id untouched.
    if (action === 'duplicate') {
      next = setKeys(next, [['canonical_id', ledgerSubscript(evidence, 'canonical_id')]]);
    }
  }

  return { kind: 'apply', row: next, eventId };
}

/** Python `list.remove`: first element equal under `==`, not identity. */
export function removeFirstEqual(items: JsonValue[], target: JsonValue): void {
  const index = items.findIndex((item) => ledgerValueEqual(item, target));
  if (index < 0) throw new Error('recover removal target disappeared');
  items.splice(index, 1);
}

/** Python `for value in iterable` over the JSON model. */
export function pythonIterable(value: JsonValue): readonly JsonValue[] {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') return [...value];
  if (value instanceof JsonObject) return value.entries.map(([key]) => key);
  throw new LedgerTypeError(`'${ledgerPythonTypeName(value)}' object is not iterable`);
}
