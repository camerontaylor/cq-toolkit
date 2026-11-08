import { afterEach, expect, test, vi } from 'vitest';
import vectors from '../../../apps/crq-python/fixtures/review-operation/vectors.json' with { type: 'json' };
import { makeWait } from '../../../src/ops/review/wait.js';
import { WaitInputSchema } from '../../../src/ops/review/internal/reviewOperation.js';
const capabilities = vectors.find((row) => row.name === 'capabilities-response')!.value;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
for (const [random, delay] of [
  [0, 12000],
  [0.5, 15000],
  [1, 18000],
])
  test(`15 s polling jitter: random=${random}, delay=${delay}`, async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(random!);
    let reads = 0;
    const pending = makeWait(async (raw) => {
      const req = JSON.parse(raw) as { op: string };
      if (req.op === 'capabilities') return JSON.stringify(capabilities);
      return JSON.stringify({
        v: 1,
        action: 'observed',
        state: ++reads === 1 ? 'queued' : 'completed',
      });
    })({ requestId: 'jitter', waitMs: 40000 });
    await vi.advanceTimersByTimeAsync(0);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(delay! - 1);
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(reads).toBe(2);
    expect(await pending).toMatchObject({
      status: 'ok',
      value: { state: 'completed', waitOutcome: 'terminal' },
    });
  });
test('wait defaults to ten minutes and expires with the known state', async () => {
  expect(WaitInputSchema.parse({ requestId: 'default' }).waitMs).toBe(600000);
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
  let settled = false;
  const pending = makeWait(async (raw) =>
    JSON.stringify(
      (JSON.parse(raw) as { op: string }).op === 'capabilities'
        ? capabilities
        : { v: 1, action: 'observed', state: 'queued' },
    ),
  )({ requestId: 'default' }).then((result) => {
    settled = true;
    return result;
  });
  await vi.advanceTimersByTimeAsync(599999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toMatchObject({
    status: 'ok',
    value: { state: 'queued', waitOutcome: 'deadline' },
  });
});
test('a final in-flight read timeout retains the last known running state', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
  let reads = 0;
  const pending = makeWait(async (raw, options) => {
    if ((JSON.parse(raw) as { op: string }).op === 'capabilities')
      return JSON.stringify(capabilities);
    reads++;
    if (reads === 3)
      return new Promise<string>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('queue delivery unknown: timeout')),
          options?.remainingMs?.() ?? 999999,
        ),
      );
    return JSON.stringify({
      v: 1,
      action: 'observed',
      state: reads === 1 ? 'queued' : 'running',
      item: 'lr-known',
    });
  })({ requestId: 'timeout', waitMs: 25000 });
  await vi.advanceTimersByTimeAsync(25000);
  expect(reads).toBe(3);
  expect(await pending).toMatchObject({
    status: 'ok',
    value: { state: 'running', item: 'lr-known', waitOutcome: 'deadline' },
  });
});
test('capability discovery consumes the same wait deadline and expiry never reads status', async () => {
  vi.useFakeTimers();
  const calls: string[] = [];
  const pending = makeWait(async (raw, options) => {
    calls.push((JSON.parse(raw) as { op: string }).op);
    expect(options?.remainingMs?.()).toBe(1000);
    return new Promise<string>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error('queue delivery unknown: timeout')),
        options!.remainingMs!(),
      ),
    );
  })({ requestId: 'slow-capability', waitMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({ status: 'ok', value: { waitOutcome: 'deadline' } });
  expect(calls).toEqual(['capabilities']);
});
test('successful slow discovery does not renew the wait budget', async () => {
  vi.useFakeTimers();
  const pending = makeWait(async (raw, options) => {
    if ((JSON.parse(raw) as { op: string }).op === 'capabilities') {
      await new Promise((resolve) => setTimeout(resolve, 600));
      return JSON.stringify(capabilities);
    }
    expect(options?.remainingMs?.()).toBe(400);
    return JSON.stringify({ v: 1, action: 'observed', state: 'queued' });
  })({ requestId: 'slow-success', waitMs: 1000 });
  await vi.advanceTimersByTimeAsync(1000);
  expect(await pending).toMatchObject({
    status: 'ok',
    value: { state: 'queued', waitOutcome: 'deadline' },
  });
});
