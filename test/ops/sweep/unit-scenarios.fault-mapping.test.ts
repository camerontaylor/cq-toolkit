// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit fault-mapping coverage: ordinary filesystem and
// evidence faults become `failed` results with their class tag, never
// escaping rejections across the op seam.
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { makeWorld, runUnit } from './unit-scenarios.helpers.js';

function escapingProbeOutput(): { stdout: string; stderr: string; exitCode: number } {
  return {
    stdout: JSON.stringify({
      success: false,
      numTotalTests: 1,
      testResults: [
        {
          name: '../escape.test.js',
          status: 'failed',
          assertionResults: [
            { fullName: 'escapes', status: 'failed', failureMessages: ['escapes'] },
          ],
        },
      ],
    }),
    stderr: '',
    exitCode: 1,
  };
}

describe('sweep unit fault mapping', () => {
  test('an unusable scratch directory fails the unit as [INFRA] instead of rejecting', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      // mkdir(recursive) on a path that is a regular file rejects with EEXIST.
      await writeFile(join(world.root, 'blocked-worktrees'), 'not a directory');
      const result = await runUnit(world, {
        worktreesDir: 'blocked-worktrees',
        // The baseline snapshot must succeed so the fault comes from the
        // final-probe scratch directory, not the run-state write.
        runStateDir: join(world.root, 'state'),
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/^\[INFRA\]/);
        expect(result.error).toContain('could not create the final-probe scratch dir');
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('an escaping failure path fails the baseline probe as [PROBE] instead of rejecting', async () => {
    const world = await makeWorld([{ failing: true }]);
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        runCheck: async () => escapingProbeOutput(),
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/^\[PROBE\]/);
        expect(result.error).toContain('the baseline probe reported ungateable paths');
        expect(result.error).toContain('escapes the workspace');
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
