import { readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { isolateAddressMany, makeReviewAddressMany } from '../../../src/ops/review/addressMany.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { fileWorktreeRegistry, resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { makeTestRepo, type TestRepo } from '../dev/repo.js';

const NOW = 1_793_145_600_000;

async function identityRepo() {
  const repo = await makeTestRepo();
  repo.git('config', 'user.name', 'Fixture User');
  repo.git('config', 'user.email', 'fixture@example.invalid');
  return repo;
}

async function fixture() {
  const repo = await identityRepo();
  try {
    const first = repo.git('rev-parse', 'HEAD').trim();
    await repo.write('src/sibling.ts', 'export const sibling = 2;\n');
    const second = repo.commitAll('second PR head');
    repo.git('push', '-q', 'origin', `${first}:refs/pull/7/head`, `${second}:refs/pull/9/head`);
    const root = dirname(repo.root);
    const registryPath = join(root, 'worktrees.json');
    const worktreeRoot = join(root, 'review');
    const run = makeGhRunner({
      bin: 'git',
      cwd: repo.root,
      env: { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_ALLOW_PROTOCOL: 'file' },
    });
    // Scripted forge metadata only; the local bare origin supplies actual Git truth.
    const prs = [
      { number: 7, headRefName: 'feature/x', headRefOid: first },
      { number: 9, headRefName: 'feature/x', headRefOid: second },
    ] as const;
    const resolve = (pr: (typeof prs)[number]) =>
      resolvePrWorktree({
        repoRoot: repo.root,
        pr: pr.number,
        headRefName: pr.headRefName,
        run,
        // Separate handles share the real file lock and persistence boundary.
        registry: fileWorktreeRegistry(registryPath),
        worktreeRoot,
        nowMs: NOW + pr.number,
      });
    return { repo, prs, resolve, registryPath, root };
  } catch (error) {
    await repo.cleanup();
    throw error;
  }
}

async function checkoutSnapshot(repo: TestRepo, path: string) {
  return {
    head: repo.git('-C', path, 'rev-parse', 'HEAD'),
    branch: repo.git('-C', path, 'symbolic-ref', 'HEAD'),
    status: repo.git('-C', path, 'status', '--porcelain=v1', '--untracked-files=all'),
    staged: repo.git('-C', path, 'diff', '--cached', '--binary'),
    unstaged: repo.git('-C', path, 'diff', '--binary'),
    untracked: await readFile(join(path, 'private-note.txt'), 'utf8'),
  };
}

test('concurrent PRs sharing a head ref retain distinct exact-head worktrees and both registry entries', async () => {
  const f = await fixture();
  try {
    const results = await Promise.all(f.prs.map(f.resolve));
    expect(new Set(await Promise.all(results.map((result) => realpath(result.path)))).size).toBe(2);
    expect(new Set(results.map((result) => result.branch)).size).toBe(2);
    const entries = await fileWorktreeRegistry(f.registryPath).load();
    expect(Object.keys(entries).sort()).toEqual(['7', '9']);
    for (const [index, pr] of f.prs.entries()) {
      const result = results[index]!;
      expect(result.reused).toBe(false);
      expect(f.repo.git('-C', result.path, 'rev-parse', 'HEAD').trim()).toBe(pr.headRefOid);
      expect(f.repo.git('-C', result.path, 'symbolic-ref', 'HEAD').trim()).toBe(
        `refs/heads/${result.branch}`,
      );
      expect(entries[String(pr.number)]).toEqual({
        path: result.path,
        branch: result.branch,
        createdAt: NOW + pr.number,
      });
    }
    expect(f.prs[0].headRefOid).not.toBe(f.prs[1].headRefOid);
    // Reopening both through fresh handles must preserve each PR's identity.
    const reused = await Promise.all(f.prs.map(f.resolve));
    // Git may canonicalize macOS /var paths to /private/var between creation and reuse.
    expect(
      await Promise.all(
        reused.map(async (result) => ({ ...result, path: await realpath(result.path) })),
      ),
    ).toEqual(
      await Promise.all(
        results.map(async (result) => ({
          ...result,
          path: await realpath(result.path),
          reused: true,
        })),
      ),
    );
  } finally {
    await f.repo.cleanup();
  }
});

test('a dirty stale PR refuses while its sibling resolves without changing caller or foreign worktrees', async () => {
  const f = await fixture();
  try {
    const stale = await f.resolve(f.prs[0]);
    await writeFile(join(stale.path, 'README.md'), 'unpublished PR 7 work\n');
    const entriesBefore = await fileWorktreeRegistry(f.registryPath).load();
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
    const entries = await fileWorktreeRegistry(f.registryPath).load();
    expect(entries['7']).toEqual(entriesBefore['7']);
    expect(entries['9']).toEqual({
      path: sibling.value.path,
      branch: sibling.value.branch,
      createdAt: NOW + 9,
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
