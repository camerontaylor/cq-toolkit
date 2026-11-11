/**
 * Lossless JSON values for the crq TypeScript port.
 *
 * `JSON.parse` erases two distinctions the Python oracle depends on:
 *
 * - `1` and `1.0` both become the JS number `1`, but Python's state validators
 *   use `type(value) is int` and `json.dumps` renders the two differently.
 * - integers above `Number.MAX_SAFE_INTEGER` round to the nearest double, while
 *   Python keeps the exact integer and writes it in full.
 *
 * It also cannot report source key order for integer-like keys. This module
 * parses the JSON grammar directly and keeps numbers as {@link JsonNumber}
 * (exact lexeme, integer/float classification, exact BigInt for integers) and
 * objects as {@link JsonObject} (ordered entries). The Python-sized number and
 * object model is the input to `pythonJson` and the state-schema validator;
 * {@link toPlainJson} materialises ordinary JavaScript values for zod.
 *
 * This is deliberately a JSON parser, not a JSON5/YAML reader: only the
 * RFC 8259 grammar is accepted. Python's non-finite constants are refused by
 * default and exposed through the `parseConstant` hook, which lets
 * `review_ledger.loads` reproduce Python's in-document refusal order.
 * Duplicate keys are the caller's choice because Python's default
 * `json.loads` keeps the last value (and the first key position), while
 * `review_ledger.loads` refuses them.
 */

/** A Python `int` or `float`, keeping the exact source lexeme. */
export class JsonNumber {
  readonly kind: 'int' | 'float';
  /** The exact source lexeme, including a leading `-`. */
  readonly raw: string;
  /** Exact Python integer value; null for floats. */
  readonly integer: bigint | null;
  /** Python float value; null for integers. */
  readonly float: number | null;

  private constructor(
    kind: 'int' | 'float',
    raw: string,
    integer: bigint | null,
    float: number | null,
  ) {
    this.kind = kind;
    this.raw = raw;
    this.integer = integer;
    this.float = float;
  }

  /** Construct a Python `int` from a BigInt, safe integer or decimal string. */
  static int(value: bigint | number | string): JsonNumber {
    if (typeof value === 'bigint') return new JsonNumber('int', value.toString(), value, null);
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw new JsonValueError('integer must be a safe JavaScript integer or a BigInt');
      }
      return new JsonNumber('int', String(value), BigInt(value), null);
    }
    if (!/^-?(?:0|[1-9][0-9]*)$/.test(value)) {
      throw new JsonValueError(`not a Python integer literal: ${JSON.stringify(value)}`);
    }
    return new JsonNumber('int', value, BigInt(value), null);
  }

  /** Construct a Python `float`, including infinities and NaN. */
  static float(value: number, raw = pythonNumberText(value)): JsonNumber {
    return new JsonNumber('float', raw, null, value);
  }
}

/** A Python `dict` with insertion order retained for every key, including numeric keys. */
export class JsonObject {
  readonly entries: ReadonlyArray<readonly [string, JsonValue]>;

  constructor(entries: ReadonlyArray<readonly [string, JsonValue]>) {
    this.entries = entries;
  }

  has(key: string): boolean {
    return this.entries.some(([name]) => name === key);
  }

  get(key: string): JsonValue | undefined {
    return this.entries.find(([name]) => name === key)?.[1];
  }
}

/** A JSON value that survives a Python round trip without numeric or order loss. */
export type JsonValue = null | boolean | string | JsonNumber | JsonValue[] | JsonObject;

/** Input accepted by the Python-compatible serialiser. */
export type PythonJsonInput = unknown;

export class JsonValueError extends Error {
  override readonly name = 'JsonValueError';
}

export class JsonParseError extends SyntaxError {
  override readonly name = 'JsonParseError';
  readonly position: number;

  constructor(message: string, position: number) {
    super(`${message} at byte offset ${String(position)}`);
    this.position = position;
  }
}

export interface ParseJsonOptions {
  /**
   * `last` (Python `json.loads`): keep the first key position and the last
   * value. `error` (review_ledger.loads): reject a duplicate key.
   */
  duplicates?: 'last' | 'error';
  /**
   * Python `parse_float`: called as soon as a float literal is scanned, so a
   * refusing callback wins over any later syntax error.
   */
  parseFloat?: (raw: string) => JsonValue;
  /**
   * Python `parse_constant`: called for `NaN`, `Infinity` and `-Infinity` as
   * soon as the token is scanned.
   */
  parseConstant?: (raw: string) => JsonValue;
  /**
   * Python `object_pairs_hook`: called with the source-ordered pairs when an
   * object closes. Supplying it disables the `duplicates` policy because the
   * hook owns the key policy.
   */
  objectPairs?: (pairs: ReadonlyArray<readonly [string, JsonValue]>) => JsonValue;
  /**
   * Called when the source contains a raw surrogate code unit that is not an
   * escaped high/low pair. Python keeps such code units as separate
   * characters; JavaScript would otherwise merge an adjacent high/low pair
   * into a scalar.
   */
  onRawSurrogate?: () => void;
}

/** Parse RFC 8259 JSON without losing int-vs-float or object key order. */
export function parseJsonValue(text: string, options: ParseJsonOptions = {}): JsonValue {
  return new Parser(text, options).parse();
}

/** The Python `repr(float)` text, used by `JsonNumber.float` and the serialiser. */
export function pythonNumberText(value: number): string {
  if (Number.isNaN(value)) return 'nan';
  if (value === Infinity) return 'inf';
  if (value === -Infinity) return '-inf';
  return Object.is(value, -0) ? '-0.0' : String(value);
}

class Parser {
  private index = 0;

  constructor(
    private readonly text: string,
    private readonly options: ParseJsonOptions,
  ) {}

  parse(): JsonValue {
    this.skipWhitespace();
    const value = this.parseValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) this.fail('unexpected trailing data');
    return value;
  }

  private parseValue(): JsonValue {
    const character = this.text[this.index];
    switch (character) {
      case '{':
        return this.parseObject();
      case '[':
        return this.parseArray();
      case '"':
        return this.parseString();
      case 't':
        return this.parseKeyword('true', true);
      case 'f':
        return this.parseKeyword('false', false);
      case 'n':
        return this.parseKeyword('null', null);
      case 'N':
        return this.parseNonFinite('NaN');
      case 'I':
        return this.parseNonFinite('Infinity');
      case undefined:
        return this.fail('expected a JSON value');
      default:
        if (this.text.startsWith('-Infinity', this.index)) {
          return this.parseNonFinite('-Infinity');
        }
        if (
          character === '-' ||
          (character !== undefined && character >= '0' && character <= '9')
        ) {
          return this.parseNumber();
        }
        return this.fail('expected a JSON value');
    }
  }

  private parseObject(): JsonValue {
    this.index += 1; // {
    const entries: Array<[string, JsonValue]> = [];
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return this.finishObject(entries);
    }
    for (;;) {
      this.skipWhitespace();
      if (this.text[this.index] !== '"') this.fail('expected an object key');
      const key = this.parseString();
      this.skipWhitespace();
      if (this.text[this.index] !== ':') this.fail("expected ':'");
      this.index += 1;
      this.skipWhitespace();
      const value = this.parseValue();
      entries.push([key, value]);
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === '}') {
        this.index += 1;
        return this.finishObject(entries);
      }
      if (separator !== ',') this.fail("expected ',' or '}'");
      this.index += 1;
    }
  }

  private finishObject(entries: Array<[string, JsonValue]>): JsonValue {
    if (this.options.objectPairs !== undefined) return this.options.objectPairs(entries);
    if ((this.options.duplicates ?? 'last') === 'last') {
      const merged: Array<[string, JsonValue]> = [];
      const positions = new Map<string, number>();
      for (const [key, value] of entries) {
        const existing = positions.get(key);
        if (existing === undefined) {
          positions.set(key, merged.length);
          merged.push([key, value]);
        } else {
          merged[existing] = [key, value];
        }
      }
      return new JsonObject(merged);
    }
    // Python's object_pairs_hook runs when the object closes, so a syntax
    // error after the repeated key but before `}` wins over the duplicate.
    const seen = new Set<string>();
    for (const [key] of entries) {
      if (seen.has(key)) this.fail(`duplicate key ${JSON.stringify(key)}`);
      seen.add(key);
    }
    return new JsonObject(entries);
  }

  private parseArray(): JsonValue[] {
    this.index += 1; // [
    const values: JsonValue[] = [];
    this.skipWhitespace();
    if (this.text[this.index] === ']') {
      this.index += 1;
      return values;
    }
    for (;;) {
      values.push(this.parseValue());
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === ']') {
        this.index += 1;
        return values;
      }
      if (separator !== ',') this.fail("expected ',' or ']'");
      this.index += 1;
      this.skipWhitespace();
    }
  }

  private parseString(): string {
    this.index += 1; // opening quote
    let result = '';
    let chunkStart = this.index;
    for (;;) {
      const character = this.text[this.index];
      if (character === undefined) this.fail('unterminated string');
      if (character === '"') {
        const chunk = this.text.slice(chunkStart, this.index);
        this.checkRawSurrogates(chunk);
        result += chunk;
        this.index += 1;
        return result;
      }
      if (character === '\\') {
        const chunk = this.text.slice(chunkStart, this.index);
        this.checkRawSurrogates(chunk);
        result += chunk;
        this.index += 1;
        result += this.parseEscape();
        chunkStart = this.index;
        continue;
      }
      const code = character.charCodeAt(0);
      if (code < 0x20) this.fail('unescaped control character in string');
      this.index += 1;
    }
  }

  private checkRawSurrogates(chunk: string): void {
    if (this.options.onRawSurrogate === undefined) return;
    for (let index = 0; index < chunk.length; index += 1) {
      const unit = chunk.charCodeAt(index);
      if (unit >= 0xd800 && unit <= 0xdbff) {
        const next = chunk.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) {
          index += 1;
          continue;
        }
        this.options.onRawSurrogate();
        return;
      }
      if (unit >= 0xdc00 && unit <= 0xdfff) {
        this.options.onRawSurrogate();
        return;
      }
    }
  }

  private parseEscape(): string {
    const escape = this.text[this.index];
    this.index += 1;
    switch (escape) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u': {
        const digits = this.text.slice(this.index, this.index + 4);
        if (!/^[0-9a-fA-F]{4}$/.test(digits)) this.fail('invalid \\u escape');
        this.index += 4;
        const code = Number.parseInt(digits, 16);
        if (code >= 0xd800 && code <= 0xdbff) {
          const low = this.parseEscapedLowSurrogate();
          if (low !== null) {
            return String.fromCodePoint(0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00));
          }
          this.options.onRawSurrogate?.();
          return String.fromCharCode(code);
        }
        if (code >= 0xdc00 && code <= 0xdfff) this.options.onRawSurrogate?.();
        return String.fromCharCode(code);
      }
      case undefined:
        return this.fail('invalid escape');
      default:
        return this.fail('invalid escape');
    }
  }

  /** Python's json scanner joins an escaped high surrogate with an escaped low. */
  private parseEscapedLowSurrogate(): number | null {
    if (this.text[this.index] !== '\\' || this.text[this.index + 1] !== 'u') return null;
    const digits = this.text.slice(this.index + 2, this.index + 6);
    if (!/^[0-9a-fA-F]{4}$/.test(digits)) return null;
    const code = Number.parseInt(digits, 16);
    if (code < 0xdc00 || code > 0xdfff) return null;
    this.index += 6;
    return code;
  }

  private parseNumber(): JsonValue {
    const start = this.index;
    if (this.text[this.index] === '-') this.index += 1;
    if (this.text[this.index] === '0') {
      this.index += 1;
      if (isDigit(this.text[this.index])) this.fail('leading zero in number');
    } else {
      const first = this.text[this.index];
      if (first === undefined || first < '1' || first > '9') this.fail('invalid number');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    let fractional = false;
    if (this.text[this.index] === '.') {
      fractional = true;
      this.index += 1;
      if (!isDigit(this.text[this.index])) this.fail('expected a digit after the decimal point');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    let exponent = false;
    if (this.text[this.index] === 'e' || this.text[this.index] === 'E') {
      // Python leaves an exponent marker without digits unconsumed, so the
      // preceding literal is still scanned and `parseFloat` still runs.
      const exponentStart = this.index;
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1;
      if (isDigit(this.text[this.index])) {
        exponent = true;
        while (isDigit(this.text[this.index])) this.index += 1;
      } else {
        this.index = exponentStart;
      }
    }
    const raw = this.text.slice(start, this.index);
    if (fractional || exponent) {
      return this.options.parseFloat === undefined
        ? JsonNumber.float(Number(raw), raw)
        : this.options.parseFloat(raw);
    }
    return JsonNumber.int(raw);
  }

  private parseNonFinite(token: string): JsonValue {
    if (this.text.slice(this.index, this.index + token.length) !== token) {
      return this.fail('expected a JSON value');
    }
    if (this.options.parseConstant === undefined) return this.fail('expected a JSON value');
    this.index += token.length;
    return this.options.parseConstant(token);
  }

  private parseKeyword<T extends boolean | null>(word: string, value: T): T {
    if (this.text.slice(this.index, this.index + word.length) !== word) {
      this.fail(`expected '${word}'`);
    }
    this.index += word.length;
    return value;
  }

  private skipWhitespace(): void {
    while (true) {
      const character = this.text[this.index];
      if (character !== ' ' && character !== '\t' && character !== '\n' && character !== '\r')
        return;
      this.index += 1;
    }
  }

  private fail(message: string): never {
    throw new JsonParseError(message, this.index);
  }
}

function isDigit(character: string | undefined): boolean {
  return character !== undefined && character >= '0' && character <= '9';
}

/**
 * Materialise ordinary JavaScript values for zod and other consumers.
 *
 * Integers become `number` values. Values beyond the safe range therefore
 * round, which is exactly why the exact document stays available in its
 * lossless form; use `bigints` when exactness matters more than zod input.
 */
export function toPlainJson(value: JsonValue, options: { bigints?: boolean } = {}): unknown {
  if (value instanceof JsonNumber) {
    if (value.kind === 'float') return value.float;
    const integer = value.integer as bigint;
    if (
      options.bigints &&
      (integer > BigInt(Number.MAX_SAFE_INTEGER) || integer < BigInt(Number.MIN_SAFE_INTEGER))
    ) {
      return integer;
    }
    return Number(integer);
  }
  if (value instanceof JsonObject) {
    const object: Record<string, unknown> = {};
    for (const [key, entry] of value.entries) {
      Object.defineProperty(object, key, {
        value: toPlainJson(entry, options),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return object;
  }
  if (Array.isArray(value)) return value.map((entry) => toPlainJson(entry, options));
  return value;
}

/**
 * Materialise ordinary JavaScript containers while keeping every number as a
 * {@link JsonNumber}.
 *
 * This is the bridge for readers that need plain arrays/objects and Python's
 * int-vs-float distinction at the same time: `new Map`, structural sharing and
 * `Object.entries` work on the result, and a later `toPlainJson` (or
 * `pythonJsonText`) still sees the exact Python value. Unlike
 * {@link toPlainJson}, no integer is converted to a JavaScript number, so an
 * integer above `Number.MAX_SAFE_INTEGER` cannot round.
 */
export function toPlainJsonRetainingNumbers(value: JsonValue): unknown {
  if (value instanceof JsonNumber) return value;
  if (value instanceof JsonObject) {
    const object: Record<string, unknown> = {};
    for (const [key, entry] of value.entries) {
      Object.defineProperty(object, key, {
        value: toPlainJsonRetainingNumbers(entry),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return object;
  }
  if (Array.isArray(value)) return value.map(toPlainJsonRetainingNumbers);
  return value;
}

interface PythonNumber {
  readonly kind: 'int' | 'float';
  readonly integer: bigint | null;
  readonly float: number | null;
}

/**
 * Python's `int`/`float` view of a JSON-shaped value.
 *
 * Python `bool` is an `int` subclass, so `True` compares as `1` and `False` as
 * `0`. A plain JavaScript number is treated as a float when it is non-integral
 * and as an integer when it is integral; callers that need the original Python
 * type must pass a {@link JsonNumber}, which is why the status reader keeps
 * exact numbers at the boundary.
 */
function pythonNumber(value: unknown): PythonNumber | null {
  if (value instanceof JsonNumber) {
    return value.kind === 'int'
      ? { kind: 'int', integer: value.integer, float: null }
      : { kind: 'float', integer: null, float: value.float };
  }
  if (typeof value === 'boolean') {
    return { kind: 'int', integer: value ? 1n : 0n, float: null };
  }
  if (typeof value === 'bigint') return { kind: 'int', integer: value, float: null };
  if (typeof value === 'number') {
    return Number.isInteger(value)
      ? { kind: 'int', integer: BigInt(value), float: null }
      : { kind: 'float', integer: null, float: value };
  }
  return null;
}

/**
 * Python `==` for two numeric values, or `null` when either side is not a
 * number.
 *
 * `1 == 1.0` is true, booleans compare as their integer value, and adjacent
 * integers above `Number.MAX_SAFE_INTEGER` stay distinct. A float never rounds
 * an integer before comparing. `NaN != NaN` and every comparison involving
 * NaN is false, matching Python.
 */
export function pythonNumbersEqual(left: unknown, right: unknown): boolean | null {
  const a = pythonNumber(left);
  const b = pythonNumber(right);
  if (a === null || b === null) return null;
  if (isNan(a) || isNan(b)) return false;
  return compareNumbers(a, b) === 0;
}

/**
 * Python ordering for two numeric values, or `null` when either side is not a
 * number.
 *
 * Returns `-1`, `0` or `1`. A compare involving NaN returns `0` because both
 * Python `<` and `>` are false; equality is still false and must be tested
 * with {@link pythonNumbersEqual}. The comparison is exact for integers above
 * `Number.MAX_SAFE_INTEGER`: it never converts an integer to a double.
 */
export function comparePythonNumbers(left: unknown, right: unknown): number | null {
  const a = pythonNumber(left);
  const b = pythonNumber(right);
  if (a === null || b === null) return null;
  if (isNan(a) || isNan(b)) return 0;
  return compareNumbers(a, b);
}

function isNan(value: PythonNumber): boolean {
  return value.kind === 'float' && Number.isNaN(value.float as number);
}

function compareNumbers(a: PythonNumber, b: PythonNumber): number {
  if (a.kind === 'int' && b.kind === 'int') {
    const left = a.integer as bigint;
    const right = b.integer as bigint;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  if (a.kind === 'float' && b.kind === 'float') {
    const left = a.float as number;
    const right = b.float as number;
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a.kind === 'int'
    ? compareIntToFloat(a.integer as bigint, b.float as number)
    : -compareIntToFloat(b.integer as bigint, a.float as number);
}

/** Exact `int` vs `float` ordering without converting the integer to a double. */
function compareIntToFloat(integer: bigint, float: number): number {
  if (Number.isNaN(float)) return 0;
  if (float === Infinity) return -1;
  if (float === -Infinity) return 1;
  if (float === 0) return integer < 0n ? -1 : integer > 0n ? 1 : 0;
  if (integer === 0n) return float < 0 ? 1 : -1;
  if (integer < 0n !== float < 0) return integer < 0n ? -1 : 1;
  const negative = integer < 0n;
  const magnitude = negative ? -integer : integer;
  const [numerator, denominator] = floatRatio(Math.abs(float));
  const left = magnitude * denominator;
  const right = numerator;
  const comparison = left < right ? -1 : left > right ? 1 : 0;
  return negative ? -comparison : comparison;
}

/**
 * Exact finite float as `numerator / denominator`, read from its IEEE-754
 * bits. The decimal `toString` form is shortest-round-trip, not the exact
 * binary value, so it can misorder an adjacent integer above 2^53.
 */
function floatRatio(value: number): [bigint, bigint] {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value, false);
  const high = BigInt(view.getUint32(0, false));
  const low = BigInt(view.getUint32(4, false));
  const bits = (high << 32n) | low;
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  const mantissa = exponentBits === 0 ? fraction : (1n << 52n) | fraction;
  const exponent = exponentBits === 0 ? -1074 : exponentBits - 1023 - 52;
  const sign = bits >> 63n === 1n ? -1n : 1n;
  return exponent >= 0
    ? [sign * (mantissa << BigInt(exponent)), 1n]
    : [sign * mantissa, 1n << BigInt(-exponent)];
}
