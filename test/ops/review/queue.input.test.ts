// Split provenance: the `public queue local input classification` cases moved
// verbatim from test/ops/review/queue.test.ts (round-2 pure-move split); the
// shared fixtures live in `queue.helpers.ts`.
import { afterEach, describe, expect, test, vi } from 'vitest';
import type {
  QueueEnqueueInput,
  QueueTransport,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import { pendingStatus, ref } from './queue.helpers.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('public queue local input classification', () => {
  test.each([
    { ...ref, action: 'bind' as const },
    { ...ref, pr: 12 },
    { ...ref, action: 'cancel' as const, mergeSha: 'a'.repeat(40) },
  ] satisfies QueueEnqueueInput[])(
    'action-dependent invalid enqueue fails before dispatch: %j',
    async (input) => {
      const transport = vi.fn<QueueTransport>();
      expect(await makeQueueOps(transport).enqueue(input)).toMatchObject({ status: 'failed' });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  test('direct SDK schema rejects fail before dispatch for every op', async () => {
    const transport = vi.fn<QueueTransport>();
    const ops = makeQueueOps(transport);
    expect(await ops.enqueue({ ...ref, requestId: '' })).toMatchObject({ status: 'failed' });
    expect(
      await ops.queueStatus({ ...ref, binding: { ...ref.binding, repo: '../repo' } }),
    ).toMatchObject({ status: 'failed' });
    expect(await ops.report({ ...ref, evidenceDir: '' })).toMatchObject({ status: 'failed' });
    expect(transport).not.toHaveBeenCalled();
  });
  test('invalid input is deterministic even with no queue configuration', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    expect(await makeQueueOps().enqueue({ ...ref, action: 'bind' })).toMatchObject({
      status: 'failed',
    });
    expect(await makeQueueOps().queueStatus(ref)).toMatchObject({ status: 'needs-human' });
  });
  test('valid commands still dispatch the intended wire payload', async () => {
    type WireRequest = { op: string; pr?: number; mergeSha?: string };
    const sent: WireRequest[] = [];
    const transport: QueueTransport = async (wire) => {
      sent.push(JSON.parse(wire) as WireRequest);
      return JSON.stringify({
        v: 1,
        requestId: ref.requestId,
        binding: ref.binding,
        result: pendingStatus,
      });
    };
    const ops = makeQueueOps(transport);
    expect(await ops.enqueue(ref)).toMatchObject({ status: 'ok' });
    expect(await ops.enqueue({ ...ref, action: 'cancel' })).toMatchObject({ status: 'ok' });
    expect(
      await ops.enqueue({ ...ref, action: 'bind', pr: 12, mergeSha: 'a'.repeat(40) }),
    ).toMatchObject({ status: 'ok' });
    expect(sent.map(({ op }) => op)).toEqual(['enqueue', 'cancel', 'bind']);
    // The optional mergeSha and the positive pr are only proven by the payload.
    expect(sent[2]).toMatchObject({ op: 'bind', pr: 12, mergeSha: 'a'.repeat(40) });
  });
  test.each([
    '{}',
    'not JSON',
    JSON.stringify({
      v: 1,
      requestId: ref.requestId,
      binding: ref.binding,
      result: { state: 'x' },
    }),
  ])('malformed remote response remains indeterminate: %s', async (raw) => {
    const transport = vi.fn<QueueTransport>(async () => raw);
    expect(await makeQueueOps(transport).queueStatus(ref)).toMatchObject({
      status: 'indeterminate',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test('unsupported capability keeps its explicit result', async () => {
    const transport: QueueTransport = async () =>
      JSON.stringify({
        v: 1,
        requestId: ref.requestId,
        binding: ref.binding,
        result: { unsupported: true },
      });
    expect(await makeQueueOps(transport).queueStatus(ref)).toMatchObject({
      status: 'ok',
      value: { state: 'unsupported' },
    });
  });
});
