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
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  makeSubprocessWorktreeEffects,
  makeWorktreeFor,
  parseBranchRefs,
  parseRemoteHeads,
  parseWorktreePorcelain,
} from '../../../src/ops/sweep/worktreeFor.js';
import type { WorktreeEffects, WorktreeForInput } from '../../../src/ops/sweep/worktreeFor.js';

// ---------------------------------------------------------------------------
// Fixtures: derived naming
// ---------------------------------------------------------------------------

const REPO_ROOT = '/repo';
const INPUT: WorktreeForInput = {
  repoRoot: REPO_ROOT,
  worktreesDir: '/runs/wt',
  runPrefix: 'cq/09-16a',
  kind: 'fix',
  slug: 'core',
  base: 'origin/main',
};
const BRANCH = 'cq/09-16a/fix/core';
const PATH = '/runs/wt/fix/core';

/** Unwraps an `ok` result; anything else fails the test with what came back. */
async function okWorkspace(op: ReturnType<typeof makeWorktreeFor>, input: WorktreeForInput) {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

/** Unwraps a `failed` result's error; any other status fails the test. */
async function failedAt(
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

interface FakeRepo {
  worktrees: Array<{ path: string; branch?: string }>;
  branches: string[];
  remoteBranches: string[];
  dirs: Set<string>;
  clean: Set<string>;
  calls: string[];
  addCalls: Array<{ repoRoot: string; path: string; branch: string; base: string }>;
  prunes: string[];
  removed: string[];
}

function fakeRepo(): FakeRepo {
  return {
    worktrees: [],
    branches: [],
    remoteBranches: [],
    dirs: new Set<string>(),
    clean: new Set<string>(),
    calls: [],
    addCalls: [],
    prunes: [],
    removed: [],
  };
}

function effectsOf(repo: FakeRepo): WorktreeEffects {
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
    pathExists: async (p) => {
      repo.calls.push(`pathExists:${p}`);
      return repo.dirs.has(p);
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

// ---------------------------------------------------------------------------
// 1–3. Reservation, reuse, create
// ---------------------------------------------------------------------------

describe('sweep.worktreeFor reservation (UC row 23)', () => {
  test('a local worktree occupying the derived path collides — the namespace is named', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: 'other/branch' }];
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(error).toMatch(/path namespace collision/);
    expect(error).toContain(PATH);
    expect(repo.addCalls).toHaveLength(0);
  });

  test('a local branch on the derived name collides — branch namespace named', async () => {
    const repo = fakeRepo();
    repo.branches = ['main', BRANCH];
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(error).toMatch(/already exists as a local branch/);
    expect(error).toMatch(/branch namespace collision/);
    expect(error).toContain(BRANCH);
  });

  test('a remote branch on the derived name collides — remote namespace named', async () => {
    const repo = fakeRepo();
    repo.remoteBranches = [BRANCH];
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(error).toMatch(/already exists on the remote/);
    expect(error).toMatch(/remote branch namespace collision/);
  });

  test('a missing origin remote is a vacuously empty namespace — the create proceeds', async () => {
    const repo = fakeRepo();
    const effects: WorktreeEffects = {
      ...effectsOf(repo),
      listRemoteBranches: async () => {
        throw new Error('git ls-remote failed — error: No such remote origin');
      },
    };
    const workspace = await okWorkspace(makeWorktreeFor(effects), INPUT);
    expect(workspace.reused).toBe(false);
    expect(repo.addCalls).toHaveLength(1);
  });

  test('a broken repo surface in the remote listing is a failed result, not an empty namespace', async () => {
    const repo = fakeRepo();
    const effects: WorktreeEffects = {
      ...effectsOf(repo),
      listRemoteBranches: async () => {
        throw new Error(
          'git ls-remote failed — fatal: not a git repository (or any of the parent directories): .git',
        );
      },
    };
    const error = await failedAt(makeWorktreeFor(effects), INPUT);
    expect(error).toMatch(/could not list remote branches/);
    expect(error).toMatch(/not a git repository/);
    expect(repo.addCalls).toHaveLength(0);
  });

  test('an existing plain directory at the derived path collides — path namespace named', async () => {
    const repo = fakeRepo();
    repo.dirs.add(PATH);
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(error).toMatch(/already exists as a directory/);
    expect(error).toMatch(/path namespace collision/);
  });

  test('the derived branch checked out at a DIFFERENT path is an anomaly → collision, not reuse', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: '/elsewhere/fix/core', branch: BRANCH }];
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(error).toMatch(/path namespace collision/);
    expect(error).toContain('/elsewhere/fix/core');
    expect(error).toContain(PATH);
  });
});

describe('sweep.worktreeFor reuse (UC row 20)', () => {
  test('a strictly-clean tree at the exact derived branch and path is reused: no add, no prune', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(workspace).toEqual({
      path: PATH,
      branch: BRANCH,
      requestedBase: 'origin/main',
      reused: true,
      clearedBaselineCaches: [],
      refusedBaselineCaches: [],
    });
    expect(repo.addCalls).toHaveLength(0);
    expect(repo.prunes).toHaveLength(0);
  });

  test('a DIRTY reused candidate is REFUSED with the tree named — never auto-cleaned', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.delete(PATH); // `git status --porcelain` non-empty semantics
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(error).toMatch(/dirty/);
    expect(error).toContain(PATH);
    // Refusal is total: no mutating effect may run against a dirty tree.
    expect(repo.addCalls).toHaveLength(0);
    expect(repo.prunes).toHaveLength(0);
    expect(repo.removed).toHaveLength(0);
  });
});

describe('sweep.worktreeFor create', () => {
  test('an empty namespace creates: worktreeAdd with the derived branch and path, reused false', async () => {
    const repo = fakeRepo();
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(workspace).toEqual({
      path: PATH,
      branch: BRANCH,
      requestedBase: 'origin/main',
      reused: false,
      clearedBaselineCaches: [],
      refusedBaselineCaches: [],
    });
    expect(repo.addCalls).toEqual([
      { repoRoot: REPO_ROOT, path: PATH, branch: BRANCH, base: 'origin/main' },
    ]);
    // Prune (stale registrations) precedes the add in the same section.
    expect(repo.prunes).toEqual([REPO_ROOT]);
    expect(repo.calls.indexOf('worktreePrune')).toBeLessThan(repo.calls.indexOf('worktreeAdd'));
  });

  test('an effects fault is a failed result naming the effect — never a throw across the op seam', async () => {
    const effects: WorktreeEffects = {
      ...effectsOf(fakeRepo()),
      listWorktrees: async () => {
        throw new Error('git exploded');
      },
    };
    const error = await failedAt(makeWorktreeFor(effects), INPUT);
    expect(error).toMatch(/could not list local worktrees/);
    expect(error).toContain('git exploded');
  });
});

// ---------------------------------------------------------------------------
// 4. I7 — the baseline is never cached on reuse
// ---------------------------------------------------------------------------

describe('sweep.worktreeFor baseline-cache eviction (I7)', () => {
  const CACHES = ['.cq/baseline', 'node_modules/.cache/probe'];

  test('reuse removes the configured cache dirs present in the tree and lists them', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    repo.dirs.add(`${PATH}/.cq/baseline`); // present…
    // …`node_modules/.cache/probe` absent: it must not be removed nor listed.
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: CACHES,
    });
    expect(workspace.reused).toBe(true);
    expect(workspace.clearedBaselineCaches).toEqual(['.cq/baseline']);
    expect(repo.removed).toEqual([`${PATH}/.cq/baseline`]);
  });

  test('reuse with no cache dirs present lists an empty eviction', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: CACHES,
    });
    expect(workspace.clearedBaselineCaches).toEqual([]);
    expect(repo.removed).toHaveLength(0);
  });

  test('the create path never evicts: clearedBaselineCaches is [] even when configured', async () => {
    const repo = fakeRepo();
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: CACHES,
    });
    expect(workspace.reused).toBe(false);
    expect(workspace.clearedBaselineCaches).toEqual([]);
    expect(repo.removed).toHaveLength(0);
  });

  test('containment: traversal, dot, absolute, and prefix-trap entries are refused — never touched on disk', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const hostile = ['../outside', '.', '/etc/tool-cache', '../wt-sibling/cache'];
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: hostile,
    });
    // Every hostile entry lands in the refused field, nothing is removed…
    expect(workspace.refusedBaselineCaches).toEqual(hostile);
    expect(workspace.clearedBaselineCaches).toEqual([]);
    expect(repo.removed).toHaveLength(0);
    // …and the refusal is total: not even an existence probe runs outside.
    expect(repo.calls.some((call) => call.startsWith('pathExists:'))).toBe(false);
  });

  test('containment spares nothing legitimate: a real subdir is still evicted alongside refusals', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    repo.dirs.add(`${PATH}/.cq/baseline`);
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: ['.cq/baseline', '../outside'],
    });
    expect(workspace.clearedBaselineCaches).toEqual(['.cq/baseline']);
    expect(workspace.refusedBaselineCaches).toEqual(['../outside']);
    expect(repo.removed).toEqual([`${PATH}/.cq/baseline`]);
  });

  test('an intermediate SYMLINK refuses the entry; a FINAL-segment symlink is unlinked, not followed', async () => {
    // REAL fs: the intermediate-symlink guard lstats actual segments and the
    // rmDir effect below performs real deletions.
    const dir = mkdtempSync(join(tmpdir(), 'worktree-evict-'));
    try {
      const wt = join(dir, 'wt', 'fix', 'core'); // the derived path for this input
      mkdirSync(wt, { recursive: true });
      mkdirSync(join(dir, 'outside'));
      writeFileSync(join(dir, 'outside', 'keep.txt'), 'keep');
      symlinkSync(join(dir, 'outside'), join(wt, '.cq')); // intermediate symlink
      symlinkSync(join(dir, 'outside'), join(wt, 'cache-link')); // FINAL-segment symlink
      // The op evicts under the CANONICAL tree path (realpath'd prefix), so
      // the fake existence probe must know that form too.
      const canonicalWt = realpathSync(wt);
      const repo = fakeRepo();
      repo.worktrees = [{ path: wt, branch: BRANCH }];
      repo.clean.add(wt);
      repo.dirs.add(join(canonicalWt, 'cache-link'));
      const effects: WorktreeEffects = {
        ...effectsOf(repo),
        rmDir: async (p) => {
          repo.calls.push(`rmDir:${p}`);
          repo.removed.push(p);
          await rm(p, { recursive: true, force: true });
        },
      };
      const workspace = await okWorkspace(makeWorktreeFor(effects), {
        ...INPUT,
        repoRoot: dir,
        worktreesDir: join(dir, 'wt'),
        baselineCacheDirs: ['.cq/baseline', 'cache-link'],
      });
      // The symlinked intermediate refuses the entry — nothing deleted through it.
      expect(workspace.refusedBaselineCaches).toEqual(['.cq/baseline']);
      expect(repo.removed.some((p) => p.includes('.cq'))).toBe(false);
      // The final-segment symlink is unlinked ITSELF; the target survives.
      expect(workspace.clearedBaselineCaches).toEqual(['cache-link']);
      expect(repo.removed).toEqual([join(canonicalWt, 'cache-link')]);
      expect(existsSync(join(dir, 'outside', 'keep.txt'))).toBe(true);
      expect(existsSync(join(wt, 'cache-link'))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 5. The git-mutex wrap
// ---------------------------------------------------------------------------

describe('sweep.worktreeFor mutex wrap (UC row 32)', () => {
  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  test('with the mutex configured, concurrent creates serialize their mutating sections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-mutex-'));
    try {
      const lockPath = join(dir, 'git-mutex.lock');
      let inside = 0;
      let overlapped = false;
      let maxInside = 0;
      const slowEffects = (repo: FakeRepo): WorktreeEffects => ({
        ...effectsOf(repo),
        worktreeAdd: async (req) => {
          repo.calls.push('worktreeAdd');
          repo.addCalls.push({ ...req });
          inside += 1;
          if (inside > 1) overlapped = true; // the wrap assertion itself
          maxInside = Math.max(maxInside, inside);
          await sleep(50);
          inside -= 1;
        },
      });
      const mutex = { lockPath, staleMs: 2_000, retries: 50, retryBaseMs: 10 };
      const opA = makeWorktreeFor(slowEffects(fakeRepo()));
      const opB = makeWorktreeFor(slowEffects(fakeRepo()));
      await Promise.all([opA({ ...INPUT, mutex }), opB({ ...INPUT, slug: 'cli', mutex })]);
      expect(overlapped).toBe(false);
      expect(maxInside).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('without the mutex the same concurrent adds overlap (differential proof)', async () => {
    let inside = 0;
    let maxInside = 0;
    const slowEffects = (repo: FakeRepo): WorktreeEffects => ({
      ...effectsOf(repo),
      worktreeAdd: async (req) => {
        repo.addCalls.push({ ...req });
        inside += 1;
        maxInside = Math.max(maxInside, inside);
        await sleep(50);
        inside -= 1;
      },
    });
    const opA = makeWorktreeFor(slowEffects(fakeRepo()));
    const opB = makeWorktreeFor(slowEffects(fakeRepo()));
    await Promise.all([opA(INPUT), opB({ ...INPUT, slug: 'cli' })]);
    expect(maxInside).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 6. Path safety
// ---------------------------------------------------------------------------

describe('sweep.worktreeFor path safety', () => {
  test('a slug traversing out of worktreesDir is refused', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, slug: '../evil' });
    expect(error).toMatch(/slug/);
    expect(error).toMatch(/traversal/);
  });

  test('a kind with a separator is refused', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, kind: 'a/b' });
    expect(error).toMatch(/kind/);
  });

  test('a runPrefix with a traversing segment is refused; nested safe segments are fine', async () => {
    const repo = fakeRepo();
    await expect(
      failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, runPrefix: 'cq/../x' }),
    ).resolves.toMatch(/runPrefix/);
    // The fixture's own runPrefix ('cq/09-16a') nests and is accepted.
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(workspace.branch).toBe(BRANCH);
  });

  test('a flag-impersonating base is refused; blank fields are refused', async () => {
    const repo = fakeRepo();
    await expect(
      failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, base: '--exec' }),
    ).resolves.toMatch(/base/);
    await expect(
      failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, repoRoot: '' }),
    ).resolves.toMatch(/repoRoot/);
    await expect(
      failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, slug: '' }),
    ).resolves.toMatch(/slug/);
  });

  test('a flag-impersonating worktreesDir is refused — the derived path is a positional git argument', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      worktreesDir: '--upstream=x',
    });
    expect(error).toMatch(/worktreesDir/);
    expect(error).toMatch(/never a flag/);
    expect(repo.addCalls).toHaveLength(0);
  });

  test('a non-array baselineCacheDirs is a failed result — the char-wise iteration corruption class', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      baselineCacheDirs: 'build' as unknown as NonNullable<WorktreeForInput['baselineCacheDirs']>,
    });
    expect(error).toMatch(/baselineCacheDirs must be an array/);
  });
});

// ---------------------------------------------------------------------------
// 6b. The mutex config boundary (the op never leaks the factory's RangeError)
// ---------------------------------------------------------------------------

describe('sweep.worktreeFor mutex config boundary', () => {
  test('a staleMs below the clamp floor is a failed result naming staleMs', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      mutex: { lockPath: '/repo/.cq/git-mutex.lock', staleMs: 100 },
    });
    expect(error).toMatch(/mutex\.staleMs \(100\)/);
    expect(error).toMatch(/≥ 2000/);
    expect(repo.addCalls).toHaveLength(0);
  });

  test('a negative retries value is a failed result naming retries', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      mutex: { lockPath: '/repo/.cq/git-mutex.lock', retries: -1 },
    });
    expect(error).toMatch(/mutex\.retries \(-1\)/);
    expect(repo.addCalls).toHaveLength(0);
  });

  test('a null mutex is a failed result, not a TypeError at the lockPath read', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      mutex: null,
    } as unknown as WorktreeForInput);
    expect(error).toMatch(/mutex must be an object/);
    expect(repo.addCalls).toHaveLength(0);
  });

  test('a well-formed mutex config passes the boundary and the create still plans', async () => {
    // The well-formed config reaches the REAL makeGitMutex — whose acquire
    // mkdir -p's the lock's parent — so the lockPath needs a real tmpdir.
    const dir = mkdtempSync(join(tmpdir(), 'worktree-mutex-ok-'));
    try {
      const repo = fakeRepo();
      const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), {
        ...INPUT,
        mutex: { lockPath: join(dir, 'git-mutex.lock'), staleMs: 30_000 },
      });
      expect(workspace.reused).toBe(false);
      expect(repo.addCalls).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 6c. Relative worktreesDir normalization (the self-collision fix)
// ---------------------------------------------------------------------------

describe('sweep.worktreeFor relative worktreesDir (resolved against repoRoot)', () => {
  test('relative dir in, create, then a re-invoke sees the exact-match worktree and REUSES', async () => {
    const repo = fakeRepo();
    const input = { ...INPUT, worktreesDir: 'wt' };
    const first = await okWorkspace(makeWorktreeFor(effectsOf(repo)), input);
    // The derived path is ABSOLUTE — resolved against repoRoot.
    expect(first.path).toBe('/repo/wt/fix/core');
    expect(first.reused).toBe(false);
    expect(repo.addCalls).toHaveLength(1);

    // A real `git worktree add` records the ABSOLUTE path; the re-invoke
    // with the same RELATIVE input must match it and reuse — not collide
    // with itself.
    repo.worktrees = [{ path: '/repo/wt/fix/core', branch: BRANCH }];
    repo.clean.add('/repo/wt/fix/core');
    const second = await okWorkspace(makeWorktreeFor(effectsOf(repo)), input);
    expect(second.reused).toBe(true);
    expect(second.path).toBe('/repo/wt/fix/core');
    expect(repo.addCalls).toHaveLength(1); // only the first call created
  });
});

// ---------------------------------------------------------------------------
// 7. The subprocess adapter: parsers (fixtures) + one real-git smoke
// ---------------------------------------------------------------------------

describe('subprocess worktree-effects parsers (captured fixtures)', () => {
  test('porcelain: branch entries carry the short branch; bare/detached carry none', () => {
    const text = [
      'worktree /repo',
      'HEAD 1111111111111111111111111111111111111111',
      '',
      'worktree /runs/wt/fix/core',
      'HEAD 2222222222222222222222222222222222222222',
      'branch refs/heads/cq/09-16a/fix/core',
      '',
      'worktree /runs/wt/fix/cli',
      'HEAD 3333333333333333333333333333333333333333',
      'detached',
      '',
    ].join('\n');
    expect(parseWorktreePorcelain(text)).toEqual([
      { path: '/repo' },
      { path: '/runs/wt/fix/core', branch: 'cq/09-16a/fix/core' },
      { path: '/runs/wt/fix/cli' },
    ]);
  });

  test('for-each-ref: one short branch per non-empty line', () => {
    expect(parseBranchRefs('main\nfeature/x\n\ncq/y/fix/z\n')).toEqual([
      'main',
      'feature/x',
      'cq/y/fix/z',
    ]);
    expect(parseBranchRefs('')).toEqual([]);
  });

  test('ls-remote: sha-tab-ref rows reduce to short branch names', () => {
    expect(
      parseRemoteHeads('1111\trefs/heads/main\n2222\trefs/heads/cq/x\n3333\trefs/tags/v1\n'),
    ).toEqual(['main', 'cq/x']);
    expect(parseRemoteHeads('')).toEqual([]);
  });
});

describe('subprocess worktree-effects (real git smoke)', () => {
  // Same auto-maintenance suppression as the adapter's runGit: a commit's
  // randomized background `gc --auto` inheriting these pipes would hang the
  // callback past git's own exit (the exact hang class the adapter fixes).
  // BOUNDED RETRY: some sandboxed dev environments stall child spawns
  // nondeterministically (observed ~1-in-10 here); the adapter's timeout
  // SIGKILLs a stalled git and each step retries — the ASSERTIONS are never
  // relaxed, a false result still fails the test outright.
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
            reject(new Error(`${stderr.trim() || error.message}`));
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

  test('init → worktree add → strict-clean → prune, on a real repo in a tmpdir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-smoke-'));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      await resilient(() => run(['-C', dir, 'commit', '--allow-empty', '-m', 'init'], dir));
      const effects = makeSubprocessWorktreeEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });

      expect(await resilient(() => effects.listBranches())).toEqual(['main']);
      expect(await resilient(() => effects.listWorktrees())).toHaveLength(1); // the checkout itself

      const wtPath = join(dir, 'wt', 'fix', 'core');
      await resilient(() =>
        effects.worktreeAdd({
          repoRoot: dir,
          path: wtPath,
          branch: 'cq/x/fix/core',
          base: 'main',
        }),
      );
      expect(await resilient(() => effects.pathExists(wtPath))).toBe(true);
      expect(await resilient(() => effects.isStrictClean(wtPath))).toBe(true);
      const worktrees = await resilient(() => effects.listWorktrees());
      const onBranch = worktrees.find((w) => w.branch === 'cq/x/fix/core');
      expect(onBranch?.path).toMatch(/wt\/fix\/core$/);

      // An untracked file breaks the STRICT clean (porcelain non-empty).
      writeFileSync(join(wtPath, 'untracked.txt'), 'dirty');
      expect(await resilient(() => effects.isStrictClean(wtPath))).toBe(false);
      await resilient(() => effects.rmDir(wtPath));
      expect(await resilient(() => effects.pathExists(wtPath))).toBe(false);

      // The stale registration survives the rm until prune removes it.
      expect(
        (await resilient(() => effects.listWorktrees())).some((w) => w.branch === 'cq/x/fix/core'),
      ).toBe(true);
      await resilient(() => effects.worktreePrune(dir));
      expect(
        (await resilient(() => effects.listWorktrees())).some((w) => w.branch === 'cq/x/fix/core'),
      ).toBe(false);

      // Git failures reject with the stderr text (fast faults, not hangs).
      await expect(
        resilient(() => effects.isStrictClean(join(dir, 'nope')).then(() => 'ran' as const)),
      ).rejects.toThrow(/git status/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  test('REAL-git create→reuse round trip through makeWorktreeFor: second call REUSES (canonicalized paths)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'worktree-roundtrip-'));
    try {
      await resilient(() => run(['init', '-q', '-b', 'main', dir], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.email', 't@example.invalid'], dir));
      await resilient(() => run(['-C', dir, 'config', 'user.name', 'T'], dir));
      await resilient(() => run(['-C', dir, 'commit', '--allow-empty', '-m', 'init'], dir));

      let adds = 0;
      const subprocess = makeSubprocessWorktreeEffects(dir, { timeoutMs: GIT_CALL_TIMEOUT_MS });
      const effects: WorktreeEffects = {
        ...subprocess,
        worktreeAdd: async (req) => {
          adds += 1;
          await subprocess.worktreeAdd(req);
        },
      };
      const op = makeWorktreeFor(effects);
      const input: WorktreeForInput = {
        repoRoot: dir,
        worktreesDir: join(dir, 'wt'),
        runPrefix: 'cq/x',
        kind: 'fix',
        slug: 'core',
        base: 'main',
      };
      // No origin remote exists here — the remote namespace is vacuously
      // empty (the missing-origin tolerance under test in this round).
      const first = await resilient(() => okWorkspace(op, input));
      expect(first.reused).toBe(false);
      expect(adds).toBe(1);
      // mkdtemp prefixes often carry a symlink (macOS /var → /private/var):
      // the canonical tree path is what a later comparison must match.
      const canonicalFirst = realpathSync(first.path);

      // A symlinked worktreesDir component must resolve to the SAME tree —
      // the create→reuse round trip would self-collide under lexical
      // comparison.
      symlinkSync(join(dir, 'wt'), join(dir, 'wt-link'));
      const viaLink = await resilient(() =>
        okWorkspace(op, { ...input, worktreesDir: join(dir, 'wt-link') }),
      );
      expect(viaLink.reused).toBe(true);
      expect(viaLink.path).toBe(canonicalFirst);
      expect(viaLink.requestedBase).toBe('main');
      expect(adds).toBe(1); // the second call did NOT create
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
