// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// fault paths (pinned contract item 6).
import { describe, expect, test } from 'vitest';
import { makeCleanup } from '../../../src/adapters/git/cleanup.js';
import type { CleanupEffects } from '../../../src/adapters/git/cleanup.js';
import {
  INPUT,
  NOW,
  WT_BRANCH,
  WT_PATH,
  effectsOf,
  failedAt,
  fakeRepo,
  seedAgedClean,
} from './cleanup.helpers.js';

// ---------------------------------------------------------------------------
// 5. Fault paths
// ---------------------------------------------------------------------------

describe('sweep.cleanup fault paths', () => {
  test('a listing fault is a failed result naming the effect', async () => {
    const effects: CleanupEffects = {
      ...effectsOf(fakeRepo()),
      listWorktrees: async () => {
        throw new Error('git exploded');
      },
    };
    const error = await failedAt(makeCleanup(effects), INPUT);
    expect(error).toMatch(/could not list local worktrees/);
    expect(error).toContain('git exploded');
  });

  test('a branch-listing fault is a failed result', async () => {
    const effects: CleanupEffects = {
      ...effectsOf(fakeRepo()),
      listBranches: async () => {
        throw new Error('for-each-ref died');
      },
    };
    const error = await failedAt(makeCleanup(effects), INPUT);
    expect(error).toMatch(/could not list local branches/);
  });

  test('an age-probe fault is a failed result naming the tree — never a silent skip', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      modifiedTimeMs: async () => {
        throw new Error('EACCES: permission denied, stat');
      },
    };
    const error = await failedAt(makeCleanup(effects), INPUT);
    expect(error).toMatch(/could not read the age of worktree/);
    expect(error).toContain(WT_PATH);
    expect(repo.removes).toHaveLength(0);
  });

  test('a clean-probe fault on an aged tree is a failed result — never a removal', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      isStrictClean: async () => {
        throw new Error('git status failed');
      },
    };
    const error = await failedAt(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(error).toMatch(/could not check .* strictly clean/);
    expect(repo.removes).toHaveLength(0);
  });

  test('a worktreeRemove fault (real run) is a failed result naming the tree AND the removals already completed', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo); // the FIRST candidate — removed successfully
    seedAgedClean(repo, '/runs/wt/fix/cli', 'cq/09-16a/fix/cli'); // the SECOND — faults
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      worktreeRemove: async (repoRoot, path, opts) => {
        if (path === '/runs/wt/fix/cli') {
          throw new Error('git worktree remove failed — contains modified files');
        }
        repo.calls.push(`worktreeRemove:${path}`);
        repo.removes.push({ repoRoot, path, force: opts?.force === true });
      },
    };
    const error = await failedAt(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(error).toMatch(/could not remove worktree/);
    expect(error).toContain('/runs/wt/fix/cli');
    // B: the already-completed removal is appended to the error — completed
    // work is never invisible.
    expect(error).toMatch(/completed before the fault/);
    expect(error).toContain(WT_PATH);
    expect(error).toContain(WT_BRANCH);
  });

  test('a branch-age fault is a failed result naming the branch', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    repo.branches.push('cq/09-16a/fix/gone');
    // branchTimes deliberately unseeded → the fake throws.
    const error = await failedAt(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(error).toMatch(/could not read the age of branch/);
    expect(error).toContain('cq/09-16a/fix/gone');
    // The aged clean candidate WAS removed before the fault (earlier
    // candidate, same real run); the faulting branch itself is not deleted.
    expect(error).toMatch(/completed before the fault/);
    expect(error).toContain(WT_PATH);
    expect(repo.removes).toEqual([{ repoRoot: '/repo', path: WT_PATH, force: false }]);
    expect(repo.branchDeletes.some((d) => d.branch === 'cq/09-16a/fix/gone')).toBe(false);
  });

  test('a branchDelete fault on the branch-only sweep is a failed result naming the branch', async () => {
    const repo = fakeRepo();
    repo.branches.push('cq/09-16a/fix/gone');
    repo.branchTimes.set('cq/09-16a/fix/gone', NOW - 60_000);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      branchDelete: async (repoRoot, branch) => {
        if (branch === 'cq/09-16a/fix/gone') throw new Error('branch delete refused');
        repo.calls.push(`branchDelete:${branch}`);
        repo.branchDeletes.push({ repoRoot, branch });
      },
    };
    const error = await failedAt(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(error).toMatch(/could not delete branch/);
    expect(error).toContain('cq/09-16a/fix/gone');
  });
});
