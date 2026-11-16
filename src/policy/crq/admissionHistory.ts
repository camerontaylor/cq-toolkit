/**
 * Bounded admission diagnostics (`admission_history`).
 *
 * Reservations remain authoritative in `backfill_reservations`; this history is
 * a diagnostic echo, never a second source of truth. Two properties matter:
 *
 * - the row is bounded. An admission decision carries a full usage observation
 *   and the whole reservation table; the history keeps only the five decision
 *   fields, the three observation fields an operator can act on, and a count per
 *   quota state;
 * - retention is bounded. Appending trims the oldest rows past
 *   {@link ADMISSION_HISTORY_LIMIT}, so the queue cannot grow without limit
 *   under ordinary work.
 *
 * The oracle mutates its queue dictionary in place. This port takes the lossless
 * queue document and returns the updated one, the same functional shape
 * `queueReceipt.enrollMergedCurrent` uses: a `JsonObject` is immutable, so an
 * in-place write would update a property no reader or writer can see. The
 * returned document carries the version marker that tells a later reader which
 * shape the rows have.
 */
import { JsonNumber, JsonObject, toPlainJsonDeep } from './jsonValue.js';
import {
  fromPlainJson,
  recordEntries,
  recordGet,
  recordHas,
  withObjectKeys,
  type JsonRecordLike,
} from './queueDoc.js';

/** `admission_history.VERSION`. */
export const ADMISSION_HISTORY_VERSION = 1;

/** `admission_history.LIMIT`: the number of rows the history keeps. */
export const ADMISSION_HISTORY_LIMIT = 256;

/** `admission_history.MARKER`: the queue key recording the row shape. */
export const ADMISSION_HISTORY_MARKER = 'backfill_admission_history_version';

/** The queue key holding the rows (`queue.setdefault("backfill_admissions")`). */
const ADMISSION_ROWS = 'backfill_admissions';

/** The decision fields a summarized row keeps, in the oracle's order. */
const DECISION_FIELDS = [
  'at',
  'item',
  'ordinary_eligible',
  'effective_remaining',
  'decision',
] as const;

/** The observation fields a summarized row keeps, in the oracle's order. */
const OBSERVATION_FIELDS = ['successful', 'observed_at', 'remaining'] as const;

/** A history row cannot be built from the decision it was handed. */
export class AdmissionHistoryError extends Error {
  override readonly name: string = 'AdmissionHistoryError';

  constructor(message: string) {
    super(message);
  }
}

function fail(message: string): never {
  throw new AdmissionHistoryError(message);
}

function asDoc(value: unknown, what: string): JsonRecordLike {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as JsonRecordLike;
}

/** `admission_history.summarize`: the bounded diagnostic projection of a decision. */
export function summarizeAdmission(decision: unknown): Record<string, unknown> {
  const document = asDoc(decision, 'admission decision');
  const rawObservation = recordGet(document, 'observation');
  // Python's `is not None` test: an absent key and a JSON null both stay null,
  // which the canonical writer emits as `null` (never an omitted member).
  const observation =
    rawObservation === undefined || rawObservation === null
      ? null
      : (() => {
          const source = asDoc(rawObservation, 'observation');
          return Object.fromEntries(
            OBSERVATION_FIELDS.filter((key) => recordHas(source, key)).map((key) => [
              key,
              recordGet(source, key),
            ]),
          );
        })();
  const counts = new Map<string, number>();
  const rawHolds = recordHas(document, 'reservations') ? recordGet(document, 'reservations') : {};
  for (const [, hold] of recordEntries(asDoc(rawHolds, 'reservations'))) {
    const row = asDoc(hold, 'reservation');
    const state = recordHas(row, 'quota_state') ? recordGet(row, 'quota_state') : 'unknown';
    if (typeof state !== 'string') fail('reservation quota_state must be a string');
    counts.set(state, (counts.get(state) ?? 0) + 1);
  }
  const reservationCounts = recordHas(document, 'reservation_counts')
    ? recordGet(document, 'reservation_counts')
    : Object.fromEntries(counts);
  const result: Record<string, unknown> = {};
  for (const key of DECISION_FIELDS) {
    if (recordHas(document, key)) result[key] = recordGet(document, key);
  }
  result['observation'] = observation;
  result['reservation_counts'] = reservationCounts;
  // The oracle returns Python's own containers, so the summary is plain JSON;
  // `appendAdmission` mints it back into the lossless model for the queue.
  return toPlainJsonDeep(result) as Record<string, unknown>;
}

/** The queue document after an append, and the row that was recorded. */
export interface AdmissionAppendResult {
  readonly queue: JsonObject;
  readonly row: JsonObject;
}

/**
 * `admission_history.append`: record one bounded row.
 *
 * The caller keeps the returned queue (the oracle mutates in place); the oldest
 * rows past the limit are dropped.
 */
export function appendAdmission(queue: JsonObject, decision: unknown): AdmissionAppendResult {
  const existing = recordHas(queue, ADMISSION_ROWS) ? recordGet(queue, ADMISSION_ROWS) : [];
  if (!Array.isArray(existing)) fail('backfill_admissions must be an array');
  const summary = fromPlainJson(summarizeAdmission(decision));
  if (!(summary instanceof JsonObject)) fail('admission summary must be an object');
  const combined: unknown[] = [...(existing as unknown[]), summary];
  const rows: JsonObject[] = [];
  for (const row of combined.slice(-ADMISSION_HISTORY_LIMIT)) {
    if (!(row instanceof JsonObject)) fail('admission row must be an object');
    rows.push(row);
  }
  return {
    queue: withObjectKeys(queue, [
      [ADMISSION_ROWS, rows],
      [ADMISSION_HISTORY_MARKER, JsonNumber.int(ADMISSION_HISTORY_VERSION)],
    ]),
    row: summary,
  };
}
