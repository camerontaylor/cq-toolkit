// Shared structured-output seam (ADR-0002 §2.3): the ONE place that turns a
// zod contract into the plain-data `OutputSchema` an invocation carries, and
// the ONE validator every lane runs after settle, over the SAME stripped
// document that was sent.
//
// WHY A SHARED MODULE: §2.3 makes the verdict uniform ("object obtained and
// it validates → complete"; anything else → error/'output-invalid') while
// the transport stays native per lane. Uniformity is only honest if every
// lane judges the payload by the same document it handed the vendor — so the
// strip below is deterministic, and `validateStructured` re-derives its zod
// schema from `os.schema` itself, never from the caller's original.
//
// RELATIONSHIP TO src/driver/json-schema.ts: that helper is the CLI-bound
// meta guard (issue #209) — it SILENTLY DROPS `$schema` and any absolute
// json-schema.org reference, because the claude CLI has no registry lookup.
// The seam needs the stricter rule an ADR can state: external references are
// a CONTRACT ERROR, not something to quietly widen — `toOutputSchema` throws
// naming the offender. The grammar knowledge (value keywords are data,
// name→schema maps keep their keys) is aligned with that file; the drop
// semantics deliberately are not shared, so this module owns its walk.
//
// Driver-family rule: no imports from src/kernel.

import { z } from 'zod';
import { boundedErrorText } from '../error-text.js';
import type { JsonSchema, OutputSchema, WorkerResult } from '../types.js';

/**
 * Keywords whose content is arbitrary DATA, never a subschema — copied
 * verbatim, never recursed, never audited for reference keys. A `const`
 * payload that merely LOOKS like a schema survives intact.
 */
const VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  'const',
  'default',
  'examples',
  'enum',
  'dependentRequired',
]);

/** Keywords whose value is a name→schema map — keys verbatim, values walked. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
]);

/**
 * Deep clone of arbitrary DATA (never a schema position) — verbatim,
 * null-prototype objects so an own `__proto__` key parsed from JSON survives
 * as a property instead of mutating the prototype.
 */
function cloneData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneData(entry));
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = cloneData(entry);
    }
    return out;
  }
  return value;
}

/** A name→schema map: KEYS verbatim, VALUES walked as schema positions. */
function cloneSchemaMap(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return cloneData(value); // malformed map — copy verbatim
  }
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    out[key] = cloneSchema(entry);
  }
  return out;
}

/**
 * The strip walk: returns a deep clone of `schema` with every `$schema` key
 * removed from genuine schema positions (top level and nested). Data
 * positions are copied verbatim, so a property literally named `$schema` or
 * a const payload shaped like a schema is untouched.
 */
function cloneSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => cloneSchema(entry));
  if (value !== null && typeof value === 'object') {
    const out = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (key === '$schema') continue;
      if (VALUE_KEYWORDS.has(key)) out[key] = cloneData(entry);
      else if (SCHEMA_MAP_KEYWORDS.has(key)) out[key] = cloneSchemaMap(entry);
      else out[key] = cloneSchema(entry);
    }
    return out;
  }
  return value;
}

/**
 * Resolves a reference against the root of the STRIPPED document, JSON
 * Pointer style (RFC 6901): `#` is the root; `#/a/b` walks `a` then `b`,
 * with `~1`→`/` and `~0`→`~` unescaped in that order. `false` for anything
 * that is not a within-document pointer.
 */
function resolvesInternally(root: unknown, ref: string): boolean {
  if (ref === '#') return true;
  if (!ref.startsWith('#/')) return false;
  let target: unknown = root;
  for (const rawToken of ref.slice(2).split('/')) {
    const token = rawToken.replaceAll('~1', '/').replaceAll('~0', '~');
    if (target === null || typeof target !== 'object') return false;
    if (Array.isArray(target)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= target.length) return false;
      target = target[index];
    } else {
      const record = target as Record<string, unknown>;
      if (!Object.prototype.hasOwnProperty.call(record, token)) return false;
      target = record[token];
    }
  }
  return true;
}

/**
 * The audit walk: every `$ref` at a genuine schema position must resolve
 * WITHIN the stripped document. External URIs (anything not a `#` pointer)
 * and dangling internal pointers throw a plain Error NAMING the reference —
 * the seam forbids external `$ref` because lanes hand the document to
 * vendors that resolve nothing outside it. Internal `$ref`/`$defs` zod
 * legitimately emits (recursive and `reused: 'ref'` shapes) are KEPT.
 */
function auditRefs(value: unknown, root: unknown): void {
  if (Array.isArray(value)) {
    for (const entry of value) auditRefs(entry, root);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (key === '$ref') {
      if (typeof entry !== 'string' || !resolvesInternally(root, entry)) {
        throw new Error(
          `toOutputSchema: the produced JSON Schema contains a $ref that cannot resolve within the document: ${String(entry)}`,
        );
      }
      continue;
    }
    if (VALUE_KEYWORDS.has(key)) continue;
    if (SCHEMA_MAP_KEYWORDS.has(key)) {
      if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
        for (const subschema of Object.values(entry as Record<string, unknown>)) {
          auditRefs(subschema, root);
        }
      }
      continue;
    }
    auditRefs(entry, root);
  }
}

/**
 * Builds the plain-data `OutputSchema` an `OpInvocation` carries: `name` is
 * the stable contract name (journalled, surfaced in diagnostics), `schema`
 * is the zod contract rendered as a draft 2020-12 JSON Schema with every
 * `$schema` meta-URI key stripped and every remaining `$ref` resolving
 * within the document.
 *
 * `io: 'input'` is LOAD-BEARING: the document constrains what a worker may
 * RETURN, and the after-settle validator feeds parsed JSON back INTO a
 * schema. Under zod's default `io: 'output'`, a non-strict object contract
 * (e.g. the merge decision schema, deliberately tolerant of unknown keys)
 * would be emitted with `additionalProperties: false`, and the round trip
 * would silently TIGHTEN the contract — a tolerable output would flip into
 * a fabricated 'output-invalid'. With `io: 'input'` a tolerant object stays
 * tolerant, while `.strict()` contracts still emit `additionalProperties:
 * false` (their catchall is `never` either way). The differential test over
 * the shipped op schemas pins verdict equality through this seam.
 *
 * Throws a plain Error when `name` is empty/blank or when the produced
 * document carries a `$ref` that cannot resolve within it.
 */
export function toOutputSchema(name: string, schema: z.ZodType): OutputSchema {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new Error('toOutputSchema: a non-empty contract name is required');
  }
  const emitted = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
  const stripped = cloneSchema(emitted) as JsonSchema;
  auditRefs(stripped, stripped);
  return { name, schema: stripped };
}

/**
 * The shared PRE-DISPATCH compile check (PR #238 review round 2): the
 * invocation schema is caller-authored plain data, so a lane compiles it
 * BEFORE shipping the document to its provider — an uncompilable document
 * (an unresolvable/unrepresentable doc) must surface as the uniform
 * `output-invalid` verdict compiled locally, never as a provider/harness
 * failure from a request-setup rejection. Returns the compiler's objection
 * (the same text `validateStructured` reports), or `undefined` when the
 * document compiles.
 */
export function compileOutputSchemaFault(os: OutputSchema): string | undefined {
  try {
    z.fromJSONSchema(os.schema as unknown as z.core.JSONSchema.JSONSchema);
    return undefined;
  } catch (err) {
    return `schema '${os.name}' could not be compiled from its JSON Schema document: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/**
 * The uniform LOCAL verdict for an invocation schema that failed the
 * preflight (PR #238 review round 2) — the settle-time miss shape, built in
 * one place so every lane that ships the document to a provider settles an
 * uncompilable schema identically: zero usage, no denials, no sessionId (no
 * record exists), the objection bounded and secret-redacted.
 */
export function uncompilableSchemaVerdict(lane: string, fault: string): WorkerResult {
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    denials: [],
    stopReason: 'error',
    error: boundedErrorText(`${lane} driver: structured output invalid — ${fault}`),
    errorClass: 'output-invalid',
  };
}

/**
 * The shared after-settle validator (ADR-0002 §2.3): judge `value` against
 * the SAME stripped document that was sent to the lane. The zod schema is
 * re-derived from `os.schema` (never the caller's original contract), so a
 * lane cannot pass a doc it did not validate against. Never mutates `value`;
 * on `ok` returns the schema-normalised plain JSON (e.g. unknown keys are
 * treated exactly as the emitted document treats them). A document that
 * cannot even COMPILE is an `ok: false` result naming the schema and the
 * compiler's objection — the same objection {@link compileOutputSchemaFault}
 * preflights before dispatch.
 */
export function validateStructured(
  os: OutputSchema,
  value: unknown,
): { ok: true; value: unknown } | { ok: false; reason: string } {
  // `JsonSchema` is deliberately the loose plain-data seam type; zod's
  // importer wants its own (structurally identical) JSON Schema type.
  const fault = compileOutputSchemaFault(os);
  if (fault !== undefined) {
    return { ok: false, reason: fault };
  }
  const schema = z.fromJSONSchema(os.schema as unknown as z.core.JSONSchema.JSONSchema);
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, reason: z.prettifyError(parsed.error) };
  }
  return { ok: true, value: parsed.data };
}
