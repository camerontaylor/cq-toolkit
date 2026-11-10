import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { isolateAddressMany, makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { discoverWorktreeSlots } from '../../../src/adapters/git/slotWorktreeRegistry.js';

import { checkoutSnapshot, fixture, identityRepo } from './addressManyWorktree.helpers.js';

test('a dirty stale PR refuses while its sibling resolves without changing caller or foreign worktrees', async () => {
  const f = await fixture();
  try {
    const stale = await f.resolve(f.prs[0]);
    await writeFile(join(stale.path, 'README.md'), 'unpublished PR 7 work\n');
    const common = f.repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
    const entriesBefore = await discoverWorktreeSlots(common);
    // The PR advances after its first checkout; refreshing must preserve dirty work.
    f.repo.git('push', '-q', 'origin', `${f.prs[1].headRefOid}:refs/pull/7/head`);
    const foreign = join(f.root, 'foreign');
    f.repo.git('worktree', 'add', '-q', '-b', 'foreign-fixture', foreign, f.prs[0].headRefOid);
    for (const path of [f.repo.root, foreign]) {
      await writeFile(join(path, 'src/a.ts'), 'export const staged = 3;\n');
      f.repo.git('-C', path, 'add', '--', 'src/a.ts');
      await writeFile(join(path, 'README.md'), 'unstaged caller-owned work\n');
      await writeFile(join(path, 'private-note.txt'), `untracked content in ${path}\n`);
    }
    const callerBefore = await checkoutSnapshot(f.repo, f.repo.root);
    const foreignBefore = await checkoutSnapshot(f.repo, foreign);
    const [refused, sibling] = await Promise.allSettled([f.resolve(f.prs[0]), f.resolve(f.prs[1])]);
    expect(refused.status).toBe('rejected');
    if (refused.status !== 'rejected') throw new Error('dirty stale PR unexpectedly resolved');
    expect(refused.reason).toBeInstanceOf(Error);
    expect((refused.reason as Error).message).toMatch(/modified|untracked|dirty/i);
    expect(sibling.status).toBe('fulfilled');
    if (sibling.status !== 'fulfilled') throw sibling.reason;
    expect(sibling.value.path).not.toBe(stale.path);
    expect(sibling.value.branch).not.toBe(stale.branch);
    expect(f.repo.git('-C', sibling.value.path, 'rev-parse', 'HEAD').trim()).toBe(
      f.prs[1].headRefOid,
    );
    const entries = await discoverWorktreeSlots(common);
    expect(entries.get(7)).toEqual({ ...entriesBefore.get(7), incomplete: true });
    expect(entries.get(9)).toMatchObject({
      state: 'bound',
      checkoutPath: sibling.value.path,
      incomplete: false,
    });
    expect(f.repo.git('-C', stale.path, 'rev-parse', 'HEAD').trim()).toBe(f.prs[0].headRefOid);
    expect(await readFile(join(stale.path, 'README.md'), 'utf8')).toBe('unpublished PR 7 work\n');
    expect(await checkoutSnapshot(f.repo, f.repo.root)).toEqual(callerBefore);
    expect(await checkoutSnapshot(f.repo, foreign)).toEqual(foreignBefore);
  } finally {
    await f.repo.cleanup();
  }
});
test('bulk clone isolation gives sibling legs independent common directories and preserves origin', async () => {
  const repo = await identityRepo();
  try {
    const roots = await Promise.all([
      isolateAddressMany(repo.root, 7, {
        cloneRoot: join(dirname(repo.root), 'clones'),
        target: 'merge-queue',
      }),
      isolateAddressMany(repo.root, 9, {
        cloneRoot: join(dirname(repo.root), 'clones'),
        target: 'merge-queue',
      }),
    ]);
    const common = roots.map((root) =>
      repo.git('-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );
    expect(new Set(common).size).toBe(2);
    expect(common).not.toContain(
      repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim(),
    );
    for (const root of roots)
      expect(repo.git('-C', root, 'remote', 'get-url', 'origin')).toBe(
        repo.git('remote', 'get-url', 'origin'),
      );
  } finally {
    await repo.cleanup();
  }
});
test('bulk clones refresh the remote target even when the caller local main is stale', async () => {
  const repo = await identityRepo();
  try {
    const old = repo.git('rev-parse', 'origin/merge-queue').trim();
    const current = repo.git('rev-parse', 'HEAD').trim();
    repo.git('branch', '-f', 'main', old);
    repo.git('push', 'origin', `${current}:refs/heads/main`);
    const root = await isolateAddressMany(repo.root, 7, {
      cloneRoot: join(dirname(repo.root), 'clones'),
    });
    expect(repo.git('-C', root, 'rev-parse', 'origin/main').trim()).toBe(current);
    expect(repo.git('rev-parse', 'main').trim()).toBe(old);
  } finally {
    await repo.cleanup();
  }
});
test('clone retains effective author and committer identity configured only in the caller', async () => {
  const repo = await identityRepo();
  try {
    repo.git('config', 'user.name', 'Repository User');
    repo.git('config', 'user.email', 'repo@example.invalid');
    repo.git('config', 'author.name', 'Repository Author');
    const root = await isolateAddressMany(repo.root, 7, {
      cloneRoot: join(dirname(repo.root), 'clones'),
      target: 'merge-queue',
    });
    // TestRepo supplies an environment identity; inspect the copied configuration itself.
    expect(repo.git('-C', root, 'config', 'author.name').trim()).toBe('Repository Author');
    expect(repo.git('-C', root, 'config', 'author.email').trim()).toBe('repo@example.invalid');
    expect(repo.git('-C', root, 'config', 'committer.name').trim()).toBe('Repository User');
  } finally {
    await repo.cleanup();
  }
});
test('failed isolation removes its partial clone directory', async () => {
  const repo = await identityRepo();
  try {
    const cloneRoot = join(dirname(repo.root), 'clones');
    await expect(
      isolateAddressMany(repo.root, 7, { cloneRoot, target: 'missing-target' }),
    ).rejects.toThrow();
    expect(await readdir(cloneRoot)).toEqual([]);
  } finally {
    await repo.cleanup();
  }
});
test.each(['credential.helper', 'commit.gpgsign', 'gpg.format', 'user.signingkey'])(
  'bulk explicitly refuses repository-local %s without copying its value',
  async (key) => {
    const repo = await identityRepo();
    try {
      repo.git('config', key, 'local-sensitive-setting');
      await expect(
        isolateAddressMany(repo.root, 7, { cloneRoot: join(dirname(repo.root), 'clones') }),
      ).rejects.toThrow('require plain review.address');
    } finally {
      await repo.cleanup();
    }
  },
);
test.each(['--local', '--worktree'])(
  'bulk refuses URL-scoped HTTP auth in %s config without copying its value',
  async (scope) => {
    const repo = await identityRepo();
    try {
      repo.git('config', 'extensions.worktreeConfig', 'true');
      repo.git('config', scope, 'http.https://github.com/.extraheader', 'auth-fixture-value');
      await expect(
        isolateAddressMany(repo.root, 7, { cloneRoot: join(dirname(repo.root), 'clones') }),
      ).rejects.toThrow('require plain review.address');
    } finally {
      await repo.cleanup();
    }
  },
);
test('ordinary repositories with linked worktrees do not require worktree config support', async () => {
  const repo = await identityRepo();
  try {
    repo.git('worktree', 'add', '--detach', join(dirname(repo.root), 'linked'), 'HEAD');
    const root = await isolateAddressMany(repo.root, 7, {
      cloneRoot: join(dirname(repo.root), 'clones'),
    });
    expect(repo.git('-C', root, 'rev-parse', 'origin/main')).toBe(
      repo.git('rev-parse', 'origin/main'),
    );
  } finally {
    await repo.cleanup();
  }
});
test('missing effective caller identity is a needs-human leg with no dispatch', async () => {
  const repo = await identityRepo();
  try {
    vi.stubEnv('GIT_AUTHOR_NAME', '');
    const address = vi.fn();
    const gh = async (args: string[]) => ({
      code: 0,
      stderr: '',
      stdout: JSON.stringify(
        args[0] === 'repo'
          ? { nameWithOwner: 'owner/repo' }
          : {
              number: 1,
              state: 'open',
              merged: false,
              draft: false,
              user: { login: 'owner', type: 'User' },
              base: { ref: 'merge-queue' },
              head: { sha: 'a'.repeat(40), ref: 'feature/x', repo: { full_name: 'owner/repo' } },
            },
      ),
    });
    const result = await makeReviewAddressMany({ gh, address })({
      repoRoot: repo.root,
      repo: 'owner/repo',
      owner: 'owner',
      pulls: [1],
      maxTokens: 100,
      tokensPerPr: 50,
    });
    expect(result.status).toBe('needs-human');
    const leg = result.report?.rows[0]?.result;
    expect(leg?.status).toBe('needs-human');
    if (leg?.status === 'needs-human') expect(leg.reason).toContain('caller author identity');
    expect(address).not.toHaveBeenCalled();
  } finally {
    vi.unstubAllEnvs();
    await repo.cleanup();
  }
});
