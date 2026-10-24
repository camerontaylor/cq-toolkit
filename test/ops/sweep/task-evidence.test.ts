import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { preserveTaskEdits } from '../../../src/ops/sweep/taskLoop.js';

const exec = promisify(execFile);
test('concurrent units preserve tracked and new files under independent refs without refs/stash', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-evidence-'));
  const git = (cwd: string) => async (args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  try {
    await git(root)(['init', '-b', 'main']);
    await git(root)(['config', 'user.name', 'Fixture']);
    await git(root)(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'source.ts'), 'baseline');
    await git(root)(['add', 'source.ts']);
    await git(root)(['commit', '-m', 'baseline']);
    const a = join(root, 'unit-a');
    const b = join(root, 'unit-b');
    await git(root)(['worktree', 'add', '-b', 'run/a', a, 'HEAD']);
    await git(root)(['worktree', 'add', '-b', 'run/b', b, 'HEAD']);
    for (const [cwd, text] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      await writeFile(join(cwd, 'source.ts'), text);
      await writeFile(join(cwd, 'new.ts'), text);
    }
    const [first, second] = await Promise.all([
      preserveTaskEdits(git(a), 'run/a'),
      preserveTaskEdits(git(b), 'run/b'),
    ]);
    expect(first.ref).not.toBe(second.ref);
    for (const [cwd, evidence, text] of [
      [a, first, 'a'],
      [b, second, 'b'],
    ] as const) {
      expect(await git(root)(['rev-parse', evidence.ref])).toBe(evidence.sha);
      expect(await git(root)(['show', `${evidence.ref}:new.ts`])).toBe(text);
      expect(await git(root)(['show', `${evidence.ref}:source.ts`])).toBe(text);
      expect(await git(cwd)(['status', '--porcelain'])).toBe('');
      expect(await readFile(join(cwd, 'source.ts'), 'utf8')).toBe('baseline');
      await expect(readFile(join(cwd, 'new.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await git(root)(['for-each-ref', '--format=%(refname)', 'refs/stash'])).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('snapshot failures never pin an invalid object or restore away evidence', async () => {
  const calls: string[][] = [];
  await expect(
    preserveTaskEdits(async (args) => {
      calls.push(args);
      return '';
    }, 'run/failed'),
  ).rejects.toThrow('could not snapshot');
  expect(calls.map((args) => args[0])).toEqual(['add', 'stash']);
});
test('a restore failure leaves the unique evidence ref pinned for recovery', async () => {
  const calls: string[][] = [];
  await expect(
    preserveTaskEdits(async (args) => {
      calls.push(args);
      if (args[0] === 'stash') return 'a'.repeat(40);
      if (args[0] === 'restore') throw new Error('restore unavailable');
      return '';
    }, 'run/restore'),
  ).rejects.toThrow('restore unavailable');
  expect(calls[2]?.slice(0, 2)).toEqual([
    'update-ref',
    expect.stringContaining('refs/cq/fix-run/run/restore/'),
  ]);
  expect(calls.at(-1)).toEqual(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
});
