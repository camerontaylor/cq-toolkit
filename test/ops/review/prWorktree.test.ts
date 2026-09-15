// E3 slice 3 — tests for prWorktree (src/ops/review/prWorktree.ts;
// UC §2 row 38).
//
// Pinned here:
//   1. ORIGIN BRANCH IS TRUTH, BY SHA: the fetch runs FIRST (a fetch failure
//      throws before the registry is even consulted — nothing touched,
//      nothing saved) and `rev-parse FETCH_HEAD` NAMES the fetched commit;
//      every reuse candidate must sit AT that sha.
//   2. Registry hit whose entry still points at truth (branch AND fetched
//      sha) → reused, and NO worktree list/add ever runs. A STALE entry is
//      NOT pruned up front — the prune is the successful re-registration
//      (the overwrite), so a run that wedges leaves the pointer intact.
//   3. REFRESH CONVERGENCE: a branch-matching tree at a STALE sha — ours,
//      inside worktreeRoot — is REMOVED non-forced (`worktree remove`, no
//      --force) and the tree is RE-CREATED at the fetched sha via
//      `add -B <branch> <path> <sha>` at that same spot; a DIRTY stale
//      tree refuses the remove, the throw carries git's stderr, and the
//      registry entry survives.
//   4. OWNERSHIP: reuse is eligible only INSIDE worktreeRoot; a
//      branch+sha-valid tree OUTSIDE the root is surfaced in the result's
//      `foreign` list (never claimed, never removed); a foreign tree
//      holding the branch refuses the create (git's double-checkout
//      refusal) and the throw names it — freeing it is the human's call.
//   5. The create path: `pr-<pr>-<sanitized-branch>` under worktreeRoot
//      (default `<repoRoot>/.cq-review-worktrees`), added with
//      `-B <branch> <path> <expectedSha>` so the new tree sits AT the
//      fetched sha, registered with the injected clock, reused=false; an
//      add FAILURE throws with git's stderr and leaves the registry (and
//      any stale entry) untouched.
//   6. Sanitization mapping: branch-name characters outside
//      [A-Za-z0-9._-] become '-' — `/` can never smuggle a directory hop;
//      the `pr-<pr>-` prefix disambiguates sanitize collisions
//      (feat/x vs feat-x land in different directories per PR).
//   7. removePrWorktree: success prunes the registry entry ONLY when it
//      points at the removed path; failure (dirty/locked) rethrows with
//      stderr and prunes NOTHING (review ops never silently destroys
//      trees; callers wrap work in try/finally — this is the primitive,
//      not the policy).
//   8. THE DOMAIN RULE, pinned behaviorally: review ops reuses ONLY an OWN
//      (in-root) tree matching the PR branch AND the fetched sha —
//      sweep-family trees on other branches neither block nor get claimed,
//      and a sweep tree HOLDING the branch blocks the create until a human
//      frees it (review ops never touches it).
//   9. fileWorktreeRegistry: missing file = empty registry; round-trip
//      save/load; a corrupt file throws a clear error.
//
// The git seam is INJECTED: a fake `run` implementing a small in-memory git
// model with a REAL sha notion (FETCH_HEAD per fetch, per-path branch+head
// rev-parse answers, `worktree add -B` moving the branch to FETCH_HEAD).
// No spawned process, no real clocks (nowMs injected).
import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileWorktreeRegistry, removePrWorktree, resolvePrWorktree } from '../../../src/ops/review/prWorktree.js';
import type {
  PrWorktreeOpts,
  RegistryMap,
  WorktreeRegistry,
  WorktreeRegistryEntry,
} from '../../../src/ops/review/prWorktree.js';
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
        // The ONLY add shape review ops uses: add -B <branch> <path> <sha>.
        if (args[4] !== '-B') {
          return { code: 2, stdout: '', stderr: `fake git: unexpected add argv ${JSON.stringify(args)}` };
        }
        const branch = args[5] ?? '';
        const path = args[6] ?? '';
        const commitish = args[7] ?? '';
        // git's DOUBLE-CHECKOUT REFUSAL: `-B` does not bypass it — while
        // ANY other registered tree holds the branch, the add refuses with
        // git's message. `worktree remove` clears the hold.
        const holder = model.worktrees.find((wt) => wt.branch === branch && wt.path !== path);
        if (holder !== undefined) {
          return { code: 128, stdout: '', stderr: `fatal: '${branch}' is already checked out at '${holder.path}'` };
        }
        if (model.worktrees.some((wt) => wt.path === path)) {
          return { code: 128, stdout: '', stderr: `fatal: '${path}' is already a registered worktree` };
        }
        // `-B` (re)points the branch at the requested commit: the new
        // tree's HEAD lands at that sha (FETCH_HEAD resolves to the
        // fetched truth).
        const head = commitish === 'FETCH_HEAD' ? (model.fetchHeadSha ?? SHA_B) : commitish;
        model.worktrees.push({ path, branch, head });
        model.headOf[path] = { branch, head };
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

/** An in-memory WorktreeRegistry that records load/save/update calls in order. */
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
    update: async (key: string, entry: WorktreeRegistryEntry | null) => {
      calls.push(entry === null ? `update:${key}:null` : `update:${key}`);
      if (entry === null) {
        delete stored[key];
      } else {
        stored[key] = { ...entry };
      }
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
  test('a registry hit whose entry still points at truth (in-root, branch AND fetched sha) → reused=true, and NO worktree list/add ever runs', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-hit-'));
    try {
      const calls: string[][] = [];
      // The entry lives INSIDE the worktreeRoot (ownership applies to the
      // registry consult too).
      const entryDir = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(entryDir, { recursive: true });
      const registry = memRegistry({ '7': { path: entryDir, branch: BRANCH, createdAt: NOW - 1000 } });
      const model = mkModel([], { headOf: { [entryDir]: { branch: BRANCH, head: SHA_B } } });
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(result).toEqual({ path: entryDir, reused: true, branch: BRANCH, foreign: [] });
      // fetch → FETCH_HEAD → the entry's branch rev-parse → its sha
      // rev-parse — no scan, no add.
      expect(calls.map((args) => args[2])).toEqual(['fetch', 'rev-parse', 'rev-parse', 'rev-parse']);
      expect(calls[1]).toEqual(['-C', repoRoot, 'rev-parse', 'FETCH_HEAD']);
      expect(calls[2]).toEqual(['-C', entryDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(calls[3]).toEqual(['-C', entryDir, 'rev-parse', 'HEAD']);
      // A valid hit is not re-registered (the entry already exists).
      expect(registry.calls).toEqual(['load']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a STALE entry whose directory is GONE is left un-pruned, and the scan reuse path takes over', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/repo/.cq-review-worktrees/ghost', branch: BRANCH, createdAt: NOW - 1000 },
    });
    const candidate = '/repo/.cq-review-worktrees/pr-7-pr-7-fix';
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: candidate, branch: BRANCH, head: SHA_B },
    ]);
    const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
    // The dead entry was SKIPPED (never pruned up front — no prune-save);
    // the scan found the branch checked out in OUR root AT THE FETCHED sha
    // and the register overwrote the stale entry.
    expect(result).toEqual({ path: candidate, reused: true, branch: BRANCH, foreign: [] });
    expect(registry.calls).toEqual(['load', 'update:7']);
    expect(registry.current()).toEqual({
      '7': { path: candidate, branch: BRANCH, createdAt: NOW },
    });
    // The dead directory short-circuits BEFORE rev-parse (no git call for
    // the ghost); after FETCH_HEAD comes the porcelain scan, then the
    // sha probe against the candidate.
    expect(calls[2]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
    expect(calls[3]).toEqual(['-C', candidate, 'rev-parse', 'HEAD']);
  });

  test('a registry entry pointing OUTSIDE the current worktreeRoot is stale by definition — resolution recreates INSIDE', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-outroot-'));
    try {
      const calls: string[][] = [];
      // The entry's tree EXISTS, holds the right branch, even sits AT the
      // fetched sha — but it lives outside the CURRENT worktreeRoot: this
      // module does not own it, so the consult must not reuse it.
      const outsidePath = join(repoRoot, 'outside-tree');
      await mkdir(outsidePath, { recursive: true });
      const registry = memRegistry({ '7': { path: outsidePath, branch: BRANCH, createdAt: NOW - 1000 } });
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }], {
        headOf: { [outsidePath]: { branch: BRANCH, head: SHA_B } },
      });
      const expectedPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(result).toEqual({ path: expectedPath, reused: false, branch: BRANCH, foreign: [] });
      // The inside-the-root entry (created fresh) replaced the outside pointer.
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: BRANCH, createdAt: NOW },
      });
      expect(registry.calls).toEqual(['load', 'update:7']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a STALE entry pointing at the WRONG branch is skipped, and a fresh tree is created (the register overwrites the stale entry)', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-stale-'));
    try {
      const calls: string[][] = [];
      // The stale tree EXISTS on disk INSIDE the worktreeRoot but holds the
      // wrong branch — the rev-parse check is what exposes it (it passes
      // the ownership gate first).
      const staleDir = join(repoRoot, '.cq-review-worktrees', 'stale-tree');
      await mkdir(staleDir, { recursive: true });
      const registry = memRegistry({ '7': { path: staleDir, branch: BRANCH, createdAt: NOW - 1000 } });
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }], {
        headOf: { [staleDir]: { branch: 'some-other-branch', head: SHA_A } },
      });
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(result.reused).toBe(false);
      expect(result.foreign).toEqual([]);
      // NO up-front prune: load, then the create's per-key register.
      expect(registry.calls).toEqual(['load', 'update:7']);
      expect(registry.current()['7']?.path).toBe(join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`));
      // rev-parse ran against the stale tree and exposed the wrong branch.
      expect(calls[2]).toEqual(['-C', staleDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(calls.some((args) => args.includes('add'))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a STALE entry at the WRONG SHA — branch matches, tree lags origin — CONVERGES: the stale in-root tree is REMOVED non-forced and RE-CREATED at the fetched sha via add -B … <sha>', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-stalesha-'));
    try {
      const calls: string[][] = [];
      // The round-1 tree still exists, still holds the branch — at sha A
      // while origin moved to sha B — at exactly the path the create wants.
      const stalePath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(stalePath, { recursive: true });
      const registry = memRegistry({ '7': { path: stalePath, branch: BRANCH, createdAt: NOW - 1000 } });
      const model = mkModel([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: BRANCH, head: SHA_A },
      ]);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      // The refresh CONVERGED at the same path, at the fetched sha.
      expect(result).toEqual({ path: stalePath, reused: false, branch: BRANCH, foreign: [] });
      // The stale entry was overwritten by the successful register — load
      // plus ONE save, no up-front prune.
      expect(registry.calls).toEqual(['load', 'update:7']);
      expect(registry.current()).toEqual({
        '7': { path: stalePath, branch: BRANCH, createdAt: NOW },
      });
      // The exact refresh walk: the consult probes exposed the staleness
      // (branch ok, sha A), the scan re-probed, the NON-FORCED remove
      // freed the branch hold, and `-B … <expectedSha>` landed the tree AT
      // the fetched truth.
      expect(calls).toEqual([
        ['-C', repoRoot, 'fetch', 'origin', BRANCH],
        ['-C', repoRoot, 'rev-parse', 'FETCH_HEAD'],
        ['-C', stalePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        ['-C', stalePath, 'rev-parse', 'HEAD'],
        ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        ['-C', stalePath, 'rev-parse', 'HEAD'],
        ['-C', repoRoot, 'worktree', 'remove', stalePath],
        ['-C', repoRoot, 'worktree', 'add', '-B', BRANCH, stalePath, SHA_B],
      ]);
      expect(calls.some((args) => args.includes('--force'))).toBe(false);
      // The hold was cleared by the remove; the new tree sits at the
      // fetched sha (the main tree is untouched).
      expect(model.worktrees).toEqual([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: BRANCH, head: SHA_B },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a stale tree that is DIRTY cannot be refreshed away — the remove refuses, the throw carries git stderr, and the registry entry SURVIVES', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-dirty-'));
    try {
      const calls: string[][] = [];
      const stalePath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(stalePath, { recursive: true });
      const registry = memRegistry({ '7': { path: stalePath, branch: BRANCH, createdAt: NOW - 1000 } });
      const model = mkModel(
        [
          { path: '/repo', branch: 'main', head: SHA_MAIN },
          { path: stalePath, branch: BRANCH, head: SHA_A },
        ],
        {
          removeFails: {
            code: 128,
            stderr: 'fatal: ... contains modified or untracked files, use --force to delete it',
          },
        },
      );
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(/worktree remove.*failed.*contains modified or untracked files/s);
      // The stale entry was NEVER pruned: the machine-readable pointer
      // survives the wedged run for the next one.
      expect(registry.calls).toEqual(['load']);
      expect(registry.current()['7']).toEqual({ path: stalePath, branch: BRANCH, createdAt: NOW - 1000 });
      // The tree itself is untouched — review ops never force-destroys.
      expect(model.worktrees).toHaveLength(2);
      expect(calls.some((args) => args.includes('--force'))).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// c. Existing-worktree scan reuse (BRANCH match AND SHA match)
// ---------------------------------------------------------------------------

describe('existing-worktree scan reuse (BRANCH match AND SHA match, INSIDE the root)', () => {
  test('an OWN worktree already checked out on the PR branch AT THE FETCHED SHA is registered and returned — zero adds (add would refuse anyway)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const ownPath = '/repo/.cq-review-worktrees/pr-7-pr-7-fix';
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: ownPath, branch: BRANCH, head: SHA_B },
      { path: '/other/thing', branch: 'unrelated', head: SHA_MAIN },
    ]);
    const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
    expect(result).toEqual({ path: ownPath, reused: true, branch: BRANCH, foreign: [] });
    // fetch → FETCH_HEAD → worktree list → sha probe; no add.
    expect(calls.map((args) => args[2])).toEqual(['fetch', 'rev-parse', 'worktree', 'rev-parse']);
    expect(calls[2]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
    expect(calls[3]).toEqual(['-C', ownPath, 'rev-parse', 'HEAD']);
    expect(calls.some((args) => args.includes('add'))).toBe(false);
    expect(registry.current()).toEqual({
      '7': { path: ownPath, branch: BRANCH, createdAt: NOW },
    });
  });

  test('a branch-matching stale tree OUTSIDE the root holds the branch — review ops never frees foreign trees: the create refuses and names the holder', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-foreignstale-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: '/elsewhere/pr-7-fix', branch: BRANCH, head: SHA_A },
      ]);
      // The out-of-root stale tree is skipped (not at the sha, not ours to
      // remove) — but it HOLDS the branch, so the create is refused and
      // git's stderr names the holder. Nothing was registered.
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(/already checked out at '\/elsewhere\/pr-7-fix'/);
      expect(registry.calls).toEqual(['load']);
      expect(registry.current()).toEqual({});
      // The foreign tree was probed but NEVER removed.
      expect(calls).toContainEqual(['-C', '/elsewhere/pr-7-fix', 'rev-parse', 'HEAD']);
      expect(calls.some((args) => args.includes('remove'))).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// d. Create path + sanitization
// ---------------------------------------------------------------------------

describe('create path', () => {
  test('no registry entry and no existing checkout → add -B … <expectedSha> under the DEFAULT worktreeRoot, registered, reused=false', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-create-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }]);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      const expectedPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      expect(result).toEqual({ path: expectedPath, reused: false, branch: BRANCH, foreign: [] });
      // The create rides the RESOLVED sha (not the FETCH_HEAD name): the
      // tree is pinned to the exact commit the fetch landed on.
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        BRANCH,
        expectedPath,
        SHA_B,
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
        SHA_B,
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
      // The create rides the RESOLVED sha.
      expect(addArgs?.[7]).toBe(SHA_B);
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
// Ownership boundary — foreign trees are surfaced, never claimed/removed
// ---------------------------------------------------------------------------

describe('ownership boundary — foreign trees are surfaced, never claimed', () => {
  test('a branch+sha-valid tree OUTSIDE the root is returned in foreign[] and never claimed — an OWN valid tree is still reused', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const foreignPath = '/elsewhere/foreign-pr-7-fix';
    const ownPath = '/repo/.cq-review-worktrees/pr-7-pr-7-fix';
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: foreignPath, branch: BRANCH, head: SHA_B },
      { path: ownPath, branch: BRANCH, head: SHA_B },
    ]);
    const result = await resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) }));
    // The OWN in-root tree was reused; the foreign at-sha tree was only
    // SURFACED — never claimed, never registered, never removed.
    expect(result).toEqual({
      path: ownPath,
      reused: true,
      branch: BRANCH,
      foreign: [{ path: foreignPath, branch: BRANCH }],
    });
    expect(registry.current()).toEqual({
      '7': { path: ownPath, branch: BRANCH, createdAt: NOW },
    });
    expect(calls).toContainEqual(['-C', foreignPath, 'rev-parse', 'HEAD']);
    expect(calls.some((args) => args.includes('add'))).toBe(false);
    expect(calls.some((args) => args.includes('remove'))).toBe(false);
  });

  test('a foreign at-sha tree holding the branch blocks the create — the refusal names the foreign holder (freeing it is the human’s call)', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-foreignhold-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: '/elsewhere/foreign-pr-7-fix', branch: BRANCH, head: SHA_B },
      ]);
      // No in-root candidate can satisfy reuse, and the foreign holder
      // refuses `add -B` — the throw carries git's stderr naming it, and
      // nothing is registered.
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(/worktree add -B.*failed.*already checked out at '\/elsewhere\/foreign-pr-7-fix'/s);
      expect(registry.calls).toEqual(['load']);
      expect(registry.current()).toEqual({});
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Path canonicalization — the ownership boundary is symlink-proof
// ---------------------------------------------------------------------------

describe('path canonicalization — symlink-proof ownership', () => {
  test('a porcelain tree stored under the CANONICAL spelling is classified in-root (and refreshed) even when the caller spelled worktreeRoot through an alias', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-sym-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const canonicalRoot = join(repoRoot, '.cq-review-worktrees');
      await mkdir(canonicalRoot, { recursive: true });
      // The caller's alias: a symlink to the same directory whose spelling
      // diverges from the canonical one (on macOS tmpdir() itself sits
      // behind /var → /private/var; the symlink makes the divergence
      // explicit and platform-independent).
      const aliasRoot = join(repoRoot, 'alias-link');
      await symlink(canonicalRoot, aliasRoot, 'dir');
      // The stale round-1 tree exists under the CANONICAL spelling (what
      // git/porcelain report), holding the branch at a stale sha.
      const stalePath = join(canonicalRoot, `pr-${PR}-${BRANCH}`);
      await mkdir(stalePath, { recursive: true });
      const model = mkModel([
        { path: repoRoot, branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: BRANCH, head: SHA_A },
      ]);
      const aliasPath = join(aliasRoot, `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, worktreeRoot: aliasRoot, run: fakeGit(model, calls) }),
      );
      // Canonicalization, not a raw prefix compare: the stale tree is OURS
      // (its canonical path lives inside the canonicalized root) — so it is
      // REFRESHED (removed + recreated), never misclassified as foreign and
      // never left blocking the create with a phantom branch hold.
      expect(result).toEqual({ path: aliasPath, reused: false, branch: BRANCH, foreign: [] });
      expect(calls).toContainEqual(['-C', repoRoot, 'worktree', 'remove', stalePath]);
      expect(calls[calls.length - 1]).toEqual(['-C', repoRoot, 'worktree', 'add', '-B', BRANCH, aliasPath, SHA_B]);
      expect(registry.current()['7']?.path).toBe(aliasPath);
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
    // is removing a DIFFERENT (old) in-root path.
    const entryPath = '/repo/.cq-review-worktrees/pr-7-pr-7-fix';
    const oldPath = '/repo/.cq-review-worktrees/pr-7-pr-7-fix.old';
    const registry = memRegistry({
      '7': { path: entryPath, branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model = mkModel([{ path: oldPath, branch: BRANCH, head: SHA_A }]);
    await removePrWorktree({
      ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
      path: oldPath,
    });
    // git removed the requested tree…
    expect(calls[calls.length - 1]).toEqual(['-C', '/repo', 'worktree', 'remove', oldPath]);
    expect(model.worktrees).toEqual([]);
    // …but the registry entry describes a DIFFERENT path and SURVIVES
    // (load ran; save never did — nothing was pruned).
    expect(registry.current()['7']).toEqual({ path: entryPath, branch: BRANCH, createdAt: NOW - 1000 });
    expect(registry.calls).toEqual(['load']);
  });

  test('a path OUTSIDE the worktreeRoot is refused before git runs — the registry and the foreign tree are untouched', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/repo/.cq-review-worktrees/pr-7-pr-7-fix', branch: BRANCH, createdAt: NOW - 1000 },
    });
    const model = mkModel([{ path: '/elsewhere/foreign-pr-7-fix', branch: BRANCH, head: SHA_B }]);
    await expect(
      removePrWorktree({
        ...baseOpts(model, registry, { run: fakeGit(model, calls) }),
        path: '/elsewhere/foreign-pr-7-fix',
      }),
    ).rejects.toThrow(/removePrWorktree: refusing to remove.*outside the review worktreeRoot/s);
    // No git call at all; the foreign tree and the registry both intact.
    expect(calls).toEqual([]);
    expect(model.worktrees).toHaveLength(1);
    expect(registry.current()['7']).toBeDefined();
    expect(registry.calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// THE DOMAIN RULE — reuse requires branch AND sha match; sweep trees unreachable
// ---------------------------------------------------------------------------

describe('domain boundary vs the sweep ops worktree', () => {
  // When the sweep family lands (`createOrReuseWorktree` — package-keyed
  // trees under a sweep root), THIS is the rule that keeps the domains
  // apart, behaviorally: review ops reuses ONLY an OWN (in-root) tree
  // matching the PR branch AND the fetched sha. Sweep trees on OTHER
  // branches neither block the create nor get claimed; a sweep tree
  // HOLDING the branch blocks the create until a human frees it — review
  // ops never removes it (pinned in the scan + ownership tests).

  test('sweep-family trees on other branches are invisible: no claim, no block, the create lands under the review root', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-domain-'));
    try {
      const sweepA = join(repoRoot, '.sweep-worktrees', 'pkg-a');
      const sweepB = join(repoRoot, '.sweep-worktrees', 'pkg-b');
      const model = mkModel([
        { path: repoRoot, branch: 'main', head: SHA_MAIN },
        { path: sweepA, branch: 'pkg-a-branch', head: SHA_A },
        { path: sweepB, branch: 'pkg-b-branch', head: SHA_B },
      ]);
      const expectedPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }));
      expect(result).toEqual({ path: expectedPath, reused: false, branch: BRANCH, foreign: [] });
      // The full argv walk: fetch → FETCH_HEAD → scan → create AT the
      // fetched sha. No sweep path is ever probed (no branch-matching
      // candidate), returned, or registered.
      expect(calls).toEqual([
        ['-C', repoRoot, 'fetch', 'origin', BRANCH],
        ['-C', repoRoot, 'rev-parse', 'FETCH_HEAD'],
        ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        ['-C', repoRoot, 'worktree', 'add', '-B', BRANCH, expectedPath, SHA_B],
      ]);
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: BRANCH, createdAt: NOW },
      });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a sweep-family tree HOLDING the PR branch (parked at a stale sha, outside the root) blocks the create and the refusal names it — review ops never frees it', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-domain2-'));
    try {
      const sweepA = join(repoRoot, '.sweep-worktrees', 'pkg-a');
      const model = mkModel([
        { path: repoRoot, branch: 'main', head: SHA_MAIN },
        { path: sweepA, branch: BRANCH, head: SHA_A },
      ]);
      // The sweep tree is probed (branch match), found stale, NOT removed
      // (foreign, never ours) — and its branch-hold refuses the create
      // with git's stderr naming the sweep path: the run ends AT the
      // refused add, nothing registered.
      const expectedPath = join(repoRoot, '.cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(/already checked out at .*pkg-a/s);
      expect(calls).toContainEqual(['-C', sweepA, 'rev-parse', 'HEAD']);
      expect(calls.some((args) => args.includes('remove'))).toBe(false);
      // The LAST call is the refused create — nothing ran after it.
      expect(calls[calls.length - 1]).toEqual(['-C', repoRoot, 'worktree', 'add', '-B', BRANCH, expectedPath, SHA_B]);
      expect(registry.current()).toEqual({});
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

  test('save is ATOMIC (write tmp + rename): interleaved save/load cycles always leave parseable content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-wt-reg-'));
    try {
      const path = join(dir, 'worktrees.json');
      const registry = fileWorktreeRegistry(path);
      // Interleave loads (including ones racing the save) with saves; after
      // EVERY cycle the on-disk registry must parse as a JSON object — an
      // interrupted in-place rewrite would leave partial JSON here and the
      // next load would throw corrupt.
      for (let cycle = 0; cycle < 15; cycle++) {
        const map: RegistryMap = {
          '7': { path: `/repo/.cq-review-worktrees/pr-7-${cycle}`, branch: BRANCH, createdAt: NOW + cycle },
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
    const dir = await mkdtemp(join(tmpdir(), 'cq-wt-reg-'));
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
});
