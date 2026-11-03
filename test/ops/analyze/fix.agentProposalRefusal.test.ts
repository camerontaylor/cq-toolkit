// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the agent
// proposal refusal subject. Siblings: fix.selection.test.ts,
// fix.previewApply.test.ts, fix.applyPreconditions.test.ts,
// fix.ruleOverFiles.test.ts, fix.agentProposal.test.ts,
// fix.patchTargets.test.ts, fix.schema.test.ts and fix.helpers.ts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeAnalyzeFix } from '../../../src/ops/analyze/fix.js';
import { BAD, MODEL, PATCH, fakeFactory, fixture, scriptedRunner, source } from './fix.helpers.js';

describe('analyze.fix — agent proposal', () => {
  test('a stale sidecar is refused before the model is asked', async () => {
    const { dir, clusterId } = await fixture();
    writeFileSync(join(dir, 'src', 'index.ts'), `${BAD}// moved on\n`);
    const { factory, invocations } = fakeFactory({ summary: 'x', patch: PATCH });
    const result = await makeAnalyzeFix({ run: scriptedRunner(), drivers: factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('stale sidecar');
    expect(invocations).toEqual([]);
  });

  test('an agent error → failed; a patch escaping the project → failed; nothing written', async () => {
    const { dir, clusterId } = await fixture();
    const broken = fakeFactory(undefined, 'error');
    const failed = await makeAnalyzeFix({ run: scriptedRunner(), drivers: broken.factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(failed.status).toBe('failed');
    const escaping = fakeFactory({
      summary: 'escape',
      patch: PATCH.replaceAll('src/index.ts', '../outside.ts'),
    });
    const refused = await makeAnalyzeFix({ run: scriptedRunner(), drivers: escaping.factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(refused.status).toBe('failed');
    if (refused.status === 'failed') expect(refused.error).toContain('escapes');
    expect(source(dir)).toBe(BAD);
  });

  test('a patch that does not apply cleanly → failed, kept for inspection', async () => {
    const { dir, clusterId } = await fixture();
    const { factory } = fakeFactory({
      summary: 'stale',
      patch: PATCH.replace('forty-two', 'forty-three'),
    });
    const result = await makeAnalyzeFix({ run: scriptedRunner(), drivers: factory })({
      dir,
      clusterId,
      model: MODEL,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('does not apply cleanly');
  });
});
