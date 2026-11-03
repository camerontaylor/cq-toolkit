// Split from test/ops/merge/executeMerges.test.ts (F3): the mergeEffects
// adapter surface — withPreparedWorktree, worktreePrepare common-dir root,
// gh spawn scoping.
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  headRefFor,
  realMergeEffects,
  withPreparedWorktree,
} from '../../../src/adapters/forge-github/mergeEffects.js';
import { FakeMergeEffects, OK } from './executeMerges.helpers.js';

describe('withPreparedWorktree — the worktree lifecycle seam helper (round 1, finding 3)', () => {
  test("prepare → fn(path) → remove, in order; fn's value resolves", async () => {
    const fake = new FakeMergeEffects();
    const fnPaths: string[] = [];
    const result = await withPreparedWorktree(fake, 7, headRefFor(7), async (path) => {
      fnPaths.push(path);
      return 'resolved';
    });
    expect(result).toBe('resolved');
    expect(fnPaths).toEqual(['/wt/pr-7']);
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test('fn throws → remove still runs, and the ORIGINAL error object is rethrown (never masked)', async () => {
    const fake = new FakeMergeEffects();
    const original = new Error('resolver exploded');
    await expect(
      withPreparedWorktree(fake, 7, headRefFor(7), async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test('fn throws AND the removal fails → the removal note is APPENDED to the original error', async () => {
    const fake = new FakeMergeEffects();
    fake.removeFailures.add('/wt/pr-7');
    await expect(
      withPreparedWorktree(fake, 7, headRefFor(7), async () => {
        throw new Error('resolver exploded');
      }),
    ).rejects.toThrow(/resolver exploded; worktreeRemove \/wt\/pr-7 also failed/);
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test("fn resolves but the removal fails → the caller's result still stands (never masked)", async () => {
    const fake = new FakeMergeEffects();
    fake.removeFailures.add('/wt/pr-7');
    const result = await withPreparedWorktree(fake, 7, headRefFor(7), async () => 'ok');
    expect(result).toBe('ok');
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head', 'remove:/wt/pr-7']);
  });

  test('a prepare throw propagates untouched — fn never runs, remove never runs (finding 6)', async () => {
    const fake = new FakeMergeEffects();
    fake.prepareThrows = new Error('worktree add refused');
    let fnRan = false;
    await expect(
      withPreparedWorktree(fake, 7, headRefFor(7), async () => {
        fnRan = true;
        return 'never';
      }),
    ).rejects.toThrow('worktree add refused');
    expect(fnRan).toBe(false);
    // Nothing was prepared — there is nothing to remove.
    expect(fake.calls).toEqual(['prepare:7@refs/pull/7/head']);
  });
});

describe('realMergeEffects.worktreePrepare — the git-common-dir root (round 2, finding 2)', () => {
  test('a linked-worktree repo (.git is a FILE) prepares under the ANSWERED common dir', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cq-merge-commondir-'));
    try {
      const repoRoot = join(tmp, 'repo');
      const realCommon = join(tmp, 'real-gitdir');
      await mkdir(repoRoot, { recursive: true });
      await mkdir(realCommon, { recursive: true });
      // The linked-worktree layout: .git is a FILE pointing at the gitdir.
      await writeFile(join(repoRoot, '.git'), `gitdir: ${join(tmp, 'worktrees-dir')}\n`, 'utf8');

      const gitCalls: string[][] = [];
      const effects = realMergeEffects({
        repoRoot,
        gitRun: async (args: string[]) => {
          gitCalls.push(args);
          if (args.includes('--git-common-dir')) {
            return { code: 0, stdout: `${realCommon}\n`, stderr: '' };
          }
          return OK; // the `worktree add` "succeeds"
        },
      });

      const { path } = await effects.worktreePrepare(7, 'refs/pull/7/head');

      // The tree lives under the ANSWERED common dir — never <repoRoot>/.git
      // (a file there: the old join threw ENOTDIR in exactly this layout).
      expect(path).toBe(join(realCommon, 'cq-merge-worktrees', 'pr-7'));
      expect(existsSync(join(realCommon, 'cq-merge-worktrees'))).toBe(true);
      expect(gitCalls).toEqual([
        ['-C', repoRoot, 'rev-parse', '--git-common-dir'],
        ['-C', repoRoot, 'worktree', 'add', '-B', 'cq-merge/pr-7', path, 'refs/pull/7/head'],
      ]);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  test('a failed common-dir probe falls back to <repoRoot>/.git (the main-checkout layout)', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'cq-merge-commondir-'));
    try {
      const repoRoot = join(tmp, 'repo');
      await mkdir(join(repoRoot, '.git'), { recursive: true }); // a real .git DIR
      const effects = realMergeEffects({
        repoRoot,
        gitRun: async (args: string[]) =>
          args.includes('--git-common-dir')
            ? { code: 128, stdout: '', stderr: 'not a repository' }
            : OK,
      });

      const { path } = await effects.worktreePrepare(7, 'refs/pull/7/head');

      expect(path).toBe(join(repoRoot, '.git', 'cq-merge-worktrees', 'pr-7'));
      expect(existsSync(join(repoRoot, '.git', 'cq-merge-worktrees'))).toBe(true);
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

describe('realMergeEffects gh spawn scoping — the real makeGhRunner over a recording fake gh (review-debt #163)', () => {
  test('realMergeEffects scopes the gh spawn to the repo root and strips an inherited GH_REPO (review-debt #163: no wrong-repo PRs on cwd/GH_REPO collisions)', async () => {
    // The REAL makeGhRunner (no run override — that would hide the spawn
    // opts) with a fake gh binary that records its cwd AND its GH_REPO: the
    // effect must spawn INSIDE repoRoot even though the test process cwd is
    // elsewhere, and an inherited GH_REPO (gh's repo resolution: -R >
    // GH_REPO > cwd) must be stripped — the cwd is otherwise defeated.
    const tmp = await mkdtemp(join(tmpdir(), 'cq-merge-ghcwd-'));
    const repo = join(tmp, 'repo');
    const record = join(tmp, 'cwd.txt');
    const ghRepoRecord = join(tmp, 'ghrepo.txt');
    await mkdir(repo);
    const gh = join(tmp, 'fake-gh.sh');
    await writeFile(
      gh,
      `#!/bin/sh\nprintf '%s' "$PWD" > '${record}'\nprintf '%s' "$GH_REPO" > '${ghRepoRecord}'\n`,
    );
    chmodSync(gh, 0o755);
    const previousGhRepo = process.env.GH_REPO;
    process.env.GH_REPO = 'wrong-owner/wrong-repo';
    try {
      const effects = realMergeEffects({ repoRoot: repo, ghBin: gh });
      expect(await effects.retargetBase(7, 'other')).toMatchObject({ code: 0 });
      // Compare REAL paths: on macOS os.tmpdir() hands out the logical
      // /var/... spelling of a symlinked directory, and sh's $PWD keeps
      // that logical form while node may hand the physical one — the
      // contract is "same directory", not "same spelling".
      const { readFile, realpath: realpathFsp } = await import('node:fs/promises');
      expect(await realpathFsp(await readFile(record, 'utf8'))).toBe(await realpathFsp(repo));
      expect(await readFile(ghRepoRecord, 'utf8')).toBe('');
    } finally {
      if (previousGhRepo === undefined) delete process.env.GH_REPO;
      else process.env.GH_REPO = previousGhRepo;
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
