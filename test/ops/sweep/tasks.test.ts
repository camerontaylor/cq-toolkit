import { mkdtemp, mkdir, symlink, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { parseCLI } from 'vitest/node';
import {
  normalizeFailurePaths,
  relatedCheckCommand,
  tasksFromFailures,
} from '../../../src/ops/sweep/tasks.js';
import type { CheckFailure } from '../../../src/ops/gates/checkRunner.js';

const failure = (file: string | null): CheckFailure => ({
  file,
  line: 1,
  column: null,
  ruleId: null,
  message: 'fails',
  severity: 'error',
});
test('groups duplicate failures by file and keeps unattributed evidence', () => {
  const tasks = tasksFromFailures({
    tool: 'tests',
    exitCode: 1,
    failures: [failure('b.test.ts'), failure('a.test.ts'), failure('a.test.ts'), failure(null)],
  });
  expect(tasks.map((task) => task.files)).toEqual([[], ['a.test.ts'], ['b.test.ts']]);
  expect(tasks[1]?.failures).toHaveLength(2);
});
test('argv template replaces full args and expands files without shell interpretation', () => {
  const check = { command: 'runner', args: ['full'], cwd: '/repo' };
  expect(
    relatedCheckCommand(check, ['a space.ts', '$(literal).ts'], ['related', '{files}', '--json'])
      .args,
  ).toEqual(['related', 'a space.ts', '$(literal).ts', '--json']);
  expect(relatedCheckCommand(check, ['-x.ts']).args).toEqual(['full', './-x.ts']);
  expect(() => relatedCheckCommand(check, ['a.ts'], ['embedded-{files}'])).toThrow('standalone');
});

test('clean runs derive no tasks; an empty related argv cannot hide the required marker', () => {
  expect(tasksFromFailures({ tool: 'tests', exitCode: 0, failures: [] })).toEqual([]);
  expect(() => relatedCheckCommand({ command: 'runner', args: [] }, [], [])).toThrow('standalone');
  expect(
    relatedCheckCommand({ command: 'runner', args: [] }, [], ['{files}', '--json']).args,
  ).toEqual(['--json']);
});

test('fallback argv reaches Vitest positional filters, including flag-shaped filenames', () => {
  const related = relatedCheckCommand({ command: 'vitest', args: ['run', '--reporter=json'] }, [
    'chosen.test.ts',
    '-flag.test.ts',
  ]);
  const parsed = parseCLI(['vitest', ...related.args]);
  expect(parsed.filter).toEqual(['chosen.test.ts', './-flag.test.ts']);
});

test('failure containment resolves workspace aliases and refuses real or symlink escapes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-paths-'));
  try {
    const workspace = join(root, 'workspace');
    const alias = join(root, 'alias');
    const outside = join(root, 'outside');
    await mkdir(join(workspace, 'packages', 'demo'), { recursive: true });
    await mkdir(outside);
    await symlink(workspace, alias, 'dir');
    await symlink(outside, join(workspace, 'escape'), 'dir');
    await writeFile(join(workspace, 'packages', 'demo', 'a.test.ts'), 'fixture');
    const set = (file: string) => ({ tool: 'tests', exitCode: 1, failures: [failure(file)] });
    for (const repo of [workspace, alias])
      for (const cwd of [workspace, alias]) {
        for (const file of [
          join(workspace, 'packages/demo/a.test.ts'),
          join(alias, 'packages/demo/a.test.ts'),
          'a.test.ts',
          'removed.test.ts',
        ]) {
          const normalized = normalizeFailurePaths(set(file), repo, join(cwd, 'packages/demo'));
          expect(normalized.failures[0]?.file).toBe(
            'packages/demo/' + (file === 'removed.test.ts' ? file : 'a.test.ts'),
          );
        }
        for (const file of [
          join(outside, 'missing.test.ts'),
          '../../../outside/missing.test.ts',
          join(alias, 'escape/missing.test.ts'),
        ])
          expect(() => normalizeFailurePaths(set(file), repo, join(cwd, 'packages/demo'))).toThrow(
            'escapes the workspace',
          );
      }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
