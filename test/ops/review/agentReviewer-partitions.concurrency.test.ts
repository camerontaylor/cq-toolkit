// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the concurrent partition dispatch and finding-merge ordering decision.
import { expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import {
  baseInput,
  fakeDrivers,
  large,
  result,
  small,
} from './agentReviewer-partitions.helpers.js';

it('runs partitions concurrently up to the limit and merges findings in plan order', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const fake = fakeDrivers({
    onHook: async (_request, invocation) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Later partitions finish first: completion order differs from plan order.
      const marker = /UTF-16 range (\d+):/.exec(invocation.prompt)?.[1] ?? '0';
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1, 30 - Number(marker) / 20_000)),
      );
      inFlight--;
    },
    result: (invocation) =>
      result({}, [
        {
          file: small.path,
          line: 2,
          rule: 'order',
          severity: 'high',
          text: `at ${/UTF-16 range (\d+):/.exec(invocation.prompt)?.[1] ?? '?'}`,
        },
      ]),
  });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      diff: large,
      components: [{ ...small, text: large }],
      maxTokens: 1_000_000,
      session: { concurrency: 3 },
    }),
  );
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error('expected ok');
  expect(maxInFlight).toBeGreaterThan(1);
  expect(maxInFlight).toBeLessThanOrEqual(3);
  const starts = outcome.value.findings.map((finding) => Number(/at (\d+)/.exec(finding.text)![1]));
  expect(starts).toEqual([...starts].sort((a, b) => a - b));
  expect(outcome.value.coverage.sessions.map((session) => session.id)).toEqual(
    outcome.value.coverage.sessions.map((_s, index) => `partition-${index + 1}`),
  );
  // Completion order does not change the fixed per-session definitions: every
  // partition dispatch carries the identical read-only reference allowlist.
  expect(
    new Set(
      fake.invocations.map(
        (invocation) => `${invocation.toolPolicy.mode}:${invocation.toolPolicy.allow?.join(',')}`,
      ),
    ),
  ).toEqual(new Set(['allowlist:read,grep,glob']));
});
