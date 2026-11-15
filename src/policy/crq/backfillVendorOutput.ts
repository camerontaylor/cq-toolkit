/**
 * Vendor review output for backfill completion (`backfill_history.py`):
 * parsing the NDJSON stream, normalising finding line anchors and proving
 * terminal scope. Pure: bytes in, values or a refusal out. No Git, store or
 * clock; the repository-dependent `adapted_terminal_scope` is a separate seam.
 */
import {
  JsonNumber,
  JsonObject,
  JsonParseError,
  parseJsonValue,
  type JsonValue,
} from './jsonValue.js';
import {
  decodeLedgerBytes,
  ledgerCanonicalBytes,
  ledgerScope,
  LedgerIntegrityError,
  LedgerJsonDecodeError,
} from './ledger.js';
import { rangesOf } from './backfillInventory.js';

/** `backfill_history.REVIEWER_FORMATS`: CLI version to its known output format. */
export const REVIEWER_FORMATS: ReadonlyMap<string, string> = new Map([
  ['0.8.2', 'coderabbit-agent-0.8.2'],
  ['0.9.2', 'coderabbit-agent-0.9.2'],
]);

const MAX_ANCHOR_LINE = 1_000_000n;

function refuseNonFinite(): never {
  throw new LedgerIntegrityError('non-finite vendor number');
}

/** Python `bytes.strip()` whitespace: ASCII space, \t, \n, \r, \v, \f. */
function isBlank(line: Uint8Array): boolean {
  return line.every((byte) => byte === 0x20 || (byte >= 0x09 && byte <= 0x0d));
}

function parseVendorLine(line: Uint8Array): JsonValue {
  const decoded = decodeLedgerBytes(line);
  try {
    return parseJsonValue(decoded.text, {
      // Python's parse_float builds a float and refuses one that overflows.
      parseFloat: (raw) => {
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? JsonNumber.float(parsed, raw) : refuseNonFinite();
      },
      parseConstant: refuseNonFinite,
      objectPairs: (pairs) => {
        const seen = new Set<string>();
        for (const [key] of pairs) {
          if (seen.has(key)) throw new LedgerIntegrityError('duplicate vendor JSON key');
          seen.add(key);
        }
        return new JsonObject(pairs);
      },
    });
  } catch (error) {
    if (error instanceof JsonParseError) throw new LedgerJsonDecodeError(error.message);
    throw error;
  }
}

/**
 * `backfill_history.vendor_events`: one object per non-blank line. A duplicate
 * key at any depth, a non-finite number or a non-object line is an integrity
 * refusal; malformed JSON or bytes keep their Python decode error classes.
 */
export function vendorEvents(raw: Uint8Array): JsonObject[] {
  const events: JsonObject[] = [];
  let start = 0;
  for (let end = 0; end <= raw.length; end += 1) {
    if (end !== raw.length && raw[end] !== 0x0a) continue;
    const line = raw.subarray(start, end);
    start = end + 1;
    if (isBlank(line)) continue;
    const value = parseVendorLine(line);
    if (!(value instanceof JsonObject))
      throw new LedgerIntegrityError('vendor event must be an object');
    events.push(value);
  }
  return events;
}

function anchorLine(value: JsonValue | undefined): number | null {
  if (!(value instanceof JsonNumber) || value.kind !== 'int' || value.integer === null) return null;
  return value.integer >= 1n && value.integer <= MAX_ANCHOR_LINE ? Number(value.integer) : null;
}

/** The line numbers of `[[start, end], ...]`, or null on any malformed pair. */
function intervalLines(rows: JsonValue[]): Set<number> | null {
  const lines = new Set<number>();
  for (const row of rows) {
    if (!Array.isArray(row) || row.length !== 2) return null;
    const start = anchorLine(row[0]);
    const end = anchorLine(row[1]);
    if (start === null || end === null || start > end) return null;
    for (let line = start; line <= end; line += 1) lines.add(line);
  }
  return lines;
}

/**
 * `backfill_history.finding_intervals`: explicit `intervals`, else
 * `startLine`/`endLine`. Any invalid anchor leaves the finding unverified
 * (`[]`), never a partial range.
 */
export function findingIntervals(value: JsonObject): Array<[number, number]> {
  let rows: JsonValue[];
  if (value.has('intervals')) {
    const intervals = value.get('intervals');
    // `for ... in vendor_intervals or []`: only a non-empty list can yield a
    // valid pair; every other non-empty shape fails the pair checks.
    if (!Array.isArray(intervals)) return [];
    rows = intervals;
  } else {
    for (const key of ['startLine', 'endLine']) {
      if (value.has(key) && anchorLine(value.get(key)) === null) return [];
    }
    const first = anchorLine(value.get('startLine'));
    const second = anchorLine(value.get('endLine'));
    const start = first ?? second;
    const end = second ?? first;
    rows =
      start !== null && end !== null
        ? [[JsonNumber.int(Math.min(start, end)), JsonNumber.int(Math.max(start, end))]]
        : [];
  }
  const lines = intervalLines(rows);
  if (lines === null) return [];
  return rangesOf(lines) as Array<[number, number]>;
}

/**
 * `backfill_history.terminal_scope`: only explicit, terminal path/blob/interval
 * evidence bound to `expectedHead` is scoped completion.
 */
export function terminalScope(raw: Uint8Array, expectedHead: string): JsonObject[] {
  const events = vendorEvents(raw);
  if (
    events.length === 0 ||
    events.some((event) => {
      const type = event.get('type');
      return type === 'error' || type === 'action_required';
    })
  )
    throw new LedgerIntegrityError('error or missing terminal evidence');
  const complete = events[events.length - 1] as JsonObject;
  if (complete.get('type') !== 'complete' || complete.get('status') !== 'review_completed')
    throw new LedgerIntegrityError('terminal non-skipped completion absent');
  if (complete.get('head') !== expectedHead)
    throw new LedgerIntegrityError('terminal evidence binds wrong/unknown reviewed head');
  const files = complete.get('reviewedFiles');
  if (!Array.isArray(files) || files.length === 0)
    throw new LedgerIntegrityError('reviewed scope absent');
  const rows: JsonObject[] = [];
  for (const item of files) {
    if (
      !(item instanceof JsonObject) ||
      item.entries.length !== 3 ||
      !item.has('path') ||
      !item.has('blob') ||
      !item.has('intervals')
    )
      throw new LedgerIntegrityError('path-only receipts cannot infer full-file scope');
    rows.push(item);
  }
  ledgerCanonicalBytes(rows); // credit-bearing fields stay in the strict ledger domain
  ledgerScope(rows);
  return rows;
}
