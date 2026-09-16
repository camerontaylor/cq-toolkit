// Analyze lane G1 — registry-slice test evidence: the two NEW entries
// (analyze.collectFailures, analyze.clusterErrors) validate the full input
// and only it — strict unknown-key rejection is load-bearing at every family
// boundary — and their importers resolve lazily to the ops (the aggregator
// with its policy-to-failed mapping, the pure clustering decision op).
import { describe, expect, test } from 'vitest';
import { fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import { FailureSetSchema } from '../../../src/ops/gates/registry.js';
import {
  ANALYZE_IDENTIFIER_ENCODED_MAX,
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  LedgerViewSchema,
  registry,
} from '../../../src/ops/analyze/registry.js';

/** A minimal valid FailureSet (the gates registry test's idiom). */
const EMPTY_FAILURE_SET = { tool: 'eslint', failures: [], exitCode: 0 };

describe('analyze registry: the two G1 entries', () => {
  test('the registry names the lane ops in order', () => {
    expect(registry.map((entry) => entry.name)).toEqual([
      'analyze.collectFailures',
      'analyze.clusterErrors',
    ]);
  });
});

describe('CollectFailuresInputSchema (full input, and only it)', () => {
  test('parses the full input: an array of FailureSets', () => {
    const valid = {
      sets: [
        {
          tool: 'eslint',
          failures: [
            {
              file: 'src/a.ts',
              line: 5,
              column: 1,
              ruleId: 'prefer-const',
              message: 'm',
              severity: 'error',
            },
          ],
          exitCode: 1,
        },
        { tool: 'eslint', failures: [], exitCode: null },
      ],
    };
    expect(CollectFailuresInputSchema.parse(valid)).toEqual(valid);
  });

  test("an EMPTY sets array is a valid SHAPE — the empty-aggregate policy is the op's `failed`, not the boundary's", () => {
    expect(CollectFailuresInputSchema.parse({ sets: [] })).toEqual({ sets: [] });
  });

  test('rejects sets that do not mirror the gates FailureSet, and smuggled keys', () => {
    expect(CollectFailuresInputSchema.safeParse({ sets: [{ tool: 5 }] }).success).toBe(false);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: 'eslint', failures: [], exitCode: '0' }],
      }).success,
    ).toBe(false);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [],
        cache: true, // a smuggled memoization field must fail loudly (I7)
      }).success,
    ).toBe(false);
    expect(CollectFailuresInputSchema.safeParse({}).success).toBe(false);
  });
});

describe('LedgerViewSchema (the frozen ledger view, mirrored here)', () => {
  test('parses a full view with bounded entries', () => {
    const valid = {
      entries: [{ signature: 'a'.repeat(8), count: 2, component: 'src/ops/analyze' }],
      knownNoise: ['a'.repeat(8)],
      needsHuman: [],
    };
    expect(LedgerViewSchema.parse(valid)).toEqual(valid);
  });

  test('rejects entries outside the ledger record boundary (one definition of the bounds)', () => {
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: '', count: 1 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x', count: 0 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x'.repeat(501), count: 1 }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({
        entries: [{ signature: 'x', count: 1, component: '' }],
        knownNoise: [],
        needsHuman: [],
      }).success,
    ).toBe(false);
  });

  test('rejects a wrong-shaped view and smuggled keys', () => {
    expect(
      LedgerViewSchema.safeParse({ entries: [], knownNoise: {}, needsHuman: [] }).success,
    ).toBe(false);
    expect(
      LedgerViewSchema.safeParse({ entries: [], knownNoise: [], needsHuman: [], extra: 1 }).success,
    ).toBe(false);
  });
});

describe('ClusterErrorsInputSchema (full input, and only it)', () => {
  const VALID = { set: EMPTY_FAILURE_SET };

  test('parses the input with and without the optional ledger view', () => {
    expect(ClusterErrorsInputSchema.parse(VALID)).toEqual(VALID);
    const withLedger = {
      ...VALID,
      ledger: { entries: [], knownNoise: ['sig'], needsHuman: ['sig'] },
    };
    expect(ClusterErrorsInputSchema.parse(withLedger)).toEqual(withLedger);
  });

  test('an explicit ledger null is NOT a view (exactOptional, like the frozen type)', () => {
    expect(ClusterErrorsInputSchema.safeParse({ ...VALID, ledger: null }).success).toBe(false);
  });

  test('rejects a set that does not mirror the FailureSet, and smuggled keys', () => {
    expect(ClusterErrorsInputSchema.safeParse({ set: { failures: [] } }).success).toBe(false);
    expect(ClusterErrorsInputSchema.safeParse({ ...VALID, verdict: 'no-clusters' }).success).toBe(
      false,
    );
  });
});

describe('the G1 importers resolve', () => {
  test('analyze.collectFailures resolves to an op and aggregates through it', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.collectFailures');
    if (!entry) throw new Error('analyze.collectFailures missing from the registry');
    expect(typeof entry.inputSchema).toBe('object');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    const result = await op({
      sets: [
        { tool: 'eslint', failures: [], exitCode: 0 },
        { tool: 'eslint', failures: [], exitCode: 0 },
      ],
    });
    expect(result).toEqual({
      status: 'ok',
      value: { tool: 'eslint', failures: [], exitCode: 0 },
    });
  });

  test('analyze.clusterErrors resolves to an op and clusters through it', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.clusterErrors');
    if (!entry) throw new Error('analyze.clusterErrors missing from the registry');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    // The importer's op is erased to Op<unknown, unknown>, so the assertion
    // is over the WHOLE result (the registry-c2 idiom) with the expected
    // cluster spelled out — signature-derived id included.
    const first = {
      file: 'src/a.ts',
      line: 1,
      column: 1,
      ruleId: 'r',
      message: 'boom 1',
      severity: 'error',
    };
    const second = {
      file: 'src/b.ts',
      line: 2,
      column: 1,
      ruleId: 'r',
      message: 'boom 2',
      severity: 'error',
    };
    const signature = JSON.stringify(['eslint', 'r', 'boom <num>']);
    const result = await op({ set: { tool: 'eslint', failures: [first, second], exitCode: 1 } });
    expect(result).toEqual({
      status: 'ok',
      value: {
        clusters: [
          {
            id: fnv1a32Hex(signature),
            signature,
            tool: 'eslint',
            ruleId: 'r',
            confidence: 'high',
            failures: [first, second],
            size: 2,
          },
        ],
        noise: [],
      },
    });
  });
});

describe('the analyze boundary bounds tool/ruleId by ENCODED size (provable signature convergence)', () => {
  // The repo's longest enabled lint rule id — 46 raw chars, ~48 encoded —
  // must pass untouched: a raw-length cap would reject it before either op
  // ran (audit round 1, A1).
  const REAL_RULE_ID = 'typescript/no-non-null-asserted-optional-chain';
  const failureWith = (ruleId: string) => ({
    file: null,
    line: null,
    column: null,
    ruleId,
    message: 'm',
    severity: 'error',
  });

  test('a real 46-char rule id is ACCEPTED on both ops', () => {
    expect(REAL_RULE_ID.length).toBe(46);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: 'oxlint', failures: [failureWith(REAL_RULE_ID)], exitCode: 1 }],
      }).success,
    ).toBe(true);
    expect(
      ClusterErrorsInputSchema.safeParse({
        set: { tool: 'oxlint', failures: [failureWith(REAL_RULE_ID)], exitCode: 1 },
      }).success,
    ).toBe(true);
  });

  test('a tool whose ENCODING exceeds the bound is rejected on both ops (200 quotes → 402 units)', () => {
    const quoted = '"'.repeat(200);
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: quoted, failures: [], exitCode: 0 }],
      }).success,
    ).toBe(false);
    expect(
      ClusterErrorsInputSchema.safeParse({ set: { tool: quoted, failures: [], exitCode: 1 } })
        .success,
    ).toBe(false);
  });

  test('the encoded bound is exact: 120 encoded units accepted, 121 rejected, message names the bound', () => {
    // 118 raw 'x' chars encode to 120 units (two surrounding quotes); 119
    // raw encode to 121. Both sit far under the loose 500 raw cap — the
    // ENCODED check is what rejects, escape-proof.
    const atBound = 'x'.repeat(ANALYZE_IDENTIFIER_ENCODED_MAX - 2);
    const overBound = 'x'.repeat(ANALYZE_IDENTIFIER_ENCODED_MAX - 1);
    expect(
      ClusterErrorsInputSchema.safeParse({
        set: { tool: atBound, failures: [failureWith(atBound)], exitCode: 1 },
      }).success,
    ).toBe(true);
    for (const [schema, input] of [
      [CollectFailuresInputSchema, { sets: [{ tool: overBound, failures: [], exitCode: 0 }] }],
      [ClusterErrorsInputSchema, { set: { tool: overBound, failures: [], exitCode: 1 } }],
      // Chain symmetry: an over-encoded ruleId is rejected by BOTH ops.
      [
        CollectFailuresInputSchema,
        {
          sets: [{ tool: 'eslint', failures: [failureWith(overBound)], exitCode: 1 }],
        },
      ],
      [
        ClusterErrorsInputSchema,
        { set: { tool: 'eslint', failures: [failureWith(overBound)], exitCode: 1 } },
      ],
    ] as const) {
      const parsed = schema.safeParse(input);
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      const issue = parsed.error.issues[0];
      expect(issue === undefined).toBe(false);
      expect(issue?.message).toContain(String(ANALYZE_IDENTIFIER_ENCODED_MAX));
    }
  });

  test('the loose raw cap rejects a 501-char identifier outright', () => {
    expect(
      CollectFailuresInputSchema.safeParse({
        sets: [{ tool: 't'.repeat(501), failures: [], exitCode: 0 }],
      }).success,
    ).toBe(false);
  });

  test('the bound is LOCAL to analyze: the gates FailureSetSchema still accepts an over-bound tool', () => {
    expect(
      FailureSetSchema.safeParse({
        tool: 't'.repeat(ANALYZE_IDENTIFIER_ENCODED_MAX + 1),
        failures: [],
        exitCode: 0,
      }).success,
    ).toBe(true);
  });
});
