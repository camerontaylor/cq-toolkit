// Split provenance: test/ops/sweep/cleanup.test.ts was split by subject into
// the cleanup.*.test.ts siblings in this directory; this file holds the
// mutex wrap (pinned contract item 5; the differential worktreeFor.test.ts
// pattern).
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeCleanup } from '../../../src/adapters/git/cleanup.js';
import type { CleanupEffects } from '../../../src/adapters/git/cleanup.js';
import { INPUT, effectsOf, fakeRepo, seedAgedClean } from './cleanup.helpers.js';
import type { FakeRepo } from './cleanup.helpers.js';

// ---------------------------------------------------------------------------
// 4. The mutex wrap (differential, the worktreeFor.mutex.test.ts pattern)
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
      const results = await Promise.all([
        makeCleanup(slowEffects(repoA))({ ...INPUT, mutex, dryRun: false }),
        makeCleanup(slowEffects(repoB))({ ...INPUT, mutex, dryRun: false }),
      ]);
      expect(results.map((r) => r.status)).toEqual(['ok', 'ok']);
      expect(repoA.removes).toHaveLength(1);
      expect(repoB.removes).toHaveLength(1);
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
