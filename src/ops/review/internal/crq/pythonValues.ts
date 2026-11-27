/**
 * Small Python value operations the finding delivery and repair transport
 * ports need beyond `pythonGet`: `+` on strings, `len`, `x[0]`, hashing for
 * dict keys, code-point slicing and rebuilding an immutable dict.
 *
 * Each helper raises the typed error whose `pythonError` is the Python
 * exception class, so the oracle differential compares the class.
 */
import { JsonNumber, JsonObject, type JsonValue } from '../../../../policy/crq/jsonValue.js';
import {
  LedgerKeyError,
  LedgerTypeError,
  ledgerPythonTypeName,
} from '../../../../policy/crq/ledger.js';
import { FindingDeliveryAttributeError } from '../../../../policy/crq/findingDelivery.js';

/** Python `IndexError` from `value[0]` on an empty sequence. */
export class PythonIndexError extends Error {
  override readonly name = 'PythonIndexError';
  readonly pythonError = 'IndexError';

  constructor(message: string) {
    super(message);
  }
}

/** Python `ValueError`. */
export class PythonValueError extends Error {
  override readonly name = 'PythonValueError';
  readonly pythonError = 'ValueError';

  constructor(message: string) {
    super(message);
  }
}

/** Python `FileNotFoundError` from reading a path that is not there. */
export class PythonFileNotFoundError extends Error {
  override readonly name = 'PythonFileNotFoundError';
  readonly pythonError = 'FileNotFoundError';

  constructor(path: string) {
    super(`no such file: ${path}`);
  }
}

/** A dict rebuilt with `updates` applied in place and new keys appended. */
export function withKeys(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(updates);
  const entries: Array<readonly [string, JsonValue]> = object.entries.map(([key, value]) => [
    key,
    replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
  ]);
  for (const [key, value] of updates) if (!object.has(key)) entries.push([key, value]);
  return new JsonObject(entries);
}

/** Python `left + right` where `left` is expected to be a `str`. */
export function concatText(left: JsonValue, right: string): string {
  if (typeof left !== 'string') {
    throw new LedgerTypeError(
      `unsupported operand type(s) for +: '${ledgerPythonTypeName(left)}' and 'str'`,
    );
  }
  return left + right;
}

/** Python `str + value` where `value` is expected to be a `str`. */
export function prependText(left: string, right: JsonValue): string {
  if (typeof right !== 'string') {
    throw new LedgerTypeError(`can only concatenate str (not "${ledgerPythonTypeName(right)}")`);
  }
  return left + right;
}

/** Python `len(value)`: code points of a str, entries of a list or dict. */
export function pythonLen(value: JsonValue): number {
  if (typeof value === 'string') return [...value].length;
  if (Array.isArray(value)) return value.length;
  if (value instanceof JsonObject) return value.entries.length;
  throw new LedgerTypeError(`object of type '${ledgerPythonTypeName(value)}' has no len()`);
}

/** Python `value[0]`: a list or str element, `KeyError` for a dict, `TypeError` otherwise. */
export function pythonFirst(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    if (value.length === 0) throw new PythonIndexError('list index out of range');
    return value[0] as JsonValue;
  }
  if (typeof value === 'string') {
    const first = [...value][0];
    if (first === undefined) throw new PythonIndexError('string index out of range');
    return first;
  }
  if (value instanceof JsonObject) throw new LedgerKeyError('0');
  throw new LedgerTypeError(`'${ledgerPythonTypeName(value)}' object is not subscriptable`);
}

/** Python `value.values()`: the values of a dict, `AttributeError` otherwise. */
export function pythonValues(value: JsonValue): readonly JsonValue[] {
  if (value instanceof JsonObject) return value.entries.map(([, item]) => item);
  throw new FindingDeliveryAttributeError(
    `'${ledgerPythonTypeName(value)}' object has no attribute 'values'`,
  );
}

/** A dict key that Python could hash: numbers and booleans share one numeric key space. */
export function hashKey(value: JsonValue): string {
  if (value === null) return 'none';
  if (typeof value === 'string') return `s:${value}`;
  if (typeof value === 'boolean') return `n:${value ? '1' : '0'}`;
  if (value instanceof JsonNumber)
    return `n:${value.kind === 'int' ? String(value.integer) : value.raw}`;
  throw new LedgerTypeError(`unhashable type: '${ledgerPythonTypeName(value)}'`);
}

/** Python `text[:count]`, counted in code points. */
export function codePointPrefix(text: string, count: number): string {
  return [...text].slice(0, count).join('');
}

/** Python `str(value)`. */
export { pythonStr } from '../../../../policy/crq/prReviewFindings.js';

/** Python `a >= b` for a non-negative int against a JSON number or bool. */
export function pythonAtLeast(left: number, right: JsonValue): boolean {
  if (typeof right === 'boolean') return left >= (right ? 1 : 0);
  if (right instanceof JsonNumber) {
    if (right.kind === 'int') return BigInt(left) >= (right.integer as bigint);
    return left >= (right.float as number);
  }
  throw new LedgerTypeError(
    `'>=' not supported between instances of 'int' and '${ledgerPythonTypeName(right)}'`,
  );
}
