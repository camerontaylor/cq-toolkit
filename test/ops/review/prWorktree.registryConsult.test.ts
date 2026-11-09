import { REPO } from './prWorktree.helpers.js';
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
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { realTmpDir } from '../../helpers/tmp-dir.js';
import { resolvePrWorktree } from '../../../src/adapters/git/prWorktree.js';
import {
  NOW,
  PR,
  BRANCH,
  LABEL,
  SHA_A,
  SHA_B,
  SHA_MAIN,
  mkModel,
  fakeGit,
  memRegistry,
  baseOpts,
} from './prWorktree.helpers.js';

// ---------------------------------------------------------------------------
// b. Registry consult (hit + stale flavors)
// ---------------------------------------------------------------------------

describe('registry consult', () => {
  test('a registry hit whose entry still points at truth (in-root, branch AND fetched sha) → reused=true, and NO worktree list/add ever runs', async () => {
    const repoRoot = await realTmpDir('cq-wt-hit-');
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
      // Fetch truth, reject bad labels, then pin the checkout before fresh
      // branch/HEAD safety probes. No scan or add.
      expect(calls.map((args) => args[2])).toEqual([
        'rev-parse',
        'fetch',
        'rev-parse',
        'symbolic-ref',
        'rev-parse',
        'rev-parse',
        'symbolic-ref',
        'rev-parse',
        'rev-parse',
        'rev-parse',
        'diff',
        'diff',
        'ls-files',
      ]);
      expect(calls[2]).toEqual(['-C', repoRoot, 'rev-parse', 'refs/cq-review/pr-7']);
      expect(calls.slice(3, 8)).toEqual([
        ['-C', entryDir, 'symbolic-ref', 'HEAD'],
        ['-C', entryDir, 'rev-parse', '--absolute-git-dir'],
        ['-C', entryDir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['-C', entryDir, 'symbolic-ref', 'HEAD'],
        ['-C', entryDir, 'rev-parse', 'HEAD'],
      ]);
      // Rebinding persists bound/incomplete metadata before reuse.
      expect(registry.calls).toEqual(['load', 'update:7']);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a STALE entry whose directory is GONE is left un-pruned, and the scan reuse path takes over', async () => {
    const calls: string[][] = [];
    const registry = memRegistry({
      '7': { path: `${REPO}/.git/cq-review-worktrees/ghost`, branch: LABEL, createdAt: NOW - 1000 },
    });
    const candidate = `${REPO}/.git/cq-review-worktrees/pr-7-pr-7-fix`;
    const model = mkModel([
      { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
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
    expect(calls[3]).toEqual(['-C', `${REPO}`, 'worktree', 'list', '--porcelain']);
    expect(calls.slice(4, 8)).toEqual([
      ['-C', candidate, 'rev-parse', '--absolute-git-dir'],
      ['-C', candidate, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['-C', candidate, 'symbolic-ref', 'HEAD'],
      ['-C', candidate, 'rev-parse', 'HEAD'],
    ]);
  });

  test('a registry entry pointing OUTSIDE the current worktreeRoot is stale by definition — resolution recreates INSIDE', async () => {
    const repoRoot = await realTmpDir('cq-wt-outroot-');
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
      const model = mkModel([{ path: `${REPO}`, branch: 'main', head: SHA_MAIN }], {
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
    const repoRoot = await realTmpDir('cq-wt-stale-');
    try {
      const calls: string[][] = [];
      // The stale tree EXISTS on disk INSIDE the worktreeRoot but holds the
      // wrong branch — the symbolic-ref check is what exposes it (it passes
      // the ownership gate first).
      const staleDir = join(repoRoot, '.git', 'cq-review-worktrees', 'stale-tree');
      await mkdir(staleDir, { recursive: true });
      const registry = memRegistry({
        '7': { path: staleDir, branch: LABEL, createdAt: NOW - 1000 },
      });
      const model = mkModel([{ path: `${REPO}`, branch: 'main', head: SHA_MAIN }], {
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
      // symbolic-ref ran against the stale tree and exposed the wrong branch.
      expect(calls[3]).toEqual(['-C', staleDir, 'symbolic-ref', 'HEAD']);
      expect(calls.some((args) => args.includes('add'))).toBe(true);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a STALE entry at the WRONG SHA — branch matches, tree lags origin — CONVERGES: the stale in-root tree is REMOVED non-forced and RE-CREATED at the fetched sha via add -B … <sha>', async () => {
    const repoRoot = await realTmpDir('cq-wt-stalesha-');
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
        { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: LABEL, head: SHA_A },
      ]);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      // The refresh CONVERGED at the same path, at the fetched sha.
      expect(result).toEqual({ path: stalePath, reused: false, branch: LABEL, foreign: [] });
      // The stale entry was overwritten by the successful register — load
      // plus ONE save, no up-front prune.
      expect(registry.calls).toEqual(['load', 'update:7', 'update:7:null', 'update:7']);
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
        ['-C', stalePath, 'symbolic-ref', 'HEAD'],
        ['-C', stalePath, 'rev-parse', '--absolute-git-dir'],
        ['-C', stalePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['-C', stalePath, 'symbolic-ref', 'HEAD'],
        ['-C', stalePath, 'rev-parse', 'HEAD'],
        ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        ['-C', stalePath, 'rev-parse', '--absolute-git-dir'],
        ['-C', stalePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['-C', stalePath, 'symbolic-ref', 'HEAD'],
        ['-C', stalePath, 'rev-parse', 'HEAD'],
        ['-C', stalePath, 'rev-list', '--count', `${SHA_B}..HEAD`],
        ['-C', stalePath, 'rev-parse', '--absolute-git-dir'],
        ['-C', stalePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['-C', repoRoot, 'worktree', 'remove', stalePath],
        ['-C', repoRoot, 'worktree', 'add', '-B', LABEL, stalePath, SHA_B],
        ['-C', stalePath, 'rev-parse', '--absolute-git-dir'],
        ['-C', stalePath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      ]);
      expect(calls.some((args) => args.includes('--force'))).toBe(false);
      // The hold was cleared by the remove; the new tree sits at the
      // fetched sha (the main tree is untouched).
      expect(model.worktrees).toEqual([
        { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
        { path: stalePath, branch: LABEL, head: SHA_B },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a stale tree that is DIRTY cannot be refreshed away — the remove refuses, the throw carries git stderr, and the registry entry SURVIVES', async () => {
    const repoRoot = await realTmpDir('cq-wt-dirty-');
    try {
      const calls: string[][] = [];
      const stalePath = join(repoRoot, '.git', 'cq-review-worktrees', `pr-${PR}-${BRANCH}`);
      await mkdir(stalePath, { recursive: true });
      const registry = memRegistry({
        '7': { path: stalePath, branch: LABEL, createdAt: NOW - 1000 },
      });
      const model = mkModel(
        [
          { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
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
      expect(registry.calls).toEqual(['load', 'update:7']);
      expect(registry.current()['7']).toEqual({
        path: stalePath,
        branch: LABEL,
        createdAt: NOW,
      });
      // The tree itself is untouched — review ops never force-destroys.
      expect(model.worktrees).toHaveLength(2);
      expect(calls.some((args) => args.includes('--force'))).toBe(false);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });
});
