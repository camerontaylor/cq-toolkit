/**
 * Lossless queue-document helpers for the queue-v1 capability.
 *
 * The capability mutates the same `queue.json` the Python runner writes, so the
 * document is parsed with {@link parseJsonValue} and only ever rewritten through
 * `atomicJsonText`: object key order, the int-vs-float lexeme and unknown
 * fields survive a request that touches one entry. Mutations are copy-on-write
 * along the changed path (the retained value objects are shared), so a large
 * queue is never re-materialised.
 *
 * The equality and truthiness helpers mirror Python's data model, which the
 * oracle's authorization comparisons rely on: `True == 1`, `1 == 1.0`,
 * `dict == dict` ignores key order and an empty container is false.
 */
import { JsonNumber, JsonObject, pythonNumbersEqual, type JsonValue } from './jsonValue.js';

/** A Python dict: `JsonObject` (lossless) or a plain own-property object. */
export type JsonRecordLike = JsonObject | Record<string, unknown>;

/** True for `JsonObject` and for plain (non-array) objects. */
export function isJsonRecord(value: unknown): value is JsonRecordLike {
  if (value instanceof JsonObject) return true;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

/** The ordered entries of a `JsonObject` or a plain object. */
export function recordEntries(value: JsonRecordLike): ReadonlyArray<readonly [string, unknown]> {
  if (value instanceof JsonObject) return value.entries;
  return Object.keys(value).map((key) => [key, (value as Record<string, unknown>)[key]] as const);
}

/** One key's value, or `undefined` when absent. */
export function recordGet(value: JsonRecordLike, key: string): unknown {
  if (value instanceof JsonObject) return value.get(key);
  return Object.prototype.hasOwnProperty.call(value, key)
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** True when the key is present (a JSON `null` counts as present). */
export function recordHas(value: JsonRecordLike, key: string): boolean {
  if (value instanceof JsonObject) return value.has(key);
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** True for a Python `int` (`type(value) is int`), never a float or boolean. */
export function isJsonInt(value: unknown): value is JsonNumber {
  return value instanceof JsonNumber && value.kind === 'int';
}

/** A Python `bool`, never a 0/1 number. */
export function isJsonBool(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/** The exact integer of an int `JsonValue` as a BigInt. */
export function jsonIntValue(value: JsonNumber): bigint {
  const integer = value.integer;
  if (integer === null) throw new Error('not an integer');
  return integer;
}

/** The integer's exact decimal text (Python's `str(int)`). */
export function jsonIntText(value: JsonNumber): string {
  return jsonIntValue(value).toString();
}

/**
 * Python truthiness for JSON-shaped values.
 *
 * `JsonNumber` zero (int or float) and `-0.0` are false, `NaN` is true, empty
 * strings/arrays/objects are false, and `None`/`False` are false.
 */
export function pyTruthy(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') return value.length > 0;
  if (typeof value === 'number') return !(value === 0);
  if (typeof value === 'bigint') return value !== 0n;
  if (value instanceof JsonNumber) {
    if (value.kind === 'int') return (value.integer as bigint) !== 0n;
    const float = value.float as number;
    return float !== 0; // NaN is truthy in Python
  }
  if (Array.isArray(value)) return value.length > 0;
  if (value instanceof JsonObject) return value.entries.length > 0;
  if (typeof value === 'object') return Object.keys(value).length > 0;
  return true;
}

/**
 * Python `==` over lossless and plain JSON-shaped values.
 *
 * Numbers compare by value (`True == 1`, `1 == 1.0`, exact above 2^53); arrays
 * keep order; dictionaries ignore order and compare by key set. Values of
 * different JSON kinds never compare equal (Python never equates a string and a
 * number this way).
 */
export function pythonValueEqual(left: unknown, right: unknown): boolean {
  const numbers = pythonNumbersEqual(left, right);
  if (numbers !== null) return numbers;
  if (left instanceof JsonNumber || right instanceof JsonNumber) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => pythonValueEqual(value, right[index]));
  }
  if (isJsonRecord(left) || isJsonRecord(right)) {
    if (!isJsonRecord(left) || !isJsonRecord(right)) return false;
    const leftEntries = recordEntries(left);
    const rightEntries = recordEntries(right);
    if (leftEntries.length !== rightEntries.length) return false;
    return leftEntries.every(
      ([key, value]) => recordHas(right, key) && pythonValueEqual(value, recordGet(right, key)),
    );
  }
  return left === right;
}

/** Python `dict.setdefault`/assignment: keep an existing key's position, append a new one. */
export function withObjectKeys(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(updates);
  const entries: Array<readonly [string, JsonValue]> = object.entries.map(([key, value]) => [
    key,
    replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
  ]);
  for (const [key, value] of updates) {
    if (!object.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

/** Python `del d[key]`: a missing key is a no-op for our callers. */
export function withoutObjectKey(object: JsonObject, key: string): JsonObject {
  return new JsonObject(object.entries.filter(([name]) => name !== key));
}

/**
 * Replace (or create) one nested object's key from a plain, JSON-shaped update.
 * Intermediate values must already be objects; a non-object intermediate is a
 * caller bug, not user input.
 */
export function setNestedEntry(
  root: JsonObject,
  parent: string,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const current = root.get(parent);
  const base = current instanceof JsonObject ? current : new JsonObject([]);
  return withObjectKeys(root, [[parent, withObjectKeys(base, updates)]]);
}

/**
 * Materialise a plain JSON-shaped value into the lossless model.
 *
 * The queue writer needs `JsonNumber` for every number so a Python `1.0`
 * lexeme is never rewritten as `1`. Values that are already lossless pass
 * through unchanged, which keeps the shared subtrees untouched.
 */
export function fromPlainJson(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (value instanceof JsonObject || value instanceof JsonNumber) return value;
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'bigint') return JsonNumber.int(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('non-finite JSON number');
    return Number.isInteger(value) ? JsonNumber.int(value) : JsonNumber.float(value);
  }
  if (Array.isArray(value)) return value.map((entry) => fromPlainJson(entry));
  if (typeof value === 'object') {
    return new JsonObject(
      Object.keys(value).map(
        (key) => [key, fromPlainJson((value as Record<string, unknown>)[key])] as const,
      ),
    );
  }
  throw new Error(`value of type ${typeof value} is not JSON`);
}
