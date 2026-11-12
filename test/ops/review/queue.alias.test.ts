// Split provenance: the `public queue local alias classification` cases moved
// verbatim from test/ops/review/queue.test.ts (round-2 pure-move split); the
// shared fixtures live in `queue.helpers.ts`.
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as queueClient from '../../../src/ops/review/internal/queueClient.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import { pendingStatus, ref } from './queue.helpers.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('public queue local alias classification', () => {
  test.each(['host;id', '-oProxyCommand=bad', 'host path'])(
    'malformed operator alias fails every op before any transport invocation: %s',
    async (alias) => {
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', alias);
      const real = queueClient.sshQueueTransport;
      const dispatched = vi.fn();
      // Wrap the real factory: a malformed alias throws there before any spawn.
      vi.spyOn(queueClient, 'sshQueueTransport').mockImplementation((value: string) => {
        const transport = real(value);
        return async (wire: string) => {
          dispatched();
          return transport(wire);
        };
      });
      const ops = makeQueueOps();
      for (const result of [
        await ops.enqueue(ref),
        await ops.queueStatus(ref),
        await ops.report({ ...ref, evidenceDir: 'evidence' }),
      ])
        expect(result).toEqual({ status: 'failed', error: 'invalid queue SSH alias' });
      expect(dispatched).not.toHaveBeenCalled();
    },
  );
  test.each(['invalid queue SSH alias', 'queue delivery unknown: timeout'])(
    'injected transport failure keeps its indeterminate verdict: %s',
    async (detail) => {
      vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
      const transport: QueueTransport = async () => {
        throw new Error(detail);
      };
      const result = await makeQueueOps(transport).queueStatus(ref);
      expect(result).toMatchObject({ status: 'indeterminate' });
      if (result.status === 'indeterminate') expect(result.detail).toContain(detail);
    },
  );
  test('injected transport still succeeds while the local alias is unusable', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', 'host;id');
    const transport: QueueTransport = async () =>
      JSON.stringify({
        v: 1,
        requestId: ref.requestId,
        binding: ref.binding,
        result: pendingStatus,
      });
    expect(await makeQueueOps(transport).queueStatus(ref)).toEqual({
      status: 'ok',
      value: pendingStatus,
    });
  });
  test('missing alias remains an explicit needs-human configuration reason', async () => {
    vi.stubEnv('CQ_QUEUE_SSH_ALIAS', '');
    const result = await makeQueueOps().queueStatus(ref);
    expect(result).toMatchObject({ status: 'needs-human' });
    if (result.status === 'needs-human') expect(result.reason).toContain('CQ_QUEUE_SSH_ALIAS');
  });
});
