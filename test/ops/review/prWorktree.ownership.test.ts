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
import { rm } from 'node:fs/promises';
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
// Ownership boundary — foreign trees are surfaced, never claimed/removed
// ---------------------------------------------------------------------------

describe('ownership boundary — foreign trees are surfaced, never claimed', () => {
  test('a legacy linked-root tree is preserved and the refusal explains operator recovery', async () => {
    const repoRoot = await realTmpDir('cq-wt-legacyhold-');
    try {
      const legacyPath = join(
        repoRoot,
        '.git',
        'worktrees',
        'linked',
        'cq-review-worktrees',
        'pr-7',
      );
      const model = mkModel([{ path: legacyPath, branch: LABEL, head: SHA_A }]);
      const registry = memRegistry({
        '7': { path: legacyPath, branch: LABEL, createdAt: NOW - 1000 },
      });
      const calls: string[][] = [];
      const resolution = resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      await expect(resolution).rejects.toThrow(/preserve its dirty files and unpushed commits/);
      await expect(resolution).rejects.toThrow(/durable rescue branch/);
      await expect(resolution).rejects.toThrow(
        /worktree remove <legacy-review-tree> without --force/,
      );
      await expect(resolution).rejects.toThrow(/Do not remove\/prune the parent linked checkout/);
      expect(calls.some((args) => args.includes('remove'))).toBe(false);
      expect(registry.current()['7']?.path).toBe(legacyPath);
      expect(model.headOf[legacyPath]?.head).toBe(SHA_A);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a branch+sha-valid tree OUTSIDE the root is returned in foreign[] and never claimed — an OWN valid tree is still reused', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const foreignPath = '/elsewhere/foreign-pr-7-fix';
    const ownPath = `${REPO}/.git/cq-review-worktrees/pr-7-pr-7-fix`;
    const model = mkModel([
      { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
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
    const repoRoot = await realTmpDir('cq-wt-foreignhold-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([
        { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
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
    const repoRoot = await realTmpDir('cq-wt-domain-');
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
        ['-C', repoRoot, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
        ['-C', repoRoot, 'fetch', 'origin', `+refs/pull/${PR}/head:refs/cq-review/pr-${PR}`],
        ['-C', repoRoot, 'rev-parse', 'refs/cq-review/pr-7'],
        ['-C', repoRoot, 'worktree', 'list', '--porcelain'],
        ['-C', repoRoot, 'worktree', 'add', '-B', LABEL, expectedPath, SHA_B],
        ['-C', expectedPath, 'rev-parse', '--absolute-git-dir'],
        ['-C', expectedPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
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
    const repoRoot = await realTmpDir('cq-wt-domain2-');
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
