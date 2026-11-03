// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the token-budget reservation and exhaustion decisions.
import { expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import {
  baseInput,
  fakeDrivers,
  large,
  result,
  small,
  usage,
} from './agentReviewer-partitions.helpers.js';

it('subtracts completed session token usage and blocks with honest partial coverage when budget runs out', async () => {
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ component: 'tracked:src/a.ts', path: 'src/a.ts', text: large }],
      maxTokens: 10,
      session: { concurrency: 1 },
    }),
  );
  expect(outcome.status).toBe('budget-exhausted');
  expect(outcome).toMatchObject({
    report: {
      usage: 10,
      coverage: {
        mode: 'partitioned',
        pieces: [{ state: 'delivered' }],
        sessions: [
          { status: 'complete', usage },
          { status: 'complete', usage },
        ],
      },
    },
  });
  expect(fake.invocations.map((invocation) => invocation.budget.maxTokens)).toEqual([10, 5]);
  expect(fake.calls()).toBe(2);
});

it('splits the remaining token allowance across concurrent sessions', async () => {
  const fake = fakeDrivers();
  await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 400,
      session: { concurrency: 4 },
    }),
  );
  expect(fake.invocations[0]!.budget.maxTokens).toBe(100);
  // Concurrent sessions reserve disjoint shares: 400 -> 100 + 100 + 100 + 100.
  const first = fake.invocations.slice(0, 4).map((invocation) => invocation.budget.maxTokens!);
  expect(first.reduce((sum, value) => sum + value, 0)).toBeLessThanOrEqual(400);
});

it('keeps successful sibling evidence complete when aggregate spend exceeds the guard', async () => {
  let releaseFirst!: () => void;
  const firstHeld = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let started = 0;
  const fake = fakeDrivers({
    onHook: async () => {
      if (++started === 1) await firstHeld;
      else releaseFirst();
    },
    result: () => result({ usage: { input: 60, output: 0, cacheRead: 0, cacheWrite: 0 } }),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 100,
      session: { concurrency: 2 },
    }),
  );
  expect(outcome.status).toBe('needs-human');
  if (outcome.status !== 'needs-human') throw new Error('expected needs-human');
  expect(outcome.reason).toContain('budget exhausted');
  expect(outcome.report?.usage).toBe(120);
  expect(outcome.report?.coverage.sessions.map((session) => session.status)).toEqual([
    'complete',
    'complete',
  ]);
  expect(outcome.report?.coverage.pieces[0]?.state).not.toBe('completed');
});
