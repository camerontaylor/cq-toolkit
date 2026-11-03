// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps the REUSE (UC row 20) and CREATE outcomes: a strictly-clean
// exact-match tree is reused, an empty namespace is created, and a dirty tree
// is refused. Shared fixtures live in ./worktreeFor.helpers.ts.
import { describe, expect, test } from 'vitest';
import { makeWorktreeFor } from '../../../src/adapters/git/worktreeFor.js';
import type { WorktreeEffects } from '../../../src/adapters/git/worktreeFor.js';
import {
  BRANCH,
  effectsOf,
  failedAt,
  fakeRepo,
  INPUT,
  okWorkspace,
  PATH,
  REPO_ROOT,
} from './worktreeFor.helpers.js';

describe('sweep.worktreeFor reuse (UC row 20)', () => {
  test('a strictly-clean tree at the exact derived branch and path is reused: no add, no prune', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    repo.heads.set(`${PATH}|HEAD`, 'sha-head');
    repo.heads.set(`${PATH}|origin/main`, 'sha-base');
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(workspace).toEqual({
      path: PATH,
      branch: BRANCH,
      requestedBase: 'origin/main',
      reused: true,
      clearedBaselineCaches: [],
      refusedBaselineCaches: [],
      headSha: 'sha-head',
      baseSha: 'sha-base',
    });
    expect(repo.addCalls).toHaveLength(0);
    expect(repo.prunes).toHaveLength(0);
  });

  test('reuse records HEAD vs input.base so a CHANGED base is visible, never silent (#176 item 3)', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    // The tree was created at an OLD base: HEAD is one commit on top of it,
    // while input.base now resolves to a different sha.
    repo.heads.set(`${PATH}|HEAD`, 'sha-head-advanced');
    repo.heads.set(`${PATH}|origin/main`, 'sha-base-moved');
    const workspace = await okWorkspace(makeWorktreeFor(effectsOf(repo)), INPUT);
    expect(workspace.reused).toBe(true);
    expect(workspace.headSha).toBe('sha-head-advanced');
    expect(workspace.baseSha).toBe('sha-base-moved');
    expect(workspace.headSha).not.toBe(workspace.baseSha);
  });

  test('a revParse fault on reuse is a failed result naming the HEAD-vs-base verification (#176 item 3)', async () => {
    const repo = fakeRepo();
    repo.worktrees = [{ path: PATH, branch: BRANCH }];
    repo.clean.add(PATH);
    const effects: WorktreeEffects = {
      ...effectsOf(repo),
      revParse: async () => {
        throw new Error('fatal: bad revision');
      },
    };
    const error = await failedAt(makeWorktreeFor(effects), INPUT);
    expect(error).toMatch(/could not verify the reused worktree/);
    expect(error).toMatch(/HEAD against base/);
    expect(error).toContain('bad revision');
    // Nothing was mutated: no eviction, no add.
    expect(repo.removed).toHaveLength(0);
    expect(repo.addCalls).toHaveLength(0);
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
