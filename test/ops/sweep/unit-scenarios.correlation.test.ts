// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { makeWorld, runUnit } from './unit-scenarios.helpers.js';

// M5b4 forward governed invocation correlation: the unit op's driver
// invocation forwards the governed job's correlation verbatim; absent a
// governed dispatch nothing is invented.
import type { OpInvocation } from '../../../src/driver/types.js';
import { runLadder } from '../../../src/kernel/governor.js';

test('M5b4 nominal evidence', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  const invocations: OpInvocation[] = [];
  try {
    const base = world.driverFactory();
    const outcome = await runLadder(
      () =>
        runUnit(world, {
          taskLoop: {},
          driver: {
            run: async (invocation: OpInvocation, runOptions?: { signal?: AbortSignal }) => {
              invocations.push(invocation);
              return base.run(invocation, runOptions);
            },
          } as never,
        }),
      { wallClockMs: 5000 },
      {
        op: 'sweep.unit',
        jobKey: 'j-unit',
        attempt: 1,
        correlation: { workId: 'run:j-unit:1', runId: 'run', role: 'sweep.unit' },
      },
    );
    expect(outcome.outcome).toBe('completed');
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.correlation).toEqual({
        workId: 'run:j-unit:1',
        runId: 'run',
        role: 'sweep.unit',
      });
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('M5b4 missing evidence', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  const invocations: OpInvocation[] = [];
  try {
    const base = world.driverFactory();
    const result = await runUnit(world, {
      taskLoop: {},
      driver: {
        run: async (invocation: OpInvocation, runOptions?: { signal?: AbortSignal }) => {
          invocations.push(invocation);
          return base.run(invocation, runOptions);
        },
      } as never,
    });
    expect(result.status).toBe('ok');
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.correlation).toBeUndefined();
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});

test('M5b4 failure evidence', async () => {
  const world = await makeWorld([{ failing: true }, { failing: false }]);
  const invocations: OpInvocation[] = [];
  try {
    const base = world.driverFactory();
    await runLadder(
      () =>
        runUnit(world, {
          taskLoop: {},
          driver: {
            run: async (invocation: OpInvocation, runOptions?: { signal?: AbortSignal }) => {
              invocations.push(invocation);
              return base.run(invocation, runOptions);
            },
          } as never,
        }),
      { wallClockMs: 5000 },
      {
        op: 'sweep.unit',
        jobKey: 'j-outer',
        attempt: 7,
        correlation: {
          workId: 'run:j-outer:7',
          runId: 'outer-run',
          parentWorkId: 'parent-1',
          role: 'orchestrator',
          task: 'outer task',
        },
      },
    );
    expect(invocations.length).toBeGreaterThan(0);
    for (const invocation of invocations) {
      expect(invocation.correlation).toEqual({
        workId: 'run:j-outer:7',
        runId: 'outer-run',
        parentWorkId: 'parent-1',
        role: 'orchestrator',
        task: 'outer task',
      });
    }
  } finally {
    await rm(world.root, { recursive: true, force: true });
  }
});
