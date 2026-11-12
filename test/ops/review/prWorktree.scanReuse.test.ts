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
// c. Existing-worktree scan reuse (LABEL match AND SHA match)
// ---------------------------------------------------------------------------

describe('existing-worktree scan reuse (LABEL match AND SHA match, INSIDE the root)', () => {
  test('an OWN worktree already checked out on the PR branch AT THE FETCHED SHA is registered and returned — zero adds (add would refuse anyway)', async () => {
    const calls: string[][] = [];
    const registry = memRegistry();
    const ownPath = `${REPO}/.git/cq-review-worktrees/pr-7-pr-7-fix`;
    const model = mkModel([
      { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
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
      'rev-parse',
      'symbolic-ref',
      'rev-parse',
      'rev-parse',
      'rev-parse',
      'diff',
      'diff',
      'ls-files',
    ]);
    expect(calls[3]).toEqual(['-C', `${REPO}`, 'worktree', 'list', '--porcelain']);
    expect(calls.slice(4, 8)).toEqual([
      ['-C', ownPath, 'rev-parse', '--absolute-git-dir'],
      ['-C', ownPath, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      ['-C', ownPath, 'symbolic-ref', 'HEAD'],
      ['-C', ownPath, 'rev-parse', 'HEAD'],
    ]);
    expect(calls.some((args) => args.includes('add'))).toBe(false);
    expect(registry.current()).toEqual({
      '7': { path: ownPath, branch: LABEL, createdAt: NOW },
    });
  });

  test('a tree at THIS PR key’s target path on an OLD branch name is RECLAIMED — non-forced remove, create succeeds in the freed slot', async () => {
    const repoRoot = await realTmpDir('cq-wt-reclaim-');
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
        { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
        { path: targetPath, branch: 'old-pr-7-branch', head: SHA_A },
      ]);
      const result = await resolvePrWorktree(
        baseOpts(model, registry, { repoRoot, run: fakeGit(model, calls) }),
      );
      expect(result).toEqual({ path: targetPath, reused: false, branch: LABEL, foreign: [] });
      expect(registry.calls).toEqual(['load', 'update:7', 'update:7:null', 'update:7']);
      // The squatter was removed NON-FORCED and the create landed at the
      // same pr-keyed slot, at the fetched sha.
      expect(calls).toContainEqual(['-C', repoRoot, 'worktree', 'remove', targetPath]);
      expect(calls[calls.length - 3]).toEqual([
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
        { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
        { path: targetPath, branch: LABEL, head: SHA_B },
      ]);
    } finally {
      await rm(repoRoot, { recursive: true, force: true });
    }
  });

  test('a branch-matching stale tree OUTSIDE the root holds the branch — review ops never frees foreign trees: the create refuses and names the holder', async () => {
    const repoRoot = await realTmpDir('cq-wt-foreignstale-');
    try {
      const calls: string[][] = [];
      const registry = memRegistry();
      const model = mkModel([
        { path: `${REPO}`, branch: 'main', head: SHA_MAIN },
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
