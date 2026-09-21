// `stripMetaSchema` — the draft-2020-12 meta-URI guard (issue #209).
//
// `z.toJSONSchema()` emits a top-level `$schema` draft-2020-12 URI; the
// Claude Code CLI rejects it pre-model when it arrives as `--json-schema` /
// the SDK's `outputFormat.schema`:
//
//   Error: --json-schema is not a valid JSON Schema: no schema with key or
//   ref "https://json-schema.org/draft/2020-12/schema"
//
// These are the helper-level pins: the meta URI (and any `$ref` to it) is
// gone, everything else survives a DEEP clone, and the caller's object is
// never mutated. The drivers' own tests cover the wiring.
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { stripMetaSchema } from '../../src/driver/json-schema.js';

const DRAFT_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

describe('stripMetaSchema — removes the meta URI, deep-clones everything else', () => {
  test('removes a top-level $schema, preserves every other key/value', () => {
    const input: Record<string, unknown> = {
      $schema: DRAFT_2020_12,
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    };
    expect(stripMetaSchema(input)).toEqual({
      type: 'object',
      properties: { answer: { type: 'string' } },
      required: ['answer'],
      additionalProperties: false,
    });
  });

  test('removes a nested $schema inside a subschema', () => {
    const input: Record<string, unknown> = {
      type: 'object',
      properties: {
        nested: { $schema: DRAFT_2020_12, type: 'string' },
      },
    };
    expect(stripMetaSchema(input)).toEqual({
      type: 'object',
      properties: { nested: { type: 'string' } },
    });
  });

  test('removes an absolute meta $ref but keeps internal #/ refs and $defs', () => {
    const input: Record<string, unknown> = {
      $defs: { x: { type: 'string' } },
      type: 'object',
      properties: {
        internal: { $ref: '#/$defs/x' },
        external: { $ref: DRAFT_2020_12 },
        insecure: { $ref: 'http://json-schema.org/draft-07/schema' },
        sibling: { $ref: '#/$defs/x', description: 'kept' },
      },
    };
    expect(stripMetaSchema(input)).toEqual({
      $defs: { x: { type: 'string' } },
      type: 'object',
      properties: {
        internal: { $ref: '#/$defs/x' },
        external: {},
        insecure: {},
        sibling: { $ref: '#/$defs/x', description: 'kept' },
      },
    });
  });

  test('absolute meta $dynamicRef/$recursiveRef are dropped; internal dynamic refs survive', () => {
    const input: Record<string, unknown> = {
      $defs: { x: { type: 'string' } },
      type: 'object',
      $ref: DRAFT_2020_12,
      $dynamicRef: DRAFT_2020_12,
      $recursiveRef: DRAFT_2020_12,
      properties: {
        internal: { $dynamicRef: '#/$defs/x' },
      },
    };
    expect(stripMetaSchema(input)).toEqual({
      $defs: { x: { type: 'string' } },
      type: 'object',
      properties: { internal: { $dynamicRef: '#/$defs/x' } },
    });
  });

  test('does not mutate the input, at any depth', () => {
    const input: Record<string, unknown> = {
      $schema: DRAFT_2020_12,
      $defs: { x: { $schema: DRAFT_2020_12, type: 'string' } },
      properties: { list: [{ $schema: DRAFT_2020_12, type: 'number' }] },
      anyOf: [{ $ref: DRAFT_2020_12 }],
    };
    const snapshot = structuredClone(input);
    const out = stripMetaSchema(input);
    expect(input).toEqual(snapshot); // untouched
    expect(out).not.toBe(input);
    expect(out['$defs']).not.toBe(input['$defs']);
  });

  test('walks nested arrays and objects', () => {
    const input: Record<string, unknown> = {
      $schema: DRAFT_2020_12,
      anyOf: [
        { type: 'object', properties: { a: { $schema: DRAFT_2020_12, type: 'string' } } },
        { type: 'array', items: [{ $schema: DRAFT_2020_12, $ref: DRAFT_2020_12 }] },
      ],
    };
    expect(stripMetaSchema(input)).toEqual({
      anyOf: [
        { type: 'object', properties: { a: { type: 'string' } } },
        { type: 'array', items: [{}] },
      ],
    });
  });

  test('value-bearing keywords (const/default/examples/enum) are copied verbatim', () => {
    const payload = { $schema: DRAFT_2020_12, $ref: DRAFT_2020_12 };
    const input: Record<string, unknown> = {
      $schema: DRAFT_2020_12,
      type: 'object',
      const: payload,
      default: { $schema: DRAFT_2020_12 },
      examples: [payload, { nested: { $ref: DRAFT_2020_12 } }],
      enum: [{ $schema: DRAFT_2020_12 }],
    };
    const out = stripMetaSchema(input);
    // The top-level (real) $schema is gone; every value keyword is intact.
    expect(out).toEqual({
      type: 'object',
      const: payload,
      default: { $schema: DRAFT_2020_12 },
      examples: [payload, { nested: { $ref: DRAFT_2020_12 } }],
      enum: [{ $schema: DRAFT_2020_12 }],
    });
    // Still a deep clone — the data values are not aliased to the input.
    expect(out['const']).not.toBe(payload);
    expect(out['examples']).not.toBe(input['examples']);
  });

  test('a property literally named $schema survives (name→schema map keys are verbatim)', () => {
    const input: Record<string, unknown> = {
      type: 'object',
      properties: {
        $schema: { type: 'string' },
        $ref: { type: 'string' },
        nested: { $schema: DRAFT_2020_12, type: 'number' },
      },
      $defs: { $schema: { type: 'string' } },
      dependentSchemas: { $schema: { type: 'string' } },
    };
    expect(stripMetaSchema(input)).toEqual({
      type: 'object',
      properties: {
        $schema: { type: 'string' }, // the KEY is data, kept
        $ref: { type: 'string' },
        nested: { type: 'number' }, // the VALUE is a schema, $schema stripped
      },
      $defs: { $schema: { type: 'string' } },
      dependentSchemas: { $schema: { type: 'string' } },
    });
  });

  test('dependentRequired is data, not a schema — its entries are copied verbatim', () => {
    const input: Record<string, unknown> = {
      type: 'object',
      dependentRequired: { $schema: ['x'], other: ['y', 'z'] },
    };
    expect(stripMetaSchema(input)).toEqual({
      type: 'object',
      dependentRequired: { $schema: ['x'], other: ['y', 'z'] },
    });
  });

  test('an own __proto__ key survives as a property (null-prototype output)', () => {
    const input = JSON.parse('{"type":"object","__proto__":{"type":"string"}}') as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(input, '__proto__')).toBe(true); // JSON.parse makes it own
    const out = stripMetaSchema(input);
    expect(Object.hasOwn(out, '__proto__')).toBe(true);
    expect(out['__proto__']).toEqual({ type: 'string' });
    expect(Object.getPrototypeOf(out)).toBeNull(); // no prototype pollution
  });

  test("zod's real output: the emitted $schema is stripped, the body survives", () => {
    const schema = z.object({ answer: z.string() }).strict();
    const emitted = z.toJSONSchema(schema) as Record<string, unknown>;
    expect(emitted['$schema']).toBe(DRAFT_2020_12); // the CLI-rejected key
    const stripped = stripMetaSchema(emitted);
    expect(stripped['$schema']).toBeUndefined();
    const expected: Record<string, unknown> = { ...emitted };
    delete expected['$schema'];
    expect(stripped).toEqual(expected);
  });
});
