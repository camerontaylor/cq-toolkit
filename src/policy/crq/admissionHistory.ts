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
 * `appendAdmission` mutates the queue document it is given, exactly like the
 * Python oracle, and records the version marker that tells a later reader which
 * shape the rows have.
 */
import { toPlainJsonDeep } from './jsonValue.js';
import { recordEntries, recordGet, recordHas, type JsonRecordLike } from './queueDoc.js';

/** `admission_history.VERSION`. */
export const ADMISSION_HISTORY_VERSION = 1;

/** `admission_history.LIMIT`: the number of rows the history keeps. */
export const ADMISSION_HISTORY_LIMIT = 256;

/** `admission_history.MARKER`: the queue key recording the row shape. */
export const ADMISSION_HISTORY_MARKER = 'backfill_admission_history_version';

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
  // The oracle returns Python's own containers, so the row is plain JSON: the
  // queue writer re-encodes the same bytes it read.
  return toPlainJsonDeep(result) as Record<string, unknown>;
}

/**
 * `admission_history.append`: record one bounded row and return it.
 *
 * The queue document is mutated in place (the runner owns the document it
 * passes here), and the oldest rows past the limit are dropped.
 */
export function appendAdmission(queue: JsonRecordLike, decision: unknown): unknown {
  const mutable = queue as Record<string, unknown>;
  const existing = recordHas(queue, 'backfill_admissions')
    ? recordGet(queue, 'backfill_admissions')
    : [];
  if (!Array.isArray(existing)) fail('backfill_admissions must be an array');
  const rows = existing as unknown[];
  if (!recordHas(queue, 'backfill_admissions')) mutable['backfill_admissions'] = rows;
  rows.push(summarizeAdmission(decision));
  if (rows.length > ADMISSION_HISTORY_LIMIT) rows.splice(0, rows.length - ADMISSION_HISTORY_LIMIT);
  mutable[ADMISSION_HISTORY_MARKER] = ADMISSION_HISTORY_VERSION;
  return rows[rows.length - 1];
}
