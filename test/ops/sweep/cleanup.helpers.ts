// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory (dry-run, dirty-ladder,
// ordering, residue, stepwise, mutex, faults, boundary, subprocess). This
// module holds the shared fixture surface and the pinned contract header.
//
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
import { makeCleanup } from '../../../src/adapters/git/cleanup.js';
import type {
  CleanupEffects,
  CleanupInput,
  CleanupReport,
} from '../../../src/adapters/git/cleanup.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

export const REPO_ROOT = '/repo';
const DIR = '/runs/wt';
const PREFIX = 'cq/09-16a';
const OLDER_THAN_MS = 5_000;
export const INPUT: CleanupInput = {
  repoRoot: REPO_ROOT,
  worktreesDir: DIR,
  runPrefix: PREFIX,
  olderThanMs: OLDER_THAN_MS,
};
export const WT_PATH = '/runs/wt/fix/core';
export const WT_BRANCH = 'cq/09-16a/fix/core';
export const NOW = Date.now();

/** Unwraps an `ok` report; anything else fails the test with what came back. */
export async function okReport(
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
export async function failedAt(
  op: ReturnType<typeof makeCleanup>,
  input: CleanupInput,
): Promise<string> {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}

// ---------------------------------------------------------------------------
// Fixture: recording fake effects
// ---------------------------------------------------------------------------

export interface FakeRepo {
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

export function fakeRepo(): FakeRepo {
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

export function effectsOf(repo: FakeRepo): CleanupEffects {
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
export function seedAgedClean(repo: FakeRepo, path = WT_PATH, branch = WT_BRANCH): void {
  repo.worktrees.push({ path, branch });
  repo.branches.push(branch);
  repo.mtimes.set(path, NOW - 60_000);
  repo.branchTimes.set(branch, NOW - 60_000);
  repo.clean.add(path);
}
