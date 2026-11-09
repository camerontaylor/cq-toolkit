// Split provenance: test/harness/mcp-server.test.ts was split into subject
// files; this one covers lifecycle hardening: a reused in-flight id is
// refused with -32600, and an output error (EPIPE from a dead peer) ends the
// loop like EOF. Pending response writes stay protected after the loop ends.
// Siblings: mcp-server.helpers.ts (shared fixtures) and the other
// mcp-server.*.test.ts files in this directory.
import { PassThrough, Writable } from 'node:stream';
import { describe, expect, onTestFinished, test } from 'vitest';
import { serveStdio } from '../../src/harness/mcp/server.js';
import { request, startServer, surfaceFor } from './mcp-server.helpers.js';

describe('lifecycle hardening (improvement pass)', () => {
  test('a reused in-flight id is refused with -32600 and the first call still completes', async () => {
    const io = startServer(surfaceFor());
    io.send(request(7, 'tools/call', { name: 'bash', arguments: { command: 'sleep 1' } }));
    io.send(request(7, 'tools/call', { name: 'bash', arguments: { command: 'echo dup' } }));
    const first = await io.next();
    expect(first['id']).toBe(7);
    expect((first['error'] as { code?: unknown }).code).toBe(-32600);
    const second = await io.next(15_000);
    expect(second['id']).toBe(7);
    expect(second['result']).toBeDefined();
  }, 30_000);

  test('an output error (EPIPE from a dead peer) ends the loop like EOF', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const server = serveStdio(surfaceFor(), input, output);
    onTestFinished(() => server.shutdown());
    output.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await expect(server.done).resolves.toBe('eof');
  });

  test('a pending response can fail after an oversized line ends the loop', async () => {
    const input = new PassThrough();
    let completeWrite!: (error?: Error | null) => void;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });
    const server = serveStdio(surfaceFor(), input, output, { maxLineBytes: 64 });
    onTestFinished(() => server.shutdown());
    input.write(`${JSON.stringify(request(1, 'ping'))}\n${'x'.repeat(65)}\n`);
    await expect(server.done).resolves.toBe('oversized-line');
    expect(output.listenerCount('error')).toBe(1);
    const closed = new Promise<void>((resolve) => output.once('close', resolve));
    completeWrite(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }));
    await closed;
  });

  test('a successful pending response releases the output listener after shutdown', async () => {
    const input = new PassThrough();
    let completeWrite!: (error?: Error | null) => void;
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        completeWrite = callback;
      },
    });
    const server = serveStdio(surfaceFor(), input, output);
    onTestFinished(() => server.shutdown());
    input.write(`${JSON.stringify(request(1, 'ping'))}\n`);
    server.shutdown();
    await expect(server.done).resolves.toBe('shutdown');
    expect(output.listenerCount('error')).toBe(1);
    completeWrite();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(output.listenerCount('error')).toBe(0);
  });
});
