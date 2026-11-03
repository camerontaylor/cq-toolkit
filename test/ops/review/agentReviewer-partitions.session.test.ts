// Split provenance: test/ops/review/agentReviewer-partitions.test.ts was split
// into agentReviewer-partitions.{session,coverage,scan,cancellation,preflight,
// budget,concurrency,failures,retries,exclusions,wire}.test.ts. This file holds
// the single-session delivery evidence and empty-component capture decisions.
import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { baseInput, fakeDrivers, result, small } from './agentReviewer-partitions.helpers.js';

it('uses one tool-aware read-only session with exact original-component delivery evidence', async () => {
  const fake = fakeDrivers();
  const outcome = await runAgentReviewer(fake.drivers, baseInput());
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  expect(outcome.value.coverage).toMatchObject({
    version: 2,
    mode: 'session',
    pieces: [{ component: small.component, state: 'completed', chars: small.text.length }],
    sessions: [
      {
        status: 'complete',
        steps: 1,
        deliveries: [
          {
            component: small.component,
            start: 0,
            end: small.text.length,
            sha256: createHash('sha256').update(small.text).digest('hex'),
          },
        ],
        requests: [
          {
            serializedChars: expect.any(Number) as unknown,
            decodedChars: expect.any(Number) as unknown,
          },
        ],
      },
    ],
  });
  expect(fake.invocations).toHaveLength(1);
  expect(fake.invocations[0]).toMatchObject({
    toolPolicy: { mode: 'allowlist', allow: ['read', 'grep', 'glob'] },
    sandboxPolicy: { level: 'read-only' },
    workspace: { path: '/fixture/repo' },
    budget: { maxTokens: 10_000, maxSteps: 4 },
    outputSchema: { name: 'review.agent/v3' },
  });
});

it('captures only exact, valid empty-component placements as delivery', async () => {
  const empty = { component: 'untracked:empty.txt', path: 'empty.txt', text: '' };
  const fake = fakeDrivers({ result: () => result({}, []) });
  const outcome = await runAgentReviewer(
    fake.drivers,
    baseInput({ components: [empty], diff: '' }),
  );
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') throw new Error(JSON.stringify(outcome));
  expect(outcome.value.coverage.pieces[0]).toMatchObject({
    state: 'completed',
    chars: 0,
    bytes: 0,
  });
  expect(outcome.value.coverage.sessions[0]?.deliveries[0]).toMatchObject({
    component: empty.component,
    start: 0,
    end: 0,
  });
});
