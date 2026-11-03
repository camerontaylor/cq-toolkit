// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// stepwise completion, absent refs and in-lock association cases
// (PR 156 r2: 1, 2, 4a, jJrLJ).
import { describe, expect, test } from 'vitest';
import { makeCleanup } from '../../../src/adapters/git/cleanup.js';
import type { CleanupEffects } from '../../../src/adapters/git/cleanup.js';
import {
  INPUT,
  NOW,
  REPO_ROOT,
  WT_BRANCH,
  WT_PATH,
  effectsOf,
  failedAt,
  fakeRepo,
  okReport,
  seedAgedClean,
} from './cleanup.helpers.js';

// ---------------------------------------------------------------------------
// 3c. Stepwise completion, absent refs, prune faults, association flips
//     (PR 156 r2: 1, 2, 4a, jJrLJ)
// ---------------------------------------------------------------------------

describe('sweep.cleanup stepwise completion, absent refs, in-lock association', () => {
  test('r2#1: branchDelete faulting AFTER a successful removal — the error says exactly what happened', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      branchDelete: async () => {
        throw new Error('branch delete refused — ref lock held');
      },
    };
    const error = await failedAt(makeCleanup(effects), { ...INPUT, dryRun: false });
    // Exactly what happened: the removal succeeded, the delete faulted.
    expect(error).toMatch(
      new RegExp(`removed worktree '${WT_PATH}'; could not delete branch '${WT_BRANCH}'`),
    );
    expect(error).toMatch(/branch delete refused/);
    // …and the completed removal is in the progress note — never invisible.
    expect(error).toMatch(/completed before the fault/);
    expect(error).toContain(WT_PATH);
    expect(repo.removes).toEqual([{ repoRoot: REPO_ROOT, path: WT_PATH, force: false }]);
  });

  test('r2#2: a branchTimeMs ABSENCE (ref deleted concurrently) keeps the candidate — op ok', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      branchTimeMs: async (repoRoot, branch) => {
        if (branch === WT_BRANCH) {
          // The shipped adapter's absence class: EMPTY for-each-ref output.
          const err = new Error(`branch '${branch}' has no ref — it is already gone`) as Error & {
            code?: string;
          };
          err.code = 'ENOENT';
          throw err;
        }
        repo.calls.push(`branchTimeMs:${branch}`);
        return NOW - 60_000;
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
    const keptRow = report.kept.find((k) => k.path === WT_PATH);
    expect(keptRow?.reason).toMatch(/branch already gone/);
  });

  test('r2#2: an ABSENT branch-only ref is skipped silently — there is nothing left to delete', async () => {
    const repo = fakeRepo();
    repo.branches.push('cq/09-16a/fix/gone');
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      branchTimeMs: async (repoRoot, branch) => {
        const err = new Error(`branch '${branch}' has no ref — it is already gone`) as Error & {
          code?: string;
        };
        err.code = 'ENOENT';
        throw err;
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(report.branchesRemoved).toEqual([]);
    expect(repo.branchDeletes).toHaveLength(0);
  });

  test('r2#4a: a worktreePrune fault on the residue path is a failed result naming the residue', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      worktreePrune: async () => {
        throw new Error('git worktree prune failed — index.lock wedged');
      },
    };
    const error = await failedAt(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(error).toMatch(/could not prune the stale registration/);
    expect(error).toContain(WT_PATH);
    expect(error).toContain('index.lock wedged');
  });

  test('jJrLJ: a branch that CHANGED at the path under the mutex → kept, zero removals', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    let listCalls = 0;
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      listWorktrees: async () => {
        listCalls += 1;
        repo.calls.push('listWorktrees');
        // First listing (classification): the candidate under the prefix.
        // The in-lock re-list: a worker switched the branch at the path —
        // it may now host a branch OUTSIDE the run prefix.
        return listCalls === 1
          ? [{ path: WT_PATH, branch: WT_BRANCH }]
          : [{ path: WT_PATH, branch: 'someone/elses/branch' }];
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
    const keptRow = report.kept.find((k) => k.path === WT_PATH);
    expect(keptRow?.reason).toMatch(/branch changed under the mutex/);
    expect(keptRow?.reason).toMatch(/never removed on stale evidence/);
  });

  test('jJrLJ: a path no longer REGISTERED under the mutex → kept, zero removals', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    let listCalls = 0;
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      listWorktrees: async () => {
        listCalls += 1;
        repo.calls.push('listWorktrees');
        return listCalls === 1 ? [{ path: WT_PATH, branch: WT_BRANCH }] : [];
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(repo.removes).toHaveLength(0);
    const keptRow = report.kept.find((k) => k.path === WT_PATH);
    expect(keptRow?.reason).toMatch(/no longer a registered worktree/);
  });
});
