// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the G2 report boundary mirror and
// its importer's default path-store binding.
import { afterEach, describe, expect, test } from 'vitest';
import {
  AnalyzeReportSchema,
  RenderAnalysisReportInputSchema,
  registry,
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

describe('AnalyzeReportSchema / RenderAnalysisReportInputSchema (full input, and only it)', () => {
  const CLUSTER = {
    id: '0deadbe0',
    signature: '["eslint","r","boom <num>"]',
    tool: 'eslint',
    ruleId: 'r',
    confidence: 'high' as const,
    failures: [
      {
        file: 'src/a.ts',
        line: 1,
        column: 1,
        ruleId: 'r',
        message: 'boom 1',
        severity: 'error' as const,
      },
    ],
    size: 1,
  };

  test('parses the full report input and rejects shape drift and smuggled keys', () => {
    const valid = { report: { clusters: [CLUSTER], noise: [] }, dir: 'ws' };
    expect(RenderAnalysisReportInputSchema.parse(valid)).toEqual(valid);
    expect(
      RenderAnalysisReportInputSchema.safeParse({ ...valid, path: 'convention' }).success,
    ).toBe(false);
    expect(RenderAnalysisReportInputSchema.safeParse({ report: valid.report }).success).toBe(false);
    expect(
      AnalyzeReportSchema.safeParse({
        clusters: [{ ...CLUSTER, id: 'not-hex' }],
        noise: [],
      }).success,
    ).toBe(false);
    expect(
      AnalyzeReportSchema.safeParse({
        clusters: [{ ...CLUSTER, confidence: 'certain' }],
        noise: [],
      }).success,
    ).toBe(false);
    expect(
      AnalyzeReportSchema.safeParse({ clusters: [{ ...CLUSTER, size: 2 }], noise: [] }).success,
    ).toBe(false);
    expect(RenderAnalysisReportInputSchema.safeParse({ ...valid, dir: '' }).success).toBe(false);
  });

  test('analyze.renderAnalysisReport resolves through its importer (the default path-store binding)', async () => {
    const entry = registry.find((candidate) => candidate.name === 'analyze.renderAnalysisReport');
    if (!entry) throw new Error('analyze.renderAnalysisReport missing from the registry');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
    // A missing dir must be a `failed` result, not a throw across the seam.
    const result = await op({ report: { clusters: [], noise: [] }, dir: 'definitely/missing' });
    expect(result.status).toBe('failed');
  });
});
