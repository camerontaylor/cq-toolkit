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
 * RFC 8259 grammar is accepted; Python's non-finite constants are deliberately refused. Duplicate keys
 * are the caller's choice because Python's default `json.loads` keeps the last
 * value (and the first key position), while `review_ledger.loads` refuses them.
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
}

/** Parse RFC 8259 JSON without losing int-vs-float or object key order. */
export function parseJsonValue(text: string, options: ParseJsonOptions = {}): JsonValue {
  return new Parser(text, options.duplicates ?? 'last').parse();
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
    private readonly duplicates: 'last' | 'error',
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
      case undefined:
        return this.fail('expected a JSON value');
      default:
        if (
          character === '-' ||
          (character !== undefined && character >= '0' && character <= '9')
        ) {
          return this.parseNumber();
        }
        return this.fail('expected a JSON value');
    }
  }

  private parseObject(): JsonObject {
    this.index += 1; // {
    const entries: Array<[string, JsonValue]> = [];
    const positions = new Map<string, number>();
    this.skipWhitespace();
    if (this.text[this.index] === '}') {
      this.index += 1;
      return new JsonObject(entries);
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
      const existing = positions.get(key);
      if (existing === undefined) {
        positions.set(key, entries.length);
        entries.push([key, value]);
      } else if (this.duplicates === 'error') {
        this.fail(`duplicate key ${JSON.stringify(key)}`);
      } else {
        entries[existing] = [key, value];
      }
      this.skipWhitespace();
      const separator = this.text[this.index];
      if (separator === '}') {
        this.index += 1;
        return new JsonObject(entries);
      }
      if (separator !== ',') this.fail("expected ',' or '}'");
      this.index += 1;
    }
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
        result += this.text.slice(chunkStart, this.index);
        this.index += 1;
        return result;
      }
      if (character === '\\') {
        result += this.text.slice(chunkStart, this.index);
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
        return String.fromCharCode(Number.parseInt(digits, 16));
      }
      case undefined:
        return this.fail('invalid escape');
      default:
        return this.fail('invalid escape');
    }
  }

  private parseNumber(): JsonNumber {
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
      exponent = true;
      this.index += 1;
      if (this.text[this.index] === '+' || this.text[this.index] === '-') this.index += 1;
      if (!isDigit(this.text[this.index])) this.fail('expected an exponent digit');
      while (isDigit(this.text[this.index])) this.index += 1;
    }
    const raw = this.text.slice(start, this.index);
    return fractional || exponent ? JsonNumber.float(Number(raw), raw) : JsonNumber.int(raw);
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
