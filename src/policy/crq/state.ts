/**
 * Read a crq on-disk state document through BOTH validators.
 *
 * The phase 0.2 JSON Schemas are the contract and the generated zod schemas are
 * their runtime form. zod alone cannot see Python's `int` vs `float`
 * distinction after a source `1.0` is materialised as a JavaScript `1`, so the
 * lossless document is also evaluated with {@link pythonSchemaAccepts}. A
 * disagreement fails closed and is reported as a `divergence` instead of being
 * silently resolved in either direction.
 *
 * This module is a reader: it never writes state, never spawns a process and
 * never reads `process.env` (ADR-0005 layering for `src/policy/*`).
 */
import {
  JsonNumber,
  JsonObject,
  JsonParseError,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from './jsonValue.js';
import { pythonSchemaAccepts } from './pythonSchema.js';
import { crqStateSchemaDocuments, crqStateSchemas, type CrqStateSchemaName } from './schemas.js';

export interface CrqStateAcceptance {
  readonly ok: true;
  /** The exact lossless document, including int/float lexemes and key order. */
  readonly document: JsonValue;
  /** The ordinary JavaScript value zod validated. */
  readonly value: unknown;
}

export interface CrqStateRejection {
  readonly ok: false;
  /** Human-readable failures. Exactly one validator failing is a divergence. */
  readonly issues: readonly string[];
  /** Set when zod and the Python evaluator disagreed about acceptance. */
  readonly divergence?: string;
}

export type CrqStateResult = CrqStateAcceptance | CrqStateRejection;

/** One own-property key per segment, from the materialised root to a leaf. */
export type StateValuePath = readonly string[];

/** A path that cannot be walked, or a requested leaf that is not a number. */
export class StateValuePathError extends Error {
  override readonly name = 'StateValuePathError';
  readonly path: readonly string[];

  constructor(message: string, path: readonly string[]) {
    super(`${message}: ${path.join('.') || '<root>'}`);
    this.path = [...path];
  }
}

/**
 * Splice exact lossless numbers into a successful state value.
 *
 * `parseCrqState` retains the lossless document but materialises `value` with
 * `toPlainJson`, which turns both `3` and `3.0` into the number `3`. A caller
 * that needs Python's `type(value) is int` (for example `status_summary`'s
 * `usage.limit`) names those leaves here; each is replaced by the exact
 * {@link JsonNumber} at the same path in the retained document.
 *
 * Containers are cloned only along a path that actually changes, so the rest
 * of a large queue keeps structural sharing and is never re-materialised.
 * Missing keys, `null` intermediates and non-number leaves leave the
 * materialised value alone; traversing a primitive or a container of the
 * wrong kind throws {@link StateValuePathError}. Array segments are canonical
 * non-negative indices only (`0`, `1`, ...); no other spelling is guessed.
 *
 * `acceptance.value` is never mutated. Object clones use own-property reads
 * and writes, so `__proto__` and similar keys cannot reach the prototype.
 */
export function stateValueWithNumbers(
  acceptance: CrqStateAcceptance,
  paths: readonly StateValuePath[],
): unknown {
  let value = acceptance.value;
  for (const path of paths) {
    if (path.length === 0) throw new StateValuePathError('path must name a leaf', path);
    value = spliceNumber(value, acceptance.document, path, path, 0);
  }
  return value;
}

const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

function spliceNumber(
  value: unknown,
  document: JsonValue,
  path: StateValuePath,
  fullPath: StateValuePath,
  offset: number,
): unknown {
  if (offset === path.length) return document instanceof JsonNumber ? document : value;
  const key = path[offset] as string;
  if (Array.isArray(value)) {
    if (!Array.isArray(document)) {
      throw new StateValuePathError('materialised and lossless containers differ', fullPath);
    }
    if (!ARRAY_INDEX.test(key)) {
      throw new StateValuePathError('array segment must be a canonical index', fullPath);
    }
    const index = Number(key);
    if (index >= value.length || index >= document.length) return value;
    const child: unknown = value[index];
    const replaced = spliceNumber(child, document[index] as JsonValue, path, fullPath, offset + 1);
    if (replaced === child) return value;
    const clone = value.slice();
    defineOwn(clone, index, replaced);
    return clone;
  }
  if (isPlainRecord(value)) {
    if (!(document instanceof JsonObject)) {
      throw new StateValuePathError('materialised and lossless containers differ', fullPath);
    }
    if (!Object.prototype.hasOwnProperty.call(value, key)) return value;
    const childDocument = document.get(key);
    if (childDocument === undefined) return value;
    const child = value[key];
    const replaced = spliceNumber(child, childDocument, path, fullPath, offset + 1);
    if (replaced === child) return value;
    const clone = clonePlainRecord(value);
    defineOwn(clone, key, replaced);
    return clone;
  }
  if (value === null || value === undefined) return value;
  throw new StateValuePathError('path traverses a non-container', fullPath);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function clonePlainRecord(value: Record<string, unknown>): Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  const clone = Object.create(prototype) as Record<string, unknown>;
  for (const key of Object.keys(value)) defineOwn(clone, key, value[key]);
  return clone;
}

function defineOwn(target: object, key: string | number, value: unknown): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/** Parse JSON text (or `next-review-at`'s bare timestamp) and validate it. */
export function parseCrqState(name: CrqStateSchemaName, text: string): CrqStateResult {
  let document: JsonValue;
  if (name === 'next-review-at.schema.json') {
    // Not JSON: one bare timestamp plus a newline; the schema describes the
    // stripped string.
    document = text.trim();
  } else {
    try {
      document = parseJsonValue(text, { duplicates: 'last' });
    } catch (error) {
      if (error instanceof JsonParseError) return { ok: false, issues: [error.message] };
      throw error;
    }
  }
  return validateCrqState(name, document);
}

/** Validate an already-parsed lossless document. */
export function validateCrqState(name: CrqStateSchemaName, document: JsonValue): CrqStateResult {
  const schema = crqStateSchemaDocuments[name];
  const zod = crqStateSchemas[name].safeParse(toPlainJson(document));
  const python = pythonSchemaAccepts(schema, document);
  if (zod.success !== python.accepted) {
    const divergence = zod.success
      ? `zod accepted a value the Python schema rejects: ${python.reason ?? 'unknown reason'}`
      : `zod rejected a value the Python schema accepts: ${zod.error.issues
          .slice(0, 3)
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`;
    return { ok: false, issues: [divergence], divergence };
  }
  if (!zod.success) {
    return {
      ok: false,
      issues: zod.error.issues.map((issue) => `${issue.path.join('.') || '$'}: ${issue.message}`),
    };
  }
  return { ok: true, document, value: zod.data };
}

/** Parse and validate every non-empty JSONL line, preserving line numbers. */
export function parseCrqStateLines(
  name: CrqStateSchemaName,
  text: string,
): Array<CrqStateResult & { line: number }> {
  const results: Array<CrqStateResult & { line: number }> = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return;
    results.push({ ...parseCrqState(name, line), line: index + 1 });
  });
  return results;
}
