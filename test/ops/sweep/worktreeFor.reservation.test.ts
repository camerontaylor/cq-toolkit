// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps the RESERVATION evidence (UC row 23): every occupied
// namespace collides and is named. Shared fixtures live in
// ./worktreeFor.helpers.ts (see its header for the suite-wide guarantees).
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
} from './worktreeFor.helpers.js';

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

  test('the remoteGetUrl classifier: NO origin is vacuously empty even under ambiguous ls-remote wording', async () => {
    const repo = fakeRepo();
    const effects: WorktreeEffects = {
      ...effectsOf(repo),
      remoteGetUrl: async () => null,
      listRemoteBranches: async () => {
        // This wording matches a missing remote AND a broken URL — the
        // classifier effect, not the text, decides.
        throw new Error(
          'git ls-remote failed — fatal: origin does not appear to be a git repository',
        );
      },
    };
    const workspace = await okWorkspace(makeWorktreeFor(effects), INPUT);
    expect(workspace.reused).toBe(false);
    expect(repo.addCalls).toHaveLength(1);
  });

  test('a configured-but-broken origin fails loudly when the classifier reports a URL', async () => {
    const repo = fakeRepo();
    const effects: WorktreeEffects = {
      ...effectsOf(repo),
      remoteGetUrl: async () => 'https://broken.invalid/origin.git',
      listRemoteBranches: async () => {
        throw new Error('git ls-remote failed — fatal: could not read from remote repository');
      },
    };
    const error = await failedAt(makeWorktreeFor(effects), INPUT);
    expect(error).toMatch(/could not list remote branches/);
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
