// Split provenance: the `queue report lifetime enforcement` cases moved
// verbatim from test/ops/review/queue.test.ts (round-2 pure-move split); the
// shared fixtures live in `queue.helpers.ts`.
import { readdir } from 'node:fs/promises';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { makeQueueClient } from '../../../src/ops/review/internal/queueClient.js';
import type {
  QueueStatus,
  QueueTransport,
} from '../../../src/ops/review/internal/queueProtocol.js';
import { cleanupQueueDirs, directory, ref } from './queue.helpers.js';

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await cleanupQueueDirs();
});

describe('queue report lifetime enforcement', () => {
  const receiptId = 'e'.repeat(64);
  const status: QueueStatus = {
    state: 'terminal-clean',
    pr: 12,
    mergeSha: 'b'.repeat(40),
    itemId: 'item-1',
    receiptId,
    consumed: true,
    reviewed: true,
    fixed: false,
  };
  const manifest = {
    version: 1,
    kind: 'manifest',
    receipt_id: receiptId,
    sha256: receiptId,
    bytes: 1,
    chunks: 1,
    encoding: 'base64-utf8-json',
    cursor: `${receiptId}:0`,
  };
  function envelope(result: unknown) {
    return JSON.stringify({
      v: 1,
      requestId: ref.requestId,
      binding: ref.binding,
      result,
    });
  }

  test('a caller cancellation during receipt delivery prevents the local import, the observer and the ack', async () => {
    const dir = await directory();
    const controller = new AbortController();
    const reason = new Error('caller cancelled before ack');
    const ops: string[] = [];
    let observed = 0;
    let acked = 0;
    const transport: QueueTransport = async (wire) => {
      const op = (JSON.parse(wire) as { op: string }).op;
      ops.push(op);
      if (op === 'status') return envelope(status);
      if (op === 'report') {
        // Cancellation lands while the manifest page is in flight; the next internal step must
        // refuse before touching the filesystem, the observer or the acknowledgement.
        controller.abort(reason);
        return envelope({ page: manifest });
      }
      if (op === 'ack') {
        acked += 1;
        return envelope(status);
      }
      throw new Error(`unexpected queue op: ${op}`);
    };
    const client = makeQueueClient(transport);
    await expect(
      client.report(ref, dir, {
        signal: controller.signal,
        onEvidenceImported: async () => {
          observed += 1;
        },
      }),
    ).rejects.toThrow(reason);
    expect(acked).toBe(0);
    expect(observed).toBe(0);
    expect(ops).not.toContain('ack');
    // No evidence bytes were imported: the delivery directory stays empty.
    expect(await readdir(dir)).toEqual([]);
  });

  test('an exhausted caller budget refuses before any queue dispatch', async () => {
    const dir = await directory();
    const ops: string[] = [];
    const transport: QueueTransport = async (wire) => {
      ops.push((JSON.parse(wire) as { op: string }).op);
      return envelope(status);
    };
    const client = makeQueueClient(transport);
    await expect(client.report(ref, dir, { remainingMs: () => 0 })).rejects.toThrow(
      /deadline exhausted/,
    );
    expect(ops).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });
});
