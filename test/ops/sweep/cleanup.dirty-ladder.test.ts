// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// safety ladder (pinned contract item 2).
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
} from './cleanup.helpers.js';

// ---------------------------------------------------------------------------
// 2. The safety ladder
// ---------------------------------------------------------------------------

describe('sweep.cleanup the dirty ladder is explicit-only', () => {
  test('REQUIRED: dirty + no force → skippedDirty, no removal, and the branch is never deleted', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.mtimes.set(WT_PATH, NOW - 60_000);
    repo.branchTimes.set(WT_BRANCH, NOW - 60_000);
    // Not in `clean`: porcelain non-empty semantics.
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(report.skippedDirty).toEqual([
      {
        path: WT_PATH,
        reason: match.stringMatching(/never removed without explicit --force/),
      },
    ]);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
    expect(report.branchesRemoved).toEqual([]);
  });

  test('dirty + force (dryRun:false) → removed, and ONLY then does the force flag reach the adapter', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.mtimes.set(WT_PATH, NOW - 60_000);
    repo.branchTimes.set(WT_BRANCH, NOW - 60_000);
    const report = await okReport(makeCleanup(effectsOf(repo)), {
      ...INPUT,
      dryRun: false,
      force: true,
    });
    expect(report.removed).toEqual([{ path: WT_PATH, branch: WT_BRANCH }]);
    expect(repo.removes).toEqual([{ repoRoot: REPO_ROOT, path: WT_PATH, force: true }]);
    expect(repo.branchDeletes).toEqual([{ repoRoot: REPO_ROOT, branch: WT_BRANCH }]);
  });

  test('force never removes a YOUNG tree and never widens the candidate set', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.mtimes.set(WT_PATH, NOW - 1_000); // younger than the 5s cutoff
    repo.branchTimes.set(WT_BRANCH, NOW - 60_000); // the tip is older than the dir
    const report = await okReport(makeCleanup(effectsOf(repo)), {
      ...INPUT,
      dryRun: false,
      force: true,
    });
    expect(report.removed).toEqual([]);
    expect(report.kept).toEqual([expect.objectContaining({ path: WT_PATH })]);
    expect(repo.removes).toHaveLength(0);
  });
});
