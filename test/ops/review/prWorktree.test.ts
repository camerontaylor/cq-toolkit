// E3 slice 3 — tests for prWorktree (src/ops/review/prWorktree.ts;
// UC §2 row 38).
//
// Pinned here:
//   1. ORIGIN BRANCH IS TRUTH, BY SHA: the fetch runs FIRST (a fetch failure
//      throws before the registry is even consulted — nothing touched,
//      nothing saved) and `rev-parse FETCH_HEAD` NAMES the fetched commit;
//      every reuse candidate must sit AT that sha.
//   2. Registry hit whose entry still points at truth (branch AND fetched
//      sha) → reused, and NO worktree list/add ever runs.
//   3. STALE registry entries — directory gone, wrong branch, or RIGHT
//      branch at a STALE sha — are pruned and resolution continues; a
//      stale-sha entry is followed by a RE-CREATE at the fetched sha via
//      `worktree add -B <branch> <path> FETCH_HEAD`.
//   4. The porcelain scan reuse path requires BRANCH match AND SHA match:
//      a tree parked on the branch name at an old sha (local memory the
//      fetch exists to override — including foreign/sweep-family trees) is
//      skipped, never reused, never registered.
//   5. The create path: `pr-<pr>-<sanitized-branch>` under worktreeRoot
//      (default `<repoRoot>/.cq-review-worktrees`), added with
//      `-B <branch> <path> FETCH_HEAD` so the new tree sits AT the fetched
//      sha, registered with the injected clock, reused=false; an add
//      FAILURE throws with git's stderr and leaves the registry untouched.
//   6. Sanitization mapping: branch-name characters outside
//      [A-Za-z0-9._-] become '-' — `/` can never smuggle a directory hop;
//      the `pr-<pr>-` prefix disambiguates sanitize collisions
//      (feat/x vs feat-x land in different directories per PR).
//   7. removePrWorktree: success prunes the registry entry ONLY when it
//      points at the removed path; failure (dirty/locked) rethrows with
//      stderr and prunes NOTHING (review ops never silently destroys
//      trees; callers wrap work in try/finally — this is the primitive,
//      not the policy).
//   8. THE DOMAIN RULE, pinned behaviorally: review ops reuses ONLY a tree
//      matching the PR branch AND the fetched sha — sweep-family trees on
//      other branches (or on the branch at a stale sha) are unreachable.
//   9. fileWorktreeRegistry: missing file = empty registry; round-trip
//      save/load; a corrupt file throws a clear error.
//
// The git seam is INJECTED: a fake `run` implementing a small in-memory git
// model with a REAL sha notion (FETCH_HEAD per fetch, per-path branch+head
// rev-parse answers, `worktree add -B` moving the branch to FETCH_HEAD).
// No spawned process, no real clocks (nowMs injected).
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
/** The STALE local sha — what an out-of-date tree has checked out. */
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** The origin truth — what the fetch lands in FETCH_HEAD (the default). */
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
/** The main tree's sha (an unrelated branch's head). */
const SHA_MAIN = 'cccccccccccccccccccccccccccccccccccccccc';

/** The in-memory git model the fake run implements. */
interface FakeGit {
  /** When set, `fetch origin <branch>` fails with this result. */
  fetchFails?: { code: number; stderr: string };
  /** When set, `rev-parse FETCH_HEAD` fails with this result. */
  fetchHeadFails?: { code: number; stderr: string };
  /** What `rev-parse FETCH_HEAD` prints — defaults to SHA_B (origin truth). */
  fetchHeadSha?: string;
  /** Current worktrees (porcelain list order); branch null = detached. */
  worktrees: Array<{ path: string; branch: string | null; head: string }>;
  /** When set, `worktree add` fails with this result. */
  addFails?: { code: number; stderr: string };
  /** When set, `worktree remove` fails with this result. */
  removeFails?: { code: number; stderr: string };
  /** Worktree path → what HEAD is checked out there (absent = not a repo). */
  headOf: Record<string, { branch: string | null; head: string }>;
}

/** Build a model: `trees` are both the porcelain list AND the rev-parse
 * view; `over.headOf` adds checkouts for paths NOT in the porcelain list
 * (stale trees git no longer lists but whose directories remain). */
const mkModel = (
  trees: Array<{ path: string; branch: string | null; head: string }> = [],
  over: Partial<FakeGit> = {},
): FakeGit => ({
  fetchHeadSha: SHA_B,
  ...over,
  worktrees: trees,
  headOf: {
    ...Object.fromEntries(
      trees
        .filter((tree): tree is typeof tree & { branch: string } => tree.branch !== null)
        .map((tree) => [tree.path, { branch: tree.branch, head: tree.head }]),
    ),
    ...(over.headOf ?? {}),
  },
});

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
      // argv shapes: ['-C', <path>, 'rev-parse', 'FETCH_HEAD'],
      // ['-C', <path>, 'rev-parse', 'HEAD'],
      // ['-C', <path>, 'rev-parse', '--abbrev-ref', 'HEAD'].
      const at = args[1] ?? '';
      const target = args[3];
      if (target === 'FETCH_HEAD') {
        if (model.fetchHeadFails !== undefined) {
          return { code: model.fetchHeadFails.code, stdout: '', stderr: model.fetchHeadFails.stderr };
        }
        return { code: 0, stdout: `${model.fetchHeadSha ?? SHA_B}\n`, stderr: '' };
      }
      const checkout = model.headOf[at];
      if (checkout === undefined) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git' };
      }
      if (target === 'HEAD') {
        return { code: 0, stdout: `${checkout.head}\n`, stderr: '' };
      }
      if (target === '--abbrev-ref' && args[4] === 'HEAD') {
        return { code: 0, stdout: `${checkout.branch ?? 'HEAD'}\n`, stderr: '' };
      }
      return { code: 2, stdout: '', stderr: `fake git: unexpected rev-parse ${JSON.stringify(args)}` };
    }
    if (sub === 'worktree') {
      const verb = args[3];
      if (verb === 'list') {
        const blocks = model.worktrees
          .map((wt) => `worktree ${wt.path}\nHEAD ${wt.head}${wt.branch === null ? '' : `\nbranch refs/heads/${wt.branch}`}`)
          .join('\n\n');
        return { code: 0, stdout: blocks === '' ? '' : `${blocks}\n`, stderr: '' };
      }
      if (verb === 'add') {
        if (model.addFails !== undefined) {
          return { code: model.addFails.code, stdout: '', stderr: model.addFails.stderr };
        }
        // The ONLY add shape review ops uses: add -B <branch> <path>
        // FETCH_HEAD — `-B` (re)points the branch at FETCH_HEAD, so the new
        // tree's HEAD lands at the fetched truth. (The model does not
        // simulate git's double-checkout refusal; the addFails seam covers
        // refusal scenarios.)
        if (args[4] !== '-B' || args[7] !== 'FETCH_HEAD') {
          return { code: 2, stdout: '', stderr: `fake git: unexpected add argv ${JSON.stringify(args)}` };
        }
        const branch = args[5] ?? '';
        const path = args[6] ?? '';
        model.worktrees.push({ path, branch, head: model.fetchHeadSha ?? SHA_B });
        model.headOf[path] = { branch, head: model.fetchHeadSha ?? SHA_B };
        return { code: 0, stdout: `Preparing worktree (checking out '${branch}')\n`, stderr: '' };
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
 * the fake git ignores -C (except through the model's own bookkeeping),
 * and only mkdir/stat touch the real fs. */
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
    const model = mkModel([], { fetchFails: { code: 128, stderr: "fatal: couldn't find remote ref refs/heads/pr-7-fix" } });
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

  test('the fetched commit is NAMED: rev-parse FETCH_HEAD runs immediately after the fetch', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    // A tmpdir repoRoot: a full resolve reaches the real mkdir of the
    // worktree root, which must land somewhere writable.
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-fetchhead-'));
    try {
      const model = mkModel();
      await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(calls[0]).toEqual(['-C', repoRoot, 'fetch', 'origin', 'pr-7-fix']);
      expect(calls[1]).toEqual(['-C', repoRoot, 'rev-parse', 'FETCH_HEAD']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an unnameable fetch (rev-parse FETCH_HEAD fails) THROWS — nothing is decided on unknown truth', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({ '7': { path: '/somewhere/pr-7', branch: BRANCH, createdAt: NOW - 1000 } });
    const model = mkModel([], { fetchHeadFails: { code: 128, stderr: 'fatal: ambiguous argument' } });
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) })),
    ).rejects.toThrow(/rev-parse FETCH_HEAD failed.*unnameable/s);
    // Only fetch + FETCH_HEAD ran; the registry was never consulted.
    expect(calls.map((args) => args[2])).toEqual(['fetch', 'rev-parse']);
    expect(registry.calls).toEqual([]);
    expect(registry.current()['7']).toBeDefined();
  });

  test('validation fails loud before any git invocation', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const model = mkModel();
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
  test('a registry hit whose entry still points at truth (branch AND fetched sha) → reused=true, and NO worktree list/add ever runs', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-wt-hit-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry({ '7': { path: dir, branch: BRANCH, createdAt: NOW - 1000 } });
      const model = mkModel([], { headOf: { [dir]: { branch: BRANCH, head: SHA_B } } });
      const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
      expect(result).toEqual({ path: dir, reused: true, branch: BRANCH });
      // fetch → FETCH_HEAD → the entry's branch rev-parse → its sha
      // rev-parse — no scan, no add.
      expect(calls.map((args) => args[2])).toEqual(['fetch', 'rev-parse', 'rev-parse', 'rev-parse']);
      expect(calls[1]).toEqual(['-C', '/repo', 'rev-parse', 'FETCH_HEAD']);
      expect(calls[2]).toEqual(['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(calls[3]).toEqual(['-C', dir, 'rev-parse', 'HEAD']);
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
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: '/elsewhere/pr-7-fix', branch: BRANCH, head: SHA_B },
    ]);
    const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
    // The dead entry was pruned BEFORE the scan; the scan found the branch
    // checked out elsewhere AT THE FETCHED SHA and registered it.
    expect(result).toEqual({ path: '/elsewhere/pr-7-fix', reused: true, branch: BRANCH });
    expect(registry.calls).toEqual(['load', 'save', 'save']);
    expect(registry.current()).toEqual({
      '7': { path: '/elsewhere/pr-7-fix', branch: BRANCH, createdAt: NOW },
    });
    // The dead directory short-circuits BEFORE rev-parse (no git call for
    // the ghost); after FETCH_HEAD comes the porcelain scan, then the
    // sha probe against the candidate.
    expect(calls[2]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
    expect(calls[3]).toEqual(['-C', '/elsewhere/pr-7-fix', 'rev-parse', 'HEAD']);
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
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }], {
        headOf: { [staleDir]: { branch: 'some-other-branch', head: SHA_A } },
      });
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(result.reused).toBe(false);
      // The stale entry was pruned, then the create path registered the new tree.
      expect(registry.calls).toEqual(['load', 'save', 'save']);
      expect(registry.current()['7']?.path).toBe(join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`));
      // rev-parse ran against the stale tree and exposed the wrong branch.
      expect(calls[2]).toEqual(['-C', staleDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(calls.some((args) => args.includes('add'))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a STALE entry at the WRONG SHA — branch matches, tree lags origin — is pruned and the tree is RE-CREATED at the fetched sha via add -B … FETCH_HEAD', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-stalesha-'));
    try {
      const calls: string[][] = [];
      // The round-1 tree still exists on disk, still HAS the branch checked
      // out — but at sha A, while origin moved to sha B. Branch match alone
      // must NOT read as reuse.
      const staleDir = join(repoRoot, 'stale-tree');
      await mkdir(staleDir, { recursive: true });
      const registry = memRegistry({ '7': { path: staleDir, branch: BRANCH, createdAt: NOW - 1000 } });
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }], {
        headOf: { [staleDir]: { branch: BRANCH, head: SHA_A } },
      });
      const newPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      // The stale entry was pruned; the tree was re-created at the fetched sha.
      expect(result).toEqual({ path: newPath, reused: false, branch: BRANCH });
      expect(registry.calls).toEqual(['load', 'save', 'save']);
      expect(registry.current()).toEqual({
        '7': { path: newPath, branch: BRANCH, createdAt: NOW },
      });
      // The branch matched, so the SHA probe is what exposed the staleness…
      expect(calls).toContainEqual(['-C', staleDir, 'rev-parse', 'HEAD']);
      // …and the re-create rides `-B <branch> <path> FETCH_HEAD`: the new
      // tree sits AT the fetched sha (the model's add -B moves the branch).
      expect(calls[calls.length - 1]).toEqual(['-C', repoRoot, 'worktree', 'add', '-B', BRANCH, newPath, 'FETCH_HEAD']);
      expect(model.headOf[newPath]).toEqual({ branch: BRANCH, head: SHA_B });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// c. Existing-worktree scan reuse (BRANCH match AND SHA match)
// ---------------------------------------------------------------------------

describe('existing-worktree scan reuse', () => {
  test('a worktree already checked out on the PR branch AT THE FETCHED SHA is registered and returned — zero adds (add would refuse anyway)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: '/elsewhere/pr-7-fix', branch: BRANCH, head: SHA_B },
      { path: '/other/thing', branch: 'unrelated', head: SHA_MAIN },
    ]);
    const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
    expect(result).toEqual({ path: '/elsewhere/pr-7-fix', reused: true, branch: BRANCH });
    // fetch → FETCH_HEAD → worktree list → sha probe; no add.
    expect(calls.map((args) => args[2])).toEqual(['fetch', 'rev-parse', 'worktree', 'rev-parse']);
    expect(calls[2]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
    expect(calls[3]).toEqual(['-C', '/elsewhere/pr-7-fix', 'rev-parse', 'HEAD']);
    expect(calls.some((args) => args.includes('add'))).toBe(false);
    expect(registry.current()).toEqual({
      '7': { path: '/elsewhere/pr-7-fix', branch: BRANCH, createdAt: NOW },
    });
  });

  test('a branch-matching tree at a STALE sha is SKIPPED — the scan never reuses local memory', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-scanstale-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: '/elsewhere/pr-7-fix', branch: BRANCH, head: SHA_A },
      ]);
      const newPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      // The stale tree was probed and rejected on sha — resolution fell
      // through to the create path instead of reusing it.
      expect(calls).toContainEqual(['-C', '/elsewhere/pr-7-fix', 'rev-parse', 'HEAD']);
      expect(result).toEqual({ path: newPath, reused: false, branch: BRANCH });
      // The stale tree was NEVER registered; only the fresh tree is.
      expect(registry.current()).toEqual({
        '7': { path: newPath, branch: BRANCH, createdAt: NOW },
      });
      expect(calls[calls.length - 1]).toEqual(['-C', repoRoot, 'worktree', 'add', '-B', BRANCH, newPath, 'FETCH_HEAD']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// d. Create path + sanitization
// ---------------------------------------------------------------------------

describe('create path', () => {
  test('no registry entry and no existing checkout → add -B … FETCH_HEAD under the DEFAULT worktreeRoot, registered, reused=false', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-create-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }]);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      const expectedPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      expect(result).toEqual({ path: expectedPath, reused: false, branch: BRANCH });
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        BRANCH,
        expectedPath,
        'FETCH_HEAD',
      ]);
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: BRANCH, createdAt: NOW },
      });
      // The created tree sits AT the fetched sha (-B moved the branch).
      expect(model.headOf[expectedPath]).toEqual({ branch: BRANCH, head: SHA_B });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an explicit worktreeRoot wins over the default', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-root-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel();
      const explicit = join(repoRoot, 'custom-trees');
      await resolvePrWorktree(baseOpts(model, registry, { repoRoot, worktreeRoot: explicit, run: fakeGit(model, calls) }));
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        BRANCH,
        join(explicit, `pr-${PR}-${BRANCH}`),
        'FETCH_HEAD',
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('sanitize mapping: every character outside [A-Za-z0-9._-] becomes "-" — "/" can never smuggle a directory hop — and the pr-<pr>- prefix disambiguates sanitize collisions', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-san-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel();
      await resolvePrWorktree(
        baseOpts(model, registry, {
          repoRoot,
          headRefName: 'feature/fix+42_x retest',
          run: fakeGit(model, calls),
        }),
      );
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs?.[6]).toBe(join(repoRoot, '.cq-review-worktrees', 'pr-7-feature-fix-42_x-retest'));
      // The added DIRECTORY is one path segment under the worktree root.
      expect(addArgs?.[6]?.startsWith(join(repoRoot, '.cq-review-worktrees') + '/')).toBe(true);
      expect(addArgs?.[6]?.slice((join(repoRoot, '.cq-review-worktrees') + '/').length)).not.toContain('/');
      // The collision rule: "feat/x" and "feat-x" sanitize to the SAME
      // segment, but each PR's directory carries its own number — two
      // branches can never share one review tree path.
      expect('feat/x'.replace(/[^A-Za-z0-9._-]/g, '-')).toBe('feat-x'.replace(/[^A-Za-z0-9._-]/g, '-'));
      expect('pr-1-feat-x').not.toBe('pr-2-feat-x');
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an add FAILURE throws with git stderr and leaves the registry untouched', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-addfail-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([], {
        addFails: { code: 128, stderr: "fatal: 'pr-7-fix' is already checked out at '/elsewhere/pr-7-fix'" },
      });
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(/worktree add -B pr-7-fix.*failed.*already checked out/s);
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
      '7': { path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix', branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model = mkModel([{ path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix', branch: BRANCH, head: SHA_B }]);
    await removePrWorktree({
      ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
      path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix',
    });
    expect(calls[calls.length - 1]).toEqual([
      '-C',
      '/repo',
      'worktree',
      'remove',
      '/repo/.cq-review-worktrees/pr-7-pr-7-fix',
    ]);
    // No --force anywhere: review ops never silently destroys trees.
    expect(calls.some((args) => args.includes('--force'))).toBe(false);
    expect(model.worktrees).toEqual([]);
    expect(registry.current()).toEqual({});
  });

  test('a dirty/locked tree → rethrows with stderr and prunes NOTHING (the caller decides)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix', branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model = mkModel([{ path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix', branch: BRANCH, head: SHA_B }], {
      removeFails: {
        code: 128,
        stderr: 'fatal: ... contains modified or untracked files, use --force to delete it',
      },
    });
    await expect(
      removePrWorktree({
        ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
        path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix',
      }),
    ).rejects.toThrow(/worktree remove.*failed.*contains modified or untracked files/s);
    // The tree stays, and the registry entry STAYS (truth on disk unchanged).
    expect(model.worktrees).toHaveLength(1);
    expect(registry.current()['7']).toBeDefined();
  });

  test('a registry entry pointing ELSEWHERE survives the removal — only its own path is pruned', async () => {
    const calls: string[][] = [];
    // The entry describes a RE-CREATED tree at a new location; the caller
    // is removing a DIFFERENT (old) path.
    const entryPath = '/repo/.cq-review-worktrees/pr-7-pr-7-fix';
    const registry = memRegistry({
      '7': { path: entryPath, branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model = mkModel([{ path: '/elsewhere/old-tree', branch: BRANCH, head: SHA_A }]);
    await removePrWorktree({
      ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
      path: '/elsewhere/old-tree',
    });
    // git removed the requested tree…
    expect(calls[calls.length - 1]).toEqual(['-C', '/repo', 'worktree', 'remove', '/elsewhere/old-tree']);
    expect(model.worktrees).toEqual([]);
    // …but the registry entry describes a DIFFERENT path and SURVIVES
    // (load ran; save never did — nothing was pruned).
    expect(registry.current()['7']).toEqual({ path: entryPath, branch: BRANCH, createdAt: NOW - 1000 });
    expect(registry.calls).toEqual(['load']);
  });
});

// ---------------------------------------------------------------------------
// THE DOMAIN RULE — reuse requires branch AND sha match; sweep trees unreachable
// ---------------------------------------------------------------------------

describe('domain boundary vs the sweep ops worktree', () => {
  // When the sweep family lands (`createOrReuseWorktree` — package-keyed
  // trees under a sweep root), THIS is the rule that keeps the domains
  // apart, behaviorally: review ops can only ever reuse a tree matching the
  // PR branch AND the fetched origin sha. A sweep tree parked on the branch
  // name at an old sha — or on any other branch — is unreachable: the scan
  // skips it and resolution creates the review's OWN pr-keyed tree. The
  // argv walk below pins that no sweep path is ever returned, registered,
  // or added to.
  test('sweep-family trees on other branches — or on the PR branch at a stale sha — are never reused', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-domain-'));
    try {
      const sweepA = join(repoRoot, '.sweep-worktrees', 'pkg-a');
      const sweepB = join(repoRoot, '.sweep-worktrees', 'pkg-b');
      const model = mkModel([
        { path: repoRoot, branch: 'main', head: SHA_MAIN },
        // Branch match but STALE sha — exactly the tree finding 1 forbids
        // reusing.
        { path: sweepA, branch: BRANCH, head: SHA_A },
        // Fetched sha but WRONG branch — not this PR's checkout.
        { path: sweepB, branch: 'pkg-b-branch', head: SHA_B },
      ]);
      const expectedPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(result).toEqual({ path: expectedPath, reused: false, branch: BRANCH });
      // The full argv walk: fetch → FETCH_HEAD → scan → probe the
      // branch-matching candidate (rejected on sha) → create at the fetched
      // sha. Nothing else is ever invoked.
      expect(calls).toEqual([
        ['-C', repoRoot, 'fetch', 'origin', BRANCH],
        ['-C', repoRoot, 'rev-parse', 'FETCH_HEAD'],
        ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        ['-C', sweepA, 'rev-parse', 'HEAD'],
        ['-C', repoRoot, 'worktree', 'add', '-B', BRANCH, expectedPath, 'FETCH_HEAD'],
      ]);
      // Neither sweep path was returned or registered — only the review's
      // own pr-keyed tree.
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: BRANCH, createdAt: NOW },
      });
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
      const map: RegistryMap = { '7': { path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix', branch: BRANCH, createdAt: NOW } };
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
