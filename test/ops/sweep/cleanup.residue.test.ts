// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// registered-but-missing residue, the branch-aware age basis and the in-lock
// revalidation (PR 156 r1: A, H, I).
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
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
// 3b. Registered-but-missing residue, branch-aware age, in-lock revalidation
//     (PR 156 r1: A, H, I)
// ---------------------------------------------------------------------------

describe('sweep.cleanup residue, branch-aware age, in-lock revalidation', () => {
  test('A: a REGISTERED-but-missing dir is pruned residue — ok result, other candidates still processed', async () => {
    const repo = fakeRepo();
    // The residue: registered with a branch, but NO dir and NO mtime — the
    // age probe hits the absence class. Its stale branch tip is YOUNG, so
    // the branch-only sweep probes it and leaves it in place.
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.branchTimes.set(WT_BRANCH, NOW - 1_000);
    // A healthy aged clean candidate that must still be processed.
    seedAgedClean(repo, '/runs/wt/fix/cli', 'cq/09-16a/fix/cli');
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.pruned).toEqual([
      {
        path: WT_PATH,
        branch: WT_BRANCH,
        reason: 'registration pruned (repo-global prune; locked registrations are skipped by git)',
      },
    ]);
    expect(repo.prunes).toEqual([REPO_ROOT]);
    // The healthy candidate was still removed.
    expect(report.removed).toEqual([{ path: '/runs/wt/fix/cli', branch: 'cq/09-16a/fix/cli' }]);
    // The residue's branch was NOT deleted here — it stays branch-only-
    // sweep eligible (below).
    expect(repo.branchDeletes.some((d) => d.branch === WT_BRANCH)).toBe(false);
  });

  test('A: the pruned residue branch stays branch-only-sweep eligible and is aged out in the same run', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.branchTimes.set(WT_BRANCH, NOW - 60_000); // the stale branch is old
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.pruned).toEqual([
      {
        path: WT_PATH,
        branch: WT_BRANCH,
        reason: 'registration pruned (repo-global prune; locked registrations are skipped by git)',
      },
    ]);
    // After the prune the branch has no worktree → the branch-only sweep
    // (which now sees it as worktree-less) deletes it.
    expect(report.branchesRemoved).toEqual([WT_BRANCH]);
    expect(repo.branchDeletes).toEqual([{ repoRoot: REPO_ROOT, branch: WT_BRANCH }]);
  });

  test('A: dry-run lists the pruned row as would-be and calls no mutator (prune included)', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.branchTimes.set(WT_BRANCH, NOW - 1_000); // young stale branch — probed, left alone
    const report = await okReport(makeCleanup(effectsOf(repo)), INPUT);
    expect(report.dryRun).toBe(true);
    expect(report.pruned).toEqual([
      {
        path: WT_PATH,
        branch: WT_BRANCH,
        reason: 'registration pruned (repo-global prune; locked registrations are skipped by git)',
      },
    ]);
    expect(repo.prunes).toHaveLength(0);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
  });

  test('A: a NON-absence stat fault on the age probe still fails the whole op', async () => {
    const repo = fakeRepo();
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      modifiedTimeMs: async () => {
        const err = new Error('EACCES: permission denied, stat') as Error & { code?: string };
        err.code = 'EACCES';
        throw err;
      },
    };
    const error = await failedAt(makeCleanup(effects), INPUT);
    expect(error).toMatch(/could not read the age of worktree/);
    expect(repo.prunes).toHaveLength(0);
  });

  test('H: an OLD dir with a FRESH tip commit is KEPT — the age basis includes branch activity', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    repo.mtimes.set(WT_PATH, NOW - 60_000); // the dir is old…
    repo.branchTimes.set(WT_BRANCH, NOW - 1_000); // …but the tip commit is fresh
    const report = await okReport(makeCleanup(effectsOf(repo)), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
    const keptRow = report.kept.find((k) => k.path === WT_PATH);
    expect(keptRow).toBeDefined();
    // The reason NAMES the recent commit activity — the thing branch -D
    // would have destroyed.
    expect(keptRow?.reason).toMatch(/recent commit/);
    expect(keptRow?.reason).toContain(WT_BRANCH);
  });

  test('I: a tree that goes DIRTY between probe and guard is not removed — the row names the revalidation', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    let cleanProbes = 0;
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      isStrictClean: async (path) => {
        cleanProbes += 1;
        repo.calls.push(`isStrictClean:${path}`);
        // First probe (classification): clean. Revalidation (inside the
        // guard): dirty — the state flipped.
        return cleanProbes === 1;
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(repo.removes).toHaveLength(0);
    expect(repo.branchDeletes).toHaveLength(0);
    expect(report.skippedDirty).toEqual([
      {
        path: WT_PATH,
        reason: match.stringMatching(/revalidated inside the mutex.*went dirty/s),
      },
    ]);
    // Both probes ran: classification + in-lock revalidation.
    expect(cleanProbes).toBe(2);
  });

  test('I: a dir that goes MISSING between probe and guard is not removed — kept, never stale-evidence removal', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    let mtimeProbes = 0;
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      modifiedTimeMs: async (path) => {
        mtimeProbes += 1;
        repo.calls.push(`modifiedTimeMs:${path}`);
        if (mtimeProbes === 1) return NOW - 60_000; // the classification probe: old
        const err = new Error(`ENOENT: gone before the guard '${path}'`) as Error & {
          code?: string;
        };
        err.code = 'ENOENT';
        throw err; // the revalidation probe: missing
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(repo.prunes).toHaveLength(0); // no prune inside revalidation either
    expect(repo.removes).toHaveLength(0);
    const keptRow = report.kept.find((k) => k.path === WT_PATH);
    expect(keptRow?.reason).toMatch(/revalidated inside the mutex/);
  });

  test('I: a tree that goes YOUNG between probe and guard is not removed', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    let mtimeProbes = 0;
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      modifiedTimeMs: async (path) => {
        mtimeProbes += 1;
        repo.calls.push(`modifiedTimeMs:${path}`);
        // First probe: old. Revalidation: touched — young again.
        return mtimeProbes === 1 ? NOW - 60_000 : NOW - 1_000;
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(report.removed).toEqual([]);
    expect(repo.removes).toHaveLength(0);
    const keptRow = report.kept.find((k) => k.path === WT_PATH);
    expect(keptRow?.reason).toMatch(/revalidated inside the mutex.*younger than the cutoff/s);
  });

  test('A: a residue dir that reappears inside the mutex is kept — the stale prune never runs', async () => {
    const repo = fakeRepo();
    // Registered with a branch, but NO dir at classification: residue. Its
    // stale branch tip is YOUNG, so the branch-only sweep probes it and
    // leaves it in place.
    repo.worktrees.push({ path: WT_PATH, branch: WT_BRANCH });
    repo.branches.push(WT_BRANCH);
    repo.branchTimes.set(WT_BRANCH, NOW - 1_000);
    let mtimeProbes = 0;
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      modifiedTimeMs: async (path) => {
        mtimeProbes += 1;
        repo.calls.push(`modifiedTimeMs:${path}`);
        if (mtimeProbes === 1) {
          // The classification probe: absent — the residue class.
          const err = new Error(`ENOENT: no dir yet '${path}'`) as Error & {
            code?: string;
          };
          err.code = 'ENOENT';
          throw err;
        }
        // The in-guard recheck: the dir is back — a concurrent worktreeFor
        // pruned the stale registration and recreated a LIVE tree here.
        return NOW - 60_000;
      },
    };
    const report = await okReport(makeCleanup(effects), { ...INPUT, dryRun: false });
    // No prune ran (it would have stripped the live tree's lock) and no row
    // was misreported as pruned.
    expect(mtimeProbes).toBe(2);
    expect(repo.prunes).toHaveLength(0);
    expect(report.pruned).toEqual([]);
    expect(repo.branchDeletes).toHaveLength(0);
    const keptRow = report.kept.find((k) => k.path === WT_PATH);
    expect(keptRow?.reason).toMatch(/revalidated inside the mutex.*reappeared/s);
  });
});
