// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the
// apply-precondition refusals subject. Siblings: fix.selection.test.ts,
// fix.previewApply.test.ts, fix.ruleOverFiles.test.ts,
// fix.agentProposal.test.ts, fix.agentProposalRefusal.test.ts,
// fix.patchTargets.test.ts, fix.schema.test.ts and fix.helpers.ts.
import { readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeAnalyzeFix } from '../../../src/ops/analyze/fix.js';
import { BAD, RULE, fixture, scriptedRunner, source } from './fix.helpers.js';

describe('analyze.fix — cluster + rule', () => {
  test('a dirty tree → needs-human naming the dirty path; nothing written', async () => {
    const { dir, clusterId } = await fixture();
    writeFileSync(join(dir, 'scratch.txt'), 'uncommitted');
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') {
      expect(result.reason).toContain('workspace dirty');
      expect(result.reason).toContain("'scratch.txt'");
    }
    expect(source(dir)).toBe(BAD);
  });

  test('a repository without a commit → needs-human asking for a commit', async () => {
    const { dir, clusterId } = await fixture({ commit: false });
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('at least one commit');
    expect(source(dir)).toBe(BAD);
  });

  test('--apply without configured checks → failed before writing', async () => {
    const { dir, clusterId } = await fixture({ config: false });
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('analyze.init');
    expect(source(dir)).toBe(BAD);
  });

  test('a sidecar that changes between preview and write is not confirmed → needs-human', async () => {
    const { dir, clusterId, sidecarPath } = await fixture();
    // The before-check runs between the preview and the apply: append a
    // byte to the sidecar there (still valid JSON — only its digest moves).
    const run = scriptedRunner({
      onTsc: () => writeFileSync(sidecarPath, `${readFileSync(sidecarPath, 'utf8')}\n`),
    });
    const result = await makeAnalyzeFix({ run })({ dir, clusterId, rule: RULE, apply: true });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('not the one previewed');
    expect(source(dir)).toBe(BAD);
  });

  test('a sidecar symlink retargeted during the before-check is not confirmed', async () => {
    const { dir, clusterId, sidecarPath } = await fixture();
    const alias = join(dir, '.cq/analysis/selected.json');
    const replacement = join(dir, '.cq/analysis/replacement.json');
    writeFileSync(replacement, readFileSync(sidecarPath));
    symlinkSync(sidecarPath, alias);
    const run = scriptedRunner({
      onTsc: () => {
        rmSync(alias);
        symlinkSync(replacement, alias);
      },
    });
    const result = await makeAnalyzeFix({ run })({
      dir,
      clusterId,
      sidecarPath: alias,
      rule: RULE,
      apply: true,
    });
    expect(result.status).toBe('needs-human');
    expect(source(dir)).toBe(BAD);
  });

  test('a target edited after analysis → failed stale sidecar with the analyze.run hint', async () => {
    const { dir, clusterId } = await fixture();
    writeFileSync(join(dir, 'src', 'index.ts'), `${BAD}// edited\n`);
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({ dir, clusterId, rule: RULE });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('cq analyze.run');
  });
});
