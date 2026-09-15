// E3 slice 3 — tests for prWorktree (src/ops/review/prWorktree.ts;
// UC §2 row 38).
//
// Pinned here:
//   1. ORIGIN BRANCH IS TRUTH: the fetch runs FIRST (a fetch failure throws
//      before the registry is even consulted — nothing touched, nothing
//      saved).
//   2. Registry hit whose entry still points at truth → reused, and NO
//      worktree list/add ever runs.
//   3. STALE registry entries (directory gone, or wrong branch checked out)
//      are pruned and resolution continues (recreated / rescanned).
//   4. The porcelain scan reuse path: a worktree already on the PR branch
//      is registered and returned (reused=true, zero adds) — `worktree
//      add` refuses already-checked-out branches, reuse is the only move.
//   5. The create path: sanitized directory under worktreeRoot (default
//      `<repoRoot>/.cq-review-worktrees`), registered with the injected
//      clock, reused=false; an add FAILURE throws with git's stderr and
//      leaves the registry untouched.
//   6. Sanitization mapping: branch-name characters outside
//      [A-Za-z0-9._-] become '-' — `/` can never smuggle a directory hop.
//   7. removePrWorktree: success prunes the registry entry; failure
//      (dirty/locked) rethrows with stderr and prunes NOTHING (review ops
//      never silently destroys trees; callers wrap work in try/finally —
//      this is the primitive, not the policy).
//   8. THE DOMAIN RULE, pinned by name: review ops consult ONLY the
//      PR-keyed review worktree machinery — never the package-keyed sweep
//      worktree (`createOrReuseWorktree` in sweep ops).
//   9. fileWorktreeRegistry: missing file = empty registry; round-trip
//      save/load; a corrupt file throws a clear error.
//
// The git seam is INJECTED: a fake `run` implementing a small in-memory git
// model (fetch ok/fails, porcelain worktree list, add/remove ok/fails,
// rev-parse per path). No spawned process, no real clocks (nowMs injected).
import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileWorktreeRegistry, removePrWorktree, resolvePrWorktree } from '../../../src/ops/review/prWorktree.js';
import type { PrWorktreeOpts, RegistryMap, WorktreeRegistry } from '../../../src/ops/review/prWorktree.js';
import type { GhFn, GhResult } from '../../../src/ops/review/gh.js';

// ---------------------------------------------------------------------------
// Fixtures + the fake git model
// ---------------------------------------------------------------------------

const NOW = 1_750_000_000_000;
const PR = 7;
const BRANCH = 'pr-7-fix';

/** The in-memory git model the fake run implements. */
interface FakeGit {
  /** When set, `fetch origin <branch>` fails with this result. */
  fetchFails?: { code: number; stderr: string };
  /** Current worktrees (porcelain list order); branch null = detached. */
  worktrees: Array<{ path: string; branch: string | null }>;
  /** When set, `worktree add` fails with this result. */
  addFails?: { code: number; stderr: string };
  /** When set, `worktree remove` fails with this result. */
  removeFails?: { code: number; stderr: string };
  /** Worktree path → branch `rev-parse --abbrev-ref HEAD` prints (absent = not a repo). */
  headOf: Record<string, string>;
}

/** Build the injected run (GhFn shape, bin 'git' by convention). */
const fakeGit = (model: FakeGit, calls?: string[][]): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    calls?.push(args);
    const sub = args[2];
    if (sub === 'fetch') {
      if (model.fetchFails !== undefined) {
        return { code: model.fetchFails.code, stdout: '', stderr: model.fetchFails.stderr };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'rev-parse') {
      const branch = model.headOf[args[1] ?? ''];
      if (branch === undefined) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
      }
      return { code: 0, stdout: `${branch}\n`, stderr: '' };
    }
    if (sub === 'worktree') {
      const verb = args[3];
      if (verb === 'list') {
        const blocks = model.worktrees
          .map((wt) => `worktree ${wt.path}\nHEAD deadbeefcafe${wt.branch === null ? '' : `\nbranch refs/heads/${wt.branch}`}`)
          .join('\n\n');
        return { code: 0, stdout: blocks === '' ? '' : `${blocks}\n`, stderr: '' };
      }
      if (verb === 'add') {
        if (model.addFails !== undefined) {
          return { code: model.addFails.code, stdout: '', stderr: model.addFails.stderr };
        }
        model.worktrees.push({ path: args[4] ?? '', branch: args[5] ?? '' });
        model.headOf[args[4] ?? ''] = args[5] ?? '';
        return { code: 0, stdout: `Preparing worktree (checking out '${args[5] ?? ''}')\n`, stderr: '' };
      }
      if (verb === 'remove') {
        if (model.removeFails !== undefined) {
          return { code: model.removeFails.code, stdout: '', stderr: model.removeFails.stderr };
        }
        const path = args[4] ?? '';
        model.worktrees = model.worktrees.filter((wt) => wt.path !== path);
        delete model.headOf[path];
        return { code: 0, stdout: '', stderr: '' };
      }
    }
    return { code: 2, stdout: '', stderr: `fake git: unexpected argv ${JSON.stringify(args)}` };
  };

/** An in-memory WorktreeRegistry that records load/save calls in order. */
const memRegistry = (initial: RegistryMap = {}): WorktreeRegistry & { calls: string[]; current: () => RegistryMap } => {
  const calls: string[] = [];
  let stored: RegistryMap = { ...initial };
  return {
    calls,
    load: async () => {
      calls.push('load');
      return { ...stored };
    },
    save: async (map: RegistryMap) => {
      calls.push('save');
      stored = { ...map };
    },
    current: () => ({ ...stored }),
  };
};

/** Base opts over the fake model; repoRoot is a throwaway absolute path —
 * the fake git ignores -C, and only mkdir/stat touch the real fs. */
const baseOpts = (model: FakeGit, registry: WorktreeRegistry, over?: Partial<PrWorktreeOpts>): PrWorktreeOpts => ({
  repoRoot: '/repo',
  pr: PR,
  headRefName: BRANCH,
  run: fakeGit(model),
  registry,
  nowMs: NOW,
  ...over,
});

// ---------------------------------------------------------------------------
// a. ORIGIN BRANCH IS TRUTH
// ---------------------------------------------------------------------------

describe('fetch-first — origin branch is truth', () => {
  test('the fetch runs FIRST and a fetch failure THROWS before the registry is even consulted', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({ '7': { path: '/somewhere/pr-7', branch: BRANCH, createdAt: NOW - 1000 } });
    const model: FakeGit = {
      fetchFails: { code: 128, stderr: "fatal: couldn't find remote ref refs/heads/pr-7-fix" },
      worktrees: [],
      headOf: {},
    };
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) })),
    ).rejects.toThrow(/fetch origin pr-7-fix failed.*couldn't find remote ref/s);
    // The fetch was the only thing attempted — registry untouched.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(['-C', '/repo', 'fetch', 'origin', 'pr-7-fix']);
    expect(registry.calls).toEqual([]);
    // The pre-existing registry entry survives untouched (nothing decided).
    expect(registry.current()['7']).toBeDefined();
  });

  test('validation fails loud before any git invocation', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const model: FakeGit = { worktrees: [], headOf: {} };
    const run = fakeGit(model, calls);
    await expect(resolvePrWorktree(baseOpts(model, registry, { pr: 0, run }))).rejects.toThrow(/resolvePrWorktree:/);
    await expect(resolvePrWorktree(baseOpts(model, registry, { headRefName: '', run }))).rejects.toThrow(
      /resolvePrWorktree:/,
    );
    await expect(resolvePrWorktree(baseOpts(model, registry, { headRefName: '-evil', run }))).rejects.toThrow(
      /resolvePrWorktree:/,
    );
    expect(calls).toEqual([]);
    expect(registry.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// b. Registry consult (hit + stale flavors)
// ---------------------------------------------------------------------------

describe('registry consult', () => {
  test('a registry hit whose entry still points at truth → reused=true, and NO worktree list/add ever runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-wt-hit-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry({ '7': { path: dir, branch: BRANCH, createdAt: NOW - 1000 } });
      const model: FakeGit = { worktrees: [], headOf: { [dir]: BRANCH } };
      const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
      expect(result).toEqual({ path: dir, reused: true, branch: BRANCH });
      // Only fetch + the entry's rev-parse ran — no scan, no add.
      expect(calls.map((args) => args[2])).toEqual(['fetch', 'rev-parse']);
      expect(calls[1]).toEqual(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      // A valid hit is not re-registered (the entry already exists).
      expect(registry.calls).toEqual(['load']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a STALE entry whose directory is GONE is pruned, and the scan reuse path takes over', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/repo/.cq-review-worktrees/ghost', branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model: FakeGit = {
      worktrees: [
        { path: '/repo', branch: 'main' },
        { path: '/elsewhere/pr-7-fix', branch: BRANCH },
      ],
      headOf: {},
    };
    const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
    // The dead entry was pruned BEFORE the scan; the scan found the branch
    // checked out elsewhere and registered it.
    expect(result).toEqual({ path: '/elsewhere/pr-7-fix', reused: true, branch: BRANCH });
    expect(registry.calls).toEqual(['load', 'save', 'save']);
    expect(registry.current()).toEqual({
      '7': { path: '/elsewhere/pr-7-fix', branch: BRANCH, createdAt: NOW },
    });
    // The dead directory short-circuits BEFORE rev-parse (no git call for
    // the ghost) — the next argv after the fetch is the porcelain scan.
    expect(calls[1]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
  });

  test('a STALE entry pointing at the WRONG branch is pruned, and a fresh tree is created', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-stale-'));
    try {
      const calls: string[][] = [];
      // The stale tree EXISTS on disk but holds the wrong branch — the
      // rev-parse check is what exposes it.
      const staleDir = join(repoRoot, 'stale-tree');
      await mkdir(staleDir, { recursive: true });
      const registry = memRegistry({ '7': { path: staleDir, branch: BRANCH, createdAt: NOW - 1000 } });
      const model: FakeGit = { worktrees: [{ path: '/repo', branch: 'main' }], headOf: { [staleDir]: 'some-other-branch' } };
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(result.reused).toBe(false);
      // The stale entry was pruned, then the create path registered the new tree.
      expect(registry.calls).toEqual(['load', 'save', 'save']);
      expect(registry.current()['7']?.path).toBe(join(repoRoot, '.cq-review-worktrees', BRANCH));
      // rev-parse ran against the stale tree and exposed the wrong branch.
      expect(calls[1]).toEqual(['-C', staleDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(calls.some((args) => args.includes('add'))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// c. Existing-worktree scan reuse
// ---------------------------------------------------------------------------

describe('existing-worktree scan reuse', () => {
  test('a worktree already checked out on the PR branch is registered and returned — zero adds (add would refuse anyway)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const model: FakeGit = {
      worktrees: [
        { path: '/repo', branch: 'main' },
        { path: '/elsewhere/pr-7-fix', branch: BRANCH },
        { path: '/other/thing', branch: 'unrelated' },
      ],
      headOf: {},
    };
    const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
    expect(result).toEqual({ path: '/elsewhere/pr-7-fix', reused: true, branch: BRANCH });
    // fetch → worktree list → register; no add, no rev-parse round trip.
    expect(calls.map((args) => args[2])).toEqual(['fetch', 'worktree']);
    expect(calls[1]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
    expect(calls.some((args) => args.includes('add'))).toBe(false);
    expect(registry.current()).toEqual({
      '7': { path: '/elsewhere/pr-7-fix', branch: BRANCH, createdAt: NOW },
    });
  });
});

// ---------------------------------------------------------------------------
// d. Create path + sanitization
// ---------------------------------------------------------------------------

describe('create path', () => {
  test('no registry entry and no existing checkout → worktree add under the DEFAULT worktreeRoot, registered, reused=false', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-create-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model: FakeGit = { worktrees: [{ path: '/repo', branch: 'main' }], headOf: {} };
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      const expectedPath = join(repoRoot, '.cq-review-worktrees', BRANCH);
      expect(result).toEqual({ path: expectedPath, reused: false, branch: BRANCH });
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs).toEqual(['-C', repoRoot, 'worktree', 'add', expectedPath, BRANCH]);
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: BRANCH, createdAt: NOW },
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an explicit worktreeRoot wins over the default', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-root-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model: FakeGit = { worktrees: [], headOf: {} };
      const explicit = join(repoRoot, 'custom-trees');
      await resolvePrWorktree(baseOpts(model, registry, { repoRoot, worktreeRoot: explicit, run: fakeGit(model, calls) }));
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        join(explicit, BRANCH),
        BRANCH,
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('sanitize mapping: every character outside [A-Za-z0-9._-] becomes "-" — "/" can never smuggle a directory hop', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-san-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model: FakeGit = { worktrees: [], headOf: {} };
      await resolvePrWorktree(
        baseOpts(model, registry, {
          repoRoot,
          headRefName: 'feature/fix+42_x retest',
          run: fakeGit(model, calls),
        }),
      );
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs?.[4]).toBe(join(repoRoot, '.cq-review-worktrees', 'feature-fix-42_x-retest'));
      // The added DIRECTORY is one path segment under the worktree root.
      expect(addArgs?.[4]?.startsWith(join(repoRoot, '.cq-review-worktrees') + '/')).toBe(true);
      expect(addArgs?.[4]?.slice((join(repoRoot, '.cq-review-worktrees') + '/').length)).not.toContain('/');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an add FAILURE throws with git stderr and leaves the registry untouched', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-addfail-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model: FakeGit = {
        worktrees: [],
        headOf: {},
        addFails: { code: 128, stderr: "fatal: 'pr-7-fix' is already checked out at '/elsewhere/pr-7-fix'" },
      };
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(/worktree add.*failed.*already checked out/s);
      expect(registry.calls).toEqual(['load']); // load happened, save NEVER did
      expect(registry.current()).toEqual({});
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// removePrWorktree — the cleanup primitive
// ---------------------------------------------------------------------------

describe('removePrWorktree', () => {
  test('success removes the tree via git and prunes the registry entry', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/repo/.cq-review-worktrees/pr-7-fix', branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model: FakeGit = {
      worktrees: [{ path: '/repo/.cq-review-worktrees/pr-7-fix', branch: BRANCH }],
      headOf: {},
    };
    await removePrWorktree({
      ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
      path: '/repo/.cq-review-worktrees/pr-7-fix',
    });
    expect(calls[calls.length - 1]).toEqual([
      '-C',
      '/repo',
      'worktree',
      'remove',
      '/repo/.cq-review-worktrees/pr-7-fix',
    ]);
    // No --force anywhere: review ops never silently destroys trees.
    expect(calls.some((args) => args.includes('--force'))).toBe(false);
    expect(model.worktrees).toEqual([]);
    expect(registry.current()).toEqual({});
  });

  test('a dirty/locked tree → rethrows with stderr and prunes NOTHING (the caller decides)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/repo/.cq-review-worktrees/pr-7-fix', branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model: FakeGit = {
      worktrees: [{ path: '/repo/.cq-review-worktrees/pr-7-fix', branch: BRANCH }],
      headOf: {},
      removeFails: {
        code: 128,
        stderr: 'fatal: ... contains modified or untracked files, use --force to delete it',
      },
    };
    await expect(
      removePrWorktree({
        ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
        path: '/repo/.cq-review-worktrees/pr-7-fix',
      }),
    ).rejects.toThrow(/worktree remove.*failed.*contains modified or untracked files/s);
    // The tree stays, and the registry entry STAYS (truth on disk unchanged).
    expect(model.worktrees).toHaveLength(1);
    expect(registry.current()['7']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// THE DOMAIN RULE — never the sweep worktree
// ---------------------------------------------------------------------------

describe('domain boundary vs the sweep ops worktree', () => {
  test('review ops consult ONLY the PR-keyed review worktree machinery — the package-keyed sweep worktree (createOrReuseWorktree) is never in any argv', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const model: FakeGit = { worktrees: [], headOf: {} };
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-domain-'));
    try {
      // A full resolve walks fetch → registry → scan → add; nothing else.
      await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      const subcommands = calls.map((args) => args.slice(2).join(' '));
      expect(subcommands).toEqual([
        'fetch origin pr-7-fix',
        'worktree list --porcelain',
        `worktree add ${join(repoRoot, '.cq-review-worktrees', 'pr-7-fix')} pr-7-fix`,
      ]);
      // The sweep family's vocabulary (package keys, sweep paths) appears nowhere.
      for (const args of calls) {
        expect(args.join(' ')).not.toMatch(/sweep|package/i);
      }
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fileWorktreeRegistry — the file-backed registry
// ---------------------------------------------------------------------------

describe('fileWorktreeRegistry', () => {
  test('a missing registry file loads as empty, save creates it, and a fresh instance round-trips', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-wt-reg-'));
    try {
      const path = join(dir, 'worktrees.json');
      const log = fileWorktreeRegistry(path);
      expect(await log.load()).toEqual({});
      const map: RegistryMap = { '7': { path: '/repo/.cq-review-worktrees/pr-7-fix', branch: BRANCH, createdAt: NOW } };
      await log.save(map);
      // A fresh registry over the same path sees the saved map (cross-run).
      expect(await fileWorktreeRegistry(path).load()).toEqual(map);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a corrupt registry file throws a CLEAR error (an array is not a registry either)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-wt-reg-'));
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
});
