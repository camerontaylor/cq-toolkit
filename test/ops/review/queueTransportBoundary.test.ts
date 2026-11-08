import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sshQueueTransport } from '../../../src/ops/review/internal/queueClient.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

interface FakeChild extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: () => boolean;
}
function childProcess(): FakeChild {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  children.push(child);
  mocks.spawn.mockReturnValue(child);
  return child;
}
const children: FakeChild[] = [];
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const child of children.splice(0)) {
    // A killed OS process eventually closes; simulate that event before
    // destroying fixture streams, without assuming the newer lifetime API.
    child.emit('close', null);
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
  mocks.spawn.mockReset();
});

test('fixed capability sends the request verbatim and reconstructs split UTF-8 output', async () => {
  const child = childProcess();
  const request = '{"v":1,"op":"status"}\n';
  const pending = sshQueueTransport('reviewed-queue')(request);
  expect(mocks.spawn).toHaveBeenCalledExactlyOnceWith(
    'ssh',
    [
      '-T',
      '-S',
      'none',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'ConnectTimeout=15',
      '-o',
      'ConnectionAttempts=1',
      '-o',
      'ClearAllForwardings=yes',
      '-o',
      'RequestTTY=no',
      '--',
      'reviewed-queue',
      'queue-v1',
    ],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  expect(child.stdin.read()).toEqual(Buffer.from(request));
  expect(child.stdin.writableEnded).toBe(true);
  const bytes = Buffer.from('{"text":"évidence"}\n');
  const split = bytes.indexOf(Buffer.from('é')) + 1;
  child.stdout.emit('data', bytes.subarray(0, split));
  child.stderr.write('diagnostic must not become protocol output');
  child.stdout.emit('data', bytes.subarray(split));
  child.emit('close', 0);
  await expect(pending).resolves.toBe(bytes.toString());
  expect(child.kill).not.toHaveBeenCalled();
});

test('accepts exactly 8192 request and response bytes', async () => {
  const child = childProcess();
  const request = 'é'.repeat(4096);
  const response = Buffer.alloc(8192, 'x');
  const pending = sshQueueTransport('queue')(request);
  expect(child.stdin.read()).toEqual(Buffer.from(request));
  child.stdout.emit('data', response.subarray(0, 4096));
  child.stdout.emit('data', response.subarray(4096));
  child.emit('close', 0);
  await expect(pending).resolves.toBe(response.toString());
  expect(child.kill).not.toHaveBeenCalled();
});

test('oversized UTF-8 request refuses before any process is spawned', async () => {
  await expect(sshQueueTransport('queue')('é'.repeat(4096) + 'x')).rejects.toThrow(
    'oversized queue request',
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test('oversized accumulated response kills and refuses even if the process exits zero', async () => {
  const child = childProcess();
  const pending = sshQueueTransport('queue')('{}\n');
  const refused = expect(pending).rejects.toThrow('oversized queue response');
  child.stdout.emit('data', Buffer.alloc(8192));
  child.stdout.emit('data', Buffer.from('x'));
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  child.emit('close', 0);
  await refused;
});

test.each([1, null])('partial response never succeeds after exit %s', async (code) => {
  const child = childProcess();
  const pending = sshQueueTransport('queue')('{}\n');
  const refused = expect(pending).rejects.toThrow('queue delivery unknown');
  child.stdout.emit('data', Buffer.from('{"partial":'));
  child.emit('close', code);
  await refused;
});

test('process startup error refuses without exposing partial output', async () => {
  const child = childProcess();
  const pending = sshQueueTransport('queue')('{}\n');
  const refused = expect(pending).rejects.toThrow('queue transport unavailable');
  child.emit('error', new Error('offline spawn refusal'));
  await refused;
  expect(vi.getTimerCount()).toBe(0);
});

test('broken stdin followed by interrupted exit remains indeterminate', async () => {
  const child = childProcess();
  const pending = sshQueueTransport('queue')('{}\n');
  const refused = expect(pending).rejects.toThrow('queue delivery unknown');
  child.stdin.emit('error', new Error('offline broken pipe'));
  child.emit('close', 255);
  await refused;
});

test('a stalled process is killed at the existing 45 second delivery deadline', async () => {
  const child = childProcess();
  const pending = sshQueueTransport('queue')('{}\n');
  const refused = expect(pending).rejects.toThrow('queue delivery unknown: timeout');
  await vi.advanceTimersByTimeAsync(44999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await refused;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  child.emit('close', null);
  expect(vi.getTimerCount()).toBe(0);
});
test('an in-flight caller abort kills the child and preserves the exact reason', async () => {
  const child = childProcess();
  const controller = new AbortController();
  const reason = new Error('caller cancelled receipt delivery');
  const pending = sshQueueTransport('queue')('{}\n', { signal: controller.signal });
  const refused = expect(pending).rejects.toBe(reason);
  child.stdout.emit('data', Buffer.from('{"partial":'));
  controller.abort(reason);
  await refused;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  expect(vi.getTimerCount()).toBe(0);
  child.emit('close', null);
});

test('an already aborted caller signal refuses before any process is spawned', async () => {
  const controller = new AbortController();
  const reason = new Error('caller cancelled before dispatch');
  controller.abort(reason);
  await expect(sshQueueTransport('queue')('{}\n', { signal: controller.signal })).rejects.toBe(
    reason,
  );
  expect(mocks.spawn).not.toHaveBeenCalled();
});

test('the delivery deadline is clamped to the caller remaining budget', async () => {
  const child = childProcess();
  const pending = sshQueueTransport('queue')('{}\n', { remainingMs: () => 2000 });
  const refused = expect(pending).rejects.toThrow('queue delivery unknown: timeout');
  await vi.advanceTimersByTimeAsync(1999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await refused;
  expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
  child.emit('close', null);
});

test('old runner refusal is unsupported only for the pre-write capability probe', async () => {
  for (const op of ['retry-capability', 'retry']) {
    const child = childProcess();
    const pending = sshQueueTransport('queue')(JSON.stringify({ op }));
    const refused = expect(pending).rejects.toThrow(
      op === 'retry-capability' ? 'Retry capability unavailable' : 'queue delivery unknown',
    );
    child.emit('close', 2);
    await refused;
  }
});

test('review-v1 uses the queue identity with snapshot-sized input and bounded output', async () => {
  const child = childProcess();
  const request = JSON.stringify({ snapshot: 'x'.repeat(10000) });
  const pending = sshQueueTransport('reviewed-queue', 'review-v1')(request);
  expect(mocks.spawn.mock.calls[0]?.[1]).toContain('review-v1');
  expect(child.stdin.read()).toEqual(Buffer.from(request));
  child.stdout.emit('data', Buffer.from('{}'));
  child.emit('close', 0);
  expect(await pending).toBe('{}');
});
test('old dispatcher refusal is unsupported for review-v1', async () => {
  const child = childProcess();
  const pending = sshQueueTransport('reviewed-queue', 'review-v1')('{"v":1,"op":"capabilities"}');
  child.emit('close', 2);
  await expect(pending).rejects.toThrow('review-v1 capability unavailable');
});

test('review client enforces the 5 MiB snapshot limit before transport while preserving 6 MiB request space', async () => {
  const { makeReviewClient, ReviewInputError } =
    await import('../../../src/ops/review/internal/queueClient.js');
  const snapshot = {
    v: 1 as const,
    tree: 'b'.repeat(40),
    objects: [{ oid: 'c'.repeat(40), type: 'blob' as const, data: '' }],
    sha256: 'd'.repeat(64),
  };
  const overhead = Buffer.byteLength(JSON.stringify(snapshot));
  snapshot.objects[0]!.data = 'A'.repeat(Math.floor((5 * 1024 * 1024 - overhead) / 4) * 4);
  const request = {
    v: 1 as const,
    op: 'submit' as const,
    request_id: 'limit-test',
    inputs: {
      repo: 'owner/repo',
      target: 'main',
      base_commit: 'a'.repeat(40),
      base_tree: 'b'.repeat(40),
      head_commit: 'c'.repeat(40),
      head_tree: 'd'.repeat(40),
      projection: 'full-diff',
    },
    snapshot,
  };
  let calls = 0;
  const client = makeReviewClient(async (raw) => {
    calls++;
    expect(Buffer.byteLength(raw)).toBeLessThan(6 * 1024 * 1024);
    return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
  });
  await client.request(request);
  expect(calls).toBe(1);
  snapshot.objects[0]!.data += 'AAAA';
  await expect(client.request(request)).rejects.toBeInstanceOf(ReviewInputError);
  expect(calls).toBe(1);
});

const busyReply = JSON.stringify({
  v: 1,
  error: { code: 'busy', message: 'not admitted', retryable: true },
});
const submitWire = () => ({
  v: 1 as const,
  op: 'submit' as const,
  request_id: 'pinned-request',
  repeat: true,
  inputs: {
    repo: 'owner/repo',
    target: 'main',
    base_commit: 'a'.repeat(40),
    base_tree: 'b'.repeat(40),
    head_commit: 'c'.repeat(40),
    head_tree: 'd'.repeat(40),
    projection: 'full-diff',
  },
});

test('review busy retries preserve the exact generation request and admit once', async () => {
  const { makeReviewClient } = await import('../../../src/ops/review/internal/queueClient.js');
  const wires: string[] = [];
  let admissions = 0;
  const input = submitWire();
  const client = makeReviewClient(async (wire) => {
    wires.push(wire);
    if (wires.length < 3) return busyReply;
    admissions++;
    return JSON.stringify({ v: 1, action: 'created', state: 'queued' });
  });
  const pending = client.request(input);
  input.request_id = 'caller-mutated';
  await vi.advanceTimersByTimeAsync(500);
  await expect(pending).resolves.toMatchObject({ action: 'created' });
  expect(new Set(wires).size).toBe(1);
  expect(JSON.parse(wires[0]!) as unknown).toMatchObject({ request_id: 'pinned-request' });
  expect(admissions).toBe(1);
});

test('persistent busy is bounded and remains explicit non-acceptance', async () => {
  const { makeReviewClient, ReviewRemoteError } =
    await import('../../../src/ops/review/internal/queueClient.js');
  const transport = vi.fn(async () => busyReply);
  const pending = makeReviewClient(transport).request(submitWire());
  const assertion = expect(pending).rejects.toBeInstanceOf(ReviewRemoteError);
  await vi.advanceTimersByTimeAsync(35_000);
  await assertion;
  expect(transport).toHaveBeenCalledTimes(140);
});

test('busy retry respects cancellation and caller deadline without another delivery', async () => {
  const { makeReviewClient, ReviewRemoteError } =
    await import('../../../src/ops/review/internal/queueClient.js');
  for (const abort of [false, true]) {
    const transport = vi.fn(async () => busyReply);
    const controller = new AbortController();
    const until = Date.now() + 100;
    const reason = new Error('cancelled');
    const pending = makeReviewClient(transport).request(submitWire(), {
      signal: controller.signal,
      remainingMs: () => until - Date.now(),
    });
    const assertion = abort
      ? expect(pending).rejects.toBe(reason)
      : expect(pending).rejects.toBeInstanceOf(ReviewRemoteError);
    await vi.advanceTimersByTimeAsync(0);
    if (abort) controller.abort(reason);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(transport).toHaveBeenCalledTimes(1);
  }
});

test('unknown delivery never retries a paid generation', async () => {
  const { makeReviewClient } = await import('../../../src/ops/review/internal/queueClient.js');
  const transport = vi.fn(async () => {
    throw new Error('connection lost');
  });
  await expect(makeReviewClient(transport).request(submitWire())).rejects.toThrow(
    'connection lost',
  );
  expect(transport).toHaveBeenCalledTimes(1);
});

test('review operation reports exhausted explicit busy as failure, not unknown delivery', async () => {
  const { makeStatus } = await import('../../../src/ops/review/status.js');
  const pending = makeStatus(async () => busyReply)({ requestId: 'pinned-request' });
  await vi.advanceTimersByTimeAsync(35_000);
  await expect(pending).resolves.toEqual({ status: 'failed', error: 'not admitted' });
});
