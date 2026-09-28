// The validator decision rule for seam v2 (ADR-0002 §2.3, checklist W3.3):
// the zod 4.6.4 JSON-Schema path — `z.toJSONSchema` into `toOutputSchema`,
// `z.fromJSONSchema` inside `validateStructured` — must round-trip the
// shipped op contracts with verdict EQUALITY against the zod originals, over
// a corpus of valid AND invalid samples. This differential is the evidence
// that the shared after-settle validator never tightens or loosens a
// contract on its way through the seam; the ajv pivot is reserved as a
// recorded decision if any schema fails it.
//
// Corpus rule: every sample is JSON-representable. `validateStructured`'s
// input is always PARSED JSON (the lanes hand over what the vendor
// returned), so a key explicitly set to `undefined` cannot reach it and the
// exactOptional absent-vs-undefined distinction is not observable through
// the seam — such samples would test a case that cannot occur.
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { toOutputSchema, validateStructured } from '../../src/driver/common/structured.js';
import type { OutputSchema } from '../../src/driver/types.js';
import { AGENTIC_PROPOSAL_SCHEMA } from '../../src/ops/analyze/agenticRemediation.js';
import { MergeConflictDecisionSchema } from '../../src/ops/merge/resolveConflict.js';
import { FixReviewItemOutputSchema } from '../../src/ops/review/fixReviewItem.js';

/** The shape the v2 conformance suite puts on structured-output legs. */
const ConformanceAnswerSchema = z.object({ answer: z.string() }).strict();

/** The reused shape zod renders as `$defs` + internal `$ref` (id metadata). */
const InnerShapeSchema = z.object({ q: z.string() }).meta({ id: 'inner' });
const ReusedDefsSchema = z.object({ a: InnerShapeSchema, b: InnerShapeSchema });

/** The recursive shape zod renders with a root `$ref: '#'`. */
interface LazyNode {
  name: string;
  children: LazyNode[];
}
const RecursiveNodeSchema: z.ZodType<LazyNode> = z.object({
  name: z.string(),
  children: z.array(z.lazy(() => RecursiveNodeSchema)),
});

interface DifferentialCase {
  /** The journalled contract name handed to `toOutputSchema`. */
  name: string;
  schema: z.ZodType;
  /** Samples the ORIGINAL zod contract must accept. */
  valid: unknown[];
  /** Representative samples the original must reject. */
  invalid: unknown[];
}

/**
 * The four shipped/conformance contracts. The merge decision is the
 * load-bearing one: it is deliberately NOT `.strict()` (unknown keys are
 * tolerated), so any emission that closes the object — zod's default
 * `io: 'output'` emits `additionalProperties: false` — fails this
 * differential on the `{decision, summary, extra}` sample.
 */
const CASES: DifferentialCase[] = [
  {
    name: 'merge.resolveConflict/v1',
    schema: MergeConflictDecisionSchema,
    valid: [
      { decision: 'acted' },
      { decision: 'acted', summary: 'resolved by rebase onto main' },
      { decision: 'escalated', summary: 'both sides rewrote the hunk', extra: 1 },
    ],
    invalid: [{}, { decision: 'nope' }, { decision: 'acted', summary: 5 }, 'acted', null],
  },
  {
    name: 'review.fixItem/v1',
    schema: FixReviewItemOutputSchema,
    valid: [
      { changed: true, summary: 'extracted helper', commits: [] },
      { changed: false, summary: 'no change needed', commits: ['a'.repeat(40)] },
    ],
    invalid: [
      { changed: true, summary: 'missing commits' },
      { changed: true, summary: 'extra key', commits: [], zz: 1 },
      { changed: 'yes', summary: 'wrong type', commits: [] },
      { changed: true, summary: 'commits not an array', commits: 'abc' },
    ],
  },
  {
    name: 'analyze.agenticRemediation/v1',
    schema: AGENTIC_PROPOSAL_SCHEMA,
    valid: [
      { summary: 'extract the retry loop into a helper' },
      { summary: 'rewrite the parser', patch: 'diff --git a/x b/x' },
    ],
    invalid: [
      { summary: '' },
      { summary: 'empty patch', patch: '' },
      { summary: 'wrong patch type', patch: 5 },
      {},
      { summary: 'strict extra key', patch: 'p', extra: 1 },
    ],
  },
  {
    name: 'conformance.answer/v1',
    schema: ConformanceAnswerSchema,
    valid: [{ answer: 'yes' }, { answer: '' }],
    invalid: [{ answer: 42 }, { answer: 'yes', extra: true }, {}, 'yes', null],
  },
];

/** True when `key` exists at ANY depth of the document. */
function hasKeyDeep(value: unknown, key: string): boolean {
  if (Array.isArray(value)) return value.some((entry) => hasKeyDeep(entry, key));
  if (value === null || typeof value !== 'object') return false;
  return Object.entries(value as Record<string, unknown>).some(
    ([k, entry]) => k === key || hasKeyDeep(entry, key),
  );
}

/** `z.fromJSONSchema` over the stripped document, the validator's own path. */
function reconstructionOf(os: OutputSchema): z.ZodType {
  return z.fromJSONSchema(os.schema as unknown as Parameters<typeof z.fromJSONSchema>[0]);
}

describe('toOutputSchema + validateStructured — zod round-trip differential (W3.3)', () => {
  for (const fixture of CASES) {
    const validCount = fixture.valid.length;
    const invalidCount = fixture.invalid.length;
    test(`${fixture.name} — verdict equality over ${validCount} valid + ${invalidCount} invalid samples`, () => {
      // (a) the document is produced at all.
      const os = toOutputSchema(fixture.name, fixture.schema);
      expect(os.name).toBe(fixture.name);
      expect(typeof os.schema).toBe('object');

      // Corpus sanity: the ORIGINAL zod contract's verdicts are what the
      // differential is measured against — a mislabeled sample must fail
      // here, not silently weaken the evidence.
      for (const sample of fixture.valid) {
        expect(fixture.schema.safeParse(sample).success, JSON.stringify(sample)).toBe(true);
      }
      for (const sample of fixture.invalid) {
        expect(fixture.schema.safeParse(sample).success, JSON.stringify(sample)).toBe(false);
      }

      // (b) the reconstruction accepts every valid sample.
      const back = reconstructionOf(os);
      for (const sample of fixture.valid) {
        expect(back.safeParse(sample).success, JSON.stringify(sample)).toBe(true);
      }

      // (c) the reconstruction rejects the representative invalid samples.
      for (const sample of fixture.invalid) {
        expect(back.safeParse(sample).success, JSON.stringify(sample)).toBe(false);
      }

      // (d) THE DIFFERENTIAL: validateStructured agrees with the original
      // zod contract's safeParse verdict over the WHOLE corpus.
      for (const sample of [...fixture.valid, ...fixture.invalid]) {
        const expected = fixture.schema.safeParse(sample).success;
        const actual = validateStructured(os, sample);
        expect(actual.ok, JSON.stringify(sample)).toBe(expected);
      }
    });
  }

  test('normalization: strict contract returns the parsed plain JSON; tolerant contract keeps tolerance', () => {
    // Strict: the ok value is the schema-normalised object.
    const fix = toOutputSchema('review.fixItem/v1', FixReviewItemOutputSchema);
    const sample = { changed: true, summary: 'extracted helper', commits: ['a'.repeat(40)] };
    const result = validateStructured(fix, sample);
    assert(result.ok);
    expect(result.value).toEqual(sample);
    expect(result.value).not.toBe(sample);

    // Tolerant: an unknown key passes through the reconstruction too — the
    // strip keeps the contract's tolerance (zod renders a document without
    // additionalProperties, and fromJSONSchema rebuilds a passthrough
    // object), so the seam never turns a tolerable output into a failure.
    const merge = toOutputSchema('merge.resolveConflict/v1', MergeConflictDecisionSchema);
    const extra = { decision: 'escalated', summary: 's', extra: 1 };
    expect(validateStructured(merge, extra).ok).toBe(true);
  });

  test('recursive contract: internal $ref kept, resolvable, and still validated', () => {
    const os = toOutputSchema('fixture.recursive/v1', RecursiveNodeSchema);
    // The root self-reference zod emits survives the strip…
    expect(JSON.stringify(os.schema)).toContain('#');
    // …and the document still validates through it, both directions.
    expect(validateStructured(os, { name: 'a', children: [{ name: 'b', children: [] }] }).ok).toBe(
      true,
    );
    expect(validateStructured(os, { name: 'a', children: [{}] }).ok).toBe(false);
    expect(validateStructured(os, { name: 'a', children: 'x' }).ok).toBe(false);
  });

  test('reused contract: $defs + internal $ref preserved and resolving', () => {
    const os = toOutputSchema('fixture.reused/v1', ReusedDefsSchema);
    const doc = JSON.stringify(os.schema);
    expect(doc).toContain('#/$defs/inner');
    expect(validateStructured(os, { a: { q: 'x' }, b: { q: 'y' } }).ok).toBe(true);
    expect(validateStructured(os, { a: { q: 'x' }, b: {} }).ok).toBe(false);
  });
});

describe('toOutputSchema — seam guards', () => {
  test('strips the $schema meta URI anywhere (top level and nested)', () => {
    const top = toOutputSchema('conformance.answer/v1', ConformanceAnswerSchema);
    expect(hasKeyDeep(top.schema, '$schema')).toBe(false);

    // A meta-injected NESTED $schema survives zod's emission; the strip
    // still removes it from the subschema position.
    const nested = z.object({ inner: z.string().meta({ $schema: 'https://json-schema.org/x' }) });
    const os = toOutputSchema('fixture.nested/v1', nested);
    expect(hasKeyDeep(os.schema, '$schema')).toBe(false);
    expect(validateStructured(os, { inner: 'x' }).ok).toBe(true);
  });

  test('throws naming an EXTERNAL $ref — including the json-schema.org meta URI the CLI stripper silently drops', () => {
    const external = z.string().meta({ $ref: 'https://example.com/external' });
    expect(() => toOutputSchema('fixture.external/v1', external)).toThrow(
      'https://example.com/external',
    );
    const meta = z.string().meta({ $ref: 'https://json-schema.org/draft/2020-12/schema' });
    expect(() => toOutputSchema('fixture.meta/v1', meta)).toThrow(
      'https://json-schema.org/draft/2020-12/schema',
    );
  });

  test('throws naming an internal $ref that cannot resolve within the document', () => {
    const dangling = z.string().meta({ $ref: '#/$defs/missing' });
    expect(() => toOutputSchema('fixture.dangling/v1', dangling)).toThrow('#/$defs/missing');
  });

  test('requires a non-empty name', () => {
    expect(() => toOutputSchema('', ConformanceAnswerSchema)).toThrow(/name/);
    expect(() => toOutputSchema('   ', ConformanceAnswerSchema)).toThrow(/name/);
  });
});

describe('validateStructured — seam guards', () => {
  test('never mutates its input, including a deeply frozen value', () => {
    const os = toOutputSchema('review.fixItem/v1', FixReviewItemOutputSchema);
    const snapshot = Object.freeze({
      changed: true,
      summary: 'extracted helper',
      commits: Object.freeze(['a'.repeat(40)]),
    });
    const before = structuredClone(snapshot);
    const result = validateStructured(os, snapshot);
    expect(result.ok).toBe(true);
    expect(snapshot).toEqual(before);
  });

  test('rejects with a non-empty reason that names the failing path', () => {
    const os = toOutputSchema('conformance.answer/v1', ConformanceAnswerSchema);
    const result = validateStructured(os, { answer: 42 });
    assert(!result.ok);
    expect(result.reason.length).toBeGreaterThan(0);
    expect(result.reason).toContain('answer');
  });
});

/** Vitest-free assertion narrow used to satisfy the type checker above. */
function assert(condition: boolean): asserts condition {
  if (!condition) throw new Error('assertion failed');
}
