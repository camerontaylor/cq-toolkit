import { withAddressOwnership } from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { expect, test } from 'vitest';
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  symlink,
  readdir,
  realpath,
  rename,
} from 'node:fs/promises';
import { join } from 'node:path';
import { resolvePrWorktree, removePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import { CheckoutWriterContext } from '../../../src/shared/checkoutWriterContext.js';
import { acquireSlot } from '../../../src/adapters/lock/slotLock.js';
import { lstat } from 'node:fs/promises';
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
  'unrelated legacy registry entry permits resolution: %s',
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
      const bytes = JSON.stringify({ 8: { path: '/other', branch: 'cq-review/pr-8' } });
      await writeFile(source, bytes);
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
      ).resolves.toMatchObject({ reused: false });
      expect(fetched).toBe(true);
      expect(await readFile(source, 'utf8')).toBe(bytes);
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('requested legacy checkout is reused without rewriting the registry', async () => {
  const f = await fixture();
  try {
    await mkdir(f.opts.worktreeRoot, { recursive: true });
    const path = join(f.opts.worktreeRoot, 'legacy');
    f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
    const source = join(f.common, 'cq-review-address-worktrees.json');
    const bytes = JSON.stringify({ 7: { path, branch: 'cq-review/pr-7', createdAt: 1 } });
    await writeFile(source, bytes);
    const result = await resolvePrWorktree({
      ...f.opts,
      registry: slotWorktreeRegistry(f.common, { legacySources: [source] }),
    });
    expect(result).toMatchObject({ path, reused: true });
    expect(await readFile(source, 'utf8')).toBe(bytes);
  } finally {
    await f.repo.cleanup();
  }
});

test('alias-spelled removal unbinds every deleted checkout pointer (mutation: notify removal with raw alias)', async () => {
  const f = await fixture();
  try {
    await mkdir(f.opts.worktreeRoot, { recursive: true });
    const alias = join(f.common, 'tree-alias');
    await symlink(f.opts.worktreeRoot, alias, 'dir');
    const opts = { ...f.opts, worktreeRoot: alias };
    const first = await resolvePrWorktree(opts);
    const canonical = await realpath(first.path);
    expect(first.path).not.toBe(canonical);
    const removed = await removePrWorktree({ ...opts, path: first.path }).then(
      () => true,
      () => false,
    );
    expect(removed, 'verified alias removal must complete').toBe(true);
    const directory = join(f.common, 'cq-review/slots');
    for (const name of (await readdir(directory)).filter((name) => name.endsWith('.json')))
      expect(await readSlotMetadata(join(directory, name))).toMatchObject({
        state: 'unbound',
        incomplete: false,
      });
    expect((await resolvePrWorktree(opts)).path).toBe(first.path);
  } finally {
    await f.repo.cleanup();
  }
});

test('removing an older checkout preserves a different bound PR pointer (mutation: omit admission binding capture)', async () => {
  const f = await fixture();
  try {
    const current = await resolvePrWorktree(f.opts);
    const old = join(f.opts.worktreeRoot, 'older');
    f.repo.git('worktree', 'add', '-qb', 'older-fixture', old, 'HEAD');
    const removed = await removePrWorktree({ ...f.opts, path: old }).then(
      () => true,
      () => false,
    );
    expect(removed, 'removal must preserve the surviving binding').toBe(true);
    expect(await readSlotMetadata(f.metadataPath)).toMatchObject({
      state: 'bound',
      checkoutPath: current.path,
      incomplete: false,
    });
    expect((await resolvePrWorktree(f.opts)).reused).toBe(true);
  } finally {
    await f.repo.cleanup();
  }
});

test('standalone slot facade completes each successful callback (mutation: omit standalone completion)', async () => {
  const f = await fixture();
  try {
    for (let round = 0; round < 2; round++) {
      const value = await f.opts.registry.withPrLock(7, async () => {
        expect((await f.opts.registry.read(7))?.incomplete).toBe(true);
        return round;
      });
      expect(value).toBe(round);
      expect(await readSlotMetadata(f.metadataPath)).toEqual({
        version: 1,
        state: 'unbound',
        incomplete: false,
      });
    }
  } finally {
    await f.repo.cleanup();
  }
});

test('completed missing checkout is recreated through the resolver (mutation: eager realpath binding at admission)', async () => {
  const f = await fixture();
  try {
    const first = await resolvePrWorktree(f.opts);
    f.repo.git('worktree', 'remove', first.path);
    const result = await resolvePrWorktree(f.opts).then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
    expect('value' in result, 'missing completed checkout must reach recreation').toBe(true);
    if (!('value' in result)) return;
    expect(result.value).toMatchObject({ path: first.path, reused: false });
    expect(await readSlotMetadata(f.metadataPath)).toMatchObject({
      state: 'bound',
      incomplete: false,
      checkoutPath: first.path,
    });
  } finally {
    await f.repo.cleanup();
  }
});

test('a dangling checkout alias remains refused (mutation: use following stat to infer absence)', async () => {
  const f = await fixture();
  try {
    const first = await resolvePrWorktree(f.opts);
    f.repo.git('worktree', 'remove', first.path);
    await symlink(join(f.common, 'missing-checkout'), first.path, 'dir');
    const before = await readFile(f.metadataPath, 'utf8');
    await expect(resolvePrWorktree(f.opts)).rejects.toThrow('bound checkout alias refused');
    expect((await lstat(first.path)).isSymbolicLink()).toBe(true);
    expect(await readFile(f.metadataPath, 'utf8')).toBe(before);
  } finally {
    await f.repo.cleanup();
  }
});

test('closed failed fetch restores fresh admission and permits retry (mutation: skip settled resolver completion)', async () => {
  const f = await fixture();
  try {
    await expect(
      resolvePrWorktree({
        ...f.opts,
        run: (args) =>
          args.includes('fetch')
            ? f.run(['-C', f.opts.repoRoot, 'fetch', 'missing-fixture-remote'])
            : f.run(args),
      }),
    ).rejects.toThrow(/fetch/);
    expect(await readSlotMetadata(f.metadataPath)).toEqual({
      version: 1,
      state: 'unbound',
      incomplete: false,
    });
    expect((await resolvePrWorktree(f.opts)).reused).toBe(false);
  } finally {
    await f.repo.cleanup();
  }
});

test('dirty refusal restores bound admission and permits a clean retry (mutation: skip settled resolver completion)', async () => {
  const f = await fixture();
  try {
    const first = await resolvePrWorktree(f.opts);
    const before = await readFile(f.metadataPath, 'utf8');
    const source = await readFile(join(first.path, 'README.md'));
    await writeFile(join(first.path, 'README.md'), 'user dirty bytes');
    await expect(resolvePrWorktree(f.opts)).rejects.toThrow(/dirty/);
    expect(await readFile(f.metadataPath, 'utf8')).toBe(before);
    expect(await readFile(join(first.path, 'README.md'), 'utf8')).toBe('user dirty bytes');
    await writeFile(join(first.path, 'README.md'), source);
    expect((await resolvePrWorktree(f.opts)).reused).toBe(true);
  } finally {
    await f.repo.cleanup();
  }
});

test('failure after worktree add retains incomplete and its checkout (mutation: allow settlement after add)', async () => {
  const f = await fixture();
  try {
    await expect(
      resolvePrWorktree({
        ...f.opts,
        onCreated: () => {
          throw new Error('after-add failure');
        },
      }),
    ).rejects.toThrow('after-add failure');
    const metadata = await readSlotMetadata(f.metadataPath);
    expect(metadata).toMatchObject({ state: 'bound', incomplete: true });
    if (metadata?.state !== 'bound') throw new Error('expected created pointer');
    expect(await readFile(join(metadata.checkoutPath, 'README.md'), 'utf8')).toContain('fixture');
    await expect(resolvePrWorktree(f.opts)).rejects.toThrow(/Incomplete slot/);
  } finally {
    await f.repo.cleanup();
  }
});

test('unbound writes and completion recheck checkout absence (mutation: omit unbound completion lstat)', async () => {
  const f = await fixture(),
    context = new CheckoutWriterContext(acquireSlot);
  try {
    const first = await resolvePrWorktree(f.opts);
    const gitDir = f.repo.git('-C', first.path, 'rev-parse', '--absolute-git-dir').trim();
    await context.acquire(f.common, 7);
    const checkout = await context.acquire(f.common, {
      checkoutPath: first.path,
      checkoutGitDir: gitDir,
    });
    await context.begin();
    await expect(
      checkout.writeMetadata({ version: 1, state: 'unbound', incomplete: true }),
    ).rejects.toThrow('unbound checkout still exists');
    f.repo.git('worktree', 'remove', first.path);
    await context.removed(first.path);
    await mkdir(first.path);
    await writeFile(join(first.path, 'private'), 'recreated bytes');
    await expect(context.complete()).rejects.toThrow('unbound checkout still exists');
    expect((await checkout.readMetadata())?.incomplete).toBe(true);
    expect(await readFile(join(first.path, 'private'), 'utf8')).toBe('recreated bytes');
  } finally {
    await context.close();
    await f.repo.cleanup();
  }
});

test('settled refusal proof cannot be replayed after a checkout mutation (mutation: propagate an older refusal proof)', async () => {
  const f = await fixture();
  try {
    const refusal = await resolvePrWorktree({
      ...f.opts,
      run: (args) =>
        args.includes('fetch')
          ? f.run(['-C', f.opts.repoRoot, 'fetch', 'missing-fixture-remote'])
          : f.run(args),
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    expect((await readSlotMetadata(f.metadataPath))?.incomplete).toBe(false);
    await expect(
      resolvePrWorktree({
        ...f.opts,
        onCreated: () => {
          throw refusal;
        },
      }),
    ).rejects.toThrow(/fetch/);
    expect(await readSlotMetadata(f.metadataPath)).toMatchObject({
      state: 'bound',
      incomplete: true,
    });
    await expect(resolvePrWorktree(f.opts)).rejects.toThrow(/Incomplete slot/);
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['same-head', 'stale-head'] as const)(
  'checkout safety probes exclude a finishing local writer: %s (mutation: inspect before checkout lock)',
  async (mode) => {
    const f = await fixture(),
      entered = deferred(),
      release = deferred();
    let local: Promise<void> | undefined,
      localHead = '',
      inspected = false;
    try {
      const first = await resolvePrWorktree(f.opts);
      if (mode === 'stale-head') {
        await f.repo.write('remote-only', 'remote branch advance');
        f.repo.commitAll('advance PR head');
        f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      }
      local = withAddressOwnership(
        { repoRoot: first.path, git: f.run, source: 'local', production: true },
        async (lease) => {
          entered.resolve();
          await release.promise;
          await lease.track(async () => {
            await writeFile(join(first.path, 'README.md'), 'local unpublished work');
            expect((await f.run(['-C', first.path, 'add', 'README.md'])).code).toBe(0);
            expect(
              (await f.run(['-C', first.path, 'commit', '-qm', 'local unpublished commit'])).code,
            ).toBe(0);
            localHead = (await f.run(['-C', first.path, 'rev-parse', 'HEAD'])).stdout.trim();
          });
        },
      );
      await entered.promise;
      const contender = await resolvePrWorktree({
        ...f.opts,
        run: async (args) => {
          const result = await f.run(args);
          const headProbe =
            args[1] === first.path && args.at(-2) === 'rev-parse' && args.at(-1) === 'HEAD';
          const aheadProbe = args.includes('rev-list') && args.includes('--count');
          if (headProbe || aheadProbe) {
            inspected = true;
            if ((mode === 'same-head' && headProbe) || (mode === 'stale-head' && aheadProbe)) {
              release.resolve();
              await local;
            }
          }
          return result;
        },
      }).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      expect(inspected, 'safety probes must wait for checkout exclusion').toBe(false);
      expect('error' in contender && String(contender.error)).toMatch(/Slot busy:/);
      release.resolve();
      await local;
      expect(f.repo.git('rev-parse', 'refs/heads/cq-review/pr-7').trim()).toBe(localHead);
      expect(await readFile(join(first.path, 'README.md'), 'utf8')).toBe('local unpublished work');
      await expect(resolvePrWorktree(f.opts)).rejects.toThrow(/unpushed|ahead/);
      expect(f.repo.git('rev-parse', 'refs/heads/cq-review/pr-7').trim()).toBe(localHead);
    } finally {
      release.resolve();
      await local;
      await f.repo.cleanup();
    }
  },
);

test('missing bound Git directory has a named refusal without changing checkout state (mutation: omit Git directory diagnostic)', async () => {
  const f = await fixture();
  let originalDir = '',
    backupDir = '',
    moved = false;
  try {
    const checkout = await resolvePrWorktree(f.opts);
    const metadata = await readSlotMetadata(f.metadataPath);
    if (metadata?.state !== 'bound') throw new Error('expected bound metadata');
    originalDir = metadata.checkoutGitDir;
    backupDir = join(f.common, 'operator-held-admin');
    const before = await readFile(f.metadataPath, 'utf8');
    const source = await readFile(join(checkout.path, 'README.md'));
    // Reversibly model partial admin deletion, never remove the checkout.
    await rename(originalDir, backupDir);
    moved = true;
    for (let refusal = 0; refusal < 2; refusal++) {
      await expect(resolvePrWorktree(f.opts)).rejects.toThrow(
        `bound checkout Git directory missing: ${originalDir}; checkout preserved: ${checkout.path}`,
      );
      expect(await readFile(f.metadataPath, 'utf8')).toBe(before);
      expect(await readFile(join(checkout.path, 'README.md'))).toEqual(source);
    }
    await rename(backupDir, originalDir);
    moved = false;
    expect((await resolvePrWorktree(f.opts)).reused).toBe(true);
    expect((await readSlotMetadata(f.metadataPath))?.incomplete).toBe(false);
  } finally {
    if (moved) await rename(backupDir, originalDir);
    await f.repo.cleanup();
  }
});
