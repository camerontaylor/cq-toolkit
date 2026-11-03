// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { makeWorld, runUnit } from './unit-scenarios.helpers.js';

test.each(['edit', 'feedback'] as const)(
  'protected config edits from %s are refused before another check executes',
  async (phase) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    let invocations = 0;
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        git: async (args) =>
          args.includes('--name-status') && invocations >= (phase === 'edit' ? 1 : 2)
            ? { code: 0, stdout: 'M\0vitest.config.ts\0', stderr: '' }
            : underlying(args),
        driver: {
          run: async () => {
            invocations++;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.outcome).toBe('escalated-to-human');
      expect(world.checks).toHaveLength(phase === 'edit' ? 1 : 2);
      expect(invocations).toBe(phase === 'edit' ? 1 : 2);
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

test.each([false, true])(
  'broader timeout uses remaining unit wall and bounds retries (bail=%s)',
  async (bail) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const original = world.runCheckFactory();
    let broaderCalls = 0;
    try {
      const result = await runUnit(world, {
        taskLoop: { wallMs: 1000 },
        runCheck: async (command) => {
          if (command.cwd?.includes('.cq-sweep-final-')) {
            broaderCalls++;
            expect(command.timeoutMs).toBeGreaterThan(0);
            expect(command.timeoutMs).toBeLessThanOrEqual(200);
            if (bail) {
              now += 201;
              return { stdout: '', stderr: 'test run aborted', exitCode: null };
            }
          }
          return original(command);
        },
        driver: {
          run: async () => {
            now += 400;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
              structuredOutput: { outcome: 'code-bug', summary: 'repair', confidence: 0.9 },
            };
          },
        },
      });
      expect(broaderCalls).toBe(1);
      expect(result.status).toBe('ok');
      if (result.status === 'ok')
        expect(result.value.tasks?.[0]?.outcome).toBe(bail ? 'unfixed' : 'fixed');
    } finally {
      clock.mockRestore();
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

test('task derivation throws become a failed OpResult', async () => {
  const world = await makeWorld([{ failing: true }]);
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: () => {
        throw new Error('bad task derivation');
      },
    });
    expect(result).toEqual({
      status: 'failed',
      error: '[INFRA] task loop failed: Error: bad task derivation',
    });
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('an unrecorded ahead commit cannot be republished on a no-task rerun', async () => {
  const world = await makeWorld([{ failing: false }]);
  const original = world.gitFactory();
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: () => [],
      runStateDir: join(world.root, 'state'),
      git: async (args) =>
        args.includes('rev-list') ? { code: 0, stdout: '1', stderr: '' } : original(args),
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.pushed).toBe(false);
      expect(result.value.indeterminate).toContain('no verified scanned commit');
    }
    expect(world.pushCalls).toEqual([]);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});
