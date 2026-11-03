// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the session-pool failure containment and halting decisions.
import { expect, it } from 'vitest';
import type { DiffSecretScanner } from '../../../src/ops/dev/denylist.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import {
  baseInput,
  clean,
  fakeDrivers,
  large,
  result,
  small,
} from './agentReviewer-partitions.helpers.js';

it('keeps dispatching independent sessions after one fails and still blocks with the failure named', async () => {
  const fake = fakeDrivers({
    result: (_invocation, call) =>
      call === 1
        ? result({ stopReason: 'error', error: 'step timeout', structuredOutput: undefined })
        : result(),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ diff: large, components: [{ ...small, text: large }], maxTokens: 1_000_000 }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(fake.calls()).toBeGreaterThan(2);
  if (outcome.status !== 'needs-human') throw new Error('expected needs-human');
  expect(outcome.reason).toContain('step timeout');
  expect(outcome.report?.coverage.sessions[0]).toMatchObject({ status: 'error' });
  expect(outcome.report?.coverage.sessions[1]).toMatchObject({ status: 'complete' });
  expect(outcome.report?.findings.length).toBeGreaterThan(0);
});

it('stops after two consecutive failed sessions instead of spending the rest of the budget', async () => {
  const fake = fakeDrivers({
    result: () =>
      result({ stopReason: 'error', error: 'provider down', structuredOutput: undefined }),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 1_000_000,
      session: { concurrency: 1 },
    }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(fake.calls()).toBe(2);
});

it("keeps completed sessions' findings and halts the pool when a later session hits a hard error", async () => {
  let calls = 0;
  const scanner: DiffSecretScanner = async (components) => {
    if (components.some(({ component }) => component === 'review-prompt') && ++calls === 3)
      throw new Error('scanner unavailable');
    return clean(components);
  };
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 1_000_000,
      scanSecrets: scanner,
      session: { concurrency: 1 },
    }),
  );
  expect(outcome.status).toBe('needs-human');
  expect(outcome.report?.findings.length).toBeGreaterThan(0);
  expect(fake.calls()).toBe(2);
});

it.each(['lane', 'delivery'] as const)('halts after a deterministic %s refusal', async (cause) => {
  const fake = fakeDrivers(cause === 'lane' ? { lane: 'acp' } : { skipHook: true });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 1_000_000,
      session: { concurrency: 1 },
    }),
  );
  expect(outcome.status).toBe('needs-human');
  if (outcome.status !== 'needs-human') throw new Error('expected needs-human');
  expect(outcome.report?.coverage.sessions).toHaveLength(1);
  expect(fake.calls()).toBe(cause === 'lane' ? 0 : 1);
  expect(outcome.report?.coverage.pieces[0]?.state).not.toBe('completed');
});
