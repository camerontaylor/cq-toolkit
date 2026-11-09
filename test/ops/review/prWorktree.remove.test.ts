// Split provenance: test/ops/review/prWorktree.test.ts was split into
// prWorktree.helpers.ts (shared fixtures) and prWorktree.fetchFirst.test.ts,
// prWorktree.registryConsult.test.ts, prWorktree.scanReuse.test.ts,
// prWorktree.createPath.test.ts, prWorktree.ownership.test.ts,
// prWorktree.paths.test.ts, prWorktree.remove.test.ts,
// prWorktree.registryFile.test.ts.
//
// Shared fixtures and the fake git model (with the full pinned-behavior
// header) live in prWorktree.helpers.ts.
import { describe, expect, test } from 'vitest';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { removePrWorktree, resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import type {
  RegistryMap,
  WorktreeRegistry,
  WorktreeRegistryEntry,
} from '../../../src/adapters/git/prWorktree.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import {
  NOW,
  PR,
  BRANCH,
  LABEL,
  SHA_A,
  SHA_B,
  mkModel,
  fakeGit,
  memRegistry,
  baseOpts,
} from './prWorktree.helpers.js';

// ---------------------------------------------------------------------------
// removePrWorktree — the cleanup primitive
// ---------------------------------------------------------------------------

describe('removePrWorktree', () => {
  test('linked checkouts resolve and remove trees under the same common git directory', async () => {
    const mainRoot = await realTmpDir('cq-wt-common-');
    try {
      const linkedRoot = join(mainRoot, 'linked');
      const commonDir = join(mainRoot, '.git');
      const model = mkModel();
      const registry = memRegistry();
      const calls: string[][] = [];
      const git = fakeGit(model, calls);
      const run: GhFn = async (args) => {
        if (args[2] === 'rev-parse' && args.includes('--git-common-dir')) {
          expect(args).toEqual([
            '-C',
            linkedRoot,
            'rev-parse',
            '--path-format=absolute',
            '--git-common-dir',
          ]);
          return { code: 0, stdout: `${commonDir}\n`, stderr: '' };
        }
        return git(args);
      };
      const opts = baseOpts(model, registry, { repoRoot: linkedRoot, run });
      const created = await resolvePrWorktree(opts);
      expect(created.path).toBe(join(commonDir, 'cq-review-worktrees', `pr-${PR}-${BRANCH}`));
      // A second resolution from the linked checkout must classify the
      // common-root tree as owned, rather than foreign.
      const reused = await resolvePrWorktree(opts);
      expect(reused).toEqual({ ...created, reused: true });
      await removePrWorktree({ ...opts, path: created.path });
      expect(model.worktrees).toEqual([]);
      expect(registry.current()).toEqual({});
      expect(calls).toContainEqual(['-C', linkedRoot, 'worktree', 'remove', created.path]);
    } finally {
      await rm(mainRoot, { recursive: true, force: true });
    }
  });

  test('success removes the tree via git and prunes the registry entry', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': {
        path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix',
        branch: LABEL,
        createdAt: NOW - 1000,
      },
    });
    const model = mkModel([
      { path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix', branch: LABEL, head: SHA_B },
    ]);
    await removePrWorktree({
      ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
      path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix',
    });
    expect(calls[calls.length - 1]).toEqual([
      '-C',
      '/repo',
      'worktree',
      'remove',
      '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix',
    ]);
    // No --force anywhere: review ops never silently destroys trees.
    expect(calls.some((args) => args.includes('--force'))).toBe(false);
    expect(model.worktrees).toEqual([]);
    expect(registry.current()).toEqual({});
  });

  test('a dirty/locked tree → rethrows with stderr and prunes NOTHING (the caller decides)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': {
        path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix',
        branch: LABEL,
        createdAt: NOW - 1000,
      },
    });
    const model = mkModel(
      [{ path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix', branch: LABEL, head: SHA_B }],
      {
        removeFails: {
          code: 128,
          stderr: 'fatal: ... contains modified or untracked files, use --force to delete it',
        },
      },
    );
    await expect(
      removePrWorktree({
        ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
        path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix',
      }),
    ).rejects.toThrow(/worktree remove.*failed.*contains modified or untracked files/s);
    // The tree stays, and the registry entry STAYS (truth on disk unchanged).
    expect(model.worktrees).toHaveLength(1);
    expect(registry.current()['7']).toBeDefined();
  });

  test('a registry entry pointing ELSEWHERE survives the removal — only its own path is pruned', async () => {
    const calls: string[][] = [];
    // The entry describes a RE-CREATED tree at a new location; the caller
    // is removing a DIFFERENT (old) in-root path.
    const entryPath = '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix';
    const oldPath = '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix.old';
    const registry = memRegistry({
      '7': { path: entryPath, branch: LABEL, createdAt: NOW - 1000 },
    });
    const model = mkModel([{ path: oldPath, branch: LABEL, head: SHA_A }]);
    await removePrWorktree({
      ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
      path: oldPath,
    });
    // git removed the requested tree…
    expect(calls[calls.length - 1]).toEqual(['-C', '/repo', 'worktree', 'remove', oldPath]);
    expect(model.worktrees).toEqual([]);
    // …but the registry entry describes a DIFFERENT path and SURVIVES
    // (load ran; save never did — nothing was pruned).
    expect(registry.current()['7']).toEqual({
      path: entryPath,
      branch: LABEL,
      createdAt: NOW - 1000,
    });
    expect(registry.calls).toEqual(['load']);
  });

  test('a path OUTSIDE the worktreeRoot is refused before any destructive git runs — the registry and the foreign tree are untouched', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': {
        path: '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix',
        branch: LABEL,
        createdAt: NOW - 1000,
      },
    });
    const model = mkModel([{ path: '/elsewhere/foreign-pr-7-fix', branch: LABEL, head: SHA_B }]);
    await expect(
      removePrWorktree({
        ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
        path: '/elsewhere/foreign-pr-7-fix',
      }),
    ).rejects.toThrow(/removePrWorktree: refusing to remove.*outside the review worktreeRoot/s);
    // The ONLY git call is the git-dir derivation the boundary check needs;
    // the foreign tree and the registry both intact.
    expect(calls).toEqual([
      ['-C', '/repo', 'rev-parse', '--path-format=absolute', '--git-common-dir'],
    ]);
    expect(model.worktrees).toHaveLength(1);
    expect(registry.current()['7']).toBeDefined();
    expect(registry.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// review-debt #121 — removePrWorktree's registry tail runs under withLock
// ---------------------------------------------------------------------------

/**
 * A one-shot gate for deterministic interleaving: the pausing side resolves
 * `reached` when it ARRIVES; the test calls `release` to let it continue.
 */
const deferredGate = (): { reached: Promise<void>; release: () => void } => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { reached, release };
};

/**
 * An in-memory registry with a REAL async mutex on withLock (queued critical
 * sections can neither observe nor mutate `stored` until released), a call
 * log carrying the lock depth, and a pause hook that can suspend the NEXT
 * save mid-write — the deterministic interleaving rig for the registry-tail
 * races. update() delegates to its own save, mirroring the real per-key
 * primitive's load-merge-save shape.
 */
const mutexRegistry = (
  initial: RegistryMap = {},
): {
  registry: WorktreeRegistry;
  calls: string[];
  current: () => RegistryMap;
  pauseNextSave: () => { reached: Promise<void>; release: () => void };
} => {
  const calls: string[] = [];
  let stored: RegistryMap = { ...initial };
  let queue: Promise<unknown> = Promise.resolve();
  let depth = 0;
  let hooked: { reached: () => void; gate: Promise<void> } | null = null;
  const registry: WorktreeRegistry = {
    load: async () => {
      calls.push(`load@${String(depth)}`);
      return { ...stored };
    },
    save: async (map: RegistryMap) => {
      if (hooked !== null) {
        const hook = hooked;
        hooked = null;
        calls.push('save:paused');
        hook.reached();
        await hook.gate;
      }
      calls.push('save');
      stored = { ...map };
    },
    update: async (key: string, entry: WorktreeRegistryEntry | null) => {
      calls.push(`${entry === null ? `update:${key}:null` : `update:${key}`}@${String(depth)}`);
      const merged: RegistryMap = { ...stored };
      if (entry === null) {
        delete merged[key];
      } else {
        merged[key] = { ...entry };
      }
      await registry.save(merged);
    },
    withLock: <T>(fn: () => Promise<T>): Promise<T> => {
      const run = queue.then(async () => {
        depth += 1;
        try {
          return await fn();
        } finally {
          depth -= 1;
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return {
    calls,
    current: () => ({ ...stored }),
    registry,
    pauseNextSave: () => {
      const pause = deferredGate();
      const continueSave = deferredGate();
      hooked = { reached: pause.release, gate: continueSave.reached };
      return { reached: pause.reached, release: continueSave.release };
    },
  };
};

describe('removePrWorktree lock discipline (review-debt #121)', () => {
  test('the registry tail (load + conditional update) runs entirely under withLock', async () => {
    const path = '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix';
    const harness = mutexRegistry({ '7': { path, branch: LABEL, createdAt: NOW - 1000 } });
    const model = mkModel([{ path, branch: LABEL, head: SHA_B }]);
    await removePrWorktree({
      ...baseOpts(model, harness.registry, { run: fakeGit(model) }),
      path,
    });
    // Both registry operations ran at lock depth 1 — inside withLock — in
    // the documented order, and the entry for the removed path was pruned.
    expect(harness.calls).toEqual(['load@1', 'update:7:null@1', 'save']);
    expect(harness.current()).toEqual({});
  });

  test('two racing removes for DIFFERENT PRs serialize under the lock — neither removal is lost', async () => {
    const path7 = '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix';
    const path9 = '/repo/.git/cq-review-worktrees/pr-9-pr-9-fix';
    const harness = mutexRegistry({
      '7': { path: path7, branch: LABEL, createdAt: NOW - 1000 },
      '9': { path: path9, branch: LABEL, createdAt: NOW - 1000 },
    });
    const model = mkModel([
      { path: path7, branch: LABEL, head: SHA_B },
      { path: path9, branch: LABEL, head: SHA_B },
    ]);
    // Suspend remove7's tail INSIDE its critical section, mid-save. remove9
    // must BLOCK at the lock (never observing or mutating the suspended
    // state), then converge after the release — both removals land.
    const pause = harness.pauseNextSave();
    const remove7 = removePrWorktree({
      ...baseOpts(model, harness.registry, { run: fakeGit(model) }),
      pr: 7,
      path: path7,
    });
    await pause.reached;
    let remove9Settled = false;
    const remove9 = removePrWorktree({
      ...baseOpts(model, harness.registry, { run: fakeGit(model) }),
      pr: 9,
      path: path9,
    }).finally(() => {
      remove9Settled = true;
    });
    // A full macrotask turn: every pre-lock step of remove9 has settled, and
    // its critical section is still queued (the lock is held).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    // Settlement is tracked by a flag, not Promise.race: racing a derived
    // promise against an already-resolved 'pending' would report pending even
    // for a settled remove9.
    expect(remove9Settled).toBe(false);
    pause.release();
    await Promise.all([remove7, remove9]);
    // Deterministic serialized order, and NEITHER key was lost or resurrected
    // (the unlocked interleave would overwrite one removal with the other's
    // stale whole-map write).
    expect(harness.calls).toEqual([
      'load@1',
      'update:7:null@1',
      'save:paused',
      'save',
      'load@1',
      'update:9:null@1',
      'save',
    ]);
    expect(harness.current()).toEqual({});
  });

  test('a remove racing a resolvePrWorktree for the SAME pr leaves the registry pointing at one consistent tree', async () => {
    const repoRoot = await realTmpDir('cq-wt-race-');
    try {
      const worktreeRoot = join(repoRoot, '.git', 'cq-review-worktrees');
      const oldPath = join(worktreeRoot, 'pr-7-old');
      const freshPath = join(worktreeRoot, `pr-${PR}-${BRANCH}`);
      const harness = mutexRegistry({
        '7': { path: oldPath, branch: LABEL, createdAt: NOW - 1000 },
      });
      // The entry points at a GONE tree (the remove's target); no listed
      // trees, so the resolve must (re)create the fresh one and register it.
      const model = mkModel();
      const calls: string[][] = [];
      // Deterministic interleave: the remove's git worktree-remove parks on
      // a gate while the resolve runs to completion (registering the fresh
      // tree); then the remove resumes — its IN-LOCK re-load must see the
      // fresh registration and leave it alone (path differs → no prune).
      const removeGate = deferredGate();
      const ungated = fakeGit(model, calls);
      const gatedRun: GhFn = async (args) => {
        if (args[2] === 'worktree' && args[3] === 'remove') {
          await removeGate.reached;
        }
        return ungated(args);
      };
      const removePromise = removePrWorktree({
        ...baseOpts(model, harness.registry, { repoRoot, run: gatedRun }),
        path: oldPath,
      });
      const resolved = await resolvePrWorktree(
        baseOpts(model, harness.registry, { repoRoot, run: ungated }),
      );
      expect(resolved.path).toBe(freshPath);
      removeGate.release();
      await removePromise;
      // One consistent tree: the fresh registration survived; no stale prune.
      expect(harness.current()['7']).toEqual({
        path: freshPath,
        branch: LABEL,
        createdAt: NOW,
      });
      expect(harness.calls).not.toContain('update:7:null@1');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
