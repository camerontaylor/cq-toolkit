import { expect, test } from 'vitest';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { readSlotMetadata } from '../../../src/adapters/lock/slotLock.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import { identityRepo, deferred } from './addressManyWorktree.helpers.js';

async function fixture() {
  const repo = await identityRepo();
  const head = repo.git('rev-parse', 'HEAD').trim();
  repo.git('push', '-q', 'origin', `${head}:refs/pull/7/head`);
  const common = repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const { makeGhRunner } = await import('../../../src/adapters/forge-github/gh.js');
  const run = makeGhRunner({ bin: 'git', cwd: repo.root });
  const worktreeRoot = join(common, 'cq-review-worktrees');
  const metadataPath = join(common, 'cq-review', 'slots', 'pr-7.json');
  const opts = {
    repoRoot: repo.root,
    pr: 7,
    headRefName: 'feature/x',
    run,
    registry: slotWorktreeRegistry(common),
    nowMs: 1,
    worktreeRoot,
  };
  return { repo, common, opts, run, metadataPath };
}

test('fetch and add are excluded before admin dir exists (mutation: acquire PR slot after fetch)', async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  let contenderFetch = false;
  const held: GhFn = async (args) => {
    if (args.includes('fetch')) {
      entered.resolve();
      await release.promise;
    }
    return f.run(args);
  };
  const first = resolvePrWorktree({ ...f.opts, run: held });
  try {
    await entered.promise;
    await expect(
      resolvePrWorktree({
        ...f.opts,
        run: async (args) => {
          if (args.includes('fetch')) contenderFetch = true;
          return f.run(args);
        },
      }),
    ).rejects.toThrow(/busy/i);
    expect(contenderFetch).toBe(false);
    expect((await readSlotMetadata(f.metadataPath))?.incomplete).toBe(true);
    release.resolve();
    expect((await first).path).toBeTruthy();
  } finally {
    release.resolve();
    await first.catch(() => undefined);
    await f.repo.cleanup();
  }
});

test('remove and re-create retain persistent slot inode (mutation: release PR slot before removal)', async () => {
  const f = await fixture();
  const entered = deferred(),
    release = deferred();
  try {
    const first = await resolvePrWorktree(f.opts);
    const lockPath = f.metadataPath.replace(/json$/, 'lock');
    const inode = (await stat(lockPath)).ino;
    await f.repo.write('src/next.ts', 'export const next = 1;\n');
    f.repo.commitAll('next PR head');
    f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    const held: GhFn = async (args) => {
      const result = await f.run(args);
      if (args.includes('remove') && result.code === 0) {
        entered.resolve();
        await release.promise;
      }
      return result;
    };
    const refresh = resolvePrWorktree({ ...f.opts, run: held });
    try {
      await entered.promise;
      let fetched = false;
      await expect(
        resolvePrWorktree({
          ...f.opts,
          headRefName: 'renamed',
          run: async (args) => {
            if (args.includes('fetch')) fetched = true;
            return f.run(args);
          },
        }),
      ).rejects.toThrow(/busy/i);
      expect(fetched).toBe(false);
      release.resolve();
      expect((await refresh).path).toBe(first.path);
    } finally {
      release.resolve();
      await refresh.catch(() => undefined);
    }
    expect((await stat(lockPath)).ino).toBe(inode);
    expect((await readSlotMetadata(f.metadataPath))?.incomplete).toBe(false);
    expect(await readFile(join(first.path, 'src/next.ts'), 'utf8')).toContain('next');
  } finally {
    release.resolve();
    await f.repo.cleanup();
  }
});

test('failed remove retains bound incomplete pointer (mutation: write unbound before removal)', async () => {
  const f = await fixture();
  try {
    const first = await resolvePrWorktree(f.opts);
    await f.repo.write('src/next.ts', 'export const next = 1;\n');
    f.repo.commitAll('next PR head');
    f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
    await writeFile(join(first.path, 'README.md'), 'private bytes\n');
    await expect(resolvePrWorktree(f.opts)).rejects.toThrow(/dirty|remove/i);
    expect(await readSlotMetadata(f.metadataPath)).toMatchObject({
      state: 'bound',
      incomplete: true,
      checkoutPath: first.path,
    });
    expect(await readFile(join(first.path, 'README.md'), 'utf8')).toBe('private bytes\n');
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['tracked', 'index', 'untracked', 'ignored', 'authenticated'] as const)(
  'same-head dirty checkout refuses with authenticated bookkeeping exception: %s (mutation: omit cleanliness check)',
  async (kind) => {
    const f = await fixture();
    try {
      const first = await resolvePrWorktree(f.opts);
      if (kind === 'tracked' || kind === 'index') {
        await writeFile(join(first.path, 'README.md'), 'private bytes\n');
        if (kind === 'index') f.repo.git('-C', first.path, 'add', 'README.md');
      } else {
        if (kind === 'ignored') await writeFile(join(first.path, '.gitignore'), 'bookkeeping\n');
        // Keep the ignored rule out of tracked/index dirtiness so this branch tests ignored content.
        if (kind === 'ignored') f.repo.git('-C', first.path, 'add', '.gitignore');
        if (kind === 'ignored') f.repo.git('-C', first.path, 'commit', '-qm', 'ignore fixture');
        if (kind === 'ignored')
          f.repo.git('-C', first.path, 'push', '-q', 'origin', 'HEAD:refs/pull/7/head');
        await writeFile(join(first.path, 'bookkeeping'), 'owned bytes\n');
      }
      const promise = resolvePrWorktree({
        ...f.opts,
        ...(kind === 'authenticated'
          ? {
              isBookkeepingPath: async (path: string) =>
                path === 'bookkeeping' &&
                (await readFile(join(first.path, path), 'utf8')) === 'owned bytes\n',
            }
          : {}),
      });
      if (kind === 'authenticated') {
        expect((await promise).reused).toBe(true);
        await writeFile(join(first.path, 'private-note'), 'unowned bytes\n');
        await expect(
          resolvePrWorktree({
            ...f.opts,
            isBookkeepingPath: async (path) => path === 'bookkeeping',
          }),
        ).rejects.toThrow(/dirty|unowned/i);
      } else await expect(promise).rejects.toThrow(/dirty|unowned/i);
    } finally {
      await f.repo.cleanup();
    }
  },
);

test.each(['common', 'address-journal', 'selfhost-journal'])(
  'requested legacy registry requires migration in D: %s (mutation: omit stat-only legacy refusal)',
  async (kind) => {
    const f = await fixture();
    try {
      const source =
        kind === 'common'
          ? join(f.common, 'cq-review-address-worktrees.json')
          : join(
              f.repo.root,
              kind,
              kind === 'selfhost-journal' ? 'worktree-registry.json' : 'worktrees.json',
            );
      await mkdir(join(source, '..'), { recursive: true });
      await writeFile(source, 'unparsed legacy bytes');
      let fetched = false;
      await expect(
        resolvePrWorktree({
          ...f.opts,
          registry: slotWorktreeRegistry(f.common, { legacySources: [source] }),
          run: async (args) => {
            if (args.includes('fetch')) fetched = true;
            return f.run(args);
          },
        }),
      ).rejects.toThrow('legacy review registry requires migration');
      expect(fetched).toBe(false);
      expect(await readFile(source, 'utf8')).toBe('unparsed legacy bytes');
    } finally {
      await f.repo.cleanup();
    }
  },
);
