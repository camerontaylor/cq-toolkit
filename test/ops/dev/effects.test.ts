import { makeDevCheck } from '../../../src/ops/dev/check.js';
import { makeDevReady } from '../../../src/ops/dev/ready.js';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { makePrOpen } from '../../../src/ops/pr/open.js';
import { makeFakeEffects, stubScanner } from './fakes.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { makeSubprocessDevEffects, requireGitOutRaw } from '../../../src/ops/dev/effects.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test('private snapshot preserves index/worktree split and binary/untracked bytes through live ABA edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cq-snapshot-test-'));
  roots.push(root);
  const effects = makeSubprocessDevEffects(root);
  const git = async (...args: string[]) =>
    requireGitOutRaw(await effects.runCommand('git', args, { timeoutMs: 10000 }), args.join(' '));
  await git('init', '-b', 'test/snapshot');
  await writeFile(join(root, 'tracked'), 'head\n');
  await writeFile(join(root, 'secret.env'), Buffer.from([0, 1, 2]));
  await git('add', '.');
  await git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-m',
    'fixture',
  );
  await git('config', 'diff.noprefix', 'true');
  await git('config', 'diff.mnemonicPrefix', 'true');
  await writeFile(join(root, 'tracked'), 'index\n');
  await git('add', 'tracked');
  await writeFile(join(root, 'tracked'), 'worktree\n');
  await writeFile(join(root, 'untracked'), Buffer.from([0, 255, 1]));
  await writeFile(join(root, 'secret.env'), Buffer.from([0, 2, 3]));
  const binary = await git('diff', '--binary');
  expect(binary).toContain('diff --git a/secret.env b/secret.env');
  let snapshotRoot = '';
  await effects.withSnapshot(async (snapshot) => {
    const run = async (command: string, args: string[]) =>
      requireGitOutRaw(await snapshot.runCommand(command, args, { timeoutMs: 10000 }), command);
    snapshotRoot = (await run('node', ['-p', 'process.cwd()'])).trim();
    expect(snapshotRoot).not.toBe(root);
    await writeFile(join(root, 'tracked'), 'temporary unscanned contents\n');
    await git('add', 'tracked');
    expect(await run('git', ['show', ':tracked'])).toBe('index\n');
    expect(await readFile(join(snapshotRoot, 'tracked'), 'utf8')).toBe('worktree\n');
    expect(await readFile(join(snapshotRoot, 'untracked'))).toEqual(Buffer.from([0, 255, 1]));
    expect(await run('git', ['diff', '--binary'])).toContain('a/secret.env b/secret.env');
    await writeFile(join(root, 'tracked'), 'index\n');
    await git('add', 'tracked');
    await writeFile(join(root, 'tracked'), 'worktree\n');
    expect(await readFile(join(snapshotRoot, 'tracked'), 'utf8')).toBe('worktree\n');
  });
  await expect(readFile(join(snapshotRoot, 'tracked'))).rejects.toThrow();
  expect(await readFile(join(root, 'tracked'), 'utf8')).toBe('worktree\n');
});

test('initial Git spawn faults resolve through each public operation taxonomy', async () => {
  const effects = makeFakeEffects();
  effects.runCommand = async () => {
    throw new Error('git spawn ENOENT');
  };
  const operations = [
    () => makeDevCheck(effects)({ repoRoot: '/missing' }),
    () => makeDevReady(effects)({ repoRoot: '/missing' }),
    () => makeDevReview({ effects, scanSecrets: stubScanner() })({ repoRoot: '/missing' }),
    () =>
      makeDevDisposition(effects)({
        repoRoot: '/missing',
        findingId: 'c001-aaaaaaaa#f1',
        action: 'fixed',
        why: 'addressed',
      }),
    () => makePrOpen(effects, {} as PrEffects)({ repoRoot: '/missing' }),
  ];
  for (const run of operations) {
    const result = await run();
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('ENOENT');
  }
});
