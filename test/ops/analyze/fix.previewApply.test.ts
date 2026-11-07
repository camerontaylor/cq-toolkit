// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the
// cluster-rule preview/apply subject (with the custom-report-directory case).
// Siblings: fix.selection.test.ts, fix.applyPreconditions.test.ts,
// fix.ruleOverFiles.test.ts, fix.agentProposal.test.ts,
// fix.agentProposalRefusal.test.ts, fix.patchTargets.test.ts,
// fix.schema.test.ts and fix.helpers.ts.
import { describe, expect, test } from 'vitest';
import { makeAnalyzeFix } from '../../../src/ops/analyze/fix.js';
import { makeAnalyzeRun } from '../../../src/ops/analyze/run.js';
import { BAD, CHECKS, GOOD, RULE, fixture, scriptedRunner, source } from './fix.helpers.js';

describe('analyze.fix — cluster + rule', () => {
  test('preview: one planned edit, a digest, the --apply hint, nothing written', async () => {
    const { dir, clusterId, sidecarPath } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({ dir, clusterId, rule: RULE });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.mode).toBe('preview');
    const preview = result.value.preview;
    expect(preview.kind).toBe('cluster-codemod');
    if (preview.kind !== 'cluster-codemod') return;
    expect(preview.plannedEdits).toBe(1);
    expect(preview.sidecarPath).toBe(sidecarPath);
    expect(preview.files[0]?.diff).toContain('+const n: number = 42;');
    expect(preview.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.value.next).toContain('--apply');
    expect(source(dir)).toBe(BAD);
  });

  test('apply: the file changes and the recheck reports 1 → 0, resolved', async () => {
    const { dir, clusterId, git } = await fixture();
    const fix = makeAnalyzeFix({ run: scriptedRunner() });
    const preview = await fix({ dir, clusterId, rule: RULE });
    if (preview.status !== 'ok') throw new Error('preview failed');
    const result = await fix({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.mode).toBe('applied');
    expect(result.value.applied?.files).toEqual(['src/index.ts']);
    expect(result.value.recheck).toMatchObject({ before: 1, after: 0, resolved: true });
    expect(source(dir)).toBe(GOOD);
    // Only the target changed in the tracked tree.
    expect(git(['status', '--porcelain', '--untracked-files=no'])).toBe('M src/index.ts');
  });

  test('apply: a recheck whose checks cannot see the cluster does not report resolved', async () => {
    const { dir, clusterId } = await fixture();
    const scripted = scriptedRunner();
    // A different check COMMAND for the same adapter (what --checks or a
    // different --configPath can select): it observes no failures, so the
    // targeted cluster is absent from the before snapshot as well as after.
    const run = ((cmd: Parameters<typeof scripted>[0]) =>
      cmd.command === 'quiet-check'
        ? { stdout: '', stderr: '', exitCode: 0 }
        : scripted(cmd)) as typeof scripted;
    const fix = makeAnalyzeFix({ run });
    const preview = await fix({ dir, clusterId, rule: RULE });
    if (preview.status !== 'ok') throw new Error('preview failed');
    const result = await fix({
      dir,
      clusterId,
      rule: RULE,
      checks: [{ adapter: 'tsc-lines', command: { command: 'quiet-check', args: [] } }],
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.recheck).toMatchObject({ before: 0, after: 0, resolved: false });
    expect(result.value.recheck?.detail).toContain('absent from the before-check');
    expect(result.value.next).not.toContain('then commit');
  });

  test('a reviewed digest that no longer matches → needs-human, nothing written', async () => {
    const { dir, clusterId } = await fixture();
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      clusterId,
      rule: RULE,
      apply: true,
      previewDigest: `sha256:${'0'.repeat(64)}`,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('preview changed');
    expect(source(dir)).toBe(BAD);
  });
});

describe('analyze.fix — a custom report directory', () => {
  test('the custom out is exempt like .cq/: the apply proceeds over its untracked reports', async () => {
    const { dir } = await fixture();
    const run = scriptedRunner();
    const analysis = await makeAnalyzeRun(run)({ dir, checks: CHECKS, out: 'reports/cq' });
    if (analysis.status !== 'ok') throw new Error('analysis failed');
    const result = await makeAnalyzeFix({ run })({
      dir,
      out: 'reports/cq',
      clusterId: analysis.value.clusters[0]?.id ?? '',
      rule: RULE,
      apply: true,
    });
    expect(result.status, JSON.stringify(result)).toBe('ok');
    expect(source(dir)).toBe(GOOD);
  });
});
