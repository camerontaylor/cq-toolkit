// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { makeWorld, runUnit } from './unit-scenarios.helpers.js';

test('failed task does not block a passing sibling task', async () => {
  const world = await makeWorld([
    { failing: true },
    { failing: true },
    { failing: true },
    { failing: false },
  ]);
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: (baseline) =>
        [0, 1].map((id) => ({
          id: String(id),
          files: ['suite.test.js'],
          failures: baseline.failures,
        })),
      driver: {
        run: async () => ({
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          denials: [],
          stopReason: 'complete',
          structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
        }),
      },
    });
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.value.tasks?.map((task) => task.outcome)).toEqual(['unfixed', 'fixed']);
      expect(result.value.tasks?.[1]?.commits).toHaveLength(1);
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test.each(['budget', 'stopped', 'invalid-output', 'dirty', 'moved-head', 'unattributed'] as const)(
  'task-loop refusal retains evidence for %s',
  async (mode) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const underlying = world.gitFactory();
    let invoked = false;
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        deriveTasks: (baseline) =>
          [0, 1].map((id) => ({
            id: String(id),
            files: mode === 'unattributed' ? [] : ['suite.test.js'],
            failures: baseline.failures,
          })),
        git: async (args) => {
          if (
            mode === 'moved-head' &&
            invoked &&
            args.includes('rev-parse') &&
            args.includes('HEAD')
          )
            return { code: 0, stdout: 'd'.repeat(40), stderr: '' };
          if (mode === 'dirty' && args.includes('status'))
            return { code: 0, stdout: ' M src/a.js', stderr: '' };
          return underlying(args);
        },
        driver: {
          run: async () => {
            invoked = true;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: mode === 'budget' ? 'budget' : mode === 'stopped' ? 'error' : 'complete',
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.value.committed).toBe(false);
      expect(result.value.tasks).toHaveLength(2);
      if (mode === 'budget') {
        expect(result.value.budgetStopped).toBe(true);
        expect(result.value.tasks?.[1]?.attempts).toHaveLength(0);
      } else if (mode === 'moved-head') {
        expect(result.value.tasks?.[0]?.reason).toContain('HEAD changed');
        expect(result.value.tasks?.[1]?.reason).toContain('human review');
      } else if (mode === 'dirty') {
        expect(result.value.tasks?.[0]?.failedAttempt?.branch).toMatch(/^cq\/unit\/failed\//);
        expect(result.value.tasks?.[0]?.failedAttempt?.sha).toMatch(/^[0-9a-f]{40,64}$/);
        expect(world.gitCalls.some((args) => args.includes('restore'))).toBe(true);
      } else if (mode === 'unattributed') {
        expect(invoked).toBe(false);
        expect(result.value.tasks?.every((task) => task.outcome === 'escalated-to-human')).toBe(
          true,
        );
      } else expect(result.value.tasks?.[0]?.outcome).toBe('unfixed');
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

test('a sibling-resolved task consumes no worker invocation or duplicate commit', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  let invocations = 0;
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      deriveTasks: (baseline) =>
        [0, 1].map((id) => ({
          id: String(id),
          files: ['suite.test.js'],
          failures: baseline.failures,
        })),
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
    if (result.status === 'ok') {
      expect(result.value.tasks?.map((task) => task.outcome)).toEqual(['fixed', 'fixed']);
      expect(result.value.tasks?.[1]?.attempts).toEqual([]);
      expect(result.value.tasks?.[1]?.commits).toEqual([]);
    }
    expect(invocations).toBe(2);
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});
