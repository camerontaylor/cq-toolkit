// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the input
// schema subject. Siblings: fix.selection.test.ts, fix.previewApply.test.ts,
// fix.applyPreconditions.test.ts, fix.ruleOverFiles.test.ts,
// fix.agentProposal.test.ts, fix.agentProposalRefusal.test.ts,
// fix.patchTargets.test.ts and fix.helpers.ts.
import { describe, expect, test } from 'vitest';
import { AnalyzeFixInputSchema } from '../../../src/ops/analyze/registry.js';

describe('AnalyzeFixInputSchema', () => {
  test('an all-digit cluster id the CLI parsed as a number is recovered exactly', () => {
    expect(AnalyzeFixInputSchema.parse({ dir: '.', clusterId: 12345678 }).clusterId).toBe(
      '12345678',
    );
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', clusterId: 'xyz' }).success).toBe(false);
  });

  test('a numeric id shorter than eight digits is refused, never zero-padded', () => {
    // 1234567 must not become 01234567 (a different cluster's id).
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', clusterId: 1234567 }).success).toBe(false);
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', clusterId: 123456789 }).success).toBe(false);
    expect(AnalyzeFixInputSchema.parse({ dir: '.', clusterId: 10000000 }).clusterId).toBe(
      '10000000',
    );
  });

  test('a JSON-object rule (what the CLI parses) becomes rule text', () => {
    const parsed = AnalyzeFixInputSchema.parse({ dir: '.', rule: { id: 'r' }, files: ['a.ts'] });
    expect(parsed.rule).toBe('{"id":"r"}');
  });

  test('strict, with the previewDigest shape enforced', () => {
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', bogus: 1 }).success).toBe(false);
    expect(AnalyzeFixInputSchema.safeParse({ dir: '.', previewDigest: 'abc' }).success).toBe(false);
    expect(
      AnalyzeFixInputSchema.safeParse({
        dir: '.',
        apply: true,
        model: { provider: 'p', model: 'm' },
      }).success,
    ).toBe(true);
  });
});
