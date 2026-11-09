/**
 * The phase 0.2 schema vocabulary, evaluated with Python's exact value model.
 *
 * `review_ledger._schema` is the checked-in Python validator. It evaluates only
 * `$schema, oneOf, type, const, enum, required, properties,
 * additionalProperties, items, minItems, maxItems, minimum, minLength,
 * pattern`, and it fails closed on anything else. Crucially it distinguishes a
 * Python `int` from a `float` (`type(value) is int`), so a JSON source `1.0`
 * is rejected in an integer position even though a JavaScript validator cannot
 * see the distinction after `JSON.parse`.
 *
 * Two details follow JSON Schema rather than that Python helper's shortcuts,
 * because zod implements the schema documents: `additionalProperties` object
 * interiors ARE validated (the Python helper leaves them to its separate
 * `map_checks`), and `const`/`enum` use mathematical numeric equality, so a
 * schema constant `1` matches the JSON number 1.0 as well as 1. Booleans stay
 * distinct from numbers, as JSON Schema requires.
 *
 * This evaluator operates on {@link JsonValue} (lossless lexemes) and exists to
 * cross-check the zod schemas generated from the same documents. A disagreement
 * is a real defect in one validator, not a case to paper over.
 */
import { JsonNumber, JsonObject, type JsonValue } from './jsonValue.js';
import type { JsonSchema } from './schemas.js';

const SUPPORTED = new Set([
  '$schema',
  'oneOf',
  'type',
  'const',
  'enum',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minimum',
  'minLength',
  'pattern',
]);

export class PythonSchemaError extends Error {
  override readonly name = 'PythonSchemaError';
}

export interface PythonSchemaResult {
  readonly accepted: boolean;
  /** First failure path and reason when rejected. */
  readonly reason?: string;
}

/** Evaluate `rule` against a lossless value with Python's validator semantics. */
export function pythonSchemaAccepts(rule: JsonSchema, value: JsonValue): PythonSchemaResult {
  const failure = firstFailure(rule, value, '$');
  return failure === null ? { accepted: true } : { accepted: false, reason: failure };
}

/** Throw when the value fails; used by callers that want a JSON-schema-style refusal. */
export function assertPythonSchema(rule: JsonSchema, value: JsonValue): void {
  const failure = firstFailure(rule, value, '$');
  if (failure !== null) throw new PythonSchemaError(failure);
}

function firstFailure(rule: JsonSchema, value: JsonValue, path: string): string | null {
  for (const keyword of Object.keys(rule)) {
    if (!SUPPORTED.has(keyword)) {
      throw new PythonSchemaError(`unsupported schema keyword '${keyword}' at ${path}`);
    }
  }
  if (Array.isArray(rule['oneOf'])) {
    const accepted = rule['oneOf'].filter(
      (branch) => firstFailure(branch as JsonSchema, value, path) === null,
    );
    if (accepted.length !== 1) {
      return `${path}: expected exactly one oneOf branch, matched ${String(accepted.length)}`;
    }
  }
  if ('type' in rule && !matchesType(rule['type'], value)) {
    return `${path}: expected type ${JSON.stringify(rule['type'])}`;
  }
  if ('const' in rule && !jsonEqual(rule['const'], value)) {
    return `${path}: expected constant ${JSON.stringify(rule['const'])}`;
  }
  if (Array.isArray(rule['enum'])) {
    const expected = rule['enum'] as unknown[];
    if (!expected.some((entry) => jsonEqual(entry, value))) {
      return `${path}: expected one of ${JSON.stringify(expected)}`;
    }
  }
  if (Array.isArray(rule['required']) && value instanceof JsonObject) {
    for (const key of rule['required'] as string[]) {
      if (!value.has(key)) return `${path}: missing required property ${JSON.stringify(key)}`;
    }
  }
  if (value instanceof JsonObject) {
    const properties =
      rule['properties'] !== null && typeof rule['properties'] === 'object'
        ? (rule['properties'] as Record<string, JsonSchema>)
        : {};
    for (const [key, child] of value.entries) {
      const childRule = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (childRule !== undefined) {
        const failure = firstFailure(childRule, child, `${path}.${key}`);
        if (failure !== null) return failure;
        continue;
      }
      const additional = rule['additionalProperties'];
      if (additional === false) return `${path}: unexpected property ${JSON.stringify(key)}`;
      if (additional !== null && typeof additional === 'object') {
        const failure = firstFailure(additional as JsonSchema, child, `${path}.${key}`);
        if (failure !== null) return failure;
      }
    }
  }
  if (Array.isArray(value)) {
    if (typeof rule['minItems'] === 'number' && value.length < rule['minItems']) {
      return `${path}: fewer than ${String(rule['minItems'])} items`;
    }
    if (typeof rule['maxItems'] === 'number' && value.length > rule['maxItems']) {
      return `${path}: more than ${String(rule['maxItems'])} items`;
    }
    const itemRule = rule['items'];
    if (itemRule !== null && typeof itemRule === 'object') {
      for (const [index, child] of value.entries()) {
        const failure = firstFailure(itemRule as JsonSchema, child, `${path}[${String(index)}]`);
        if (failure !== null) return failure;
      }
    }
  }
  if ('minimum' in rule && value instanceof JsonNumber && value.kind === 'int') {
    const minimum = toJsonValue(rule['minimum']);
    if (minimum instanceof JsonNumber && minimum.kind === 'int') {
      if ((value.integer as bigint) < (minimum.integer as bigint)) {
        return `${path}: below minimum ${String(minimum.integer)}`;
      }
    } else if (typeof minimum === 'number' && Number(value.integer) < minimum) {
      return `${path}: below minimum ${String(minimum)}`;
    }
  } else if ('minimum' in rule && value instanceof JsonNumber && value.kind === 'float') {
    const minimum = toJsonValue(rule['minimum']);
    if (minimum instanceof JsonNumber) {
      const bound = minimum.kind === 'int' ? Number(minimum.integer) : (minimum.float as number);
      if ((value.float as number) < bound) return `${path}: below minimum ${String(bound)}`;
    } else if (typeof minimum === 'number' && (value.float as number) < minimum) {
      return `${path}: below minimum ${String(minimum)}`;
    }
  }
  if (typeof value === 'string') {
    if (typeof rule['minLength'] === 'number' && Array.from(value).length < rule['minLength']) {
      return `${path}: shorter than ${String(rule['minLength'])} code points`;
    }
    if (typeof rule['pattern'] === 'string' && !pythonFullMatch(rule['pattern'], value)) {
      return `${path}: does not match ${JSON.stringify(rule['pattern'])}`;
    }
  }
  return null;
}

function matchesType(type: unknown, value: JsonValue): boolean {
  const expected = Array.isArray(type) ? type : [type];
  return expected.some((entry) => {
    switch (entry) {
      case 'null':
        return value === null;
      case 'boolean':
        return typeof value === 'boolean';
      case 'string':
        return typeof value === 'string';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return value instanceof JsonObject;
      case 'number':
        return value instanceof JsonNumber;
      case 'integer':
        return value instanceof JsonNumber && value.kind === 'int';
      default:
        throw new PythonSchemaError(`unsupported schema type ${JSON.stringify(entry)}`);
    }
  });
}

/** Compare a JSON-schema literal (parsed by JSON.parse) with a lossless value. */
function jsonEqual(left: unknown, right: JsonValue): boolean {
  if (left === null || typeof left === 'boolean' || typeof left === 'string') return left === right;
  if (typeof left === 'number') {
    if (!(right instanceof JsonNumber)) return false;
    const candidate = right.kind === 'int' ? Number(right.integer) : (right.float as number);
    // JSON Schema numeric equality is mathematical: 1 and 1.0 are the same
    // instance value. The schema literal itself came through JSON.parse, so a
    // literal 1.0 is already the JavaScript number 1.
    return candidate === left;
  }
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false;
    return left.every((entry, index) => jsonEqual(entry, right[index] as JsonValue));
  }
  if (left !== null && typeof left === 'object') {
    if (!(right instanceof JsonObject)) return false;
    const entries = Object.entries(left as Record<string, unknown>);
    if (entries.length !== right.entries.length) return false;
    return entries.every(([key, entry]) => {
      const candidate = right.get(key);
      return candidate !== undefined && jsonEqual(entry, candidate);
    });
  }
  return false;
}

/**
 * Convert a JSON-schema literal parsed by `JSON.parse` to the lossless model.
 *
 * Schema literals have no int-vs-float ambiguity that matters for const/enum
 * comparisons here (the documents use strings, integers and booleans), but
 * converting keeps the comparison in one model.
 */
function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return value;
  if (typeof value === 'number') {
    return Number.isInteger(value) && Number.isSafeInteger(value) && !Object.is(value, -0)
      ? JsonNumber.int(value)
      : JsonNumber.float(value);
  }
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (value !== null && typeof value === 'object') {
    return new JsonObject(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        toJsonValue(entry),
      ]),
    );
  }
  throw new PythonSchemaError(`non-JSON schema literal of type ${typeof value}`);
}

/**
 * Python `re.fullmatch` for the checked-in pattern vocabulary.
 *
 * The patterns are anchored already; the explicit length check is still needed
 * because JavaScript `$` also matches before a final line terminator, while
 * Python `fullmatch` does not. `\d` is translated to Unicode decimal digits to
 * match Python's default Unicode `re` semantics.
 */
function pythonFullMatch(pattern: string, value: string): boolean {
  const translated = pattern.replaceAll('\\d', '\\p{Nd}').replaceAll('\\D', '\\P{Nd}');
  let expression: RegExp;
  try {
    expression = new RegExp(`^(?:${translated})$`, 'u');
  } catch {
    throw new PythonSchemaError(`unsupported regular expression ${JSON.stringify(pattern)}`);
  }
  const match = expression.exec(value);
  return match !== null && match[0].length === value.length;
}
