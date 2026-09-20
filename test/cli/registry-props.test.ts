// T4.2 registry properties suite — test/cli/registry-props.test.ts.
//
// ws-a acceptance "Any op invokable standalone from TS with plain-object
// input; result JSON-serializable (property test over the shipped op
// registry as families land)".
//
// For EVERY shipped registry entry (all families, resolved through the same
// lazy central registry the CLI uses):
//   1. a schema-derived plain-object input ROUND-TRIPS through JSON —
//      `JSON.parse(JSON.stringify(input))` deep-equals the generated object,
//      so every op boundary takes a lossless plain-data input;
//   2. when the schema accepts that input, the schema's parsed RESULT
//      JSON-serializes (round-trips again) — the validated value the op runs
//      on is plain data;
//   3. the entry's importer resolves to an op function (lazy, side-effect
//      free at bind time).
//
// The op RESULT serialization is pinned over the pure sample (the same lane
// the parity suite dispatches): every returned OpResult must pass the frozen
// OpResultSchema, satisfy the CLI's own `assertJsonLossless` walk, and
// round-trip through JSON. Invoking effectful ops (gh/git/model/filesystem)
// from a unit test would not be hermetic, so the sample is the pure lane —
// the effectful lanes' artifacts are covered by their own family suites.
import { describe, expect, test } from 'vitest';
import { assertJsonLossless } from '../../src/cli/output.js';
import { OpResultSchema } from '../../src/kernel/schema.js';
import { clusterErrorsOp } from '../../src/ops/analyze/clusterErrors.js';
import { collectFailuresOp } from '../../src/ops/analyze/collectFailures.js';
import { hackDetector } from '../../src/ops/gates/hackDetector.js';
import { regressionGate } from '../../src/ops/gates/regressionGate.js';
import { checkDiffMonotonicity } from '../../src/ops/ratchet/monotonicGuard.js';
import { list } from '../../src/registry/index.js';

const entries = await list();

interface SchemaLike {
  def?: Record<string, unknown>;
  shape?: Record<string, unknown>;
}

/**
 * Build a plain-object SAMPLE from a zod 4 schema by walking its `.def`.
 * Deliberately permissive: refinements (branch-prefix rules, cross-field
 * couplings) are not satisfied — the property here is JSON-round-tripping,
 * not validity — and unknown/unsupported shapes degrade to `{}` rather than
 * throwing. Object schemas always yield a plain `{}`-prototype record.
 */
function sampleFor(schema: unknown, depth = 0): unknown {
  if (depth > 8) return {};
  const like = schema as SchemaLike;
  const def = like.def;
  if (def === undefined || typeof def['type'] !== 'string') return {};
  const inner = (): unknown => sampleFor(def['innerType'] ?? def['in'] ?? def['schema'], depth + 1);
  switch (def['type']) {
    case 'string':
      return 'x';
    case 'number':
    case 'bigint':
      return 0;
    case 'boolean':
      return true;
    case 'literal': {
      const values = def['values'];
      return Array.isArray(values) ? values[0] : null;
    }
    case 'enum': {
      const enumEntries = def['entries'];
      if (enumEntries !== null && typeof enumEntries === 'object') {
        return Object.values(enumEntries as Record<string, unknown>)[0];
      }
      return 'x';
    }
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'readonly':
    case 'catch':
      return inner();
    case 'array':
      return [];
    case 'record':
      return {};
    case 'tuple': {
      const items = def['items'];
      return Array.isArray(items) ? items.map((item) => sampleFor(item, depth + 1)) : [];
    }
    case 'union': {
      const options = def['options'];
      if (Array.isArray(options) && options.length > 0) return sampleFor(options[0], depth + 1);
      return {};
    }
    case 'pipe':
      return inner();
    case 'object': {
      const shape = like.shape;
      if (shape === undefined) return {};
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(shape)) out[key] = sampleFor(child, depth + 1);
      return out;
    }
    default:
      return {};
  }
}

/** A plain object: `{}`-prototype or null-prototype, never an array/class. */
function isPlainObject(value: unknown): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const cases = entries.map((entry) => [entry.name, entry] as const);

describe('every registry entry: schema-generated plain-object input round-trips', () => {
  test('the shipped registry exposes a non-trivial entry set', () => {
    expect(entries.length).toBeGreaterThan(20);
  });

  test.each(cases)('%s', async (_name, entry) => {
    const input = sampleFor(entry.inputSchema);
    expect(isPlainObject(input)).toBe(true);
    const roundTripped: unknown = JSON.parse(JSON.stringify(input));
    expect(roundTripped).toEqual(input);

    const parsed = entry.inputSchema.safeParse(roundTripped);
    if (parsed.success) {
      // The parse result (the value the op actually receives) is lossless
      // plain data too.
      expect(JSON.parse(JSON.stringify(parsed.data))).toEqual(parsed.data);
    }

    const op = await entry.importer();
    expect(typeof op).toBe('function');
  });
});

describe('pure sample: op results are JSON-serializable (OpResultSchema + the CLI walk)', () => {
  const samples: Array<[string, () => Promise<unknown>]> = [
    ['gates.regressionGate', () => regressionGate({ base: emptyTscSet(), final: emptyTscSet() })],
    ['gates.hackDetector', () => hackDetector({ diff: '' })],
    ['analyze.collectFailures', () => collectFailuresOp({ sets: [] })],
    ['analyze.clusterErrors', () => clusterErrorsOp({ set: emptyTscSet() })],
    ['ratchet.monotonicGuard', async () => ({ status: 'ok', value: checkDiffMonotonicity('') })],
  ];

  test.each(samples)(
    '%s: result passes OpResultSchema and round-trips JSON',
    async (_name, run) => {
      const result = await run();
      expect(OpResultSchema.safeParse(result).success).toBe(true);
      assertJsonLossless(result);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    },
  );

  function emptyTscSet(): { tool: string; failures: never[]; exitCode: number } {
    return { tool: 'tsc', failures: [], exitCode: 0 };
  }
});
