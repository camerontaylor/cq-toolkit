// Split provenance: test/ops/dev/check.test.ts was split by subject into
// check.input-rules.test.ts, check.adopter.test.ts, check.portable-scan.test.ts,
// check.selection.test.ts, check.gates.test.ts and check.diff-gates.test.ts.
import { readFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { makeDevCheck } from '../../../src/ops/dev/check.js';
import type { CommandResult } from '../../../src/ops/dev/effects.js';
import { devEffectsFor, pnpmArgs } from './check.helpers.js';
import { makeTestRepo, type CommandHandler, type TestRepo } from './repo.js';

let repo: TestRepo;
beforeEach(async () => {
  repo = await makeTestRepo();
});
afterEach(async () => {
  await repo.cleanup();
});

const effectsFor = (override?: CommandHandler) => devEffectsFor(repo, override);

describe('dev.check', () => {
  test('git diff --check catches committed whitespace damage against the pinned base', async () => {
    await repo.write('src/a.ts', 'export const a = 1; \n');
    repo.commitAll('trailing space');
    const result = await makeDevCheck(effectsFor())({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('diff-check:committed');
  });

  test('knip is skipped (and recorded) for a docs-only diff, and runs for a code change', async () => {
    repo.git('reset', '-q', '--hard', 'origin/main');
    await repo.write('README.md', '# docs only\n');
    repo.commitAll('docs');
    const docs = effectsFor();
    const skipped = await makeDevCheck(docs)({ repoRoot: repo.root });
    expect(skipped.status === 'ok' && skipped.value.gates[3]).toMatchObject({
      name: 'knip',
      status: 'skipped',
    });
    expect(pnpmArgs(docs)).not.toContainEqual(['run', 'knip']);

    await repo.write('src/b.ts', 'export {};\n');
    const withUntracked = effectsFor();
    await makeDevCheck(withUntracked)({ repoRoot: repo.root });
    expect(pnpmArgs(withUntracked)).toContainEqual(['run', 'knip']);
  });

  test('the denylist scan sees the archived tree WITH the staged and unstaged patch applied', async () => {
    await repo.write('src/staged.ts', 'export const staged = true;\n');
    repo.git('add', 'src/staged.ts');
    await repo.write('README.md', '# unstaged edit\n');
    const seen: string[] = [];
    const effects = effectsFor(async (command, args) => {
      if (command !== 'node') return undefined;
      expect(args[1]).toBe('--tree');
      const tree = (args[0] ?? '').replace(/\/scripts\/denylist-scan$/, '');
      seen.push(await readFile(`${tree}/src/staged.ts`, 'utf8'));
      seen.push(await readFile(`${tree}/README.md`, 'utf8'));
      return 'clean\n';
    });
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('ok');
    expect(seen).toEqual(['export const staged = true;\n', '# unstaged edit\n']);
  });

  test('a failed patch apply faults the denylist gate (never silently green)', async () => {
    await repo.write('README.md', '# unstaged edit\n');
    const effects = effectsFor((command, args) =>
      command === 'git' && args.includes('apply')
        ? ({
            exitCode: 1,
            stdout: '',
            stderr: 'patch does not apply',
            timedOut: false,
          } as CommandResult)
        : undefined,
    );
    const result = await makeDevCheck(effects)({ repoRoot: repo.root });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') expect(result.error).toContain('denylist-scan');
  });
});
