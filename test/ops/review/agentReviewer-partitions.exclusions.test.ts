// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the excluded-content coverage decision.
import { expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { baseInput, fakeDrivers } from './agentReviewer-partitions.helpers.js';

it('returns complete zero-session coverage for excluded content and distinguishes assurance from limitation', async () => {
  const components = [
    { component: 'tracked:src/generated.ts', path: 'src/generated.ts', text: 'generated' },
    { component: 'tracked:src/vendor.ts', path: 'src/vendor.ts', text: 'vendor' },
  ];
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({
      components,
      exclude: [
        { pattern: 'src/generated.ts', assuredBy: 'generated from reviewed schema' },
        { pattern: 'src/vendor.ts' },
      ],
    }),
  );
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  expect(fake.calls()).toBe(0);
  expect(outcome.value.coverage.sessions).toEqual([]);
  expect(outcome.value.coverage.pieces).toMatchObject([
    { state: 'excluded', exclusion: { assuredBy: 'generated from reviewed schema' } },
    {
      state: 'excluded',
      exclusion: { limitation: expect.stringContaining('no assuredBy check') as unknown },
    },
  ]);
  expect(outcome.value.advisories).toContain(
    'agent review covered no content: all components excluded',
  );
  expect(outcome.value.limitations).toHaveLength(1);
});
