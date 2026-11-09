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
import { JsonParseError, parseJsonValue, toPlainJson, type JsonValue } from './jsonValue.js';
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
