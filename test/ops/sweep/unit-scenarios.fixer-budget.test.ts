// Split provenance: test/ops/sweep/unit-scenarios.test.ts was split into
// unit-scenarios.*.test.ts siblings (shared fixtures in unit-scenarios.helpers.ts).
// In-process sweep.unit decision coverage. Plan-level rescue, assembly, prep,
// and fleet claims remain in the real runSweepPlan contracts because those
// decisions live in the e2e composition helper rather than production.
import { rm } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import type { Driver, WorkerResult } from '../../../src/driver/types.js';
import { makeSweepUnitOp } from '../../../src/ops/sweep/unit.js';
import type { FakeWorld } from './unit-scenarios.helpers.js';
import { bindingsOf, makeWorld, runUnit } from './unit-scenarios.helpers.js';

// PR #246 review (Codex P1): the fixer budget, lane-neutrally. wallClockMs is
// REQUIRED — the enforced in-flight spend bound; maxTokens/maxUsd are post-run
// landing gates. Any breach fails the unit [INFRA] before anything is staged,
// committed, or pushed.
describe('sweep unit fixer budget enforcement', () => {
  const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  /** A fixer that settles complete with the given usage/cost. */
  function settled(usage: WorkerResult['usage'], costUSD?: number): Driver {
    return {
      run: async () =>
        ({
          usage,
          ...(costUSD !== undefined ? { costUSD, costBasis: 'modeled' as const } : {}),
          denials: [],
          stopReason: 'complete',
        }) satisfies WorkerResult,
    };
  }

  /** Assert a budget trip: failed [INFRA], naming the cap, nothing staged or pushed. */
  function expectBudgetTrip(
    world: FakeWorld,
    result: Awaited<ReturnType<typeof runUnit>>,
    detail: RegExp,
  ): void {
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toMatch(/^\[INFRA\] .*stopped with reason 'budget'/);
      expect(result.error).toMatch(detail);
    }
    expect(world.gitCalls.some((args) => args.includes('add'))).toBe(false);
    expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    expect(world.pushCalls).toEqual([]);
  }

  test('maxTokens landing gate: a settled run at or above the cap is refused, whatever the lane reported', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(world, {
        budget: { wallClockMs: 600_000, maxTokens: 1000 },
        driver: settled({ input: 600, output: 400, cacheRead: 0, cacheWrite: 0 }),
      });
      expectBudgetTrip(world, result, /token total 1000 reached maxTokens 1000/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('maxUsd landing gate: unpriced usage is refused (DD-9 fail closed); priced work lands only within the cap', async () => {
    const unpriced = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(unpriced, {
        budget: { wallClockMs: 600_000, maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }),
      });
      expectBudgetTrip(unpriced, result, /unpriced usage .* under maxUsd 5/);
    } finally {
      await rm(unpriced.root, { recursive: true, force: true });
    }
    const over = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(over, {
        budget: { wallClockMs: 600_000, maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 6),
      });
      expectBudgetTrip(over, result, /cost 6 USD exceeded maxUsd 5/);
    } finally {
      await rm(over.root, { recursive: true, force: true });
    }
    const within = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const result = await runUnit(within, {
        budget: { wallClockMs: 600_000, maxUsd: 5 },
        driver: settled({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0 }, 4),
      });
      expect(result.status).toBe('ok');
    } finally {
      await rm(within.root, { recursive: true, force: true });
    }
  });

  test('wallClockMs: the deadline aborts the fixer and reports a budget trip, not a cancellation', async () => {
    // Two conforming lane shapes on abort: settle 'aborted', or throw.
    const onAbort: Array<(signal: AbortSignal) => Promise<WorkerResult>> = [
      (signal) =>
        new Promise((resolve) => {
          signal.addEventListener('abort', () =>
            resolve({ usage: ZERO, denials: [], stopReason: 'aborted' }),
          );
        }),
      (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => reject(new Error('lane aborted')));
        }),
    ];
    for (const settle of onAbort) {
      const world = await makeWorld([{ failing: true }, { failing: false }]);
      try {
        let received: AbortSignal | undefined;
        const result = await runUnit(world, {
          budget: { wallClockMs: 20 },
          driver: {
            run: async (_invocation, options) => {
              received = options?.signal;
              if (received === undefined) throw new Error('no deadline signal reached the lane');
              return settle(received);
            },
          },
        });
        expect(received?.aborted).toBe(true);
        expectBudgetTrip(world, result, /wallClockMs 20 elapsed/);
      } finally {
        await rm(world.root, { recursive: true, force: true });
      }
    }
  });

  test('a budget without wallClockMs, or with maxAttempts, is refused at construction', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      // A landing gate alone bounds no in-flight spend.
      for (const budget of [{ maxTokens: 1000 }, { maxUsd: 5 }]) {
        expect(() => makeSweepUnitOp(bindingsOf(world, { budget }))).toThrow(
          /wallClockMs is required/,
        );
      }
      expect(() => makeSweepUnitOp(bindingsOf(world, { budget: { maxAttempts: 2 } }))).toThrow(
        /maxAttempts is not enforceable/,
      );
      expect(() =>
        makeSweepUnitOp(bindingsOf(world, { budget: { wallClockMs: 600_000, maxAttempts: 2 } })),
      ).toThrow(/maxAttempts is not enforceable/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
