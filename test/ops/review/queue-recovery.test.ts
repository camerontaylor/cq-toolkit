import { expect, test, vi, afterEach } from 'vitest';
import { makeQueueOps } from '../../../src/ops/review/queue.js';
import type { QueueTransport } from '../../../src/ops/review/internal/queueProtocol.js';
const ref = {
  requestId: 'request-1',
  binding: {
    kind: 'merged-current' as const,
    repo: 'owner/repo',
    pr: 12,
    mergeSha: 'b'.repeat(40),
    targetSelector: 'promoted-main' as const,
  },
};
const pending = {
  state: 'pending',
  pr: 12,
  mergeSha: 'b'.repeat(40),
  itemId: 'current-1',
  receiptId: null,
  consumed: false,
  reviewed: false,
  fixed: false,
};
afterEach(() => vi.useRealTimers());
test('finite observation resumes after disconnect without starts, including busy and stale reads', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  let fault: string | undefined = 'busy';
  const transport: QueueTransport = async (raw) => {
    const req = JSON.parse(raw) as { op: string; requestId: string; binding: unknown };
    calls.push(req.op);
    return JSON.stringify({
      v: 1,
      requestId: req.requestId,
      binding: req.binding,
      result: fault
        ? { error: { code: fault, retryable: fault === 'busy', restart: true } }
        : pending,
    });
  };
  const ops = makeQueueOps(transport);
  for (const code of ['busy', 'stale-cursor', undefined]) {
    fault = code;
    const result = ops.drain({ requests: [ref], waitMs: 30, pollMs: 10 });
    await vi.advanceTimersByTimeAsync(30);
    expect(await result).toMatchObject({
      status: 'ok',
      value: { action: 'observed', accepted: false, unfinished: ['request-1'] },
    });
  }
  expect(new Set(calls)).toEqual(new Set(['status']));
});
test('retry defaults to observation and explicit retry carries the expected receipt', async () => {
  const calls: Record<string, unknown>[] = [];
  const transport: QueueTransport = async (raw) => {
    const req = JSON.parse(raw) as { op: string; requestId: string; binding: unknown };
    calls.push(req);
    return JSON.stringify({
      v: 1,
      requestId: req.requestId,
      binding: req.binding,
      result:
        req.op === 'status'
          ? pending
          : { action: 'accepted', accepted: true, reason: 'vendor-rate-limited' },
    });
  };
  const ops = makeQueueOps(transport);
  expect(await ops.retry(ref)).toMatchObject({
    status: 'ok',
    value: { action: 'observed', accepted: false },
  });
  expect(await ops.retry({ ...ref, transient: true })).toMatchObject({ status: 'failed' });
  expect(
    await ops.retry({ ...ref, transient: true, expectedReceiptId: 'a'.repeat(64) }),
  ).toMatchObject({ status: 'ok', value: { accepted: true } });
  expect(calls.map((c) => c['op'])).toEqual(['status', 'retry']);
  expect(calls[1]?.['expectedReceiptId']).toBe('a'.repeat(64));
});
test('disconnect can resume and a stalled read cannot extend the wall deadline', async () => {
  vi.useFakeTimers();
  let mode = 'disconnect';
  const ops = makeQueueOps(async (raw) => {
    const req = JSON.parse(raw) as { op: string; requestId: string; binding: unknown };
    expect(req.op).toBe('status');
    if (mode === 'disconnect') throw new Error('disconnected');
    return new Promise<string>(() => {});
  });
  expect(await ops.drain({ requests: [ref], waitMs: 20, pollMs: 10 })).toMatchObject({
    status: 'indeterminate',
  });
  mode = 'stall';
  const resumed = ops.drain({ requests: [ref], waitMs: 20, pollMs: 10 });
  await vi.advanceTimersByTimeAsync(20);
  expect(await resumed).toMatchObject({ status: 'ok', value: { unfinished: [ref.requestId] } });
});
