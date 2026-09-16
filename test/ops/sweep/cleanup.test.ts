// Sweep lane (WS-D, goal D2) — evidence for the age-based cleanup
// (src/ops/sweep/cleanup.ts; UC §1 row 13).
//
// Pinned here, on injected fake effects unless stated:
//   1. THE DRY-RUN DEFAULT: a bare invocation calls ZERO mutating effects
//      and reports the would-be outcome (removed/skippedDirty/branchesRemoved
//      are the WOULD-BE lists under dryRun true).
//   2. THE SAFETY LADDER (the goal's required assertion): no worktree is
//      ever removed while dirty except via explicit force — a dirty aged
//      tree is skipped without it, removed with it (and the branch of a
//      KEPT dirty tree is never deleted); clean trees never need force.
//   3. REMOVAL = worktreeRemove THEN branchDelete, and the force flag
//      reaches the adapter only on the explicit dirty path.
//   4. THE BOUNDARIES ARE HARD: a branch outside the run prefix or a path
//      outside worktreesDir is an untouchable kept row, with force or
//      without; branch-only prefix branches are aged by their tip and
//      deleted alone.
//   5. THE MUTEX: with the mutex configured, concurrent cleanups serialize
//      their mutating sections (differential proof — without it the same
//      slow removals overlap).
//   6. FAULTS: every effect fault is a `failed` result naming the tree —
//      never a throw across the op seam, never a fabricated ok.
//   7. THE BOUNDARY CONTRACT: every input defect is a single `failed`
//      result naming the field.
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import { makeCleanup, makeSubprocessCleanupEffects } from '../../../src/ops/sweep/cleanup.js';
import type {
  CleanupEffects,
  CleanupInput,
  CleanupReport,
} from '../../../src/ops/sweep/cleanup.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const REPO_ROOT = '/repo';
const DIR = '/runs/wt';
const PREFIX = 'cq/09-16a';
const OLDER_THAN_MS = 5_000;
const INPUT: CleanupInput = {
  repoRoot: REPO_ROOT,
  worktreesDir: DIR,
  runPrefix: PREFIX,
  olderThanMs: OLDER_THAN_MS,
};
const WT_PATH = '/runs/wt/fix/core';
const WT_BRANCH = 'cq/09-16a/fix/core';
const NOW = Date.now();

/** Unwraps an `ok` report; anything else fails the test with what came back. */
async function okReport(
  op: ReturnType<typeof makeCleanup>,
  input: CleanupInput,
): Promise<CleanupReport> {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

/** Unwraps a `failed` result's error; any other status fails the test. */
async function failedAt(op: ReturnType<typeof makeCleanup>, input: CleanupInput): Promise<string> {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}

// ---------------------------------------------------------------------------
// Fixture: recording fake effects
// ---------------------------------------------------------------------------

interface FakeRepo {
  worktrees: Array<{ path: string; branch?: string }>;
  branches: string[];
  /** seeded per absolute path: the mtime the age probe reports */
  mtimes: Map<string, number>;
  clean: Set<string>;
  /** seeded per branch name: the tip committer date the branch-age probe reports */
  branchTimes: Map<string, number>;
  calls: string[];
  removes: Array<{ repoRoot: string; path: string; force: boolean }>;
  branchDeletes: Array<{ repoRoot: string; branch: string }>;
  prunes: string[];
}

function fakeRepo(): FakeRepo {
  return {
    worktrees: [],
    branches: [],
    mtimes: new Map(),
    clean: new Set(),
    branchTimes: new Map(),
    calls: [],
    removes: [],
    branchDeletes: [],
    prunes: [],
  };
}

function effectsOf(repo: FakeRepo): CleanupEffects {
  return {
    listWorktrees: async () => {
      repo.calls.push('listWorktrees');
      return repo.worktrees.map((w) => ({ ...w }));
    },
    listBranches: async () => {
      repo.calls.push('listBranches');
      return [...repo.branches];
    },
    modifiedTimeMs: async (path) => {
      repo.calls.push(`modifiedTimeMs:${path}`);
      const mtime = repo.mtimes.get(path);
      if (mtime === undefined) {
        // The ABSENCE class carries the code, exactly like a real stat.
        const err = new Error(`ENOENT: no mtime seeded for '${path}'`) as Error & {
          code?: string;
        };
        err.code = 'ENOENT';
        throw err;
      }
      return mtime;
    },
    isStrictClean: async (path) => {
      repo.calls.push(`isStrictClean:${path}`);
      return repo.clean.has(path);
    },
    worktreeRemove: async (repoRoot, path, opts) => {
      repo.calls.push(`worktreeRemove:${path}`);
      repo.removes.push({ repoRoot, path, force: opts?.force === true });
    },
    branchDelete: async (repoRoot, branch) => {
      repo.calls.push(`branchDelete:${branch}`);
      repo.branchDeletes.push({ repoRoot, branch });
    },
    worktreePrune: async (repoRoot) => {
      repo.calls.push(`worktreePrune:${repoRoot}`);
      repo.prunes.push(repoRoot);
    },
    branchTimeMs: async (repoRoot, branch) => {
      repo.calls.push(`branchTimeMs:${branch}`);
      const tip = repo.branchTimes.get(branch);
      if (tip === undefined) throw new Error(`branch '${branch}' has no committer date`);
      return tip;
    },
  };
}

/** Seed one aged clean candidate (the common fixture; old dir, old tip). */
function seedAgedClean(repo: FakeRepo, path = WT_PATH, branch = WT_BRANCH): void {
  repo.worktrees.push({ path, branch });
  repo.branches.push(branch);
  repo.mtimes.set(path, NOW - 60_000);
  repo.branchTimes.set(branch, NOW - 60_000);
  repo.clean.add(path);
}

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
    expect(report.pruned).toEqual([{ path: WT_PATH, branch: WT_BRANCH }]);
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
    expect(report.pruned).toEqual([{ path: WT_PATH, branch: WT_BRANCH }]);
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
    expect(report.pruned).toEqual([{ path: WT_PATH, branch: WT_BRANCH }]);
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
});

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

// ---------------------------------------------------------------------------
// 4. The mutex wrap (differential, the worktreeFor.test.ts pattern)
// ---------------------------------------------------------------------------

describe('sweep.cleanup mutex wrap (UC row 32)', () => {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  test('with the mutex configured, concurrent removals serialize their mutating sections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-mutex-'));
    try {
      const lockPath = join(dir, 'git-mutex.lock');
      let inside = 0;
      let overlapped = false;
      let maxInside = 0;
      const slowEffects = (repo: FakeRepo): CleanupEffects => ({
        ...effectsOf(repo),
        worktreeRemove: async (repoRoot, path, opts) => {
          repo.calls.push(`worktreeRemove:${path}`);
          repo.removes.push({ repoRoot, path, force: opts?.force === true });
          inside += 1;
          if (inside > 1) overlapped = true; // the wrap assertion itself
          maxInside = Math.max(maxInside, inside);
          await sleep(50);
          inside -= 1;
        },
      });
      const mutex = { lockPath, staleMs: 2_000, retries: 50, retryBaseMs: 10 };
      const repoA = fakeRepo();
      seedAgedClean(repoA);
      const repoB = fakeRepo();
      seedAgedClean(repoB, '/runs/wt/fix/cli', 'cq/09-16a/fix/cli');
      await Promise.all([
        makeCleanup(slowEffects(repoA))({ ...INPUT, mutex, dryRun: false }),
        makeCleanup(slowEffects(repoB))({ ...INPUT, mutex, dryRun: false }),
      ]);
      expect(overlapped).toBe(false);
      expect(maxInside).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  test('without the mutex the same concurrent removals overlap (differential proof)', async () => {
    let inside = 0;
    let maxInside = 0;
    const slowEffects = (repo: FakeRepo): CleanupEffects => ({
      ...effectsOf(repo),
      worktreeRemove: async (repoRoot, path, opts) => {
        repo.removes.push({ repoRoot, path, force: opts?.force === true });
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(50);
        inside -= 1;
      },
    });
    const repoA = fakeRepo();
    seedAgedClean(repoA);
    const repoB = fakeRepo();
    seedAgedClean(repoB, '/runs/wt/fix/cli', 'cq/09-16a/fix/cli');
    await Promise.all([
      makeCleanup(slowEffects(repoA))({ ...INPUT, dryRun: false }),
      makeCleanup(slowEffects(repoB))({ ...INPUT, dryRun: false }),
    ]);
    expect(maxInside).toBe(2);
  });
});

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

// ---------------------------------------------------------------------------
// 6. The boundary contract
// ---------------------------------------------------------------------------

describe('sweep.cleanup boundary', () => {
  test('REQUIRED: a null or primitive input is a failed result — the boundary guards the top level before any field read', async () => {
    const op = makeCleanup(effectsOf(fakeRepo()));
    const nullError = await failedAt(op, null as unknown as CleanupInput);
    expect(nullError).toMatch(/input must be an object/);
    const numberError = await failedAt(op, 42 as unknown as CleanupInput);
    expect(numberError).toMatch(/input must be an object/);
    const undefinedError = await failedAt(op, undefined as unknown as CleanupInput);
    expect(undefinedError).toMatch(/input must be an object/);
  });

  test('blank fields are refused', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(failedAt(makeCleanup(effects), { ...INPUT, repoRoot: '' })).resolves.toMatch(
      /repoRoot/,
    );
    await expect(failedAt(makeCleanup(effects), { ...INPUT, worktreesDir: '' })).resolves.toMatch(
      /worktreesDir/,
    );
    await expect(failedAt(makeCleanup(effects), { ...INPUT, runPrefix: '' })).resolves.toMatch(
      /runPrefix/,
    );
  });

  test('a dash-leading worktreesDir is refused — the removal path is a positional git argument', async () => {
    const error = await failedAt(makeCleanup(effectsOf(fakeRepo())), {
      ...INPUT,
      worktreesDir: '--upstream=x',
    });
    expect(error).toMatch(/worktreesDir/);
    expect(error).toMatch(/never a flag/);
  });

  test('a control character in repoRoot or worktreesDir is refused — the porcelain lists are line-oriented', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, repoRoot: '/re\npo' }),
    ).resolves.toMatch(/repoRoot .*control characters|control characters/);
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, worktreesDir: '/runs/wt\r' }),
    ).resolves.toMatch(/control characters/);
  });

  test('a hostile runPrefix is refused — it guards the only removable branch namespace', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, runPrefix: '../evil' }),
    ).resolves.toMatch(/runPrefix/);
    await expect(failedAt(makeCleanup(effects), { ...INPUT, runPrefix: 'a..b' })).resolves.toMatch(
      /refname|safe segments/,
    );
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, runPrefix: 'cq/foo.lock' }),
    ).resolves.toMatch(/runPrefix/);
    await expect(failedAt(makeCleanup(effects), { ...INPUT, runPrefix: '-cq' })).resolves.toMatch(
      /runPrefix/,
    );
  });

  test('olderThanMs must be a non-negative integer; dryRun and force must be booleans', async () => {
    const effects = effectsOf(fakeRepo());
    await expect(failedAt(makeCleanup(effects), { ...INPUT, olderThanMs: -1 })).resolves.toMatch(
      /olderThanMs/,
    );
    await expect(failedAt(makeCleanup(effects), { ...INPUT, olderThanMs: 1.5 })).resolves.toMatch(
      /olderThanMs/,
    );
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, dryRun: 'yes' } as unknown as CleanupInput),
    ).resolves.toMatch(/dryRun must be a boolean/);
    await expect(
      failedAt(makeCleanup(effects), { ...INPUT, force: 1 } as unknown as CleanupInput),
    ).resolves.toMatch(/force must be a boolean/);
  });

  test('the mutex config boundary: a null mutex and a below-floor staleMs are failed results', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    await expect(
      failedAt(makeCleanup(effectsOf(repo)), {
        ...INPUT,
        mutex: null,
      } as unknown as CleanupInput),
    ).resolves.toMatch(/mutex must be an object/);
    await expect(
      failedAt(makeCleanup(effectsOf(repo)), {
        ...INPUT,
        mutex: { lockPath: '/repo/.cq/git-mutex.lock', staleMs: 100 },
      }),
    ).resolves.toMatch(/mutex\.staleMs \(100\)/);
    expect(repo.removes).toHaveLength(0);
  });

  test('a well-formed mutex config passes the boundary and a dry run still reports', async () => {
    // The well-formed config reaches the REAL makeGitMutex — whose acquire
    // mkdir -p's the lock's parent — so the lockPath needs a real tmpdir.
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-mutex-ok-'));
    try {
      const repo = fakeRepo();
      seedAgedClean(repo);
      const report = await okReport(makeCleanup(effectsOf(repo)), {
        ...INPUT,
        mutex: { lockPath: join(dir, 'git-mutex.lock'), staleMs: 30_000 },
      });
      expect(report.dryRun).toBe(true);
      expect(repo.removes).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the real subprocess binding exposes every seam member (shape pin)', () => {
    const effects = makeSubprocessCleanupEffects('/repo');
    expect(Object.keys(effects).sort()).toEqual([
      'branchDelete',
      'branchTimeMs',
      'isStrictClean',
      'listBranches',
      'listWorktrees',
      'modifiedTimeMs',
      'worktreePrune',
      'worktreeRemove',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 8. The subprocess adapter against REAL git (the dirty-refusal backstop,
//    PR 156 r1 D)
// ---------------------------------------------------------------------------

describe('subprocess cleanup effects (real git smoke)', () => {
  // Same auto-maintenance suppression and BOUNDED RETRY as the
  // worktreeFor.test.ts real-git idiom: the assertions are never relaxed,
  // a stalled spawn retries instead.
  const GIT_CALL_TIMEOUT_MS = 6_000;
  const GIT_CALL_ATTEMPTS = 4;
  const run = (args: string[], cwd: string): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile(
        'git',
        ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
        { cwd, timeout: GIT_CALL_TIMEOUT_MS, killSignal: 'SIGKILL' },
        (error, stdout, stderr) => {
          if (error !== null) {
            reject(new Error(stderr.trim() || error.message));
            return;
          }
          resolve(stdout);
        },
      );
    });
  const resilient = async <T>(step: () => Promise<T>): Promise<T> => {
    let last: unknown;
    for (let attempt = 1; attempt <= GIT_CALL_ATTEMPTS; attempt++) {
      try {
        return await step();
      } catch (err) {
        last = err;
      }
    }
    throw last;
  };

  test('init → worktree add → dirty: plain remove REJECTED by git → --force succeeds → branchTimeMs parses → branch -D works', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cleanup-smoke-'));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      mkdirSync(join(dir, 'seed'), { recursive: true });
      writeFileSync(join(dir, 'seed', 'data.txt'), 'tracked');
      await resilient(() => run(['-C', dir, 'add', '.'], dir));
      await resilient(() => run(['-C', dir, 'commit', '-m', 'seed tracked content'], dir));
      const wtPath = join(dir, 'wt', 'fix', 'core');
      await resilient(() =>
        run(['-C', dir, 'worktree', 'add', '-b', 'cq/x/fix/core', wtPath, 'main'], dir),
      );
      // Dirty the tree (untracked file: porcelain non-empty).
      writeFileSync(join(wtPath, 'dirty.txt'), 'dirty');

      const effects = makeSubprocessCleanupEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });
      // THE BACKSTOP: git itself refuses a dirty plain removal — the
      // adapter builds NO --flag unless the op's explicit force reached it.
      await expect(resilient(() => effects.worktreeRemove(dir, wtPath))).rejects.toThrow(
        /contains modified or untracked/,
      );
      // --force is the explicit dirty path and succeeds.
      await resilient(() => effects.worktreeRemove(dir, wtPath, { force: true }));
      // The branch age parses as an integer ms (the H age-basis half).
      const tipMs = await resilient(() => effects.branchTimeMs(dir, 'cq/x/fix/core'));
      expect(Number.isInteger(tipMs)).toBe(true);
      expect(tipMs).toBeGreaterThan(0);
      // branch -D works AFTER the removal — no worktree holds the branch.
      await resilient(() => effects.branchDelete(dir, 'cq/x/fix/core'));
      // r2#2: the DELETED branch's for-each-ref output is EMPTY — the
      // adapter maps that to the ENOENT absence class the op keeps on.
      const goneErr = (await resilient(() =>
        effects.branchTimeMs(dir, 'cq/x/fix/core').then(
          () => null,
          (err: unknown) => err,
        ),
      )) as (Error & { code?: string }) | null;
      expect(goneErr).toBeInstanceOf(Error);
      expect(goneErr?.code).toBe('ENOENT');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
