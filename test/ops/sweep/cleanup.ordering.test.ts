// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// removal ordering, kept accounting and the branch-only sweep (pinned
// contract items 3 and 4).
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import { makeCleanup } from '../../../src/adapters/git/cleanup.js';
import {
  INPUT,
  NOW,
  REPO_ROOT,
  WT_BRANCH,
  WT_PATH,
  effectsOf,
  fakeRepo,
  okReport,
  seedAgedClean,
} from './cleanup.helpers.js';

// ---------------------------------------------------------------------------
// 3. Ordering, kept accounting, branch-only sweep
// ---------------------------------------------------------------------------

describe('sweep.cleanup removal ordering and kept accounting', () => {
  test('clean + old → worktreeRemove runs BEFORE branchDelete', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    const removeAt = repo.calls.indexOf(`worktreeRemove:${WT_PATH}`);
    const deleteAt = repo.calls.indexOf(`branchDelete:${WT_BRANCH}`);
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(deleteAt).toBeGreaterThan(removeAt);
  });

  test('a YOUNG tree is kept; the primary checkout and out-of-scope trees are kept untouchable', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    repo.worktrees.push({ path: '/repo', branch: 'main' }); // the primary checkout
    repo.branches.push('main');
    repo.mtimes.set(WT_PATH, NOW - 1_000);
    repo.worktrees.push({
      path: '/elsewhere/cq/09-16a/fix/cli',
      branch: WT_BRANCH.replace('core', 'cli'),
    });
    repo.worktrees.push({ path: '/runs/wt/fix/other', branch: 'feature/not-mine' });
    const report = await okReport(makeCleanup(effectsOf(repo)), INPUT);
    expect(report.kept).toEqual([
      { path: WT_PATH, reason: match.stringMatching(/younger than the cutoff/) },
      {
        path: '/repo',
        reason: match.stringMatching(/outside the run prefix .*outside worktreesDir/s),
      },
      {
        path: '/elsewhere/cq/09-16a/fix/cli',
        reason: match.stringMatching(/outside worktreesDir/),
      },
      { path: '/runs/wt/fix/other', reason: match.stringMatching(/outside the run prefix/) },
    ]);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
  });

  test('branch-only: an aged prefix branch with no worktree is deleted alone', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    repo.branches.push('cq/09-16a/fix/gone');
    repo.branchTimes.set('cq/09-16a/fix/gone', NOW - 60_000);
    repo.branches.push('feature/not-mine'); // outside the prefix — untouchable
    repo.branches.push('cq/09-16a/fix/young');
    repo.branchTimes.set('cq/09-16a/fix/young', NOW - 1_000); // young — left in place
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.branchesRemoved).toEqual([WT_BRANCH, 'cq/09-16a/fix/gone']);
    expect(repo.removes).toEqual([{ repoRoot: REPO_ROOT, path: WT_PATH, force: false }]);
    expect(repo.branchDeletes).toEqual([
      { repoRoot: REPO_ROOT, branch: WT_BRANCH },
      { repoRoot: REPO_ROOT, branch: 'cq/09-16a/fix/gone' },
    ]);
    // The branch of a KEPT (here: removed-later? no — the young one) tree is untouched.
    expect(repo.branchDeletes.some((d) => d.branch === 'cq/09-16a/fix/young')).toBe(false);
  });

  test('a prefix branch whose worktree is KEPT is never branch-deleted by the branch-only sweep', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.mtimes.set(WT_PATH, NOW - 60_000); // aged…
    repo.branchTimes.set(WT_BRANCH, NOW - 60_000); // …and the tip is old too
    // …but dirty → skipped; the branch must survive with its tree.
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.skippedDirty).toHaveLength(1);
    expect(report.branchesRemoved).toEqual([]);
    expect(repo.branchDeletes).toHaveLength(0);
    expect(repo.removes).toHaveLength(0);
  });

  test('a branch matching the prefix only as a STRING prefix (cq/09-16a-x) is untouchable', async () => {
    const repo = fakeRepo();
    repo.branches.push('cq/09-16a-x/fix/core'); // sibling prefix, not <prefix>/…
    repo.branchTimes.set('cq/09-16a-x/fix/core', NOW - 60_000);
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.branchesRemoved).toEqual([]);
    expect(repo.branchDeletes).toHaveLength(0);
  });
});
