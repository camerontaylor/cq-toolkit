import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import { slotWorktreeRegistry } from '../../../src/adapters/git/slotWorktreeRegistry.js';
import {
  runAddressReviewLoop,
  withAddressOwnership,
} from '../../../src/ops/review/internal/addressCheckoutOwnership.js';
import { identityRepo } from './addressManyWorktree.helpers.js';

async function fixture() {
  const repo = await identityRepo();
  repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
  const common = repo.git('rev-parse', '--path-format=absolute', '--git-common-dir').trim();
  const root = join(common, 'cq-review-worktrees');
  await mkdir(root, { recursive: true });
  const opts = {
    repoRoot: repo.root,
    pr: 7,
    headRefName: 'feature',
    worktreeRoot: root,
    nowMs: 1,
    run: makeGhRunner({ bin: 'git', cwd: repo.root }),
  };
  return { repo, common, root, opts };
}

test.each(['propagated', 'caught'] as const)(
  'legacy hint survives separate owner and resolver facades without pruning stale checkout: %s',
  async (mode) => {
    const f = await fixture();
    try {
      const path = join(f.root, 'pr-7-feature');
      f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
      const source = join(f.repo.root, 'worktree-registry.json');
      const bytes = JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' } });
      await writeFile(source, bytes);
      await writeFile(join(f.repo.root, 'new-file'), 'new head');
      f.repo.git('add', 'new-file');
      f.repo.git('commit', '-m', 'advance head');
      f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
      const registry = slotWorktreeRegistry(f.common, { legacySources: [source] });
      const attempt = () =>
        withAddressOwnership(
          {
            repoRoot: f.repo.root,
            git: f.opts.run,
            source: 'pr:7',
            production: true,
            legacySources: [source],
          },
          async (lease) =>
            runAddressReviewLoop(lease, {
              owner: 'fixture',
              repo: 'base',
              pr: 7,
              headRefName: 'feature',
              repoRoot: f.repo.root,
              git: f.opts.run,
              gh: async () => {
                throw new Error('forge must not dispatch');
              },
              registry,
              worktreeRoot: f.root,
              nowMs: 1,
              driver: { provider: 'mock', model: 'offline' },
              dispatchLogPath: join(f.repo.root, 'dispatch.jsonl'),
            }).catch((error: Error) => {
              if (mode === 'caught') return { reasons: [error.message] };
              throw error;
            }),
        );
      const first = await attempt().then(
        (outcome) => outcome.reasons.join(' '),
        (error: Error) => error.message,
      );
      expect(first).toMatch(
        mode === 'caught' ? /requires reconciliation/ : /identity or head mismatch/,
      );
      await expect(attempt()).rejects.toThrow(/incomplete/i);
      expect((await lstat(path)).isDirectory()).toBe(true);
      expect(await readFile(source, 'utf8')).toBe(bytes);
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('successfully imported checkout can refresh within the same lifetime', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'pr-7-feature');
    f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
    const source = join(f.repo.root, 'worktrees.json');
    await writeFile(source, JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' } }));
    const registry = slotWorktreeRegistry(f.common, { legacySources: [source] });
    await withAddressOwnership(
      {
        repoRoot: f.repo.root,
        git: f.opts.run,
        source: 'pr:7',
        production: true,
        legacySources: [source],
      },
      async () => {
        expect((await resolvePrWorktree({ ...f.opts, registry })).reused).toBe(true);
        await writeFile(join(f.repo.root, 'advance'), 'new head');
        f.repo.git('add', 'advance');
        f.repo.git('commit', '-m', 'advance head');
        f.repo.git('push', '-q', 'origin', 'HEAD:refs/pull/7/head');
        expect((await resolvePrWorktree({ ...f.opts, registry })).reused).toBe(false);
      },
    );
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['common', 'address-journal', 'selfhost-journal'])(
  'valid requested legacy checkout imports without shared-map mutation: %s',
  async (kind) => {
    const f = await fixture();
    try {
      const path = join(f.root, 'old');
      f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
      const source =
        kind === 'common'
          ? join(f.common, 'cq-review-address-worktrees.json')
          : join(
              f.repo.root,
              kind,
              kind === 'selfhost-journal' ? 'worktree-registry.json' : 'worktrees.json',
            );
      await mkdir(join(source, '..'), { recursive: true });
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
  },
);

test('missing legacy requested entry permits new PR resolution', async () => {
  const f = await fixture();
  try {
    const source = join(f.common, 'cq-review-address-worktrees.json');
    const bytes = JSON.stringify({ 8: { path: '/other', branch: 'cq-review/pr-8' } });
    await writeFile(source, bytes);
    const result = await resolvePrWorktree({
      ...f.opts,
      registry: slotWorktreeRegistry(f.common, { legacySources: [source] }),
    });
    expect(result.reused).toBe(false);
    expect(await readFile(source, 'utf8')).toBe(bytes);
  } finally {
    await f.repo.cleanup();
  }
});

test.each(['foreign', 'conflicting'])(
  'foreign or conflicting requested hint never authorizes deletion: %s',
  async (kind) => {
    const f = await fixture();
    try {
      const first = join(f.common, 'legacy.json'),
        second = join(f.common, 'journal.json');
      const path = kind === 'foreign' ? f.repo.root : join(f.root, 'one');
      await writeFile(first, JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' }, 8: null }));
      await writeFile(
        second,
        JSON.stringify({
          7: { path: kind === 'foreign' ? path : join(f.root, 'two'), branch: 'cq-review/pr-7' },
        }),
      );
      await expect(
        resolvePrWorktree({
          ...f.opts,
          registry: slotWorktreeRegistry(f.common, { legacySources: [first, second] }),
        }),
      ).rejects.toThrow(kind === 'foreign' ? /foreign/ : /conflicting/);
      expect(f.repo.git('rev-parse', '--is-inside-work-tree').trim()).toBe('true');
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('new incomplete wins over old complete hint', async () => {
  const f = await fixture();
  try {
    const source = join(f.repo.root, 'worktrees.json');
    const path = join(f.root, 'old');
    f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
    await writeFile(source, JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' } }));
    const registry = slotWorktreeRegistry(f.common, { legacySources: [source] });
    await resolvePrWorktree({ ...f.opts, registry });
    const { acquireSlot } = await import('../../../src/adapters/lock/slotLock.js');
    const slot = await acquireSlot(f.common, 7);
    const metadata = await slot.readMetadata();
    if (!metadata) throw new Error('expected registered metadata');
    await slot.writeMetadata({ ...metadata, incomplete: true });
    await slot.close();
    let wrote = false;
    await expect(
      resolvePrWorktree({
        ...f.opts,
        registry,
        run: async (args) => {
          wrote = true;
          return f.opts.run(args);
        },
      }),
    ).rejects.toThrow(/incomplete/i);
    expect(wrote).toBe(false);
  } finally {
    await f.repo.cleanup();
  }
});

test('legacy corruption scoped to unmigrated slot', async () => {
  const f = await fixture();
  try {
    const source = join(f.repo.root, 'worktree-registry.json');
    const path = join(f.root, 'old');
    f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
    await writeFile(source, JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' } }));
    const registry = slotWorktreeRegistry(f.common, { legacySources: [source] });
    await resolvePrWorktree({ ...f.opts, registry });
    await writeFile(source, '{');
    await expect(resolvePrWorktree({ ...f.opts, registry })).resolves.toMatchObject({
      reused: true,
    });
    await expect(resolvePrWorktree({ ...f.opts, pr: 8, registry })).rejects.toThrow(source);
    expect(await readFile(source, 'utf8')).toBe('{');
  } finally {
    await f.repo.cleanup();
  }
});

test('imported checkout protected from remove through registration', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'old');
    f.repo.git('worktree', 'add', '-b', 'cq-review/pr-7', path, 'HEAD');
    const source = join(f.repo.root, 'worktree-registry.json');
    const bytes = JSON.stringify({ 7: { path, branch: 'cq-review/pr-7' } });
    await writeFile(source, bytes);
    const base = slotWorktreeRegistry(f.common, { legacySources: [source] });
    const { acquireSlot } = await import('../../../src/adapters/lock/slotLock.js');
    const gitDir = f.repo.git('-C', path, 'rev-parse', '--absolute-git-dir').trim();
    let checked = false;
    const registry = {
      ...base,
      update: async () => {
        await expect(acquireSlot(f.common, { checkoutGitDir: gitDir })).rejects.toThrow(/busy/i);
        checked = true;
        throw new Error('registration fault');
      },
    };
    await expect(resolvePrWorktree({ ...f.opts, registry })).rejects.toThrow('registration fault');
    expect(checked).toBe(true);
    expect(await readFile(source, 'utf8')).toBe(bytes);
    const { readSlotMetadata } = await import('../../../src/adapters/lock/slotLock.js');
    expect(
      (await readSlotMetadata(join(f.common, 'cq-review', 'slots', 'pr-7.json')))?.incomplete,
    ).toBe(true);
    expect(f.repo.git('-C', path, 'rev-parse', '--is-inside-work-tree').trim()).toBe('true');
  } finally {
    await f.repo.cleanup();
  }
});
