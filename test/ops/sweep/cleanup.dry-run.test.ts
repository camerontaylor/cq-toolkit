// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// dry-run default (pinned contract item 1; the full contract header lives in
// cleanup.helpers.ts).
import { describe, expect, test } from 'vitest';
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
// 1. The dry-run default
// ---------------------------------------------------------------------------

describe('sweep.cleanup dry-run default (UC row 13)', () => {
  test('REQUIRED: a bare input calls ZERO mutating effects and reports the would-be removal', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    const report = await okReport(makeCleanup(effectsOf(repo)), INPUT);
    expect(report.dryRun).toBe(true);
    expect(report.removed).toEqual([{ path: WT_PATH, branch: WT_BRANCH }]);
    expect(report.branchesRemoved).toEqual([WT_BRANCH]);
    // The mutators never ran.
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
    // The probes did.
    expect(repo.calls).toContain(`modifiedTimeMs:${WT_PATH}`);
    expect(repo.calls).toContain(`isStrictClean:${WT_PATH}`);
  });

  test('dry-run with force still mutates nothing — the dirty tree only appears as would-be removed', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.mtimes.set(WT_PATH, NOW - 60_000);
    repo.branchTimes.set(WT_BRANCH, NOW - 60_000);
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, force: true });
    expect(report.dryRun).toBe(true);
    expect(report.removed).toEqual([{ path: WT_PATH, branch: WT_BRANCH }]);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
  });

  test('an explicit dryRun:false performs the removals', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.dryRun).toBe(false);
    expect(repo.removes).toEqual([{ repoRoot: REPO_ROOT, path: WT_PATH, force: false }]);
    expect(repo.branchDeletes).toEqual([{ repoRoot: REPO_ROOT, branch: WT_BRANCH }]);
  });
});
