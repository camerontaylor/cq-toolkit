// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the agent
// proposal lifecycle subject. Siblings: fix.selection.test.ts,
// fix.previewApply.test.ts, fix.applyPreconditions.test.ts,
// fix.ruleOverFiles.test.ts, fix.agentProposalRefusal.test.ts,
// fix.patchTargets.test.ts, fix.schema.test.ts and fix.helpers.ts.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { makeAnalyzeFix } from '../../../src/ops/analyze/fix.js';
import {
  BAD,
  GOOD,
  MODEL,
  PATCH,
  fakeFactory,
  fixture,
  scriptedRunner,
  source,
} from './fix.helpers.js';

describe('analyze.fix — agent proposal', () => {
  test('two steps: preview stores the patch; a one-step apply is refused; apply with the digest writes it', async () => {
    const { dir, clusterId } = await fixture();
    const { factory, invocations } = fakeFactory({ summary: 'use a number', patch: PATCH });
    const fix = makeAnalyzeFix({ run: scriptedRunner(), drivers: factory });
    const budget = { maxTokens: 1000 };
    const preview = await fix({ dir, clusterId, model: MODEL, budget });
    expect(preview.status).toBe('ok');
    if (preview.status !== 'ok' || preview.value.preview.kind !== 'agent-patch') {
      throw new Error(`expected an agent-patch preview: ${JSON.stringify(preview)}`);
    }
    expect(invocations[0]?.toolPolicy.mode).toBe('none');
    expect(invocations[0]?.sandboxPolicy.level).toBe('read-only');
    expect(invocations[0]?.budget).toEqual(budget);
    expect(preview.value.preview.targets).toEqual(['src/index.ts']);
    expect(readFileSync(preview.value.preview.proposalPath, 'utf8')).toBe(PATCH);
    expect(source(dir)).toBe(BAD);
    // ONE step (model + apply, no digest): a fresh, unseen proposal — refused.
    const beforeOneStep = invocations.length;
    const oneStep = await fix({ dir, clusterId, model: MODEL, apply: true });
    expect(oneStep.status).toBe('needs-human');
    expect(invocations.length).toBe(beforeOneStep);
    if (oneStep.status === 'needs-human')
      expect(oneStep.reason).toContain('--previewDigest=sha256:');
    expect(source(dir)).toBe(BAD);
    // TWO steps: the reviewed digest applies exactly the stored proposal.
    const calls = invocations.length;
    const applied = await fix({
      dir,
      clusterId,
      model: MODEL,
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(invocations.length).toBe(calls);
    expect(applied.status).toBe('ok');
    if (applied.status !== 'ok') return;
    expect(applied.value.applied?.patch).toBe(PATCH);
    expect(applied.value.recheck).toMatchObject({ before: 1, after: 0, resolved: true });
    expect(source(dir)).toBe(GOOD);
  });

  test('--previewDigest applies the STORED proposal without asking the model again', async () => {
    const { dir, clusterId } = await fixture();
    const first = fakeFactory({ summary: 'use a number', patch: PATCH });
    const preview = await makeAnalyzeFix({ run: scriptedRunner(), drivers: first.factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    if (preview.status !== 'ok') throw new Error('preview failed');
    const second = fakeFactory({ summary: 'different', patch: 'garbage' });
    const applied = await makeAnalyzeFix({ run: scriptedRunner(), drivers: second.factory })({
      dir,
      clusterId,
      previewDigest: preview.value.preview.digest,
      apply: true,
    });
    expect(applied.status).toBe('ok');
    expect(
      applied.status === 'ok' &&
        applied.value.preview.kind === 'agent-patch' &&
        applied.value.preview.source,
    ).toBe('stored-proposal');
    expect(second.invocations).toEqual([]);
    expect(source(dir)).toBe(GOOD);
  });

  test('a stored proposal is bound to its analysis: a changed sidecar refuses the digest', async () => {
    const { dir, clusterId, sidecarPath } = await fixture();
    const { factory } = fakeFactory({ summary: 'use a number', patch: PATCH });
    const fix = makeAnalyzeFix({ run: scriptedRunner(), drivers: factory });
    const preview = await fix({ dir, clusterId, model: MODEL });
    if (preview.status !== 'ok') throw new Error('preview failed');
    writeFileSync(sidecarPath, `${readFileSync(sidecarPath, 'utf8')}\n`);
    const result = await fix({
      dir,
      clusterId,
      apply: true,
      previewDigest: preview.value.preview.digest,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('preview changed');
    expect(source(dir)).toBe(BAD);
  });

  test('a summary-only proposal is a preview with nothing to apply', async () => {
    const { dir, clusterId } = await fixture();
    const { factory } = fakeFactory({ summary: 'needs a human look' });
    const result = await makeAnalyzeFix({ run: scriptedRunner(), drivers: factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(result.status === 'ok' && result.value.preview.kind).toBe('agent-summary');
    expect(result.status === 'ok' && result.value.mode).toBe('preview');
    expect(source(dir)).toBe(BAD);
  });
});
