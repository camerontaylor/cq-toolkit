// Lane C S4 — `analyze.fix` over a REAL git repository with a SCRIPTED
// runner (the checks and the ast-grep scan answer from the bytes on disk; no
// compiler or ast-grep binary needed) and a FAKE driver factory (no model).
// Pinned: selection, preview (no write), the attended apply + recheck on all
// three paths (cluster rule, rule over files, agent patch), and every
// refusal's taxonomy.
//
// Split provenance: test/ops/analyze/fix.test.ts was split into eight subject
// test files in this directory and a shared fixture module; this is the
// rule-over-files subject. Siblings: fix.selection.test.ts,
// fix.previewApply.test.ts, fix.applyPreconditions.test.ts,
// fix.agentProposal.test.ts, fix.agentProposalRefusal.test.ts,
// fix.patchTargets.test.ts, fix.schema.test.ts and fix.helpers.ts.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeAttendedApprovalAuthority } from '../../../src/ops/analyze/attended.js';
import { makeAnalyzeFix } from '../../../src/ops/analyze/fix.js';
import { BAD, GOOD, RULE, fixture, scriptedRunner, source } from './fix.helpers.js';

describe('analyze.fix — rule over files', () => {
  test('same-target edits committed after preview do not authorize a different plan', async () => {
    const { dir, git } = await fixture();
    const changed = BAD.replace('export { n };', 'const m = "forty-two";\nexport { n, m };');
    const run = scriptedRunner({
      onTsc: () => {
        writeFileSync(join(dir, 'src/index.ts'), changed);
        git(['add', 'src/index.ts']);
        git(['commit', '-q', '-m', 'concurrent change']);
      },
    });
    const result = await makeAnalyzeFix({ run })({
      dir,
      rule: RULE,
      files: ['src/index.ts'],
      apply: true,
    });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human')
      expect(result.reason).toContain('plan changed since preview');
    expect(source(dir)).toBe(changed);
  });

  test('source drift after admission is checked under the lock before writing', async () => {
    const { dir } = await fixture();
    const changed = BAD + '// concurrent change\n';
    const result = await makeAnalyzeFix({
      run: scriptedRunner(),
      attended: (config) => {
        const authority = makeAttendedApprovalAuthority(config);
        const admit = authority.admit.bind(authority);
        authority.admit = async (subject) => {
          const admitted = await admit(subject);
          writeFileSync(join(dir, 'src/index.ts'), changed);
          return admitted;
        };
        return authority;
      },
    })({ dir, rule: RULE, files: ['src/index.ts'], apply: true });
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('preview source changed');
    expect(source(dir)).toBe(changed);
  });
  test('preview then apply; recheck counts go down', async () => {
    const { dir } = await fixture();
    const fix = makeAnalyzeFix({ run: scriptedRunner() });
    const preview = await fix({ dir, rule: RULE, files: ['src/index.ts'] });
    expect(preview.status === 'ok' && preview.value.preview.kind).toBe('rule-codemod');
    expect(source(dir)).toBe(BAD);
    const applied = await fix({ dir, rule: RULE, files: ['src/index.ts'], apply: true });
    expect(applied.status).toBe('ok');
    if (applied.status !== 'ok') return;
    expect(applied.value.recheck).toMatchObject({ before: 1, after: 0, resolved: true });
    expect(source(dir)).toBe(GOOD);
  });

  test('nothing matched → preview mode with "nothing to apply", even with --apply', async () => {
    const { dir } = await fixture();
    const rule = JSON.stringify({
      id: 'x',
      language: 'TypeScript',
      rule: { pattern: 'zzz' },
      fix: 'y',
    });
    const result = await makeAnalyzeFix({ run: scriptedRunner() })({
      dir,
      rule,
      files: ['src/index.ts'],
      apply: true,
    });
    expect(result.status === 'ok' && result.value.mode).toBe('preview');
    expect(result.status === 'ok' && result.value.next).toContain('nothing to apply');
  });
});
