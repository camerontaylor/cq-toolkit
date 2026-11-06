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
    const result = ops.drain({ requests: [ref], waitMs: 30, pollMs: 1000 });
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
        req.op === 'retry-capability'
          ? { retry: 1 }
          : req.op === 'status'
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
  expect(calls.map((c) => c['op'])).toEqual(['status', 'retry-capability', 'retry']);
  expect(calls[2]?.['expectedReceiptId']).toBe('a'.repeat(64));
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
  const disconnected = ops.drain({ requests: [ref], waitMs: 20, pollMs: 1000 });
  await vi.advanceTimersByTimeAsync(20);
  expect(await disconnected).toMatchObject({
    status: 'ok',
    value: { errors: { 'request-1': 'disconnected' } },
  });
  mode = 'stall';
  const resumed = ops.drain({ requests: [ref], waitMs: 20, pollMs: 1000 });
  await vi.advanceTimersByTimeAsync(20);
  expect(await resumed).toMatchObject({ status: 'ok', value: { unfinished: [ref.requestId] } });
});
test('unsupported and busy retries are explicit non-acceptance', async () => {
  for (const result of [
    { unsupported: 'old runner' },
    { error: { code: 'busy', retryable: true } },
  ]) {
    const ops = makeQueueOps(async (raw) => {
      const req = JSON.parse(raw) as { requestId: string; binding: unknown };
      return JSON.stringify({ v: 1, requestId: req.requestId, binding: req.binding, result });
    });
    const actual = await ops.retry({ ...ref, transient: true, expectedReceiptId: 'a'.repeat(64) });
    expect(actual).toMatchObject({
      status: 'ok',
      value:
        'unsupported' in result
          ? { state: 'unsupported' }
          : { action: 'busy', accepted: false, reason: 'not-applied' },
    });
  }
});
test('drain retains successful observations alongside per-ID errors and enforces poll floor', async () => {
  vi.useFakeTimers();
  const ops = makeQueueOps(async (raw) => {
    const req = JSON.parse(raw) as { requestId: string; binding: unknown };
    if (req.requestId === 'broken') throw new Error('disconnected');
    return JSON.stringify({
      v: 1,
      requestId: req.requestId,
      binding: req.binding,
      result: { ...pending, reviewed: true },
    });
  });
  expect(await ops.drain({ requests: [ref], waitMs: 10, pollMs: 999 })).toMatchObject({
    status: 'failed',
  });
  const result = ops.drain({ requests: [ref, { ...ref, requestId: 'broken' }], waitMs: 10 });
  await vi.advanceTimersByTimeAsync(10);
  expect(await result).toMatchObject({
    status: 'ok',
    value: {
      unfinished: ['broken'],
      observations: { 'request-1': { reviewed: true } },
      errors: { broken: 'disconnected' },
    },
  });
});
test('zero-wait drain still observes each request once', async () => {
  const calls: string[] = [];
  const ops = makeQueueOps(async (raw) => {
    const req = JSON.parse(raw) as { requestId: string; binding: unknown };
    calls.push(req.requestId);
    return JSON.stringify({
      v: 1,
      requestId: req.requestId,
      binding: req.binding,
      result: pending,
    });
  });
  expect(await ops.drain({ requests: [ref], waitMs: 0 })).toMatchObject({
    status: 'ok',
    value: {
      action: 'observed',
      accepted: false,
      unfinished: [ref.requestId],
      observations: { 'request-1': { reviewed: false } },
    },
  });
  expect(calls).toEqual(['request-1']);
});
test('transport rejection at the deadline still returns unfinished IDs', async () => {
  vi.useFakeTimers();
  const ops = makeQueueOps(
    async (_raw, options) =>
      new Promise<string>((_resolve, reject) => {
        setTimeout(
          () => reject(new Error('queue delivery unknown: timeout')),
          options?.remainingMs?.(),
        );
      }),
  );
  const result = ops.drain({ requests: [ref], waitMs: 20 });
  await vi.advanceTimersByTimeAsync(20);
  expect(await result).toMatchObject({
    status: 'ok',
    value: {
      unfinished: [ref.requestId],
      errors: { 'request-1': 'queue delivery unknown: timeout' },
    },
  });
});
test('drain returns unsupported immediately without spending its wait budget', async () => {
  vi.useFakeTimers();
  let calls = 0;
  const ops = makeQueueOps(async (raw) => {
    calls++;
    const req = JSON.parse(raw) as { requestId: string; binding: unknown };
    return JSON.stringify({
      v: 1,
      requestId: req.requestId,
      binding: req.binding,
      result: { unsupported: 'old runner' },
    });
  });
  expect(await ops.drain({ requests: [ref], waitMs: 60000 })).toMatchObject({
    status: 'ok',
    value: { state: 'unsupported' },
  });
  expect(calls).toBe(1);
  expect(vi.getTimerCount()).toBe(0);
});
test('denied probe reports no-permission and sends no retry write', async () => {
  const calls: string[] = [];
  const ops = makeQueueOps(async (raw) => {
    const req = JSON.parse(raw) as { op: string; requestId: string; binding: unknown };
    calls.push(req.op);
    return JSON.stringify({
      v: 1,
      requestId: req.requestId,
      binding: req.binding,
      result: { denied: 'no-permission' },
    });
  });
  expect(
    await ops.retry({ ...ref, transient: true, expectedReceiptId: 'a'.repeat(64) }),
  ).toMatchObject({
    status: 'ok',
    value: { action: 'denied', accepted: false, reason: 'no-permission' },
  });
  expect(calls).toEqual(['retry-capability']);
});
