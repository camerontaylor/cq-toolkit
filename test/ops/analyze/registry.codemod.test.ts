// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the codemod and remediation
// boundary mirrors plus their importers' fail-closed resolution.
import { afterEach, describe, expect, test } from 'vitest';
import {
  AgenticRemediationInputSchema,
  ApplyRemediationInputSchema,
  AstGrepCodemodInputSchema,
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

describe('AstGrepCodemodInputSchema / ApplyRemediationInputSchema (full input, and only it)', () => {
  test('the codemod schema: at least one file, non-empty rule, timeout defaulted at this boundary', () => {
    const valid = { dir: 'ws', rule: 'id: r', files: ['src/a.ts'], dryRun: true };
    const parsed = AstGrepCodemodInputSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, timeoutMs: 600_000 });
    expect(AstGrepCodemodInputSchema.safeParse({ ...valid, files: [] }).success).toBe(false);
    expect(AstGrepCodemodInputSchema.safeParse({ ...valid, rule: '' }).success).toBe(false);
    expect(AstGrepCodemodInputSchema.parse({ ...valid, dryRun: false }).timeoutMs).toBe(600_000);
    // A smuggled rule FILE indirection must fail loudly — the rule rides the input.
    expect(AstGrepCodemodInputSchema.safeParse({ ...valid, rulePath: 'r.yml' }).success).toBe(
      false,
    );
  });

  test('the agenticRemediation schema: the frozen driver-seam policy objects ride the kernel mirrors', () => {
    const cluster = {
      id: '0deadbe0',
      signature: '["oxlint","r","boom"]',
      tool: 'oxlint',
      ruleId: 'r',
      confidence: 'low' as const,
      failures: [
        {
          file: 'src/a.ts',
          line: 1,
          column: 1,
          ruleId: 'r',
          message: 'boom',
          severity: 'error' as const,
        },
      ],
      size: 1,
    };
    const valid = {
      clusterId: '0deadbe0',
      cluster,
      modelSpec: { model: 'glm-4.6', provider: 'zai' },
    };
    expect(AgenticRemediationInputSchema.parse(valid)).toEqual(valid);
    // An SDK-model object instead of the plain-data spec is a shape error.
    expect(
      AgenticRemediationInputSchema.safeParse({ ...valid, modelSpec: { model: 5 } }).success,
    ).toBe(false);
    expect(AgenticRemediationInputSchema.safeParse({ ...valid, driver: {} }).success).toBe(false);
  });

  test('the applyRemediation schema: clusterId and approved are OPTIONAL — their ABSENCE is the needs-human refusal', () => {
    const valid = { sidecarPath: 'ws/analysis-x.sidecar.json', rule: 'id: r', dryRun: true };
    const parsed = ApplyRemediationInputSchema.parse(valid);
    expect(parsed).toEqual({ ...valid, timeoutMs: 600_000 });
    // A present-but-empty clusterId is shape noise the boundary rejects; a
    // MISSING one is a decision the op refuses.
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, clusterId: '' }).success).toBe(false);
    expect(
      ApplyRemediationInputSchema.safeParse({ ...valid, clusterId: 'abc12345', approved: 'yes' })
        .success,
    ).toBe(false);
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, store: '/convention' }).success).toBe(
      false,
    );
  });

  test('both importers resolve; the apply op fails CLOSED on a missing sidecar (no scan, no write)', async () => {
    for (const name of ['analyze.astGrepCodemod', 'analyze.applyRemediation']) {
      const entry = registry.find((candidate) => candidate.name === name);
      if (!entry) throw new Error(`${name} missing from the registry`);
      expect(typeof entry.inputSchema).toBe('object');
      const op = await entry.importer();
      expect(typeof op).toBe('function');
    }
    const apply = registry.find((candidate) => candidate.name === 'analyze.applyRemediation');
    if (!apply) throw new Error('analyze.applyRemediation missing from the registry');
    const op = await apply.importer();
    const result = await op({
      sidecarPath: '/nonexistent/analysis-00000000.sidecar.json',
      clusterId: '0deadbe0',
      approved: true,
      rule: 'id: r',
      dryRun: false,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('failed closed');
    }
  });
});
