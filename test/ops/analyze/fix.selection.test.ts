// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the
// selection subject. Siblings: fix.previewApply.test.ts,
// fix.applyPreconditions.test.ts, fix.ruleOverFiles.test.ts,
// fix.agentProposal.test.ts, fix.agentProposalRefusal.test.ts,
// fix.patchTargets.test.ts, fix.schema.test.ts and fix.helpers.ts.
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeAnalyzeFix } from '../../../src/ops/analyze/fix.js';
import { BAD, RULE, fixture, repos, scriptedRunner, source } from './fix.helpers.js';

describe('analyze.fix — selection', () => {
  test('newest-sidecar discovery skips a dangling matching entry', async () => {
    const { dir, clusterId } = await fixture();
    symlinkSync('missing.json', join(dir, '.cq/analysis/analysis-ffffffffffffffff.sidecar.json'));
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({ dir, clusterId, rule: RULE });
    expect(result.status).toBe('ok');
  });

  test('only dangling sidecars produce a structured missing-sidecar refusal', async () => {
    const { dir } = await fixture();
    mkdirSync(join(dir, 'empty-reports'));
    symlinkSync('missing.json', join(dir, 'empty-reports/analysis-ffffffffffffffff.sidecar.json'));
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      out: 'empty-reports',
      clusterId: 'deadbeef',
      rule: RULE,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('no analysis sidecar');
  });
  test('a non-missing metadata failure refuses instead of selecting an older sidecar', async () => {
    const { dir, clusterId } = await fixture();
    const name = 'analysis-ffffffffffffffff.sidecar.json';
    // The valid fixture sorts first. This candidate cannot be ranked: its
    // self-referential link fails stat with ELOOP, not confirmed absence.
    symlinkSync(name, join(dir, '.cq/analysis', name));
    const run = scriptedRunner();
    const result = await makeAnalyzeFix({ run })({ dir, clusterId, rule: RULE, apply: true });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('could not select the newest analysis sidecar');
      expect(result.error).toContain('ELOOP');
    }
    expect(run.calls).toEqual([]);
    expect(source(dir)).toBe(BAD);
  });

  test('both selections, neither, and an empty file list are failed', async () => {
    const { dir, clusterId } = await fixture();
    const fix = makeAnalyzeFix({ run: scriptedRunner() });
    const both = await fix({ dir, clusterId, rule: RULE, files: ['src/index.ts'] });
    expect(both.status).toBe('failed');
    const neither = await fix({ dir });
    expect(neither.status).toBe('failed');
    if (neither.status === 'failed') expect(neither.error).toContain('--clusterId');
    expect((await fix({ dir, rule: RULE, files: [] })).status).toBe('failed');
  });

  test('a cluster without --rule or --model → failed naming both', async () => {
    const { dir, clusterId } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({ dir, clusterId });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('--rule');
      expect(result.error).toContain('--model');
    }
  });

  test('an unknown cluster id → failed listing the known ids', async () => {
    const { dir, clusterId } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId: '00000000',
      rule: RULE,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain(clusterId);
  });

  test('no sidecar yet → failed naming analyze.run', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'cq-fix-nosidecar-')));
    repos.push(dir);
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId: 'deadbeef',
      rule: RULE,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('analyze.run');
  });
});
