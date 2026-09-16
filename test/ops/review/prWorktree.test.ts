// E3 slice 3 — tests for prWorktree (src/ops/review/prWorktree.ts;
// UC §2 row 38).
//
// Pinned here:
//   1. THE PR'S HEAD REF IS TRUTH, BY SHA: the fetch of refs/pull/<n>/head
//      runs FIRST (a fetch failure
//      throws before the registry is even consulted — nothing touched,
//      nothing saved) and `rev-parse refs/cq-review/pr-<n>` NAMES the fetched commit (a PR-specific ref — FETCH_HEAD is repo-global shared state);
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
//      (default `<repoRoot>/.git/cq-review-worktrees`), added with
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
// model with a REAL sha notion (the fetched PR head per fetch, per-path branch+head
// rev-parse answers, `worktree add -B` moving the branch to the fetched PR head).
// No spawned process, no real clocks (nowMs injected).
import { describe, expect, test } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  fileWorktreeRegistry,
  nextRegistryTmpNonce,
  registryTmpPath,
  removePrWorktree,
  resolvePrWorktree,
  reviewBranchFor,
} from '../../../src/ops/review/prWorktree.js';
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
/** The PR-keyed review label resolvePrWorktree checks out (see reviewBranchFor). */
const LABEL = reviewBranchFor(PR);
/** The STALE local sha — what an out-of-date tree has checked out. */
const SHA_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** The origin truth — what the fetch lands in (the PR-specific ref's target). */
const SHA_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
/** The main tree's sha (an unrelated branch's head). */
const SHA_MAIN = 'cccccccccccccccccccccccccccccccccccccccc';

/** The in-memory git model the fake run implements. */
interface FakeGit {
  /** When set, `fetch origin <branch>` fails with this result. */
  fetchFails?: { code: number; stderr: string };
  /** When set, `rev-parse` of the fetched PR-specific ref fails with this result. */
  fetchHeadFails?: { code: number; stderr: string };
  /** What `rev-parse` of the fetched PR-specific ref prints — defaults to SHA_B (origin truth). */
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
const fakeGit =
  (model: FakeGit, calls?: string[][]): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    calls?.push(args);
    const sub = args[2];
    if (sub === 'fetch') {
      if (model.fetchFails !== undefined) {
        return { code: model.fetchFails.code, stdout: '', stderr: model.fetchFails.stderr };
      }
      // FORK WORLD: origin hosts the PR's pull ref (refs/pull/<n>/head),
      // NOT the contributor's branch — a bare branch-name fetch must fail
      // (it would miss, or grab an unrelated same-named base-repo branch).
      const refspec = (args[4] ?? '').replace(/^\+/, '');
      if (!refspec.startsWith('refs/pull/')) {
        return {
          code: 128,
          stdout: '',
          stderr: `fatal: couldn't find remote ref refs/heads/${refspec}`,
        };
      }
      return { code: 0, stdout: '', stderr: '' };
    }
    if (sub === 'rev-list') {
      // argv shape: ['-C', <path>, 'rev-list', '--count', '<range>'] —
      // commits on HEAD beyond the fetched head: a tree AT the fetched sha
      // has none (0); a stale tree carries some (1+).
      const at = args[1] ?? '';
      const listed = model.headOf[at];
      if (listed === undefined) {
        return { code: 128, stdout: '', stderr: 'fatal: not a git repository' };
      }
      // SHA_A models the PR's OLD head — an ancestor of the fetched truth
      // (the ordinary stale case: 0 commits beyond it). An unrecognized
      // head models unpushed fixer work (1+).
      const ancestor = listed.head === SHA_A || listed.head === (model.fetchHeadSha ?? SHA_B);
      const count = ancestor ? '0' : '1';
      return { code: 0, stdout: `${count}\n`, stderr: '' };
    }
    if (sub === 'rev-parse' && args[3] === '--absolute-git-dir') {
      // Real git resolves a linked-worktree .git FILE to the real dir; the
      // model answers <repoRoot>/.git like a plain checkout.
      return { code: 0, stdout: `${join(args[1] ?? '', '.git')}\n`, stderr: '' };
    }
    if (sub === 'rev-parse') {
      // argv shapes: ['-C', <path>, 'rev-parse', 'refs/cq-review/pr-7'],
      // ['-C', <path>, 'rev-parse', 'HEAD'],
      // ['-C', <path>, 'rev-parse', '--abbrev-ref', 'HEAD'].
      const at = args[1] ?? '';
      const target = args[3] ?? '';
      if (target === 'FETCH_HEAD' || target.startsWith('refs/cq-review/')) {
        if (model.fetchHeadFails !== undefined) {
          return {
            code: model.fetchHeadFails.code,
            stdout: '',
            stderr: model.fetchHeadFails.stderr,
          };
        }
        return { code: 0, stdout: `${model.fetchHeadSha ?? SHA_B}\n`, stderr: '' };
      }
      const checkout = model.headOf[at];
      if (checkout === undefined) {
        return {
          code: 128,
          stdout: '',
          stderr: 'fatal: not a git repository (or any of the parent directories): .git',
        };
      }
      if (target === 'HEAD') {
        return { code: 0, stdout: `${checkout.head}\n`, stderr: '' };
      }
      if (target === '--abbrev-ref' && args[4] === 'HEAD') {
        return { code: 0, stdout: `${checkout.branch ?? 'HEAD'}\n`, stderr: '' };
      }
      return {
        code: 2,
        stdout: '',
        stderr: `fake git: unexpected rev-parse ${JSON.stringify(args)}`,
      };
    }
    if (sub === 'worktree') {
      const verb = args[3];
      if (verb === 'list') {
        const blocks = model.worktrees
          .map(
            (wt) =>
              `worktree ${wt.path}\nHEAD ${wt.head}${wt.branch === null ? '' : `\nbranch refs/heads/${wt.branch}`}`,
          )
          .join('\n\n');
        return { code: 0, stdout: blocks === '' ? '' : `${blocks}\n`, stderr: '' };
      }
      if (verb === 'add') {
        if (model.addFails !== undefined) {
          return { code: model.addFails.code, stdout: '', stderr: model.addFails.stderr };
        }
        // The ONLY add shape review ops uses: add -B <branch> <path> <sha>.
        if (args[4] !== '-B') {
          return {
            code: 2,
            stdout: '',
            stderr: `fake git: unexpected add argv ${JSON.stringify(args)}`,
          };
        }
        const branch = args[5] ?? '';
        const path = args[6] ?? '';
        const commitish = args[7] ?? '';
        // git's DOUBLE-CHECKOUT REFUSAL: `-B` does not bypass it — while
        // ANY other registered tree holds the branch, the add refuses with
        // git's message. `worktree remove` clears the hold.
        const holder = model.worktrees.find((wt) => wt.branch === branch && wt.path !== path);
        if (holder !== undefined) {
          return {
            code: 128,
            stdout: '',
            stderr: `fatal: '${branch}' is already checked out at '${holder.path}'`,
          };
        }
        if (model.worktrees.some((wt) => wt.path === path)) {
          return {
            code: 128,
            stdout: '',
            stderr: `fatal: '${path}' is already a registered worktree`,
          };
        }
        // `-B` (re)points the branch at the requested commit: the new
        // tree's HEAD lands at that sha (FETCH_HEAD resolves to the
        // fetched truth).
        const head =
          commitish === 'FETCH_HEAD' || commitish.startsWith('refs/cq-review/')
            ? (model.fetchHeadSha ?? SHA_B)
            : commitish;
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
const memRegistry = (
  initial: RegistryMap = {},
): WorktreeRegistry & { calls: string[]; current: () => RegistryMap } => {
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
    withLock: async <T>(fn: () => Promise<T>) => fn(),
  };
};

/** Base opts over the fake model; repoRoot is a throwaway absolute path —
 * the fake git ignores -C (except through the model's own bookkeeping),
 * and only mkdir/stat touch the real fs. */
const baseOpts = (
  model: FakeGit,
  registry: WorktreeRegistry,
  over?: Partial<PrWorktreeOpts>,
): PrWorktreeOpts => ({
  repoRoot: '/repo',
  pr: PR,
  headRefName: BRANCH,
  run: fakeGit(model),
  registry,
  nowMs: NOW,
  ...over,
});

// ---------------------------------------------------------------------------
// a. THE PR HEAD REF IS TRUTH
// ---------------------------------------------------------------------------

describe('fetch-first — origin branch is truth', () => {
  test('the fetch runs FIRST and a fetch failure THROWS before the registry is even consulted', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/somewhere/pr-7', branch: LABEL, createdAt: NOW - 1000 },
    });
    const model = mkModel([], {
      fetchFails: { code: 128, stderr: "fatal: couldn't find remote ref refs/pull/7/head" },
    });
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) })),
    ).rejects.toThrow(/fetch origin refs\/pull\/7\/head failed.*couldn't find remote ref/s);
    // The fetch was the only thing attempted — registry untouched.
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['-C', '/repo', 'rev-parse', '--absolute-git-dir']);
    expect(calls[1]).toEqual([
      '-C',
      '/repo',
      'fetch',
      'origin',
      '+refs/pull/7/head:refs/cq-review/pr-7',
    ]);
    expect(calls[1]).toEqual([
      '-C',
      '/repo',
      'fetch',
      'origin',
      '+refs/pull/7/head:refs/cq-review/pr-7',
    ]);
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
      expect(calls[0]).toEqual(['-C', repoRoot, 'rev-parse', '--absolute-git-dir']);
      expect(calls[1]).toEqual([
        '-C',
        repoRoot,
        'fetch',
        'origin',
        '+refs/pull/7/head:refs/cq-review/pr-7',
      ]);
      expect(calls[2]).toEqual(['-C', repoRoot, 'rev-parse', 'refs/cq-review/pr-7']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a FORKED PR: headRefName names a branch that does NOT exist on origin — the pull-ref fetch still resolves the true head', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-fork-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      // The contributor's branch name appears NOWHERE on origin or locally
      // (the fake fetch refuses every bare branch name) — only
      // refs/pull/7/head carries the PR's truth.
      const forkBranch = 'contributor-patch';
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }]);
      const expectedPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${forkBranch}`);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, {
          repoRoot,
          headRefName: forkBranch,
          run: fakeGit(model, calls),
        }),
      );
      expect(result).toEqual({ path: expectedPath, reused: false, branch: LABEL, foreign: [] });
      // The truth came from the PULL REF, not the (nonexistent) branch name.
      expect(calls[1]).toEqual([
        '-C',
        repoRoot,
        'fetch',
        'origin',
        `+refs/pull/${PR}/head:refs/cq-review/pr-${PR}`,
      ]);
      // The local branch label was created AT the fetched sha.
      expect(model.headOf[expectedPath]).toEqual({ branch: LABEL, head: SHA_B });
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('an unnameable fetch (rev-parse of the PR-specific ref fails) THROWS — nothing is decided on unknown truth', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/somewhere/pr-7', branch: LABEL, createdAt: NOW - 1000 },
    });
    const model = mkModel([], {
      fetchHeadFails: { code: 128, stderr: 'fatal: ambiguous argument' },
    });
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { run: fakeGit(model, calls) })),
    ).rejects.toThrow(/rev-parse refs\/cq-review\/pr-7 failed.*unnameable/s);
    // Only fetch + FETCH_HEAD ran; the registry was never consulted.
    expect(calls.map((args) => args[2])).toEqual(['rev-parse', 'fetch', 'rev-parse']);
    expect(registry.calls).toEqual([]);
    expect(registry.current()['7']).toBeDefined();
  });

  test('validation fails loud before any git invocation', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const model = mkModel();
    const run = fakeGit(model, calls);
    await expect(resolvePrWorktree(baseOpts(model, registry, { pr: 0, run }))).rejects.toThrow(
      /resolvePrWorktree:/,
    );
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { headRefName: '', run })),
    ).rejects.toThrow(/resolvePrWorktree:/);
    await expect(
      resolvePrWorktree(baseOpts(model, registry, { headRefName: '-evil', run })),
    ).rejects.toThrow(/resolvePrWorktree:/);
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
      const entryDir = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(entryDir, { recursive: true });
      const registry = memRegistry({
        '7': { path: entryDir, branch: LABEL, createdAt: NOW - 1000 },
      });
      const model = mkModel([], { headOf: { [entryDir]: { branch: LABEL, head: SHA_B } } });
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      expect(result).toEqual({ path: entryDir, reused: true, branch: LABEL, foreign: [] });
      // fetch → FETCH_HEAD → the entry's branch rev-parse → its sha
      // rev-parse — no scan, no add.
      expect(calls.map((args) => args[2])).toEqual([
        'rev-parse',
        'fetch',
        'rev-parse',
        'rev-parse',
        'rev-parse',
      ]);
      expect(calls[2]).toEqual(['-C', repoRoot, 'rev-parse', 'refs/cq-review/pr-7']);
      expect(calls[3]).toEqual(['-C', entryDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
      expect(calls[4]).toEqual(['-C', entryDir, 'rev-parse', 'HEAD']);
      // A valid hit is not re-registered (the entry already exists).
      expect(registry.calls).toEqual(['load']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a STALE entry whose directory is GONE is left un-pruned, and the scan reuse path takes over', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: '/repo/.git/cq-review-worktrees/ghost', branch: LABEL, createdAt: NOW - 1000 },
    });
    const candidate = '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix';
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: candidate, branch: LABEL, head: SHA_B },
    ]);
    const result = await resolvePrWorktree(
      baseOpts(model, registry, { run: fakeGit(model, calls) }),
    );
    // The dead entry was SKIPPED (never pruned up front — no prune-save);
    // the scan found the branch checked out in OUR root AT THE FETCHED sha
    // and the register overwrote the stale entry.
    expect(result).toEqual({ path: candidate, reused: true, branch: LABEL, foreign: [] });
    expect(registry.calls).toEqual(['load', 'update:7']);
    expect(registry.current()).toEqual({
      '7': { path: candidate, branch: LABEL, createdAt: NOW },
    });
    // The dead directory short-circuits BEFORE rev-parse (no git call for
    // the ghost); after FETCH_HEAD comes the porcelain scan, then the
    // sha probe against the candidate.
    expect(calls[3]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
    expect(calls[4]).toEqual(['-C', candidate, 'rev-parse', 'HEAD']);
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
      const registry = memRegistry({
        '7': { path: outsidePath, branch: LABEL, createdAt: NOW - 1000 },
      });
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }], {
        headOf: { [outsidePath]: { branch: LABEL, head: SHA_B } },
      });
      const expectedPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      expect(result).toEqual({ path: expectedPath, reused: false, branch: LABEL, foreign: [] });
      // The inside-the-root entry (created fresh) replaced the outside pointer.
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: LABEL, createdAt: NOW },
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
      const staleDir = join(repoRoot, '.git', 'cq-review-worktrees', 'stale-tree');
      await mkdir(staleDir, { recursive: true });
      const registry = memRegistry({
        '7': { path: staleDir, branch: LABEL, createdAt: NOW - 1000 },
      });
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }], {
        headOf: { [staleDir]: { branch: 'some-other-branch', head: SHA_A } },
      });
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      expect(result.reused).toBe(false);
      expect(result.foreign).toEqual([]);
      // NO up-front prune: load, then the create's per-key register.
      expect(registry.calls).toEqual(['load', 'update:7']);
      expect(registry.current()['7']?.path).toBe(
        join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`),
      );
      // rev-parse ran against the stale tree and exposed the wrong branch.
      expect(calls[3]).toEqual(['-C', staleDir, 'rev-parse', '--abbrev-ref', 'HEAD']);
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
      const stalePath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(stalePath, { recursive: true });
      const registry = memRegistry({
        '7': { path: stalePath, branch: LABEL, createdAt: NOW - 1000 },
      });
      const model = mkModel([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: LABEL, head: SHA_A },
      ]);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      // The refresh CONVERGED at the same path, at the fetched sha.
      expect(result).toEqual({ path: stalePath, reused: false, branch: LABEL, foreign: [] });
      // The stale entry was overwritten by the successful register — load
      // plus ONE save, no up-front prune.
      expect(registry.calls).toEqual(['load', 'update:7']);
      expect(registry.current()).toEqual({
        '7': { path: stalePath, branch: LABEL, createdAt: NOW },
      });
      // The exact refresh walk: the consult probes exposed the staleness
      // (branch ok, sha A), the scan re-probed, the NON-FORCED remove
      // freed the branch hold, and `-B … <expectedSha>` landed the tree AT
      // the fetched truth.
      expect(calls).toEqual([
        ['-C', repoRoot, 'rev-parse', '--absolute-git-dir'],
        ['-C', repoRoot, 'fetch', 'origin', `+refs/pull/${PR}/head:refs/cq-review/pr-${PR}`],
        ['-C', repoRoot, 'rev-parse', 'refs/cq-review/pr-7'],
        ['-C', stalePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        ['-C', stalePath, 'rev-parse', 'HEAD'],
        ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        ['-C', stalePath, 'rev-parse', 'HEAD'],
        ['-C', stalePath, 'rev-list', '--count', `${SHA_B}..HEAD`],
        ['-C', repoRoot, 'worktree', 'remove', stalePath],
        ['-C', repoRoot, 'worktree', 'add', '-B', LABEL, stalePath, SHA_B],
      ]);
      expect(calls.some((args) => args.includes('--force'))).toBe(false);
      // The hold was cleared by the remove; the new tree sits at the
      // fetched sha (the main tree is untouched).
      expect(model.worktrees).toEqual([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: LABEL, head: SHA_B },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a stale tree that is DIRTY cannot be refreshed away — the remove refuses, the throw carries git stderr, and the registry entry SURVIVES', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-dirty-'));
    try {
      const calls: string[][] = [];
      const stalePath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(stalePath, { recursive: true });
      const registry = memRegistry({
        '7': { path: stalePath, branch: LABEL, createdAt: NOW - 1000 },
      });
      const model = mkModel(
        [
          { path: '/repo', branch: 'main', head: SHA_MAIN },
          { path: stalePath, branch: LABEL, head: SHA_A },
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
      expect(registry.current()['7']).toEqual({
        path: stalePath,
        branch: LABEL,
        createdAt: NOW - 1000,
      });
      // The tree itself is untouched — review ops never force-destroys.
      expect(model.worktrees).toHaveLength(2);
      expect(calls.some((args) => args.includes('--force'))).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// c. Existing-worktree scan reuse (LABEL match AND SHA match)
// ---------------------------------------------------------------------------

describe('existing-worktree scan reuse (LABEL match AND SHA match, INSIDE the root)', () => {
  test('an OWN worktree already checked out on the PR branch AT THE FETCHED SHA is registered and returned — zero adds (add would refuse anyway)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const ownPath = '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix';
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: ownPath, branch: LABEL, head: SHA_B },
      { path: '/other/thing', branch: 'unrelated', head: SHA_MAIN },
    ]);
    const result = await resolvePrWorktree(
      baseOpts(model, registry, { run: fakeGit(model, calls) }),
    );
    expect(result).toEqual({ path: ownPath, reused: true, branch: LABEL, foreign: [] });
    // fetch → FETCH_HEAD → worktree list → sha probe; no add.
    expect(calls.map((args) => args[2])).toEqual([
      'rev-parse',
      'fetch',
      'rev-parse',
      'worktree',
      'rev-parse',
    ]);
    expect(calls[3]).toEqual(['-C', '/repo', 'worktree', 'list', '--porcelain']);
    expect(calls[4]).toEqual(['-C', ownPath, 'rev-parse', 'HEAD']);
    expect(calls.some((args) => args.includes('add'))).toBe(false);
    expect(registry.current()).toEqual({
      '7': { path: ownPath, branch: LABEL, createdAt: NOW },
    });
  });

  test('a tree at THIS PR key’s target path on an OLD branch name is RECLAIMED — non-forced remove, create succeeds in the freed slot', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-reclaim-'));
    try {
      const calls: string[][] = [];
      // The branch was RENAMED after a previous round: the old tree still
      // sits at the pr-keyed path, checked out on the OLD branch name. The
      // path is the PR's slot, not the branch's — reclaim it.
      const targetPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(targetPath, { recursive: true });
      const registry = memRegistry({
        '7': { path: targetPath, branch: 'old-pr-7-branch', createdAt: NOW - 1000 },
      });
      const model = mkModel([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: targetPath, branch: 'old-pr-7-branch', head: SHA_A },
      ]);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      expect(result).toEqual({ path: targetPath, reused: false, branch: LABEL, foreign: [] });
      expect(registry.calls).toEqual(['load', 'update:7']);
      // The squatter was removed NON-FORCED and the create landed at the
      // same pr-keyed slot, at the fetched sha.
      expect(calls).toContainEqual(['-C', repoRoot, 'worktree', 'remove', targetPath]);
      expect(calls[calls.length - 1]).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        LABEL,
        targetPath,
        SHA_B,
      ]);
      expect(calls.some((args) => args.includes('--force'))).toBe(false);
      expect(model.worktrees).toEqual([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: targetPath, branch: LABEL, head: SHA_B },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a branch-matching stale tree OUTSIDE the root holds the branch — review ops never frees foreign trees: the create refuses and names the holder', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-foreignstale-'));
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([
        { path: '/repo', branch: 'main', head: SHA_MAIN },
        { path: '/elsewhere/pr-7-fix', branch: LABEL, head: SHA_A },
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
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      const expectedPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      expect(result).toEqual({ path: expectedPath, reused: false, branch: LABEL, foreign: [] });
      // The create rides the RESOLVED sha (not the FETCH_HEAD name): the
      // tree is pinned to the exact commit the fetch landed on.
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        LABEL,
        expectedPath,
        SHA_B,
      ]);
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: LABEL, createdAt: NOW },
      });
      // The created tree sits AT the fetched sha (-B moved the branch).
      expect(model.headOf[expectedPath]).toEqual({ branch: LABEL, head: SHA_B });
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
      await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, worktreeRoot: explicit, run: fakeGit(model, calls) }),
      );
      expect(calls.find((args) => args.includes('add'))).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        LABEL,
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
      expect(addArgs?.[6]).toBe(
        join(repoRoot, '.git', 'cq-review-worktrees', 'pr-7-feature-fix-42_x-retest'),
      );
      // The create rides the RESOLVED sha.
      expect(addArgs?.[7]).toBe(SHA_B);
      // The added DIRECTORY is one path segment under the worktree root.
      expect(addArgs?.[6]?.startsWith(join(repoRoot, '.git', 'cq-review-worktrees') + '/')).toBe(
        true,
      );
      expect(
        addArgs?.[6]?.slice((join(repoRoot, '.git', 'cq-review-worktrees') + '/').length),
      ).not.toContain('/');
      // The collision rule: "feat/x" and "feat-x" sanitize to the SAME
      // segment, but each PR's directory carries its own number — two
      // branches can never share one review tree path.
      expect('feat/x'.replace(/[^A-Za-z0-9._-]/g, '-')).toBe(
        'feat-x'.replace(/[^A-Za-z0-9._-]/g, '-'),
      );
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
        addFails: {
          code: 128,
          stderr: `fatal: '${LABEL}' is already checked out at '/elsewhere/${LABEL}'`,
        },
      });
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(
        new RegExp(
          `worktree add -B ${LABEL}.*failed.*already checked out`.replace(/\//g, '\\/'),
          's',
        ),
      );
      expect(registry.calls).toEqual(['load']); // load happened, save NEVER did
      expect(registry.current()).toEqual({});
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// PR-keyed branch labels — two PRs sharing a headRefName never collide
// ---------------------------------------------------------------------------

describe('PR-keyed branch labels', () => {
  test('PR 7 and PR 9 both headRefName "main": distinct labels, distinct paths, no cross-claim', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-two-'));
    try {
      const registry = memRegistry();
      // PR 7 resolves first: its label is cq-review/pr-7, its path pr-7-main.
      const model = mkModel([{ path: '/repo', branch: 'main', head: SHA_MAIN }]);
      const r7 = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, headRefName: 'main', run: fakeGit(model) }),
      );
      const path7 = join(repoRoot, '.git', 'cq-review-worktrees', 'pr-7-main');
      expect(r7).toEqual({ path: path7, reused: false, branch: reviewBranchFor(7), foreign: [] });
      // PR 9 — the SAME headRefName — must neither claim nor remove PR 7's
      // tree: the label is pr-keyed, so PR 7's tree can never read as PR 9's.
      const r9 = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, pr: 9, headRefName: 'main', run: fakeGit(model) }),
      );
      const path9 = join(repoRoot, '.git', 'cq-review-worktrees', 'pr-9-main');
      expect(r9).toEqual({ path: path9, reused: false, branch: reviewBranchFor(9), foreign: [] });
      // One registry, two keys, two different paths — the two-keys-one-path
      // confusion is gone because the labels are pr-keyed.
      expect(registry.current()['7']).toEqual({
        path: path7,
        branch: reviewBranchFor(7),
        createdAt: NOW,
      });
      expect(registry.current()['9']).toEqual({
        path: path9,
        branch: reviewBranchFor(9),
        createdAt: NOW,
      });
      // PR 7's tree still stands, untouched, on its own label.
      expect(
        model.worktrees.some((wt) => wt.path === path7 && wt.branch === reviewBranchFor(7)),
      ).toBe(true);
      expect(
        model.worktrees.some((wt) => wt.path === path9 && wt.branch === reviewBranchFor(9)),
      ).toBe(true);
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
    const ownPath = '/repo/.git/cq-review-worktrees/pr-7-pr-7-fix';
    const model = mkModel([
      { path: '/repo', branch: 'main', head: SHA_MAIN },
      { path: foreignPath, branch: LABEL, head: SHA_B },
      { path: ownPath, branch: LABEL, head: SHA_B },
    ]);
    const result = await resolvePrWorktree(
      baseOpts(model, registry, { run: fakeGit(model, calls) }),
    );
    // The OWN in-root tree was reused; the foreign at-sha tree was only
    // SURFACED — never claimed, never registered, never removed.
    expect(result).toEqual({
      path: ownPath,
      reused: true,
      branch: LABEL,
      foreign: [{ path: foreignPath, branch: LABEL }],
    });
    expect(registry.current()).toEqual({
      '7': { path: ownPath, branch: LABEL, createdAt: NOW },
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
        { path: '/elsewhere/foreign-pr-7-fix', branch: LABEL, head: SHA_B },
      ]);
      // No in-root candidate can satisfy reuse, and the foreign holder
      // refuses `add -B` — the throw carries git's stderr naming it, and
      // nothing is registered.
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(
        /worktree add -B.*failed.*already checked out at '\/elsewhere\/foreign-pr-7-fix'/s,
      );
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
        { path: stalePath, branch: LABEL, head: SHA_A },
      ]);
      const aliasPath = join(aliasRoot, `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, {
          repoRoot,
          worktreeRoot: aliasRoot,
          run: fakeGit(model, calls),
        }),
      );
      // Canonicalization, not a raw prefix compare: the stale tree is OURS
      // (its canonical path lives inside the canonicalized root) — so it is
      // REFRESHED (removed + recreated), never misclassified as foreign and
      // never left blocking the create with a phantom branch hold.
      expect(result).toEqual({ path: aliasPath, reused: false, branch: LABEL, foreign: [] });
      expect(calls).toContainEqual(['-C', repoRoot, 'worktree', 'remove', stalePath]);
      expect(calls[calls.length - 1]).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        LABEL,
        aliasPath,
        SHA_B,
      ]);
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
    expect(calls).toEqual([['-C', '/repo', 'rev-parse', '--absolute-git-dir']]);
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
      const expectedPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      expect(result).toEqual({ path: expectedPath, reused: false, branch: LABEL, foreign: [] });
      // The full argv walk: fetch → FETCH_HEAD → scan → create AT the
      // fetched sha. No sweep path is ever probed (no branch-matching
      // candidate), returned, or registered.
      expect(calls).toEqual([
        ['-C', repoRoot, 'rev-parse', '--absolute-git-dir'],
        ['-C', repoRoot, 'fetch', 'origin', `+refs/pull/${PR}/head:refs/cq-review/pr-${PR}`],
        ['-C', repoRoot, 'rev-parse', 'refs/cq-review/pr-7'],
        ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        ['-C', repoRoot, 'worktree', 'add', '-B', LABEL, expectedPath, SHA_B],
      ]);
      expect(registry.current()).toEqual({
        '7': { path: expectedPath, branch: LABEL, createdAt: NOW },
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
        { path: sweepA, branch: LABEL, head: SHA_A },
      ]);
      // The sweep tree is probed (branch match), found stale, NOT removed
      // (foreign, never ours) — and its branch-hold refuses the create
      // with git's stderr naming the sweep path: the run ends AT the
      // refused add, nothing registered.
      const expectedPath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await expect(
        resolvePrWorktree(baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) })),
      ).rejects.toThrow(/already checked out at .*pkg-a/s);
      expect(calls).toContainEqual(['-C', sweepA, 'rev-parse', 'HEAD']);
      expect(calls.some((args) => args.includes('remove'))).toBe(false);
      // The LAST call is the refused create — nothing ran after it.
      expect(calls[calls.length - 1]).toEqual([
        '-C',
        repoRoot,
        'worktree',
        'add',
        '-B',
        LABEL,
        expectedPath,
        SHA_B,
      ]);
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
    const dir = await mkdtemp(join(tmpdir(), 'cq-wt-reg-'));
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

// ---------------------------------------------------------------------------
// Codex threads r4-followups — cwd independence + canonical reclaim
// ---------------------------------------------------------------------------

describe('cwd independence — a RELATIVE repoRoot resolves everywhere', () => {
  test('a relative repoRoot produces ABSOLUTE -C args and an absolute worktree path (mkdir and git must not straddle two resolvers)', async () => {
    const absRepo = await mkdtemp(join(tmpdir(), 'cq-wt-rel-'));
    try {
      // The relative spelling of the absolute tmpdir repo: pathResolve(rel)
      // must land back on absRepo no matter which cwd the caller runs from.
      const rel = relative(process.cwd(), absRepo);
      const calls: string[][] = [];
      const model = mkModel([{ path: absRepo, branch: 'main', head: SHA_MAIN }]);
      const result = await resolvePrWorktree({
        repoRoot: rel,
        pr: PR,
        headRefName: 'main',
        run: fakeGit(model, calls),
        registry: memRegistry(),
        nowMs: NOW,
      });
      // The fetch rode the absolute repo root, not the relative spelling.
      const fetchArgs = calls.find((args) => args.includes('fetch'));
      expect(fetchArgs?.[1]).toBe(absRepo);
      // The create landed inside the ABSOLUTE repo's .git (never a doubled
      // rel/rel prefix, never a cwd-dependent location).
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs?.[1]).toBe(absRepo);
      expect(addArgs?.[6]).toBe(join(absRepo, '.git', 'cq-review-worktrees', `pr-${PR}-main`));
      expect(result.path).toBe(join(absRepo, '.git', 'cq-review-worktrees', `pr-${PR}-main`));
    } finally {
      await rm(absRepo, { recursive: true, force: true });
    }
  });
});

describe('canonical reclaim — the target slot matches across spelling divergence', () => {
  test('a porcelain tree at the target slot under the CANONICAL root spelling is reclaimed even when the caller spelled worktreeRoot through an alias', async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-rc-'));
    try {
      const calls: string[][] = [];
      const canonicalRoot = join(repoRoot, '.git', 'cq-review-worktrees');
      await mkdir(canonicalRoot, { recursive: true });
      const aliasRoot = join(repoRoot, 'alias-link');
      await symlink(canonicalRoot, aliasRoot, 'dir');
      // A tree parked at the PR's CURRENT target slot under the CANONICAL
      // spelling (what real git porcelain reports through a symlinked
      // tmpdir), on some OTHER branch (a branch rename left it there).
      // The caller's targetPath spells the alias; only the canonicalized
      // comparison can see that both name the same directory.
      const realCanonicalRoot = await realpath(canonicalRoot);
      const parkedPath = join(realCanonicalRoot, `pr-${PR}-main`);
      await mkdir(parkedPath, { recursive: true });
      const model = mkModel([
        { path: repoRoot, branch: 'main', head: SHA_MAIN },
        { path: parkedPath, branch: 'renamed-away', head: SHA_A },
      ]);
      const result = await resolvePrWorktree({
        repoRoot,
        pr: PR,
        headRefName: 'main',
        run: fakeGit(model, calls),
        registry: memRegistry(),
        nowMs: NOW,
      });
      // The parked tree was REMOVED (non-forced) and the create landed in
      // the freed slot — the raw-spelling equality would have skipped the
      // reclaim and wedged on the double-checkout refusal.
      const removeArgs = calls.find((args) => args.includes('remove'));
      expect(removeArgs?.[removeArgs.length - 1]).toBe(parkedPath);
      const addArgs = calls.find((args) => args.includes('add'));
      expect(addArgs?.[6]).toBe(join(canonicalRoot, `pr-${PR}-main`));
      expect(addArgs?.[7]).toBe(SHA_B);
      expect(result.reused).toBe(false);
      expect(result.path).toBe(join(canonicalRoot, `pr-${PR}-main`));
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
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
    const remove9 = removePrWorktree({
      ...baseOpts(model, harness.registry, { run: fakeGit(model) }),
      pr: 9,
      path: path9,
    });
    // A full macrotask turn: every pre-lock step of remove9 has settled, and
    // its critical section is still queued (the lock is held).
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    const settled = await Promise.race([
      remove9.then(
        () => 'done' as const,
        () => 'error' as const,
      ),
      Promise.resolve('pending' as const),
    ]);
    expect(settled).toBe('pending');
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
    const repoRoot = await mkdtemp(join(tmpdir(), 'cq-wt-race-'));
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
