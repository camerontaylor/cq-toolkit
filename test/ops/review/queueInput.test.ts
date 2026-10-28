import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import type {
  QueueReference,
  QueueEnqueueInput,
  QueueTransport,
} from '../../../src/ops/review/internal/queueProtocol.js';
const reference: QueueReference = {
  requestId: 'request-1',
  binding: {
    kind: 'merged-current',
    repo: 'owner/repo',
    pr: 12,
    mergeSha: 'a'.repeat(40),
    targetSelector: 'promoted-main',
  },
};
afterEach(() => vi.unstubAllEnvs());
describe('public queue local input classification', () => {
  test.each([
    { ...reference, action: 'bind' as const },
    { ...reference, pr: 12 },
    { ...reference, action: 'cancel' as const, mergeSha: 'a'.repeat(40) },
    { ...reference, requestId: '' },
    { ...reference, binding: { ...reference.binding, repo: '../repo' } },
  ] satisfies QueueEnqueueInput[])(
    'definite invalid enqueue fails before transport: %j',
    async (input) => {
      const transport = vi.fn<QueueTransport>();
      expect(await makeQueueOps(transport).enqueue(input)).toMatchObject({
        status: 'failed',
        error: expect.any(String),
      });
      expect(transport).not.toHaveBeenCalled();
    },
  );
  test('status and report SDK schema errors fail before transport', async () => {
    const transport = vi.fn<QueueTransport>();
    const ops = makeQueueOps(transport);
    expect(await ops.queueStatus({ ...reference, requestId: '' })).toMatchObject({
      status: 'failed',
    });
    expect(await ops.report({ ...reference, evidenceDir: '' })).toMatchObject({
      status: 'failed',
    });
    expect(transport).not.toHaveBeenCalled();
  });
  test('invalid input is deterministic even without SSH configuration', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    expect(await makeQueueOps().enqueue({ ...reference, action: 'bind' })).toMatchObject({
      status: 'failed',
    });
    expect(await makeQueueOps().queueStatus(reference)).toMatchObject({
      status: 'needs-human',
    });
  });
  test.each([
    '{}',
    'not JSON',
    JSON.stringify({
      v: 1,
      requestId: reference.requestId,
      binding: reference.binding,
      result: { state: 'unrecognized' },
    }),
  ])('malformed remote response remains indeterminate: %s', async (raw) => {
    const transport = vi.fn<QueueTransport>(async () => raw);
    expect(await makeQueueOps(transport).queueStatus(reference)).toMatchObject({
      status: 'indeterminate',
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });
  test('unknown transport failure is not reclassified as local input', async () => {
    const transport: QueueTransport = async () => {
      throw new Error('delivery unknown');
    };
    expect(await makeQueueOps(transport).enqueue(reference)).toMatchObject({
      status: 'indeterminate',
    });
  });
  test('unsupported capability retains its explicit result', async () => {
    const transport: QueueTransport = async () =>
      JSON.stringify({
        v: 1,
        requestId: reference.requestId,
        binding: reference.binding,
        result: { unsupported: true },
      });
    expect(await makeQueueOps(transport).queueStatus(reference)).toMatchObject({
      status: 'ok',
      value: { state: 'unsupported' },
    });
  });
});
