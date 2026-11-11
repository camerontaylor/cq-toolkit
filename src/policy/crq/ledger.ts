/**
 * The pure `review_ledger` contract, in TypeScript.
 *
 * This is the B1 half of the crq port: it decides whether a ledger record is
 * valid, what its canonical bytes and digest are, and whether a replay is a
 * legal extension of the history. It performs no I/O and constructs no
 * publication effect. `apps/crq-python/review_ledger.py` remains the oracle;
 * `test/policy/crq/ledger.test.ts` replays Python-generated vectors recorded
 * in `apps/crq-python/fixtures/crq-ledger-b1/vectors.json`.
 *
 * Runtime state uses the lossless {@link JsonValue} model rather than plain
 * JavaScript objects, because `review_ledger` distinguishes a Python `int`
 * from a `float` (`0` vs `0.0`) and hashes the canonical bytes. Canonical
 * encoding itself stays in `pythonJson` (one implementation shared with the
 * receipt path); this module only consumes it.
 *
 * Deliberately absent: outbox spooling, artifact retention, locking, Git
 * publication and the signer. Owner ruling D1 keeps the signer Python, and the
 * publisher effects remain a later B2 step.
 */
import {
  JsonNumber,
  JsonObject,
  JsonParseError,
  parseJsonValue,
  type JsonValue,
} from './jsonValue.js';
import { REVIEW_LEDGER_SCHEMA } from './ledgerSchema.js';
import {
  PythonJsonError,
  ledgerJsonBytes,
  ledgerJsonDigest,
  ledgerJsonText,
} from './pythonJson.js';
import { PythonSchemaError, pythonSchemaAccepts } from './pythonSchema.js';

export const LEDGER_SCHEMA_VERSION = 'cq.review-ledger/v1';
export const LEDGER_REPOSITORY = 'camerontaylor/cq-toolkit';

const MAX_INTERVAL_LINE = 1_000_000n;

/** `review_ledger.IntegrityError`: publication must stop and be reconciled. */
export class LedgerIntegrityError extends Error {
  override readonly name: string = 'LedgerIntegrityError';
  /** The Python exception class the vector differential compares. */
  readonly pythonError: string = 'IntegrityError';

  constructor(message: string) {
    super(message);
  }
}

/**
 * `KeyError` from a missing mapping key in a retained record that was never
 * schema-validated. `review_ledger.publish` walks retained records directly,
 * so a malformed record can refuse after earlier acknowledgements were
 * written; keeping the Python class lets that prefix survive the port.
 */
export class LedgerKeyError extends LedgerIntegrityError {
  override readonly name = 'LedgerKeyError';
  override readonly pythonError = 'KeyError';

  constructor(key: string) {
    super(`'${key}'`);
  }
}

/**
 * `datetime.strptime`'s failure mode for an exact-shaped timestamp whose
 * fields do not match its format or calendar. `review_ledger` lets this
 * `ValueError` escape, so the port keeps the same class.
 */
export class LedgerTimestampError extends Error {
  override readonly name = 'LedgerTimestampError';
  readonly pythonError = 'ValueError';

  constructor(message: string) {
    super(message);
  }
}

/** `json.JSONDecodeError`: malformed JSON text, not a ledger-integrity refusal. */
export class LedgerJsonDecodeError extends Error {
  override readonly name = 'LedgerJsonDecodeError';
  readonly pythonError = 'JSONDecodeError';

  constructor(message: string) {
    super(message);
  }
}

/** `UnicodeDecodeError`: the byte input is invalid in its detected encoding. */
export class LedgerUnicodeDecodeError extends Error {
  override readonly name = 'LedgerUnicodeDecodeError';
  readonly pythonError = 'UnicodeDecodeError';

  constructor(message: string) {
    super(message);
  }
}

export interface LedgerTimestamp {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

/**
 * `review_ledger.scope`: path -> blob -> credited line numbers.
 *
 * Python keys a dict by the tuple `(path, blob)`. Two nested maps preserve
 * that identity without inventing a separator that a path could contain.
 */
export type LedgerScope = Map<string, Map<string, Set<number>>>;

function fail(message: string): never {
  throw new LedgerIntegrityError(message);
}

function requireObject(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) fail(`${what} must be an object`);
  return value;
}

function field(object: JsonObject, key: string): JsonValue {
  const value = object.get(key);
  if (value === undefined) fail(`missing ${key}`);
  return value;
}

function stringField(object: JsonObject, key: string): string {
  const value = field(object, key);
  if (typeof value !== 'string') fail(`${key} must be a string`);
  return value;
}

function objectField(object: JsonObject, key: string): JsonObject {
  return requireObject(field(object, key), key);
}

function arrayField(object: JsonObject, key: string): JsonValue[] {
  const value = field(object, key);
  if (!Array.isArray(value)) fail(`${key} must be an array`);
  return value;
}

/** Python truthiness for the JSON domain; `NaN` is truthy, `-0.0` is not. */
function pythonTruthy(value: JsonValue | undefined): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (value instanceof JsonNumber) {
    return value.kind === 'int' ? value.integer !== 0n : value.float !== 0;
  }
  if (Array.isArray(value)) return value.length > 0;
  return value.entries.length > 0;
}

function pythonZero(value: JsonValue): boolean {
  return (
    value instanceof JsonNumber && (value.kind === 'int' ? value.integer === 0n : value.float === 0)
  );
}

function digestOf(value: JsonValue): string {
  try {
    return ledgerJsonDigest(value);
  } catch (error) {
    if (error instanceof PythonJsonError) throw new LedgerIntegrityError(error.message);
    throw error;
  }
}

/** `review_ledger.canonical` bytes. */
export function ledgerCanonicalBytes(value: JsonValue): Uint8Array {
  return ledgerJsonBytes(value);
}

/** `review_ledger.canonical` text (UTF-8; may contain non-ASCII scalars). */
export function ledgerCanonicalText(value: JsonValue): string {
  return ledgerJsonText(value);
}

/** `review_ledger.digest`: SHA-256 of the ledger-canonical bytes. */
export function ledgerDigestOf(value: JsonValue): string {
  return digestOf(value);
}

/**
 * `review_ledger.loads`: strict JSON with duplicate keys and every float
 * refused, followed by the canonical-domain checks (integer range, Unicode
 * scalars). Python accepts `NaN`/`Infinity` tokens as non-standard constants
 * and refuses them through `parse_constant`, so those are integrity refusals,
 * not decode errors.
 */
export function ledgerLoads(raw: string | Uint8Array): JsonValue {
  const decoded =
    typeof raw === 'string' ? { text: raw, rawSurrogate: false } : decodeLedgerBytes(raw);
  let rawSurrogate = decoded.rawSurrogate;

  let value: JsonValue;
  try {
    value = parseJsonValue(decoded.text, {
      // Python refuses these while scanning, in document order: `[1.0,]` is
      // an integrity refusal even though the document is also malformed.
      parseFloat: () => fail('unsupported numeric JSON value'),
      parseConstant: () => fail('unsupported numeric JSON value'),
      // Python's object_pairs_hook runs at object close, so a later syntax
      // error outranks a duplicate key that has already been scanned.
      objectPairs: (pairs) => {
        const seen = new Set<string>();
        for (const [key] of pairs) {
          if (seen.has(key)) fail('duplicate JSON key');
          seen.add(key);
        }
        return new JsonObject(pairs);
      },
      // A literal surrogate, or an escape not paired with an escaped low,
      // stays a separate Python character even when JS would merge the two.
      onRawSurrogate: () => {
        rawSurrogate = true;
      },
    });
  } catch (error) {
    if (error instanceof JsonParseError) throw new LedgerJsonDecodeError(error.message);
    throw error;
  }
  // Python keeps raw surrogate code points as separate characters; JavaScript
  // would otherwise merge an adjacent high/low pair into a scalar. Refuse the
  // record the oracle refuses.
  if (rawSurrogate) fail('non-scalar Unicode');
  try {
    ledgerJsonBytes(value);
  } catch (error) {
    if (error instanceof PythonJsonError) throw new LedgerIntegrityError(error.message);
    throw error;
  }
  return value;
}

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;
const UTF16_BE_BOM = [0xfe, 0xff] as const;
const UTF16_LE_BOM = [0xff, 0xfe] as const;
const UTF32_BE_BOM = [0x00, 0x00, 0xfe, 0xff] as const;
const UTF32_LE_BOM = [0xff, 0xfe, 0x00, 0x00] as const;

interface DecodedLedgerText {
  readonly text: string;
  /** The bytes contained a surrogate code point, not a scalar character. */
  readonly rawSurrogate: boolean;
}

/**
 * `json.detect_encoding` for `bytes` input, including its exact precedence:
 * UTF-32/UTF-16/UTF-8 BOMs, then the four-byte heuristics, then the two-byte
 * heuristics. The decoded text is what Python hands to the JSON scanner
 * (`surrogatepass`, so lone surrogates survive to the canonical-domain check).
 */
function decodeLedgerBytes(raw: Uint8Array): DecodedLedgerText {
  if (startsWithBytes(raw, UTF32_BE_BOM)) return decodeUtf32(raw.subarray(4), true);
  if (startsWithBytes(raw, UTF32_LE_BOM)) return decodeUtf32(raw.subarray(4), false);
  if (startsWithBytes(raw, UTF16_BE_BOM)) return decodeUtf16(raw.subarray(2), true);
  if (startsWithBytes(raw, UTF16_LE_BOM)) return decodeUtf16(raw.subarray(2), false);
  if (startsWithBytes(raw, UTF8_BOM)) return decodeUtf8(raw.subarray(3));

  if (raw.length >= 4) {
    if (raw[0] === 0) {
      return raw[1] === 0 ? decodeUtf32(raw, true) : decodeUtf16(raw, true);
    }
    if (raw[1] === 0) {
      return raw[2] === 0 && raw[3] === 0 ? decodeUtf32(raw, false) : decodeUtf16(raw, false);
    }
  } else if (raw.length === 2) {
    if (raw[0] === 0) return decodeUtf16(raw, true);
    if (raw[1] === 0) return decodeUtf16(raw, false);
  }
  return decodeUtf8(raw);
}

function startsWithBytes(bytes: Uint8Array, prefix: readonly number[]): boolean {
  if (bytes.length < prefix.length) return false;
  return prefix.every((byte, index) => bytes[index] === byte);
}

function decodeUtf8(bytes: Uint8Array): DecodedLedgerText {
  let result = '';
  let rawSurrogate = false;
  for (let index = 0; index < bytes.length;) {
    const first = bytes[index] ?? 0;
    if (first < 0x80) {
      result += String.fromCharCode(first);
      index += 1;
      continue;
    }
    let length: number;
    let codePoint: number;
    let minimum: number;
    if (first >= 0xc2 && first <= 0xdf) {
      length = 2;
      codePoint = first & 0x1f;
      minimum = 0x80;
    } else if (first >= 0xe0 && first <= 0xef) {
      length = 3;
      codePoint = first & 0x0f;
      minimum = 0x800;
    } else if (first >= 0xf0 && first <= 0xf4) {
      length = 4;
      codePoint = first & 0x07;
      minimum = 0x10000;
    } else {
      throw new LedgerUnicodeDecodeError('invalid UTF-8 start byte');
    }
    if (index + length > bytes.length) {
      throw new LedgerUnicodeDecodeError('truncated UTF-8 sequence');
    }
    for (let offset = 1; offset < length; offset += 1) {
      const continuation = bytes[index + offset] ?? 0;
      if ((continuation & 0xc0) !== 0x80) {
        throw new LedgerUnicodeDecodeError('invalid UTF-8 continuation byte');
      }
      codePoint = (codePoint << 6) | (continuation & 0x3f);
    }
    if (codePoint < minimum || codePoint > 0x10ffff) {
      throw new LedgerUnicodeDecodeError('invalid UTF-8 code point');
    }
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) rawSurrogate = true;
    result += String.fromCodePoint(codePoint);
    index += length;
  }
  return { text: result, rawSurrogate };
}

function decodeUtf16(bytes: Uint8Array, bigEndian: boolean): DecodedLedgerText {
  if (bytes.length % 2 !== 0) throw new LedgerUnicodeDecodeError('truncated UTF-16');
  let result = '';
  let rawSurrogate = false;
  for (let index = 0; index < bytes.length; index += 2) {
    const unit = readUint16(bytes, index, bigEndian);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 3 < bytes.length) {
      const low = readUint16(bytes, index + 2, bigEndian);
      if (low >= 0xdc00 && low <= 0xdfff) {
        result += String.fromCharCode(unit, low);
        index += 2;
        continue;
      }
    }
    // surrogatepass: an unpaired surrogate is preserved, then refused by the
    // canonical-domain check if it reaches a string value.
    if (unit >= 0xd800 && unit <= 0xdfff) rawSurrogate = true;
    result += String.fromCharCode(unit);
  }
  return { text: result, rawSurrogate };
}

function decodeUtf32(bytes: Uint8Array, bigEndian: boolean): DecodedLedgerText {
  if (bytes.length % 4 !== 0) throw new LedgerUnicodeDecodeError('truncated UTF-32');
  let result = '';
  let rawSurrogate = false;
  for (let index = 0; index < bytes.length; index += 4) {
    const codePoint = bigEndian
      ? readUint16(bytes, index, true) * 0x10000 + readUint16(bytes, index + 2, true)
      : readUint16(bytes, index + 2, false) * 0x10000 + readUint16(bytes, index, false);
    if (codePoint > 0x10ffff) throw new LedgerUnicodeDecodeError('invalid UTF-32 code point');
    if (codePoint >= 0xd800 && codePoint <= 0xdfff) rawSurrogate = true;
    result += String.fromCodePoint(codePoint);
  }
  return { text: result, rawSurrogate };
}

function readUint16(bytes: Uint8Array, index: number, bigEndian: boolean): number {
  const first = bytes[index] ?? 0;
  const second = bytes[index + 1] ?? 0;
  return bigEndian ? (first << 8) | second : (second << 8) | first;
}

const TIMESTAMP_SHAPE =
  /^(\p{Nd}{4})-(\p{Nd}{2})-(\p{Nd}{2})T(\p{Nd}{2}):(\p{Nd}{2}):(\p{Nd}{2})Z$/u;
const TIMESTAMP_MONTH = /^(?:1[0-2]|0[1-9])$/;
const TIMESTAMP_DAY = /^(?:3[01]|0[1-9]|[12]\p{Nd})$/u;
const TIMESTAMP_HOUR = /^(?:2[0-3]|[01]\p{Nd})$/u;
const TIMESTAMP_MINUTE = /^(?:[0-5]\p{Nd})$/u;
const TIMESTAMP_SECOND = /^(?:6[01]|[0-5]\p{Nd})$/u;
const DECIMAL_DIGIT = /\p{Nd}/u;

/**
 * `review_ledger.timestamp`: exactly `YYYY-MM-DDTHH:MM:SSZ`, with Python's
 * Unicode `\d` shape check followed by `strptime`'s field grammar. CPython's
 * `%Y` accepts any Unicode decimal digits, and `%d`/`%H`/`%M`/`%S` accept a
 * Unicode digit after an ASCII `0`/`1`/`2`/`5`; `%m` is ASCII-only.
 */
export function ledgerTimestamp(value: JsonValue | undefined): LedgerTimestamp {
  if (typeof value !== 'string') fail('expected exact UTC timestamp');
  const shape = TIMESTAMP_SHAPE.exec(value);
  if (shape === null || shape[0].length !== value.length) fail('expected exact UTC timestamp');

  const yearField = shape[1] ?? '';
  const monthField = shape[2] ?? '';
  const dayField = shape[3] ?? '';
  const hourField = shape[4] ?? '';
  const minuteField = shape[5] ?? '';
  const secondField = shape[6] ?? '';
  if (
    !TIMESTAMP_MONTH.test(monthField) ||
    !TIMESTAMP_DAY.test(dayField) ||
    !TIMESTAMP_HOUR.test(hourField) ||
    !TIMESTAMP_MINUTE.test(minuteField) ||
    !TIMESTAMP_SECOND.test(secondField)
  ) {
    throw new LedgerTimestampError(`time data '${value}' does not match format`);
  }

  const year = pythonDigits(yearField);
  const month = Number(monthField);
  const day = pythonDigits(dayField);
  const hour = pythonDigits(hourField);
  const minute = pythonDigits(minuteField);
  const second = pythonDigits(secondField);
  if (
    year < 1 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month) ||
    hour > 23 ||
    minute > 59 ||
    second > 59
  ) {
    throw new LedgerTimestampError(`time data '${value}' does not match format`);
  }
  return { year, month, day, hour, minute, second };
}

/** Python `int()` for a string of Unicode decimal digits. */
function pythonDigits(text: string): number {
  let value = 0;
  for (const character of text) value = value * 10 + decimalDigitValue(character);
  return value;
}

/**
 * Unicode `Nd` code points occur in aligned runs of ten, so the digit value is
 * the offset from the start of the character's run.
 */
function decimalDigitValue(character: string): number {
  const codePoint = character.codePointAt(0);
  if (codePoint === undefined) throw new LedgerTimestampError('empty timestamp field');
  if (codePoint >= 0x30 && codePoint <= 0x39) return codePoint - 0x30;
  let start = codePoint;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start -= 1;
  return (codePoint - start) % 10;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    return leap ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * `review_ledger.path`: already-canonical, relative, POSIX, NUL-free and
 * backslash-free. `PurePosixPath` normalisation is observable, so the input
 * must equal its normal form.
 */
export function ledgerPath(value: JsonValue | undefined): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\u0000') ||
    value.includes('\\') ||
    value.startsWith('/') ||
    value === '.'
  ) {
    fail('non-canonical repository path');
  }
  const parts = value.split('/');
  if (parts.some((part) => part.length === 0 || part === '.' || part === '..')) {
    fail('non-canonical repository path');
  }
  return value;
}

/**
 * `review_ledger.intervals`: disjoint, ascending 1-based inclusive ranges.
 * The total and the largest line are bounded so a hostile record cannot make
 * validation allocate unbounded memory.
 */
export function ledgerIntervals(rows: JsonValue): Set<number> {
  if (!Array.isArray(rows)) fail('invalid or overlapping intervals');
  const result = new Set<number>();
  let last = 0n;
  for (const pair of rows) {
    if (!Array.isArray(pair) || pair.length !== 2) fail('invalid or overlapping intervals');
    const start = pair[0];
    const end = pair[1];
    if (
      !(start instanceof JsonNumber) ||
      start.kind !== 'int' ||
      !(end instanceof JsonNumber) ||
      end.kind !== 'int'
    ) {
      fail('invalid or overlapping intervals');
    }
    const first = start.integer ?? 0n;
    const final = end.integer ?? 0n;
    if (
      first <= last ||
      final < first ||
      final > MAX_INTERVAL_LINE ||
      BigInt(result.size) + (final - first) + 1n > MAX_INTERVAL_LINE
    ) {
      fail('invalid or overlapping intervals');
    }
    for (let line = Number(first); line <= Number(final); line += 1) result.add(line);
    last = final;
  }
  return result;
}

/** `review_ledger.scope`: keyed by path and blob, rejecting duplicates. */
export function ledgerScope(rows: JsonValue): LedgerScope {
  if (!Array.isArray(rows)) fail('scope must be an array');
  const result: LedgerScope = new Map();
  for (const row of rows) {
    const object = requireObject(row, 'scope row');
    const name = ledgerPath(field(object, 'path'));
    const blob = stringField(object, 'blob');
    const byBlob = result.get(name);
    if (byBlob !== undefined && byBlob.has(blob)) fail('duplicate scope path/blob');
    const lines = ledgerIntervals(field(object, 'intervals'));
    if (byBlob === undefined) {
      result.set(name, new Map([[blob, lines]]));
    } else {
      byBlob.set(blob, lines);
    }
  }
  return result;
}

/**
 * `review_ledger.event`: derive the id, then validate the resulting record.
 * Key insertion order matches the oracle (`schema`, `event_type`, `source_key`,
 * `occurred_at`, `payload`, `id`) even though canonical encoding sorts.
 */
export function ledgerEvent(
  kind: string,
  sourceKey: string,
  occurredAt: string,
  payload: JsonValue,
): JsonObject {
  const base = new JsonObject([
    ['schema', LEDGER_SCHEMA_VERSION],
    ['event_type', kind],
    ['source_key', sourceKey],
    ['occurred_at', occurredAt],
    ['payload', payload],
  ]);
  const record = new JsonObject([...base.entries, ['id', digestOf(base)]]);
  ledgerValidate(record);
  return record;
}

/** `review_ledger.validate`: schema, timestamp, hash, then event semantics. */
export function ledgerValidate(value: JsonValue): JsonValue {
  let accepted: boolean;
  try {
    accepted = pythonSchemaAccepts(REVIEW_LEDGER_SCHEMA, value).accepted;
  } catch (error) {
    if (error instanceof PythonSchemaError) fail(error.message);
    throw error;
  }
  if (!accepted) fail('event does not match one schema variant');

  const record = requireObject(value, 'event');
  ledgerTimestamp(field(record, 'occurred_at'));
  const withoutId = new JsonObject(record.entries.filter(([key]) => key !== 'id'));
  if (stringField(record, 'id') !== digestOf(withoutId)) fail('event hash mismatch');

  const payload = objectField(record, 'payload');
  switch (stringField(record, 'event_type')) {
    case 'review':
      validateReview(record, payload);
      break;
    case 'finding-event':
      validateFindingEvent(payload);
      break;
    case 'job-state':
      validateJobState(payload);
      break;
    case 'import-result':
      validateImportResult(payload);
      break;
    default:
      fail('unsupported ledger event type');
  }
  return value;
}

function validateReview(record: JsonObject, payload: JsonObject): void {
  const repo = stringField(payload, 'repo');
  const source = objectField(payload, 'source');
  const expected = `${repo}:${stringField(source, 'producer')}:${stringField(source, 'id')}`;
  if (stringField(record, 'source_key') !== expected || stringField(source, 'repo') !== repo) {
    fail('review source identity mismatch');
  }

  const requestedRows = arrayField(payload, 'requested_scope');
  const requested = ledgerScope(requestedRows);
  const input = ledgerScope(arrayField(payload, 'input_scope'));
  const reviewed = ledgerScope(arrayField(payload, 'reviewed_scope'));
  if (digestOf(requestedRows) !== stringField(payload, 'scope_digest')) {
    fail('scope digest mismatch');
  }
  for (const [name, blobs] of reviewed) {
    for (const [blob, lines] of blobs) {
      if (
        !isSubset(lines, requested.get(name)?.get(blob)) ||
        !isSubset(lines, input.get(name)?.get(blob))
      ) {
        fail('mapped review scope exceeds requested/input scope');
      }
    }
  }

  const dispositions = new Map<string, JsonObject>();
  for (const row of arrayField(payload, 'paths')) {
    const object = requireObject(row, 'path disposition');
    const name = ledgerPath(field(object, 'path'));
    if (dispositions.has(name)) fail('duplicate path disposition');
    dispositions.set(name, object);
  }
  for (const [name, blobs] of reviewed) {
    for (const [blob] of blobs) {
      const row = dispositions.get(name);
      const disposition = row?.get('disposition');
      if (
        row === undefined ||
        (disposition !== 'included' && disposition !== 'renamed') ||
        row.get('blob') !== blob
      ) {
        fail('credit on excluded or mismatched path');
      }
    }
  }

  for (const row of arrayField(payload, 'findings')) {
    const finding = requireObject(row, 'finding');
    const path = field(finding, 'path');
    if (path !== null) ledgerPath(path);
    const intervals = ledgerIntervals(field(finding, 'intervals'));
    if (finding.get('anchor_status') === 'verified') {
      if (
        !pythonTruthy(finding.get('path')) ||
        !pythonTruthy(finding.get('blob')) ||
        intervals.size === 0
      ) {
        fail('verified finding requires exact anchor');
      }
    }
  }

  if (payload.get('outcome') === 'completed' && !ledgerCreditable(record)) {
    fail('completed review lacks authenticated scoped completion');
  }
}

function isSubset(subset: ReadonlySet<number>, superset: ReadonlySet<number> | undefined): boolean {
  if (superset === undefined) return subset.size === 0;
  for (const line of subset) if (!superset.has(line)) return false;
  return true;
}

function validateFindingEvent(payload: JsonObject): void {
  const evidence = objectField(payload, 'evidence');
  if (!pythonTruthy(evidence)) fail('finding disposition requires evidence');
  const action = stringField(payload, 'action');
  if (
    (action === 'fixed' || action === 'already-fixed') &&
    !(pythonTruthy(evidence.get('fixing_commit')) && pythonTruthy(evidence.get('verification')))
  ) {
    fail('fixed disposition requires fixing and verification evidence');
  }
  if (
    action === 'delivered' &&
    !(pythonTruthy(evidence.get('acknowledgement')) && pythonTruthy(evidence.get('repair_task')))
  ) {
    fail('delivery requires durable acknowledgement/task');
  }
  if (
    action === 'confirmed' &&
    !(pythonTruthy(evidence.get('target')) && pythonTruthy(evidence.get('anchor_verified')))
  ) {
    fail('confirmed finding requires current-tip anchor evidence');
  }
}

function validateJobState(payload: JsonObject): void {
  if (
    stringField(payload, 'state') === 'quarantine-released' &&
    !pythonTruthy(payload.get('operator'))
  ) {
    fail('quarantine release requires operator');
  }
  const next = field(payload, 'next_eligible_at');
  if (next !== null) ledgerTimestamp(next);
}

function validateImportResult(payload: JsonObject): void {
  const result = stringField(payload, 'result');
  if (result === 'credited' && !pythonTruthy(field(payload, 'review_id'))) {
    fail('import disposition lacks referenced review');
  }
  if (result === 'duplicate' && !pythonTruthy(field(payload, 'duplicate_id'))) {
    fail('import disposition lacks referenced review');
  }
}

function ledgerNumberEqual(left: JsonNumber, right: JsonNumber): boolean {
  if (left.kind === 'int' && right.kind === 'int') return left.integer === right.integer;
  if (left.kind === 'float' && right.kind === 'float') {
    const a = left.float;
    const b = right.float;
    return a !== null && b !== null && !Number.isNaN(a) && !Number.isNaN(b) && a === b;
  }
  const integer = left.kind === 'int' ? left.integer : right.integer;
  const float = left.kind === 'float' ? left.float : right.float;
  if (integer === null || float === null || !Number.isFinite(float) || !Number.isInteger(float)) {
    return false;
  }
  return BigInt(float) === integer;
}

/**
 * Python `==` for JSON-shaped ledger values, used where Python compares
 * parsed records rather than canonical bytes.
 *
 * Numbers compare by value, so `1 == 1.0`; booleans compare to their integer
 * value, so `True == 1`; mappings ignore key order while sequences keep it.
 * `review_ledger.loads` rejects duplicate keys, so object entries are unique.
 */
export function ledgerValueEqual(left: JsonValue, right: JsonValue): boolean {
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    const leftNumber = typeof left === 'boolean' ? JsonNumber.int(left ? 1 : 0) : left;
    const rightNumber = typeof right === 'boolean' ? JsonNumber.int(right ? 1 : 0) : right;
    if (leftNumber instanceof JsonNumber && rightNumber instanceof JsonNumber) {
      return ledgerNumberEqual(leftNumber, rightNumber);
    }
    return typeof left === 'boolean' && typeof right === 'boolean' && left === right;
  }
  if (left instanceof JsonNumber || right instanceof JsonNumber) {
    if (!(left instanceof JsonNumber) || !(right instanceof JsonNumber)) return false;
    return ledgerNumberEqual(left, right);
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
      return false;
    }
    return left.every((value, index) => ledgerValueEqual(value, right[index] as JsonValue));
  }
  if (left instanceof JsonObject || right instanceof JsonObject) {
    if (!(left instanceof JsonObject) || !(right instanceof JsonObject)) return false;
    if (left.entries.length !== right.entries.length) return false;
    return left.entries.every(([key, value]) => {
      if (!right.has(key)) return false;
      return ledgerValueEqual(value, right.get(key) as JsonValue);
    });
  }
  return left === right;
}

/** `review_ledger.creditable`: the only completion authority for a review. */
export function ledgerCreditable(value: JsonValue): boolean {
  if (!(value instanceof JsonObject) || value.get('event_type') !== 'review') return false;
  const payload = value.get('payload');
  if (!(payload instanceof JsonObject)) return false;
  const source = payload.get('source');
  const completion = payload.get('completion');
  if (!(source instanceof JsonObject) || !(completion instanceof JsonObject)) return false;

  const type = source.get('type');
  const producer = source.get('producer');
  const producerMatches =
    (type === 'crq-run' && producer === 'crq-runner-app') ||
    (type === 'github-review' && producer === 'coderabbitai[bot]');
  const exitCode = completion.get('exit_code');
  return (
    payload.get('outcome') === 'completed' &&
    producerMatches &&
    source.get('authenticated') === true &&
    completion.get('terminal') === true &&
    completion.get('skipped') === false &&
    completion.get('scope_verified') === true &&
    exitCode !== undefined &&
    pythonZero(exitCode) &&
    !pythonTruthy(completion.get('errors'))
  );
}

/** `review_ledger.record_path`: `records/<YYYY>/<MM>/<id>.json`. */
export function ledgerRecordPath(value: JsonValue): string {
  const record = requireObject(value, 'record');
  const timestamp = ledgerTimestamp(field(record, 'occurred_at'));
  const id = stringField(record, 'id');
  const year = String(timestamp.year).padStart(4, '0');
  const month = String(timestamp.month).padStart(2, '0');
  return `records/${year}/${month}/${id}.json`;
}

/**
 * `review_ledger.validate_sequence`: replay validation. Returns the accepted
 * id -> record map, exactly as the oracle does; a repeated id is idempotent,
 * a conflicting source key or a forked finding chain is an integrity error.
 */
export function ledgerValidateSequence(values: readonly JsonValue[]): Map<string, JsonValue> {
  const sources = new Map<string, string>();
  const ids = new Map<string, JsonValue>();
  const reviews = new Set<string>();
  const findings = new Map<string, string>();
  const tips = new Map<string, string | null>();

  for (const value of values) {
    ledgerValidate(value);
    const record = requireObject(value, 'record');
    const key = stringField(record, 'source_key');
    const ident = stringField(record, 'id');

    const existing = sources.get(key);
    if (existing !== undefined && existing !== ident) fail('source evidence conflict');
    if (ids.has(ident)) continue;
    sources.set(key, ident);
    ids.set(ident, value);

    const payload = objectField(record, 'payload');
    switch (stringField(record, 'event_type')) {
      case 'review': {
        reviews.add(ident);
        for (const row of arrayField(payload, 'findings')) {
          const finding = requireObject(row, 'finding');
          const findingId = stringField(finding, 'id');
          if (findings.has(findingId)) fail('finding occurrence collision');
          findings.set(findingId, ident);
          tips.set(findingId, null);
        }
        break;
      }
      case 'finding-event': {
        const findingId = stringField(payload, 'finding_id');
        const reviewId = stringField(payload, 'review_id');
        const previous = payload.get('previous_event_id');
        if (previous === undefined) fail('missing previous_event_id');
        if (
          findings.get(findingId) !== reviewId ||
          !tips.has(findingId) ||
          tips.get(findingId) !== previous
        ) {
          fail('missing finding or stale/forked predecessor');
        }
        tips.set(findingId, ident);
        break;
      }
      case 'import-result': {
        const linked =
          payload.get('result') === 'credited'
            ? payload.get('review_id')
            : payload.get('duplicate_id');
        if (pythonTruthy(linked) && (typeof linked !== 'string' || !reviews.has(linked))) {
          fail('import references missing review');
        }
        break;
      }
      default:
        break;
    }
  }
  return ids;
}

/** `review_ledger.independent_import`: a non-crediting import outcome. */
export function independentImport(value: JsonValue): boolean {
  if (!(value instanceof JsonObject)) return false;
  const payload = value.get('payload');
  if (!(payload instanceof JsonObject)) return false;
  if (requiredKey(value, 'event_type') !== 'import-result') return false;
  const result = requiredKey(payload, 'result');
  if (result instanceof JsonObject || Array.isArray(result)) {
    throw new LedgerIntegrityError('import result is not hashable');
  }
  if (result !== 'unverified' && result !== 'rejected') return false;
  if (requiredKey(payload, 'review_id') !== null) return false;
  return requiredKey(payload, 'duplicate_id') === null;
}

/** `review_ledger.initial_inventory_enrollment`: a first, distinct enrollment. */
export function initialInventoryEnrollment(value: JsonValue): boolean {
  if (!(value instanceof JsonObject)) return false;
  const payload = value.get('payload');
  if (!(payload instanceof JsonObject)) return false;
  if (requiredKey(value, 'event_type') !== 'job-state') return false;
  // Python's `and` chain short-circuits, so each key is read only after the
  // previous field matched. A malformed later field must refuse at this
  // record, before the planner can acknowledge a record that follows it.
  if (requiredKey(payload, 'reason') !== 'inventory enqueue') return false;
  if (requiredKey(payload, 'state') !== 'pending') return false;
  if (!ledgerValueEqual(requiredKey(payload, 'attempt'), ZERO)) return false;
  if (!ledgerValueEqual(requiredKey(payload, 'failures'), ZERO)) return false;
  if (!ledgerValueEqual(requiredKey(payload, 'generation'), ZERO)) return false;
  if (requiredKey(payload, 'next_eligible_at') !== null) return false;
  if (payload.has('operator')) return false;
  const sourceKey = requiredKey(value, 'source_key');
  const jobId = requiredKey(payload, 'job_id');
  if (typeof jobId !== 'string') {
    throw new LedgerIntegrityError('record payload.job_id is not a string');
  }
  return sourceKey === `job:${jobId}:${digestOf(payload)}`;
}

const ZERO = JsonNumber.int(0);

function requiredKey(object: JsonObject, key: string): JsonValue {
  const value = object.get(key);
  if (value === undefined) throw new LedgerKeyError(key);
  return value;
}

/**
 * `review_ledger.independent_batch`: only homogeneous imports or first-ever,
 * distinct inventory enrollments may share a publication commit.
 */
export function independentBatch(
  values: readonly JsonValue[],
  previous: readonly JsonValue[],
): boolean {
  if (values.every((value) => independentImport(value))) return true;
  const seen = new Set<string>();
  for (const value of previous) {
    if (!(value instanceof JsonObject) || value.get('event_type') !== 'job-state') continue;
    const payload = value.get('payload');
    if (payload instanceof JsonObject) {
      const jobId = payload.get('job_id');
      if (typeof jobId === 'string') seen.add(jobId);
    }
  }
  for (const value of values) {
    if (!initialInventoryEnrollment(value)) return false;
    const payload = value instanceof JsonObject ? value.get('payload') : undefined;
    const jobId = payload instanceof JsonObject ? payload.get('job_id') : undefined;
    if (typeof jobId !== 'string' || seen.has(jobId)) return false;
    seen.add(jobId);
  }
  return true;
}
