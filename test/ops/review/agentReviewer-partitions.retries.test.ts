// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the transient-failure retry decision.
import { expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { baseInput, fakeDrivers, result, usage } from './agentReviewer-partitions.helpers.js';

it('retries a transient session failure once, counting both attempts, but not other failures', async () => {
  const transient = fakeDrivers({
    result: (_invocation, call) =>
      call === 1
        ? result({
            stopReason: 'error',
            error: 'step timeout',
            errorClass: 'transient',
            structuredOutput: undefined,
          })
        : result(),
  });
  const outcome = await runAgentReviewer(transient.drivers, baseInput());
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error('expected ok');
  expect(transient.calls()).toBe(2);
  const session = outcome.value.coverage.sessions[0]!;
  expect(session).toMatchObject({ status: 'complete', attempts: 2 });
  expect(session.usage.input).toBe(usage.input * 2);
  expect(session.deliveries).toHaveLength(1);
  expect(session.requests).toHaveLength(2);
  expect(outcome.value.usage).toBe(
    2 * (usage.input + usage.output + usage.cacheRead + usage.cacheWrite),
  );

  const persistent = fakeDrivers({
    result: () =>
      result({
        stopReason: 'error',
        error: 'step timeout',
        errorClass: 'transient',
        structuredOutput: undefined,
      }),
  });
  const failed = await runAgentReviewer(persistent.drivers, baseInput());
  expect(failed.status).toBe('needs-human');
  expect(persistent.calls()).toBe(2);

  const deterministic = fakeDrivers({
    result: () =>
      result({
        stopReason: 'error',
        error: 'bad request',
        errorClass: 'unknown',
        structuredOutput: undefined,
      }),
  });
  await runAgentReviewer(deterministic.drivers, baseInput());
  expect(deterministic.calls()).toBe(1);
});
