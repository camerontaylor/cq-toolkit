// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject into
// worktreeFor.{reservation,reuse-create,baseline-cache,mutex,path-safety,parsers,git-fault,real-git}.test.ts;
// this module holds the fixtures they share and declares no tests.
//
// Sweep lane (WS-D, goal D1) — evidence for the worktree provider
// (src/ops/sweep/worktreeFor.ts; UC §1 rows 20, 23; R2 D2; I7).
//
// Pinned here, on injected fake effects unless stated:
//   1. RESERVATION (UC row 23): every occupied namespace — local worktree
//      on the derived path, local branch, remote branch, existing plain
//      directory — is a `failed` result NAMING the namespace; the op
//      refuses, it never mints fresh prefixes.
//   2. REUSE (UC row 20): a worktree at exactly the derived branch AND
//      path is reused only when STRICTLY clean (reused true, no add, no
//      prune); a dirty tree is REFUSED with the tree named — never
//      auto-cleaned, never silently skipped; a branch checked out at a
//      different path is an anomaly → collision.
//   3. CREATE: prune → add with the derived branch/path/base; reused false.
//   4. I7: a REUSED tree has its configured baseline cache dirs evicted
//      (rmDir) and listed; absent ones are not; create carries [].
//   5. THE MUTEX: with mutex configured, concurrent creates on one lockPath
//      serialize their mutating sections (differential proof — without the
//      mutex the same slow adds overlap); prune runs before add.
//   6. PATH SAFETY: kind/slug/runPrefix segments cannot traverse out of
//      worktreesDir or impersonate git flags.
//   7. THE SUBPROCESS ADAPTER: the porcelain / for-each-ref / ls-remote
//      parsers against captured fixtures, plus ONE fast real-git smoke
//      (init → worktree add → strict-clean → prune) — the adapters' only
//      process touch.
import { makeWorktreeFor } from '../../../src/adapters/git/worktreeFor.js';
import type { WorktreeEffects, WorktreeForInput } from '../../../src/adapters/git/worktreeFor.js';

// ---------------------------------------------------------------------------
// Fixtures: derived naming
// ---------------------------------------------------------------------------

export const REPO_ROOT = '/repo';
export const INPUT: WorktreeForInput = {
  repoRoot: REPO_ROOT,
  worktreesDir: '/runs/wt',
  runPrefix: 'cq/09-16a',
  kind: 'fix',
  slug: 'core',
  base: 'origin/main',
};
export const BRANCH = 'cq/09-16a/fix/core';
export const PATH = '/runs/wt/fix/core';

/** Unwraps an `ok` result; anything else fails the test with what came back. */
export async function okWorkspace(op: ReturnType<typeof makeWorktreeFor>, input: WorktreeForInput) {
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
  op: ReturnType<typeof makeWorktreeFor>,
  input: WorktreeForInput,
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
  remoteBranches: string[];
  dirs: Set<string>;
  clean: Set<string>;
  /** seeded per `${worktreePath}|${ref}`: the sha `revParse` reports */
  heads: Map<string, string>;
  /** seeded per absolute target path: the tracked files the effect reports */
  tracked: Map<string, string[]>;
  calls: string[];
  addCalls: Array<{ repoRoot: string; path: string; branch: string; base: string }>;
  prunes: string[];
  removed: string[];
}

export function fakeRepo(): FakeRepo {
  return {
    worktrees: [],
    branches: [],
    remoteBranches: [],
    dirs: new Set<string>(),
    clean: new Set<string>(),
    heads: new Map<string, string>(),
    tracked: new Map<string, string[]>(),
    calls: [],
    addCalls: [],
    prunes: [],
    removed: [],
  };
}

export function effectsOf(repo: FakeRepo): WorktreeEffects {
  return {
    listWorktrees: async () => {
      repo.calls.push('listWorktrees');
      return repo.worktrees.map((w) => ({ ...w }));
    },
    listBranches: async () => {
      repo.calls.push('listBranches');
      return [...repo.branches];
    },
    listRemoteBranches: async () => {
      repo.calls.push('listRemoteBranches');
      return [...repo.remoteBranches];
    },
    revParse: async (worktreePath, ref) => {
      repo.calls.push(`revParse:${worktreePath}|${ref}`);
      return repo.heads.get(`${worktreePath}|${ref}`) ?? `sha:${ref}`;
    },
    pathExists: async (p) => {
      repo.calls.push(`pathExists:${p}`);
      return repo.dirs.has(p);
    },
    trackedFilesUnder: async (worktreePath, relTarget) => {
      repo.calls.push(`trackedFilesUnder:${worktreePath}|${relTarget}`);
      return repo.tracked.get(relTarget) ?? [];
    },
    isStrictClean: async (p) => {
      repo.calls.push(`isStrictClean:${p}`);
      return repo.clean.has(p);
    },
    worktreeAdd: async (req) => {
      repo.calls.push('worktreeAdd');
      repo.addCalls.push({ ...req });
    },
    worktreePrune: async (root) => {
      repo.calls.push('worktreePrune');
      repo.prunes.push(root);
    },
    rmDir: async (p) => {
      repo.calls.push(`rmDir:${p}`);
      repo.removed.push(p);
    },
  };
}
