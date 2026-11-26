/**
 * The slice of Python's dynamic semantics the legacy-coverage ports need, over
 * plain JSON-shaped values (objects, arrays, strings, numbers, booleans, null).
 *
 * Python lets `AttributeError`, `TypeError`, `KeyError` and `IndexError`
 * escape from `dict.get` on a non-dict, iteration of a non-iterable and
 * unhashable set members; {@link PyError} carries the class name so a caller
 * (and the differential test) can tell them apart. Documented deviation: a
 * plain JS number cannot distinguish the int `1` from the float `1.0`; a whole
 * number is read as an int.
 */
import { CoverageUtilizationError, coverageTime } from './coverageUtilization.js';
import { UtcInstant } from './utc.js';

export type PyErrorClass =
  | 'ValueError'
  | 'TypeError'
  | 'KeyError'
  | 'AttributeError'
  | 'IndexError'
  | 'RuntimeError'
  | 'OverflowError'
  | 'OSError';

/** A Python exception the oracle would raise, with its class name. */
export class PyError extends Error {
  override readonly name: string = 'PyError';
  readonly pythonError: PyErrorClass;
  constructor(pythonError: PyErrorClass, message: string) {
    super(message);
    this.pythonError = pythonError;
  }
}

export type Dict = Record<string, unknown>;

export function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function pyTypeName(value: unknown): string {
  if (value === null || value === undefined) return 'NoneType';
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : 'float';
  if (typeof value === 'bigint') return 'int';
  if (typeof value === 'string') return 'str';
  if (Array.isArray(value)) return 'list';
  return 'dict';
}

/** `type(x) is int`: bool and non-integral numbers are not ints. */
export function isPyInt(value: unknown): value is number | bigint {
  return typeof value === 'bigint' || (typeof value === 'number' && Number.isInteger(value));
}

/** `d.get(key)`: undefined when absent; AttributeError for a non-dict. */
export function pyGet(value: unknown, key: string): unknown {
  if (!isDict(value)) {
    throw new PyError('AttributeError', `'${pyTypeName(value)}' object has no attribute 'get'`);
  }
  return Object.hasOwn(value, key) ? value[key] : undefined;
}

/** `d.get(key, default)`: the default only applies to an absent key. */
export function pyGetOr(value: unknown, key: string, fallback: unknown): unknown {
  const found = pyGet(value, key);
  return found === undefined ? fallback : found;
}

/** `d[key]`: KeyError for an absent key, TypeError for a non-dict. */
export function pyIndex(value: unknown, key: string): unknown {
  if (!isDict(value)) {
    throw new PyError('TypeError', `'${pyTypeName(value)}' object is not subscriptable`);
  }
  if (!Object.hasOwn(value, key)) throw new PyError('KeyError', `'${key}'`);
  return value[key];
}

/** Python's `str.isspace` set, also what `str.split()` and `strip()` use. */
const PY_SPACE =
  '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const SPACE_RUN = new RegExp(`[${PY_SPACE}]+`, 'u');
const EDGE_SPACE = new RegExp(`^[${PY_SPACE}]+|[${PY_SPACE}]+$`, 'gu');

/** `s.split()`. */
export function pySplitWhitespace(text: string): string[] {
  return text.split(SPACE_RUN).filter((part) => part !== '');
}

/** `s.splitlines()`: every Python line boundary, no trailing empty element. */
export function pySplitlines(text: string): string[] {
  const lines: string[] = [];
  let start = 0;
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    const isBreak =
      code === 0x0a ||
      code === 0x0b ||
      code === 0x0c ||
      code === 0x0d ||
      (code >= 0x1c && code <= 0x1e) ||
      code === 0x85 ||
      code === 0x2028 ||
      code === 0x2029;
    if (!isBreak) {
      index += 1;
      continue;
    }
    lines.push(text.slice(start, index));
    index += code === 0x0d && text.charCodeAt(index + 1) === 0x0a ? 2 : 1;
    start = index;
  }
  if (start < text.length) lines.push(text.slice(start));
  return lines;
}

/** `repr(str)`. */
export function pyReprString(text: string): string {
  const quote = text.includes("'") && !text.includes('"') ? '"' : "'";
  let out = quote;
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (char === quote || char === '\\') out += `\\${char}`;
    else if (char === '\n') out += '\\n';
    else if (char === '\r') out += '\\r';
    else if (char === '\t') out += '\\t';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += char;
  }
  return out + quote;
}

/** `int(text)` for a str: sign, ASCII digits, single underscores between digits. */
export function pyIntFromString(text: string): number {
  const stripped = text.replace(EDGE_SPACE, '');
  if (!/^[+-]?\d+(?:_\d+)*$/u.test(stripped)) {
    throw new PyError(
      'ValueError',
      `invalid literal for int() with base 10: ${pyReprString(text)}`,
    );
  }
  return Number(stripped.replaceAll('_', ''));
}

/** `str(value)` for the scalar shapes an id or PR number takes. */
export function pyStr(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return 'None';
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  throw new PyError('TypeError', `cannot render ${pyTypeName(value)} as str`);
}

const isNumeric = (v: unknown): v is number | boolean | bigint =>
  typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint';

/** `a == b` over JSON values (bool, int and float compare numerically). */
export function pyEq(a: unknown, b: unknown): boolean {
  const left = a === undefined ? null : a;
  const right = b === undefined ? null : b;
  if (isNumeric(left) && isNumeric(right)) return Number(left) === Number(right);
  if (typeof left === 'string' || typeof right === 'string') return left === right;
  if (left === null || right === null) return left === right;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => pyEq(value, right[index]));
  }
  if (isDict(left) && isDict(right)) {
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => Object.hasOwn(right, key) && pyEq(left[key], right[key]))
    );
  }
  return false;
}

/** The hash identity of a hashable JSON value; TypeError for list and dict. */
export function pyHashKey(value: unknown): string {
  if (value === null || value === undefined) return 'N';
  if (typeof value === 'string') return `s${value}`;
  if (isNumeric(value)) return `n${Number(value)}`;
  throw new PyError('TypeError', `unhashable type: '${pyTypeName(value)}'`);
}

/** `x in container` (list by ==, str by substring, dict by key). */
export function pyContains(container: unknown, needle: unknown): boolean {
  if (Array.isArray(container)) return container.some((value) => pyEq(value, needle));
  if (typeof container === 'string') {
    if (typeof needle !== 'string') {
      throw new PyError('TypeError', "'in <string>' requires string as left operand");
    }
    return container.includes(needle);
  }
  if (isDict(container)) {
    pyHashKey(needle);
    return typeof needle === 'string' && Object.hasOwn(container, needle);
  }
  throw new PyError('TypeError', `argument of type '${pyTypeName(container)}' is not iterable`);
}

/** `list(iter(value))`: a str yields characters, a dict its keys. */
export function pyIter(value: unknown): unknown[] {
  if (Array.isArray(value)) return [...(value as unknown[])];
  if (typeof value === 'string') return Array.from(value);
  if (isDict(value)) return Object.keys(value);
  throw new PyError('TypeError', `'${pyTypeName(value)}' object is not iterable`);
}

/** `set(iterable)`, insertion-ordered: dedupes by hash identity. */
export function pySet(value: unknown): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const element of pyIter(value)) {
    const key = pyHashKey(element);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(element);
    }
  }
  return out;
}

/** Code-point order, as Python sorts `str` (JS sorts by UTF-16 unit). */
export function compareCodePoints(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) {
    const diff = (left[index] as string).codePointAt(0)! - (right[index] as string).codePointAt(0)!;
    if (diff !== 0) return diff;
  }
  return left.length - right.length;
}

/** `a < b` ordering for the str/number values a sort key holds; TypeError otherwise. */
export function pyCompare(a: unknown, b: unknown): number {
  if (typeof a === 'string' && typeof b === 'string') return compareCodePoints(a, b);
  if (isNumeric(a) && isNumeric(b)) {
    return Number(a) < Number(b) ? -1 : Number(a) > Number(b) ? 1 : 0;
  }
  throw new PyError(
    'TypeError',
    `'<' not supported between instances of '${pyTypeName(a)}' and '${pyTypeName(b)}'`,
  );
}

/** Tuple ordering: the first unequal element decides. */
export function pyCompareTuples(a: readonly unknown[], b: readonly unknown[]): number {
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    if (!pyEq(a[index], b[index])) return pyCompare(a[index], b[index]);
  }
  return a.length - b.length;
}

/** A Python number (int, float or bool) as a JS number; TypeError otherwise. */
export function pyNumber(value: unknown): number {
  if (isNumeric(value)) return Number(value);
  throw new PyError('TypeError', `expected a number, got '${pyTypeName(value)}'`);
}

/**
 * `coverage._time`: a UTC instant in epoch microseconds. A {@link UtcInstant}
 * stands for an aware `datetime`; everything else is `coverage._time`'s input.
 */
export function pyTime(value: unknown): bigint {
  if (value instanceof UtcInstant) return value.epochMicros;
  try {
    return coverageTime(value);
  } catch (error) {
    if (error instanceof CoverageUtilizationError) {
      throw new PyError(error.pythonError, error.message);
    }
    throw error;
  }
}

/** `coverage._iso`: `isoformat()` with `+00:00` spelled `Z`; the fraction only when non-zero. */
export function pyIso(value: unknown): string {
  const micros = pyTime(value);
  const text = new UtcInstant(micros).iso;
  return text.endsWith('.000000Z') ? `${text.slice(0, 19)}Z` : text;
}

/** `coverage._path`: a normalized repository-relative POSIX path. */
export function pyPath(value: unknown): string {
  const invalid = (): PyError => new PyError('ValueError', 'expected a repository-relative path');
  if (typeof value !== 'string' || value === '' || value.includes('\0')) throw invalid();
  if (value.startsWith('/')) throw invalid();
  const parts = value.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..') || parts.length === 0) throw invalid();
  return parts.join('/');
}

/** `str(PurePosixPath(path).parent)` for a normalized relative path. */
export function pyParent(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '.' : path.slice(0, slash);
}

/** Python `round(x, 3)`: half-even on the exact binary value. */
export function pyRound3(value: number): number {
  const sixteenths = value * 16;
  if (Number.isInteger(sixteenths) && Math.abs(sixteenths) % 2 === 1) {
    const scaled = 62.5 * sixteenths;
    const floor = Math.floor(scaled);
    return (Math.abs(floor) % 2 === 0 ? floor : floor + 1) / 1000;
  }
  return Number(value.toFixed(3));
}
