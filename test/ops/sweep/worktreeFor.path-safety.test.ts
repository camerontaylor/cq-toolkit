// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps PATH SAFETY (derived segments never traverse or impersonate
// git flags) and relative-worktreesDir normalization. Shared fixtures live in
// ./worktreeFor.helpers.ts.
import { describe, expect, test } from 'vitest';
import { makeWorktreeFor } from '../../../src/adapters/git/worktreeFor.js';
import type { WorktreeForInput } from '../../../src/adapters/git/worktreeFor.js';
import {
  BRANCH,
  effectsOf,
  failedAt,
  fakeRepo,
  INPUT,
  okWorkspace,
} from './worktreeFor.helpers.js';

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

  test("a '..' RUN inside a kind segment is refused — it feeds a git refname", async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, kind: 'a..b' });
    expect(error).toMatch(/kind/);
    expect(error).toMatch(/refname/);
  });

  test("a '.lock'-suffixed slug is refused — loose-ref-file collision", async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), { ...INPUT, slug: 'foo.lock' });
    expect(error).toMatch(/slug/);
    expect(error).toMatch(/refname/);
  });

  test('a control character in worktreesDir is refused — the porcelain lists are line-oriented', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      worktreesDir: '/runs/wt\n/evil',
    });
    expect(error).toMatch(/worktreesDir/);
    expect(error).toMatch(/control characters/);
  });

  test('a control character in repoRoot is refused — a relative worktreesDir resolves against it (jFLC9)', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      repoRoot: '/re\npo',
    });
    expect(error).toMatch(/repoRoot/);
    expect(error).toMatch(/control characters/);
  });

  test('a control character in runPrefix is refused', async () => {
    const repo = fakeRepo();
    const error = await failedAt(makeWorktreeFor(effectsOf(repo)), {
      ...INPUT,
      runPrefix: 'cq/09-16a\r/x',
    });
    expect(error).toMatch(/runPrefix/);
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
