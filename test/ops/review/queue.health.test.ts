// Split provenance: the two queue-health cases moved verbatim from
// test/ops/review/queue.test.ts (round-2 pure-move split); the shared fixtures
// live in `queue.helpers.ts`.
import { expect, test } from 'vitest';
import { makeQueueClient } from '../../../src/ops/review/internal/queueClient.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import { ref } from './queue.helpers.js';

test('health parses an authorized snapshot and rejects malformed counts', async () => {
  const healthRef = {
    requestId: ref.requestId,
    binding: { repo: ref.binding.repo, targetSelector: ref.binding.targetSelector },
  };
  const result = {
    lastCompletedTick: '2026-11-02T00:00:00Z',
    ageSeconds: 10,
    discoveryComplete: false,
    incompleteTicks: 3,
    pending: 2,
    blocked: 1,
    deployedSha: 'a'.repeat(40),
    snapshot: 'b'.repeat(64),
  };
  const transport: QueueTransport = async (wire) => {
    const request = JSON.parse(wire) as Record<string, unknown>;
    expect(request['op']).toBe('health');
    return JSON.stringify({ v: 1, requestId: ref.requestId, binding: healthRef.binding, result });
  };
  expect(await makeQueueClient(transport).health(healthRef)).toEqual(result);
  expect(await makeQueueOps(transport).queueHealth(healthRef)).toEqual({
    status: 'ok',
    value: result,
  });
  result.pending = -1;
  expect(await makeQueueOps(transport).queueHealth(healthRef)).toMatchObject({ status: 'failed' });
  await expect(makeQueueClient(transport).health(healthRef)).rejects.toThrow();
});

test('health preserves retryable busy replies from admission and generation changes', async () => {
  const healthRef = {
    requestId: 'health-client',
    binding: { repo: 'owner/repo', targetSelector: 'promoted-main' as const },
  };
  const result = { error: { code: 'busy', retryable: true } };
  const transport: QueueTransport = async () => JSON.stringify({ v: 1, ...healthRef, result });
  expect(await makeQueueClient(transport).health(healthRef)).toEqual(result);
  expect(await makeQueueOps(transport).queueHealth(healthRef)).toEqual({
    status: 'ok',
    value: result,
  });
  result.error.retryable = false;
  await expect(makeQueueClient(transport).health(healthRef)).rejects.toThrow();
});
