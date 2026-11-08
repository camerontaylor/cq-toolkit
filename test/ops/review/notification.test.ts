import { expect, test } from 'vitest';
import { reviewNotifyDestination } from '../../../src/config/review-notify.js';
import { makeStatus } from '../../../src/ops/review/status.js';
import { StatusInputSchema } from '../../../src/ops/review/internal/reviewOperation.js';

test('defaults notification host to the lowercase short hostname and daemon port', () => {
  expect(reviewNotifyDestination({ PASEO_AGENT_ID: 'agent' }, () => 'TRITON')).toEqual({
    paseo_agent_id: 'agent',
    paseo_host: 'triton:6767',
  });
});

test('explicit configured host overrides hostname discovery', () => {
  expect(
    reviewNotifyDestination(
      { PASEO_AGENT_ID: 'agent', CQ_REVIEW_NOTIFY_HOST: 'uranus:7676' },
      () => {
        throw new Error('must not read hostname');
      },
    ),
  ).toEqual({ paseo_agent_id: 'agent', paseo_host: 'uranus:7676' });
});

test('FQDNs use only the lowercase first label and blank override uses the default', () => {
  expect(
    reviewNotifyDestination(
      { PASEO_AGENT_ID: 'agent', CQ_REVIEW_NOTIFY_HOST: '  ' },
      () => 'PLUTO.example.invalid',
    ),
  ).toEqual({ paseo_agent_id: 'agent', paseo_host: 'pluto:6767' });
});

test('no agent means no destination or hostname lookup', () => {
  expect(
    reviewNotifyDestination({}, () => {
      throw new Error('must not read hostname');
    }),
  ).toBeUndefined();
});

test('unusable or unavailable hostnames leave host null', () => {
  for (const host of ['', '.domain', '-host', 'host name', 'host:6767', 'a'.repeat(64)])
    expect(reviewNotifyDestination({ PASEO_AGENT_ID: 'agent' }, () => host)?.paseo_host).toBeNull();
  expect(
    reviewNotifyDestination({ PASEO_AGENT_ID: 'agent' }, () => {
      throw new Error('unavailable');
    })?.paseo_host,
  ).toBeNull();
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
