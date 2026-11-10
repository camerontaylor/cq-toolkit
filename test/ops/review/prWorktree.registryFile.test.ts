// Split provenance: test/ops/review/prWorktree.test.ts was split into
// prWorktree.helpers.ts (shared fixtures) and prWorktree.fetchFirst.test.ts,
// prWorktree.registryConsult.test.ts, prWorktree.scanReuse.test.ts,
// prWorktree.createPath.test.ts, prWorktree.ownership.test.ts,
// prWorktree.paths.test.ts, prWorktree.remove.test.ts,
// prWorktree.registryFile.test.ts.
//
// Shared fixtures and the fake git model (with the full pinned-behavior
// header) live in prWorktree.helpers.ts.
import { describe, expect, test, vi } from 'vitest';
import { mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import {
  fileWorktreeRegistry,
  nextRegistryTmpNonce,
  registryTmpPath,
} from '../../../src/adapters/git/prWorktree.js';
import type { RegistryMap, WorktreeRegistryEntry } from '../../../src/adapters/git/prWorktree.js';
import { NOW, LABEL } from './prWorktree.helpers.js';

const acquireFault = vi.hoisted(() => ({ code: '', attempts: 0 }));
vi.mock('proper-lockfile', async (original) => {
  const actual = await original<typeof import('proper-lockfile')>();
  return {
    ...actual,
    lock: async (...args: Parameters<typeof actual.lock>) => {
      if (acquireFault.code) {
        acquireFault.attempts += 1;
        throw Object.assign(new Error('filesystem unavailable'), { code: acquireFault.code });
      }
      return actual.lock(...args);
    },
  };
});

// ---------------------------------------------------------------------------
// fileWorktreeRegistry — the file-backed registry
// ---------------------------------------------------------------------------

describe('fileWorktreeRegistry', () => {
  test.each(['EACCES', 'EPERM', 'EROFS', 'ENOSPC', 'ENOENT'])(
    'fails immediately on %s without blaming a lock holder or entering the callback',
    async (code) => {
      acquireFault.code = code;
      acquireFault.attempts = 0;
      const callback = vi.fn();
      try {
        const error: unknown = await fileWorktreeRegistry('/unused/registry.json')
          .withLock(callback)
          .catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error('expected acquisition failure');
        expect(error.message).toContain(`acquisition failed (${code})`);
        expect(error.cause).toMatchObject({ code });
        expect(acquireFault.attempts).toBe(1);
        expect(callback).not.toHaveBeenCalled();
      } finally {
        acquireFault.code = '';
      }
    },
  );

  test('a contender waits until a recently abandoned lock becomes stale and recovers it', async () => {
    const dir = await realTmpDir('cq-wt-reg-');
    const path = join(dir, 'worktrees.json');
    try {
      await mkdir(`${path}.lock`);
      const abandoned = new Date(Date.now() - 9_900);
      await utimes(`${path}.lock`, abandoned, abandoned);
      const registry = fileWorktreeRegistry(path);
      await registry.withLock(() =>
        registry.update('7', { path: '/t/pr-7', branch: 'b7', createdAt: NOW }),
      );
      expect(await registry.load()).toHaveProperty('7');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a live holder can finish a checkout longer than the old retry budget before the contender enters', async () => {
    const dir = await realTmpDir('cq-wt-reg-');
    const registry = fileWorktreeRegistry(join(dir, 'worktrees.json'));
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let holderFinished = false;
    try {
      const holder = registry.withLock(async () => {
        entered();
        await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
        holderFinished = true;
      });
      await holding;
      const contender = registry.withLock(async () => {
        expect(holderFinished).toBe(true);
      });
      await Promise.all([holder, contender]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a missing registry file loads as empty, save creates it, and a fresh instance round-trips', async () => {
    const dir = await realTmpDir('cq-wt-reg-');
    try {
      const path = join(dir, 'worktrees.json');
      const log = fileWorktreeRegistry(path);
      expect(await log.load()).toEqual({});
      const map: RegistryMap = {
        '7': {
          path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix',
          branch: LABEL,
          createdAt: NOW,
        },
      };
      await log.save(map);
      // A fresh registry over the same path sees the saved map (cross-run).
      expect(await fileWorktreeRegistry(path).load()).toEqual(map);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt registry file throws a CLEAR error (an array is not a registry either)', async () => {
    const dir = await realTmpDir('cq-wt-reg-');
    try {
      const path = join(dir, 'worktrees.json');
      await writeFile(path, '{not json at all', 'utf8');
      await expect(fileWorktreeRegistry(path).load()).rejects.toThrow(/corrupt/);
      await writeFile(path, '[]', 'utf8');
      await expect(fileWorktreeRegistry(path).load()).rejects.toThrow(/corrupt/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('save is ATOMIC (write tmp + rename): interleaved save/load cycles always leave parseable content', async () => {
    const dir = await realTmpDir('cq-wt-reg-');
    try {
      const path = join(dir, 'worktrees.json');
      const registry = fileWorktreeRegistry(path);
      // Interleave loads (including ones racing the save) with saves; after
      // EVERY cycle the on-disk registry must parse as a JSON object — an
      // interrupted in-place rewrite would leave partial JSON here and the
      // next load would throw corrupt.
      for (let cycle = 0; cycle < 15; cycle++) {
        const map: RegistryMap = {
          '7': {
            path: `/repo/.cq-review-worktrees/pr-7-${cycle}`,
            branch: LABEL,
            createdAt: NOW + cycle,
          },
        };
        await Promise.all([registry.load(), registry.save(map), registry.load()]);
        const onDisk: unknown = JSON.parse(await readFile(path, 'utf8'));
        expect(onDisk).toHaveProperty('7');
      }
      // A FRESH registry instance sees the last save (the rename replaced
      // the file, nothing was lost between cycles).
      const final = await fileWorktreeRegistry(path).load();
      expect(final['7']?.path).toBe('/repo/.cq-review-worktrees/pr-7-14');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('update() MERGES per key: sequential updates for different PRs preserve each other (no whole-map clobber)', async () => {
    const dir = await realTmpDir('cq-wt-reg-');
    try {
      const path = join(dir, 'worktrees.json');
      const registry = fileWorktreeRegistry(path);
      const entry7: WorktreeRegistryEntry = { path: '/t/pr-7', branch: 'b7', createdAt: NOW };
      const entry9: WorktreeRegistryEntry = { path: '/t/pr-9', branch: 'b9', createdAt: NOW + 1 };
      await registry.update('7', entry7);
      await registry.update('9', entry9);
      // Each update re-reads the file before writing its ONE key: the first
      // entry survives the second update (concurrent resolves for different
      // PRs can no longer drop each other).
      expect(await registry.load()).toEqual({ '7': entry7, '9': entry9 });
      // Clearing one key leaves the other untouched.
      await registry.update('7', null);
      expect(await registry.load()).toEqual({ '9': entry9 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('registry tmp names are UNIQUE per save call (a shared .tmp let one rename steal the other’s source)', () => {
    // The nonce generator is one-up — two calls can never collide…
    expect(nextRegistryTmpNonce()).not.toBe(nextRegistryTmpNonce());
    // …and the derived tmp path stays one boring segment beside the target.
    const a = registryTmpPath('/t/registry.json', nextRegistryTmpNonce());
    const b = registryTmpPath('/t/registry.json', nextRegistryTmpNonce());
    expect(a).not.toBe(b);
    for (const tmp of [a, b]) {
      expect(tmp.startsWith('/t/registry.json.')).toBe(true);
      expect(tmp.endsWith('.tmp')).toBe(true);
      expect(tmp.slice('/t/'.length)).not.toContain('/');
    }
  });

  test('update() rides withLock on the file-backed registry: two concurrent updates for different keys BOTH persist', async () => {
    const dir = await realTmpDir('cq-wt-reg-');
    try {
      const path = join(dir, 'worktrees.json');
      const registry = fileWorktreeRegistry(path);
      const entry7: WorktreeRegistryEntry = { path: '/t/pr-7', branch: 'b7', createdAt: NOW };
      const entry9: WorktreeRegistryEntry = { path: '/t/pr-9', branch: 'b9', createdAt: NOW + 1 };
      // Fired CONCURRENTLY under `withLock` (the documented contract:
      // update is an UNLOCKED primitive): the `<path>.lock` serializes the
      // load-merge-save chains, so the second update re-reads the first's
      // entry instead of clobbering it (an unsynchronized whole-map save
      // would drop one).
      await Promise.all([
        registry.withLock(() => registry.update('7', entry7)),
        registry.withLock(() => registry.update('9', entry9)),
      ]);
      const map = await registry.load();
      expect(map['7']).toEqual(entry7);
      expect(map['9']).toEqual(entry9);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
