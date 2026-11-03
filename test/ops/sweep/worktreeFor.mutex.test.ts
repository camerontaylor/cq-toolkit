// Split provenance: test/ops/sweep/worktreeFor.test.ts was split by subject;
// this file keeps the git-mutex wrap (UC row 32) and the mutex config boundary
// (the op never leaks the factory's RangeError). Shared fixtures live in
// ./worktreeFor.helpers.ts.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeWorktreeFor } from '../../../src/adapters/git/worktreeFor.js';
import type { WorktreeEffects, WorktreeForInput } from '../../../src/adapters/git/worktreeFor.js';
import type { FakeRepo } from './worktreeFor.helpers.js';
import { effectsOf, failedAt, fakeRepo, INPUT, okWorkspace } from './worktreeFor.helpers.js';

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
