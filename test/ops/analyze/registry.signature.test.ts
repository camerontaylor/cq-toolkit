// Split provenance: test/ops/analyze/registry.test.ts was split into the
// registry.*.test.ts siblings in this directory; shared fixtures live in
// registry.helpers.ts. This file carries the applyRemediation signature
// disambiguator (Z1), schema and registry dispatch.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import {
  ApplyRemediationInputSchema,
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

describe('the applyRemediation signature disambiguator through the registry (Z1)', () => {
  test('the schema accepts the colliding-id input WITH signature and rejects a non-string one', () => {
    const valid = {
      sidecarPath: 'ws/analysis-e6854fd8.sidecar.json',
      clusterId: 'e6854fd8',
      signature: '["eslint","r","tjivlzyj"]',
      approved: true,
      rule: 'id: r',
      dryRun: true,
    };
    expect(ApplyRemediationInputSchema.parse(valid).signature).toBe('["eslint","r","tjivlzyj"]');
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, signature: 7 }).success).toBe(false);
    expect(ApplyRemediationInputSchema.safeParse({ ...valid, signature: '' }).success).toBe(false);
  });

  test('a colliding-pair sidecar dispatched WITHOUT signature fails naming the ambiguity (selection precedes the scan)', async () => {
    const { clusterErrors } = await import('../../../src/ops/analyze/clusterErrors.js');
    const { contentDigest, renderAnalysisReport, serializeAnalysisSidecar } =
      await import('../../../src/ops/analyze/renderAnalysisReport.js');
    const failure = (file: string, message: string) => ({
      file,
      line: 1,
      column: 1,
      ruleId: 'r',
      message,
      severity: 'error' as const,
    });
    // The G1-pinned FNV collision: two distinct signatures, one 32-bit id.
    const report = clusterErrors({
      tool: 'eslint',
      exitCode: 1,
      failures: [failure('src/a.ts', 'tjivlzyj'), failure('src/b.ts', 'qcmqx')],
    });
    const contents: Record<string, string> = {
      'src/a.ts': 'tjivlzyj;\n',
      'src/b.ts': 'qcmqx;\n',
    };
    const evidence = report.clusters.map((cluster) => ({
      clusterId: cluster.id,
      signature: cluster.signature,
      targets: [
        ...new Set(cluster.failures.map((f) => f.file).filter((f): f is string => f !== null)),
      ]
        .sort()
        .map((file) => ({ file, digest: contentDigest(contents[file] as string) })),
    }));
    const sidecarText = serializeAnalysisSidecar(
      renderAnalysisReport(report, { evidence }).sidecar,
    );
    const dir = await mkdtemp(join(tmpdir(), 'analyze-z1-'));
    try {
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'a.ts'), contents['src/a.ts'] as string, 'utf8');
      await writeFile(join(dir, 'src', 'b.ts'), contents['src/b.ts'] as string, 'utf8');
      await writeFile(join(dir, 'analysis-e6854fd8.sidecar.json'), sidecarText, 'utf8');
      const entry = registry.find((candidate) => candidate.name === 'analyze.applyRemediation');
      if (!entry) throw new Error('analyze.applyRemediation missing from the registry');
      const op = await entry.importer();
      const result = await op({
        sidecarPath: join(dir, 'analysis-e6854fd8.sidecar.json'),
        clusterId: 'e6854fd8',
        approved: true,
        rule: 'id: r',
        dryRun: false,
      });
      // The ambiguity fault fires at cluster SELECTION — before the scan —
      // so this dispatch is deterministic without an ast-grep binary.
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toContain("ambiguous cluster id 'e6854fd8'");
        expect(result.error).toContain('pass the cluster');
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 20_000);
});
