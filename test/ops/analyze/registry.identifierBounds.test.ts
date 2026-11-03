// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the analyze identifier bound: the
// ENCODED-size cap shared by both G1 ops, and its locality to analyze.
import { afterEach, describe, expect, test } from 'vitest';
import { FailureSetSchema } from '../../../src/ops/gates/registry.js';
import {
  ANALYZE_IDENTIFIER_ENCODED_MAX,
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  setAnalyzeApprovalAuthority,
} from '../../../src/ops/analyze/registry.js';

// The authority binding is PROCESS-WIDE module state (the same reason the
// playbook registry and quarantine ledger are shared), so every test must
// hand it back. Without this, one test binding an authority would silently
// authorize writes in the next — the exact failure the deny-all default
// exists to prevent.
afterEach(() => {
  setAnalyzeApprovalAuthority(undefined);
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
