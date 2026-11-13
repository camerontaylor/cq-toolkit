/** Python dict-shaped immutable edits over {@link JsonObject}. Kept here so
 * the ops layer keeps one idiom for Python dict writes. */
import { JsonObject, type JsonValue } from '../../../policy/crq/jsonValue.js';

/** Python `d[key] = value` keeping insertion order, last write wins. */
export function setKeys(
  object: JsonObject,
  updates: ReadonlyArray<readonly [string, JsonValue]>,
): JsonObject {
  const replacement = new Map(updates);
  const entries: Array<readonly [string, JsonValue]> = object.entries.map(
    ([key, value]: readonly [string, JsonValue]): readonly [string, JsonValue] => [
      key,
      replacement.has(key) ? (replacement.get(key) as JsonValue) : value,
    ],
  );
  for (const [key, value] of updates) {
    if (!object.has(key)) entries.push([key, value]);
  }
  return new JsonObject(entries);
}

/** Python `d.pop(key, None)`; returns the object unchanged when absent. */
export function removeKeys(object: JsonObject, keys: readonly string[]): JsonObject {
  const drop = new Set(keys);
  if ([...drop].every((key) => !object.has(key))) return object;
  return new JsonObject(
    object.entries.filter(([name]: readonly [string, JsonValue]) => !drop.has(name)),
  );
}
