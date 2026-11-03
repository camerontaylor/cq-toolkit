// Split provenance: test/harness/mcp-server.test.ts was split into subject
// files; this one covers CONCURRENCY + CANCELLATION: ping is answered while
// a slow run is in flight; notifications/cancelled kills the in-flight run
// and suppresses its response; shutdown() and EOF abort in-flight calls.
// Siblings: mcp-server.helpers.ts (shared fixtures) and the other
// mcp-server.*.test.ts files in this directory.
import { describe, expect, test } from 'vitest';
import type { HarnessSurface } from '../../src/harness/surface.js';
import { request, startServer, surfaceFor } from './mcp-server.helpers.js';

describe('concurrency and cancellation', () => {
  test('ping is answered while a slow run is in flight', async () => {
    const io = startServer(surfaceFor());
    io.send(request(1, 'tools/call', { name: 'bash', arguments: { command: 'sleep 0.5' } }));
    io.send(request(2, 'ping'));
    expect(await io.next()).toMatchObject({ id: 2, result: {} });
    expect(await io.next()).toMatchObject({
      id: 1,
      result: { content: [{ type: 'text', text: 'exit 0' }] },
    });
  });

  test('notifications/cancelled kills the in-flight run and suppresses its response', async () => {
    const io = startServer(surfaceFor());
    const started = Date.now();
    io.send(request(5, 'tools/call', { name: 'bash', arguments: { command: 'sleep 30' } }));
    io.send(request(6, 'ping')); // proves the call was dispatched before cancelling
    expect(await io.next()).toMatchObject({ id: 6 });
    io.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 5 } });
    // Surface calls are serialized: this read only runs once the sleep is dead.
    io.send(request(7, 'tools/call', { name: 'read', arguments: { path: 'missing.txt' } }));
    expect(await io.next()).toMatchObject({ id: 7, result: { isError: true } });
    expect(Date.now() - started).toBeLessThan(10_000);
    io.send(request(8, 'ping'));
    expect(await io.next()).toMatchObject({ id: 8 }); // no id-5 response slipped in
    expect(io.received.some((message) => message['id'] === 5)).toBe(false);
  }, 15_000);

  test('cancelling an unknown or finished request id is harmless', async () => {
    const io = startServer(surfaceFor());
    io.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 404 } });
    io.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} });
    io.send({ jsonrpc: '2.0', method: 'notifications/cancelled' });
    io.send(request(1, 'ping'));
    expect(await io.next()).toMatchObject({ id: 1 });
  });

  test('shutdown() aborts the in-flight call and writes nothing more', async () => {
    const real = surfaceFor();
    const signals: AbortSignal[] = [];
    const spying: HarnessSurface = {
      manifest: real.manifest,
      tools: real.tools,
      has: (name: string): name is 'read' | 'bash' => real.has(name),
      call: (name, args, opts) => {
        if (opts?.signal !== undefined) signals.push(opts.signal);
        return real.call(name, args, opts);
      },
    };
    const io = startServer(spying);
    io.send(request(1, 'tools/call', { name: 'bash', arguments: { command: 'sleep 30' } }));
    io.send(request(2, 'ping'));
    expect(await io.next()).toMatchObject({ id: 2 });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    const started = Date.now();
    io.server.shutdown();
    await expect(io.server.done).resolves.toBe('shutdown');
    expect(signals[0]?.aborted).toBe(true);
    // The killed sleep frees the serialized surface promptly.
    await expect(real.call('read', { path: 'nope.txt' })).resolves.toMatchObject({
      outcome: { ok: false },
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(io.received.some((message) => message['id'] === 1)).toBe(false);
  }, 15_000);

  test('EOF also aborts the in-flight call', async () => {
    const real = surfaceFor();
    const io = startServer(real);
    io.send(request(1, 'tools/call', { name: 'bash', arguments: { command: 'sleep 30' } }));
    io.send(request(2, 'ping'));
    expect(await io.next()).toMatchObject({ id: 2 });
    const started = Date.now();
    io.input.end();
    await expect(io.server.done).resolves.toBe('eof');
    await real.call('read', { path: 'nope.txt' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});
