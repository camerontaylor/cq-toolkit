/**
 * Queue-v1 transient-retry classification (`queue_transport`).
 *
 * Only a complete typed proof authorizes a vendor-only continuation or a
 * transient retry. Legacy outcome labels, prose, partial provenance and mixed
 * causes grant nothing: the receipt's immutable bytes carry the proof, and a
 * missing or malformed cause leaves the item blocked with a human decision.
 */
import {
  isJsonInt,
  isJsonRecord,
  jsonIntValue,
  recordEntries,
  recordGet,
  type JsonRecordLike,
} from './queueDoc.js';

export type TransientCategory = 'transport' | 'timeout' | 'interrupted' | 'vendor-rate-limited';

const VENDOR_CAUSE = new Map<string, string>([
  ['source', 'vendor'],
  ['category', 'vendor-rate-limited'],
  ['code', 'rate_limit'],
]);

/** `set(value)` for a lossless or plain JSON object, and Python's set of keys. */
function entryKeys(value: JsonRecordLike): string[] {
  return recordEntries(value).map(([key]) => key);
}

function exactKeys(value: JsonRecordLike, expected: readonly string[]): boolean {
  const keys = entryKeys(value).sort();
  const wanted = [...expected].sort();
  return keys.length === wanted.length && keys.every((key, index) => key === wanted[index]);
}

/** `type(value) is int`: never a float, never a boolean. */
function intOf(value: unknown): number | null {
  if (!isJsonInt(value)) return null;
  const asNumber = Number(jsonIntValue(value));
  return Number.isSafeInteger(asNumber) ? asNumber : null;
}

/** A cause must be exactly `{source, category, code}` with the expected values. */
function causeMatches(cause: unknown, expected: ReadonlyMap<string, string>): boolean {
  if (!isJsonRecord(cause) || !exactKeys(cause, ['source', 'category', 'code'])) return false;
  return [...expected.entries()].every(([key, value]) => recordGet(cause, key) === value);
}

/** A `{source: "queue", category: "unknown", code}` cause; returns its code. */
function queueCauseCode(cause: unknown): string | null {
  if (!isJsonRecord(cause) || !exactKeys(cause, ['source', 'category', 'code'])) return null;
  if (recordGet(cause, 'source') !== 'queue' || recordGet(cause, 'category') !== 'unknown')
    return null;
  const code = recordGet(cause, 'code');
  return typeof code === 'string' ? code : null;
}

/**
 * `queue_transport._vendor_rate_limit`: only a complete all-causes proof can
 * authorize vendor-only continuation.
 */
export function vendorRateLimit(document: JsonRecordLike): boolean {
  const classification = recordGet(document, 'classification');
  if (
    recordGet(document, 'outcome') !== 'rate_limited' ||
    recordGet(document, 'counted') !== false ||
    !isJsonRecord(classification) ||
    recordGet(classification, 'outcome') !== 'rate_limited' ||
    recordGet(classification, 'counted') !== false ||
    ![0, 1].includes(intOf(recordGet(classification, 'exit')) as number) ||
    intOf(recordGet(classification, 'bad_lines')) !== 0
  ) {
    return false;
  }
  const proof = recordGet(classification, 'failure_provenance');
  if (!isJsonRecord(proof) || !exactKeys(proof, ['version', 'complete', 'causes'])) return false;
  if (intOf(recordGet(proof, 'version')) !== 1 || recordGet(proof, 'complete') !== true)
    return false;
  const causes = recordGet(proof, 'causes');
  if (!Array.isArray(causes) || causes.length === 0) return false;
  return causes.every((cause) => causeMatches(cause, VENDOR_CAUSE));
}

const TRANSPORT_CODES = new Set(['network_error', 'transport_error', 'unexpected-exit']);
const TERMINAL_CODES = new Set(['unexpected-exit', 'nonterminal-review']);
const EXIT_RANGES: Record<string, readonly number[]> = {
  transport: [0, 1],
  timeout: [124],
  interrupted: [-2, -9, -15, 130, 137, 143],
};

/**
 * `queue_transport._retry_transient`: a typed, complete, exact-cause proof for
 * one retry category, or `null` when the receipt grants no authority.
 */
export function retryTransient(document: JsonRecordLike): TransientCategory | null {
  if (vendorRateLimit(document)) return 'vendor-rate-limited';
  const classification = recordGet(document, 'classification');
  if (
    !isJsonRecord(classification) ||
    recordGet(document, 'counted') !== false ||
    recordGet(classification, 'counted') !== false ||
    recordGet(document, 'outcome') !== recordGet(classification, 'outcome') ||
    (recordGet(classification, 'outcome') !== 'error' &&
      recordGet(classification, 'outcome') !== 'interrupted') ||
    intOf(recordGet(classification, 'bad_lines')) !== 0
  ) {
    return null;
  }
  const exit = intOf(recordGet(classification, 'exit'));
  if (exit === null) return null;
  const typed = recordGet(classification, 'retry_transient');
  if (
    !isJsonRecord(typed) ||
    !exactKeys(typed, ['version', 'category']) ||
    intOf(recordGet(typed, 'version')) !== 1
  ) {
    return null;
  }
  const category = recordGet(typed, 'category');
  if (
    typeof category !== 'string' ||
    !Object.prototype.hasOwnProperty.call(EXIT_RANGES, category)
  ) {
    return null;
  }
  if (!(EXIT_RANGES[category] as readonly number[]).includes(exit)) return null;
  const proof = recordGet(classification, 'failure_provenance');
  if (
    !isJsonRecord(proof) ||
    intOf(recordGet(proof, 'version')) !== 1 ||
    recordGet(proof, 'complete') !== true
  ) {
    return null;
  }
  const causes = recordGet(proof, 'causes');
  if (!Array.isArray(causes) || causes.length === 0) return null;
  const codes = category === 'transport' ? TRANSPORT_CODES : TERMINAL_CODES;
  const causeCodes = causes.map((cause) => queueCauseCode(cause));
  if (causeCodes.some((code) => code === null || !codes.has(code))) return null;
  if (
    category === 'transport' &&
    !causeCodes.some((code) => code === 'network_error' || code === 'transport_error')
  ) {
    return null;
  }
  return category as TransientCategory;
}

/** `queue_transport`'s typed vendor reason document. */
export function vendorRateLimitReason(): Record<string, string> {
  return { source: 'vendor', category: 'vendor-rate-limited', code: 'rate_limit' };
}
