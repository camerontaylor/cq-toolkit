/**
 * Python-compatible JSON bytes for the crq port.
 *
 * Two canonical encodings exist in the Python oracle and they are NOT
 * interchangeable — their bytes are hashed and become receipt/ledger identity:
 *
 * - `review_receipt.canonical`: `json.dumps(value, sort_keys=True,
 *   separators=(',', ':'), ensure_ascii=True)` encoded as UTF-8 (therefore
 *   ASCII). Keys sort by Unicode code point; every non-ASCII code unit is
 *   `\\uXXXX` escaped, including lone surrogates.
 * - `review_ledger.canonical`: RFC 8785 over an integer-only, Unicode-scalar
 *   domain. Keys sort by their UTF-16BE encoding, strings stay UTF-8 (control
 *   characters escaped), floats and integers outside +/-9007199254740991 are
 *   refused, and non-scalar Unicode is an integrity error.
 *
 * `crq_repair.atomic` additionally writes `json.dump(value, indent=2)` plus a
 * newline with ASCII escaping and insertion order. That is the queue-byte
 * encoding, not a canonical digest encoding.
 *
 * {@link parseJsonValue} keeps the int-vs-float lexeme and object order that
 * `JSON.parse` loses; pass its {@link JsonObject}/{@link JsonNumber} values
 * here for exact round trips. Plain JS numbers are accepted too: an integer
 * is a Python int and a non-integer is a Python float, so a constructed `1.0`
 * that must stay a float needs `JsonNumber.float(1)`.
 */
import { createHash } from 'node:crypto';
import { JsonNumber, JsonObject, pythonNumberText, type PythonJsonInput } from './jsonValue.js';

export type { PythonJsonInput } from './jsonValue.js';

export class PythonJsonError extends Error {
  override readonly name: string = 'PythonJsonError';
  /** A Python exception class the vector differential can compare. */
  readonly pythonError: string;

  constructor(message: string, pythonError: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

/** `review_ledger.IntegrityError`: publication must stop. */
export class PythonJsonIntegrityError extends PythonJsonError {
  override readonly name = 'PythonJsonIntegrityError';

  constructor(message: string) {
    super(message, 'IntegrityError');
  }
}

/** A value the chosen Python encoder cannot represent (e.g. a Python `TypeError`). */
export class PythonJsonTypeError extends PythonJsonError {
  override readonly name = 'PythonJsonTypeError';

  constructor(message: string) {
    super(message, 'TypeError');
  }
}

export interface PythonJsonOptions {
  /** Escape every code unit above 0x7e as `\\uXXXX`. */
  asciiOnly: boolean;
  /** Sort object keys (canonical encodings); otherwise preserve insertion order. */
  sortKeys: boolean;
  /** Key sort domain for canonical encodings. */
  keyOrder?: 'code-point' | 'utf16be' | 'insertion';
  /** `json.dump(indent=n)`, or null for the compact separators. */
  indent?: number | null;
  /** Append one `\n` after a top-level value (the atomic queue writer does). */
  trailingNewline?: boolean;
  /**
   * Python's DEFAULT `json.dumps` separators (`", "` / `": "`) instead of the
   * compact `("," / ":")`. Python flips to compact only when `indent` or an
   * explicit `separators=` is given, so `status.md`'s bare `json.dumps`
   * blocks need this; the atomic writers keep the compact join.
   */
  spacedSeparators?: boolean;
  /**
   * `review_ledger.canonical`'s integer-only domain: refuse floats, integers
   * outside the interoperable JSON range, and non-scalar Unicode.
   */
  integerDomain?: boolean;
}

/** Encode one value exactly as the selected Python JSON writer would. */
export function pythonJsonText(value: PythonJsonInput, options: PythonJsonOptions): string {
  const encoder = new Encoder(options);
  const text = encoder.encode(value, 0);
  return options.trailingNewline ? text + '\n' : text;
}

/** UTF-8 bytes of {@link pythonJsonText}; canonical ASCII output is byte-identical. */
export function pythonJson(value: PythonJsonInput, options: PythonJsonOptions): Uint8Array {
  return Buffer.from(pythonJsonText(value, options), 'utf8');
}

/** `review_receipt.canonical` bytes. */
export function receiptJsonBytes(value: PythonJsonInput): Uint8Array {
  return pythonJson(value, {
    asciiOnly: true,
    sortKeys: true,
    keyOrder: 'code-point',
    indent: null,
  });
}

/** `review_receipt.canonical` text (always ASCII by construction). */
export function receiptJsonText(value: PythonJsonInput): string {
  return Buffer.from(receiptJsonBytes(value)).toString('utf8');
}

/** Hex SHA-256 of {@link receiptJsonBytes}, i.e. `review_receipt.digest`. */
export function receiptJsonDigest(value: PythonJsonInput): string {
  return sha256Hex(receiptJsonBytes(value));
}

/** `review_ledger.canonical` bytes. */
export function ledgerJsonBytes(value: PythonJsonInput): Uint8Array {
  return pythonJson(value, {
    asciiOnly: false,
    sortKeys: true,
    keyOrder: 'utf16be',
    indent: null,
    integerDomain: true,
  });
}

/** `review_ledger.canonical` text (UTF-8; may contain non-ASCII scalars). */
export function ledgerJsonText(value: PythonJsonInput): string {
  return Buffer.from(ledgerJsonBytes(value)).toString('utf8');
}

/** Hex SHA-256 of {@link ledgerJsonBytes}, i.e. `review_ledger.digest`. */
export function ledgerJsonDigest(value: PythonJsonInput): string {
  return sha256Hex(ledgerJsonBytes(value));
}

/** `crq_repair.atomic`'s `json.dump(value, indent=2)` plus one trailing newline. */
export function atomicJsonText(value: PythonJsonInput): string {
  return pythonJsonText(value, {
    asciiOnly: true,
    sortKeys: false,
    keyOrder: 'insertion',
    indent: 2,
    trailingNewline: true,
  });
}

/** SHA-256 of arbitrary bytes, lower-case hex. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

interface NormalizedEntry {
  readonly key: string;
  readonly value: PythonJsonInput;
}

class Encoder {
  private readonly asciiOnly: boolean;
  private readonly integerDomain: boolean;
  private readonly spaced: boolean;
  private readonly indent: number | null;

  constructor(private readonly options: PythonJsonOptions) {
    this.asciiOnly = options.asciiOnly;
    this.integerDomain = options.integerDomain === true;
    this.spaced = options.spacedSeparators === true;
    this.indent = options.indent ?? null;
  }

  encode(value: PythonJsonInput, depth: number): string {
    if (value === null) return 'null';
    if (value === true) return 'true';
    if (value === false) return 'false';
    if (typeof value === 'string') return this.encodeString(value);
    if (typeof value === 'bigint') return this.encodeInteger(value);
    if (typeof value === 'number') return this.encodePlainNumber(value);
    if (value instanceof JsonNumber) {
      return value.kind === 'int'
        ? this.encodeInteger(value.integer as bigint)
        : this.encodeFloat(value.float as number);
    }
    if (value instanceof JsonObject) return this.encodeObject(value.entries, depth);
    if (Array.isArray(value)) return this.encodeArray(value, depth);
    if (typeof value === 'object')
      return this.encodePlainObject(value as Record<string, unknown>, depth);
    throw new PythonJsonTypeError(`Object of type ${typeof value} is not JSON serializable`);
  }

  private encodeInteger(value: bigint): string {
    if (this.integerDomain && (value > MAX_INTEROPERABLE_INT || value < -MAX_INTEROPERABLE_INT)) {
      throw new PythonJsonIntegrityError('integer outside interoperable JSON range');
    }
    return value.toString();
  }

  private encodeFloat(value: number): string {
    if (this.integerDomain) {
      throw new PythonJsonIntegrityError('unsupported canonical JSON value');
    }
    return pythonFloatRepr(value);
  }

  private encodePlainNumber(value: number): string {
    if (Object.is(value, -0) || !Number.isInteger(value)) return this.encodeFloat(value);
    if (!Number.isSafeInteger(value)) {
      // JSON.parse would already have rounded this, so exact bytes are not
      // recoverable. Refuse rather than emit a silently different integer.
      throw new PythonJsonTypeError(
        'unsafe JavaScript number: parse with parseJsonValue or pass a BigInt/JsonNumber',
      );
    }
    return this.encodeInteger(BigInt(value));
  }

  private encodeArray(values: readonly unknown[], depth: number): string {
    if (values.length === 0) return '[]';
    const encoded = Array.from({ length: values.length }, (_, index) => {
      if (!(index in values)) throw new PythonJsonTypeError('sparse arrays are not JSON arrays');
      return this.encode(values[index], depth + 1);
    });
    return this.wrap('[', ']', encoded, depth);
  }

  private encodeObject(
    entries: ReadonlyArray<readonly [string, PythonJsonInput]>,
    depth: number,
  ): string {
    const normalized = normalizeEntries(entries, this.options);
    if (normalized.length === 0) return '{}';
    const encoded = normalized.map(
      ({ key, value }) =>
        `${this.encodeString(key)}${this.keyValueSeparator()}${this.encode(value, depth + 1)}`,
    );
    return this.wrap('{', '}', encoded, depth);
  }

  private encodePlainObject(value: Record<string, unknown>, depth: number): string {
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      const name = value.constructor?.name ?? 'unknown';
      throw new PythonJsonTypeError(`object of type '${name}' is not JSON serializable`);
    }
    const entries: Array<readonly [string, unknown]> = [];
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') {
        throw new PythonJsonTypeError('symbol-keyed members are not JSON serializable');
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (descriptor === undefined || !descriptor.enumerable) {
        throw new PythonJsonTypeError(
          `non-enumerable member ${JSON.stringify(key)} is not JSON serializable`,
        );
      }
      entries.push([key, descriptor.value]);
    }
    return this.encodeObject(entries, depth);
  }

  /** `":"` compact, `": "` spaced or indented: Python's separator choice. */
  private keyValueSeparator(): string {
    if (this.indent !== null || this.spaced) return ': ';
    return ':';
  }

  private wrap(open: '{' | '[', close: '}' | ']', items: string[], depth: number): string {
    if (this.indent === null) {
      // Python's default `json.dumps` separators put a space after each
      // comma and colon; every canonical writer here stays compact.
      return open + items.join(this.spaced ? ', ' : ',') + close;
    }
    const padding = ' '.repeat(this.indent * (depth + 1));
    const closing = ' '.repeat(this.indent * depth);
    return `${open}\n${padding}${items.join(`,\n${padding}`)}\n${closing}${close}`;
  }

  private encodeString(value: string): string {
    return encodePythonString(value, this.asciiOnly, this.integerDomain);
  }
}

function normalizeEntries(
  entries: ReadonlyArray<readonly [string, PythonJsonInput]>,
  options: PythonJsonOptions,
): NormalizedEntry[] {
  const seen = new Set<string>();
  const normalized = entries.map(([key, value]) => {
    if (seen.has(key)) throw new PythonJsonTypeError(`duplicate object key ${JSON.stringify(key)}`);
    seen.add(key);
    return { key, value };
  });
  if (!options.sortKeys) return normalized;
  if (options.keyOrder === 'utf16be') {
    // JavaScript string `<` compares UTF-16 code units, which IS big-endian
    // byte order; Python sorts ledger keys by exactly those bytes.
    return normalized.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }
  return normalized.sort((a, b) => compareCodePoints(a.key, b.key));
}

/** Python `str` comparison is by Unicode code point, not UTF-16 code unit. */
export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left, (character) => character.codePointAt(0) as number);
  const rightPoints = Array.from(right, (character) => character.codePointAt(0) as number);
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index += 1) {
    const a = leftPoints[index] as number;
    const b = rightPoints[index] as number;
    if (a !== b) return a < b ? -1 : 1;
  }
  return leftPoints.length === rightPoints.length
    ? 0
    : leftPoints.length < rightPoints.length
      ? -1
      : 1;
}

/**
 * Python `json.dumps` string escaping.
 *
 * ASCII mode escapes every code unit above 0x7e, so an astral scalar becomes
 * exactly two `\\uXXXX` escapes and a lone surrogate remains one escape. UTF-8
 * mode leaves scalars literal (including astral pairs) but refuses lone
 * surrogates, matching the UnicodeEncodeError the ledger maps to IntegrityError.
 */
export function encodePythonString(
  value: string,
  asciiOnly: boolean,
  scalarDomain: boolean,
): string {
  let output = '"';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    switch (code) {
      case 0x22:
        output += '\\"';
        continue;
      case 0x5c:
        output += '\\\\';
        continue;
      case 0x08:
        output += '\\b';
        continue;
      case 0x0c:
        output += '\\f';
        continue;
      case 0x0a:
        output += '\\n';
        continue;
      case 0x0d:
        output += '\\r';
        continue;
      case 0x09:
        output += '\\t';
        continue;
      default:
        break;
    }
    if (code < 0x20) {
      output += unicodeEscape(code);
      continue;
    }
    if (isHighSurrogate(code)) {
      const next = value.charCodeAt(index + 1);
      if (isLowSurrogate(next)) {
        if (asciiOnly) {
          output += unicodeEscape(code) + unicodeEscape(next);
        } else {
          output += value[index] as string;
          output += value[index + 1] as string;
        }
        index += 1;
        continue;
      }
      if (scalarDomain) throw new PythonJsonIntegrityError('non-scalar Unicode');
    } else if (isLowSurrogate(code) && scalarDomain) {
      throw new PythonJsonIntegrityError('non-scalar Unicode');
    }
    if (asciiOnly && code > 0x7e) {
      output += unicodeEscape(code);
    } else {
      output += value[index] as string;
    }
  }
  return output + '"';
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

const MAX_INTEROPERABLE_INT = 9007199254740991n;

/**
 * Python 3's `repr(float)` / `json.dumps` float text.
 *
 * Python uses the shortest round-tripping decimal digits (the same digits
 * JavaScript's `toExponential()` produces), then chooses fixed notation for
 * decimal exponents in [-4, 16) and scientific notation otherwise. Scientific
 * exponents always carry a sign and at least two digits. Integer-valued floats
 * always keep `.0` in fixed notation. `-0.0`, `Infinity`, `-Infinity` and `NaN`
 * are spelled as Python's `json.dumps` spells them.
 */
export function pythonFloatRepr(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Infinity) return 'Infinity';
  if (value === -Infinity) return '-Infinity';
  if (Object.is(value, -0)) return '-0.0';
  const negative = value < 0;
  const exponential = Math.abs(value).toExponential();
  const match = /^(\d)(?:\.(\d+))?e([+-])(\d+)$/.exec(exponential);
  if (match === null) throw new Error(`unexpected JavaScript exponential form: ${exponential}`);
  const digits = (match[1] as string) + (match[2] ?? '');
  const exponent = (match[3] === '-' ? -1 : 1) * Number(match[4] as string);
  const sign = negative ? '-' : '';
  if (exponent >= -4 && exponent < 16) {
    const point = exponent + 1;
    if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
    if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}.0`;
    return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
  }
  const mantissa = digits.length === 1 ? digits : `${digits[0]}.${digits.slice(1)}`;
  const exponentText = String(Math.abs(exponent)).padStart(2, '0');
  return `${sign}${mantissa}e${exponent < 0 ? '-' : '+'}${exponentText}`;
}

/** Re-exported for callers that only need the exact source lexeme. */
export { pythonNumberText };
