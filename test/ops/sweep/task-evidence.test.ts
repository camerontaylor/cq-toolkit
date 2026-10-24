import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { commitFailedAttempt } from '../../../src/ops/sweep/taskLoop.js';

const exec = promisify(execFile);

test('concurrent units pin plain failed commits under independent run branches and restore clean', async () => {
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
    await git(root)(['worktree', 'add', '-b', 'run/a/tests/pkg-a', a, 'HEAD']);
    await git(root)(['worktree', 'add', '-b', 'run/b/tests/pkg-b', b, 'HEAD']);
    const evidence = await Promise.all(
      [
        { cwd: a, runPrefix: 'run/a', slug: 'pkg-a', text: 'a' },
        { cwd: b, runPrefix: 'run/b', slug: 'pkg-b', text: 'b' },
      ].map(async ({ cwd, runPrefix, slug, text }) => {
        await writeFile(join(cwd, 'source.ts'), text);
        await writeFile(join(cwd, 'new.ts'), text);
        const head = await git(cwd)(['rev-parse', 'HEAD']);
        await git(cwd)(['add', '-A', '--', '.']);
        const attempt = await commitFailedAttempt(git(cwd), {
          runPrefix,
          kind: 'tests',
          slug,
          task: 'src/source.ts',
          parent: head,
          firstAttempt: 1,
          tier: 'worker',
          model: { provider: 'fixture', model: 'scripted' },
          gate: 'related',
          outcome: 'unfixed',
          reason: 'related check rejected the edit',
          pushFailed: false,
        });
        await git(cwd)(['restore', '--source=HEAD', '--staged', '--worktree', '--', '.']);
        return { cwd, attempt, text };
      }),
    );
    expect(evidence[0]?.attempt.branch).toBe('run/a/failed/tests/pkg-a/src-source-ts/a1');
    expect(evidence[1]?.attempt.branch).toBe('run/b/failed/tests/pkg-b/src-source-ts/a1');
    for (const { cwd, attempt, text } of evidence) {
      expect(await git(root)(['rev-parse', `refs/heads/${attempt.branch}`])).toBe(attempt.sha);
      expect(await git(root)(['show', `${attempt.sha}:new.ts`])).toBe(text);
      expect(await git(root)(['show', `${attempt.sha}:source.ts`])).toBe(text);
      expect(await git(root)(['show', '-s', '--format=%P', attempt.sha])).toBe(
        await git(cwd)(['rev-parse', 'HEAD']),
      );
      expect(await git(root)(['show', '-s', '--format=%an <%ae>', attempt.sha])).toBe(
        'CQ fix engine <cq-fix-engine@invalid>',
      );
      const message = await git(root)(['show', '-s', '--format=%B', attempt.sha]);
      expect(message).toContain('cq-failed(unfixed): src/source.ts');
      expect(message).toContain('Cq-Run: run/');
      expect(message).toContain('Cq-Unit: tests/');
      expect(message).toContain('Cq-Task: src/source.ts');
      expect(message).toContain('Cq-Attempt: 1');
      expect(message).toContain('Cq-Tier: worker');
      expect(message).toContain('Cq-Model: fixture/scripted');
      expect(message).toContain('Cq-Gate: related');
      expect(message).toContain('Cq-Outcome: unfixed');
      expect(await git(cwd)(['status', '--porcelain'])).toBe('');
      expect(await readFile(join(cwd, 'source.ts'), 'utf8')).toBe('baseline');
      await expect(readFile(join(cwd, 'new.ts'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    }
    expect(await git(root)(['for-each-ref', '--format=%(refname)', 'refs/stash'])).toBe('');
    expect(await git(root)(['for-each-ref', '--format=%(refname)', 'refs/cq'])).toBe('');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed-attempt branch collisions increment and push opt-in marks commits to skip CI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-task-collision-'));
  const git = (cwd: string) => async (args: string[]) =>
    (await exec('git', ['-C', cwd, ...args])).stdout.trim();
  try {
    await git(root)(['init', '-b', 'main']);
    await git(root)(['config', 'user.name', 'Fixture']);
    await git(root)(['config', 'user.email', 'fixture@invalid']);
    await writeFile(join(root, 'file.ts'), 'base');
    await git(root)(['add', 'file.ts']);
    await git(root)(['commit', '-m', 'base']);
    const parent = await git(root)(['rev-parse', 'HEAD']);
    const collision = 'run/failed/tests/pkg/file-ts/a1';
    await git(root)(['update-ref', `refs/heads/${collision}`, parent]);
    await writeFile(join(root, 'file.ts'), 'changed');
    await git(root)(['add', '-A', '--', '.']);
    const attempt = await commitFailedAttempt(git(root), {
      runPrefix: 'run',
      kind: 'tests',
      slug: 'pkg',
      task: 'file.ts',
      parent,
      firstAttempt: 1,
      tier: 'rescue',
      model: { provider: 'fixture', model: 'rescuer' },
      gate: 'budget',
      outcome: 'escalated-to-human',
      reason: 'token budget exhausted',
      pushFailed: true,
    });
    expect(attempt.branch).toBe('run/failed/tests/pkg/file-ts/a2');
    const message = await git(root)(['show', '-s', '--format=%B', attempt.sha]);
    expect(message.split('\n')[0]).toBe('cq-failed(escalated-to-human): file.ts [skip ci]');
    expect(message).toContain('Cq-Attempt: 2');
    expect(message).toContain('Cq-Tier: rescue');
    expect(message).toContain('Cq-Gate: budget');
    expect(message).toContain('Cq-Outcome: escalated-to-human');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('failed-attempt tree failures stop before creating any refs', async () => {
  const calls: string[][] = [];
  await expect(
    commitFailedAttempt(
      async (args) => {
        calls.push(args);
        return '';
      },
      {
        runPrefix: 'run',
        kind: 'tests',
        slug: 'pkg',
        task: 'file.ts',
        parent: 'a'.repeat(40),
        firstAttempt: 1,
        tier: 'worker',
        model: { provider: 'fixture', model: 'scripted' },
        gate: 'none',
        outcome: 'unfixed',
        reason: 'failure',
        pushFailed: false,
      },
    ),
  ).rejects.toThrow('could not write failed-attempt tree');
  expect(calls).toEqual([['write-tree']]);
});
