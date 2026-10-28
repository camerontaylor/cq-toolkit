import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { sshQueueTransport } from '../../../src/ops/review/internal/queueClient.js';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

function childProcess() {
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
const children: ReturnType<typeof childProcess>[] = [];
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
  expect(child.stdin.read()?.toString()).toBe(request);
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
