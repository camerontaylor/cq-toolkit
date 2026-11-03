// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the lane entry list and the G1
// importers' resolution (the lazy importer path onto the real ops).
import { afterEach, describe, expect, test } from 'vitest';
import { fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import { registry, setAnalyzeApprovalAuthority } from '../../../src/ops/analyze/registry.js';

// The authority binding is PROCESS-WIDE module state (the same reason the
// playbook registry and quarantine ledger are shared), so every test must
// hand it back. Without this, one test binding an authority would silently
// authorize writes in the next — the exact failure the deny-all default
// exists to prevent.
afterEach(() => {
  setAnalyzeApprovalAuthority(undefined);
});

describe('analyze registry: the lane entries', () => {
  test('the registry names the lane ops in order', () => {
    expect(registry.map((entry) => entry.name)).toEqual([
      'analyze.init',
      'analyze.run',
      'analyze.fix',
      'analyze.collectFailures',
      'analyze.clusterErrors',
      'analyze.renderAnalysisReport',
      'analyze.astGrepCodemod',
      'analyze.agenticRemediation',
      'analyze.applyRemediation',
      'analyze.playbookRegister',
      'analyze.playbookDispatch',
      'analyze.playbookQuarantineList',
    ]);
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
