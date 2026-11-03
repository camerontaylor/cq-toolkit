// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { expect, test } from 'vitest';
import type { WorkerResult } from '../../../src/driver/types.js';
import { createEscalationState, nextEscalation } from '../../../src/ops/fix/escalation.js';
import { makeWorld, runUnit, vitestOutput } from './unit-scenarios.helpers.js';

test.each(['tokens', 'wall'] as const)(
  'shared run %s exhaustion refuses a new provider dispatch',
  async (cap) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    let calls = 0;
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        taskRunBudget: {
          remainingTokens: () => (cap === 'tokens' ? 0 : 100),
          remainingWallMs: () => (cap === 'wall' ? 0 : 60_000),
          reportResult: () => {
            throw new Error('must not report an undispatched call');
          },
        },
        driver: {
          run: async () => {
            calls++;
            throw new Error('must not dispatch');
          },
        },
      });
      expect(calls).toBe(0);
      expect(result.status).toBe('ok');
      if (result.status === 'ok') {
        expect(result.value.budgetStopped).toBe(true);
        expect(result.value.tasks?.[0]?.attempts).toEqual([]);
        expect(result.value.tasks?.[0]?.commits).toEqual([]);
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);

test('task invocation cost preserves its basis and shared accounting observes both stateless calls', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  const accounted: WorkerResult[] = [];
  try {
    const result = await runUnit(world, {
      taskLoop: {},
      taskRunBudget: {
        remainingTokens: () => 100,
        remainingWallMs: () => 60_000,
        reportResult: (worker) => accounted.push(worker),
      },
      driver: {
        run: async () => ({
          stopReason: 'complete',
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.002,
          costBasis: 'modeled',
          denials: [],
          structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
        }),
      },
    });
    expect(result.status).toBe('ok');
    expect(accounted).toHaveLength(2);
    if (result.status === 'ok') {
      expect(result.value.tasks?.[0]?.attempts.map((a) => [a.costUSD, a.costBasis])).toEqual([
        [0.002, 'modeled'],
        [0.002, 'modeled'],
      ]);
      expect(result.value.tasks?.[0]?.rounds?.[0]?.validation?.verdict).toBe('pass');
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test.each(['probe-fault', 'no-progress'] as const)(
  'broader %s preserves the next configured worker round without consuming rescue',
  async (fault) => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    const runCheck = world.runCheckFactory();
    const prompts: string[] = [];
    let probes = 0;
    let state = createEscalationState();
    try {
      const result = await runUnit(world, {
        taskLoop: {},
        taskEscalation: {
          next: (task, progress) => {
            const transition = nextEscalation(
              state,
              { workerAttempts: 2, rescueBase: 1, rescuePerFixed: 10, rescuePerPackageCap: 1 },
              { ...progress, package: 'alpha', task: task.id, canRescue: true },
            );
            state = transition.state;
            return transition.decision;
          },
          verified: () => {},
        },
        runCheck: async (command) => {
          if (command.cwd?.includes('.cq-sweep-final-') && probes++ === 0) {
            if (fault === 'probe-fault') throw new Error('temporary broader probe fault');
            return { stdout: vitestOutput(true), stderr: '', exitCode: 1 };
          }
          return runCheck(command);
        },
        driver: {
          run: async (invocation) => {
            prompts.push(invocation.prompt);
            return {
              stopReason: 'complete',
              denials: [],
              usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
              structuredOutput: { outcome: 'code-bug', summary: 'repair source', confidence: 0.9 },
            };
          },
        },
      });
      expect(result.status).toBe('ok');
      expect(state.perRunUsed).toBe(0);
      expect(prompts).toHaveLength(4);
      expect(prompts[2]).toContain('Tier: worker; attempt: 2');
      if (result.status === 'ok') {
        expect(result.value.tasks?.[0]?.outcome).toBe('fixed');
        expect(result.value.tasks?.[0]?.commits).toHaveLength(1);
        expect(result.value.tasks?.[0]?.rounds?.[0]?.validation?.regression).toBeUndefined();
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  },
);
