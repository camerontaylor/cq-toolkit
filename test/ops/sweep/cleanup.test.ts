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
import { mkdtempSync, rmSync } from 'node:fs';
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
      if (mtime === undefined) throw new Error(`ENOENT: no mtime seeded for '${path}'`);
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
    branchTimeMs: async (repoRoot, branch) => {
      repo.calls.push(`branchTimeMs:${branch}`);
      const tip = repo.branchTimes.get(branch);
      if (tip === undefined) throw new Error(`branch '${branch}' has no committer date`);
      return tip;
    },
  };
}

/** Seed one aged clean candidate (the common fixture). */
function seedAgedClean(repo: FakeRepo, path = WT_PATH, branch = WT_BRANCH): void {
  repo.worktrees.push({ path, branch });
  repo.branches.push(branch);
  repo.mtimes.set(path, NOW - 60_000);
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

  test('a worktreeRemove fault (real run) is a failed result naming the tree', async () => {
    const repo = fakeRepo();
    seedAgedClean(repo);
    const effects: CleanupEffects = {
      ...effectsOf(repo),
      worktreeRemove: async () => {
        throw new Error('git worktree remove failed — contains modified files');
      },
    };
    const error = await failedAt(makeCleanup(effects), { ...INPUT, dryRun: false });
    expect(error).toMatch(/could not remove worktree/);
    expect(error).toContain(WT_PATH);
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
      'worktreeRemove',
    ]);
  });
});
