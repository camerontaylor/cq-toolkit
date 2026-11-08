import { expect, test } from 'vitest';
import { reviewNotifyDestination } from '../../../src/config/review-notify.js';
import { makeStatus } from '../../../src/ops/review/status.js';
import { StatusInputSchema } from '../../../src/ops/review/internal/reviewOperation.js';

test('captures agent and configured host, leaving an absent host null', () => {
  expect(reviewNotifyDestination({})).toBeUndefined();
  expect(reviewNotifyDestination({ PASEO_AGENT_ID: 'agent' })).toEqual({
    paseo_agent_id: 'agent',
    paseo_host: null,
  });
  expect(
    reviewNotifyDestination({ PASEO_AGENT_ID: 'agent', CQ_REVIEW_NOTIFY_HOST: 'triton:6767' }),
  ).toEqual({ paseo_agent_id: 'agent', paseo_host: 'triton:6767' });
});

test('status accepts replacement and explicit withdrawal and dispatches notify-update', async () => {
  expect(StatusInputSchema.parse({ requestId: 'one', notify: null }).notify).toBeNull();
  const wires: unknown[] = [];
  const op = makeStatus(async (raw) => {
    const wire = JSON.parse(raw) as { op: string };
    wires.push(wire);
    if (wire.op === 'capabilities')
      return JSON.stringify({
        v: 1,
        command: 'review-v1',
        operations: ['submit', 'status', 'result', 'cancel', 'notify-update'],
        features: ['chunked-result-v1'],
        limits: {
          max_request_bytes: 6291456,
          max_snapshot_bytes: 5242880,
          max_content_bytes: 3145728,
          max_objects: 4096,
          chunk_bytes: 3072,
        },
      });
    return JSON.stringify({
      v: 1,
      action: 'observed',
      state: 'queued',
      notify: { state: 'withdrawn' },
    });
  });
  const result = await op({ requestId: 'one', notify: null });
  expect(result).toMatchObject({ status: 'ok', value: { notify: { state: 'withdrawn' } } });
  expect(wires).toContainEqual({ v: 1, op: 'notify-update', request_id: 'one', notify: null });
});
