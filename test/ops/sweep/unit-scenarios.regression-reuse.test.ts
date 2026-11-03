// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type { WorkerResult } from '../../../src/driver/types.js';
import { makeSalvage } from '../../../src/ops/sweep/salvage.js';
import { makeWorld, runUnit } from './unit-scenarios.helpers.js';

describe('sweep unit in-process scenarios', () => {
  test('regression fails before commit and preserves its own dirty worktree for salvage', async () => {
    const world = await makeWorld([
      { failing: true, message: 'baseline' },
      { failing: true, message: 'novel failure' },
    ]);
    try {
      const result = await runUnit(world, {
        driver: {
          run: async () => {
            world.dirty.value = true;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            } satisfies WorkerResult;
          },
        },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/REGRESSION/);
        expect(result.error).toContain('novel failure');
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      expect(
        world.gitCalls.some((args) =>
          args.some((arg) => ['reset', 'checkout', 'clean', 'stash', 'restore'].includes(arg)),
        ),
      ).toBe(false);
      expect(world.dirty.value).toBe(true);
      // Salvage reads the state the unit LEFT: the tree it created and its
      // cleanliness — never a stub that answers 'dirty' regardless.
      expect(world.worktreeState.map((entry) => entry.path)).toEqual([world.worktreePath]);
      const salvage = makeSalvage({
        pathExists: async (path) => world.worktreeState.some((entry) => entry.path === path),
        isStrictClean: async () => !world.dirty.value,
        canonicalize: async (path) => path,
      });
      const preserved = await salvage({
        repoRoot: world.root,
        entries: [{ path: world.worktreePath, journal: { allTerminal: false } }],
      });
      expect(preserved.status).toBe('ok');
      if (preserved.status === 'ok') expect(preserved.value.rows[0]?.class).toBe('preserve');
      const later = await runUnit(world);
      expect(later.status).toBe('failed');
      if (later.status === 'failed') expect(later.error).toMatch(/dirty .*refusing reuse/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('reuse reports ref-specific HEAD and base resolutions', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      const first = await runUnit(world);
      expect(first.status).toBe('ok');
      const reused = await runUnit(world);
      expect(reused.status).toBe('ok');
      if (reused.status === 'ok') {
        expect(reused.value.worktree).toMatchObject({
          reused: true,
          headSha: 'head-sha',
          baseSha: 'base-sha',
        });
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
