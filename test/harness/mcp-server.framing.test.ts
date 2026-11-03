// Split provenance: test/harness/mcp-server.test.ts was split into subject
// files; this one covers FRAMING and lifetime: an oversized line is a
// protocol break (done 'oversized-line') and is never processed truncated;
// EOF ends with 'eof'; shutdown is idempotent.
// Siblings: mcp-server.helpers.ts (shared fixtures) and the other
// mcp-server.*.test.ts files in this directory.
import { describe, expect, test } from 'vitest';
import { request, startServer, surfaceFor } from './mcp-server.helpers.js';

describe('framing and lifetime', () => {
  test('a line at exactly maxLineBytes is processed', async () => {
    const line = JSON.stringify(request(1, 'ping'));
    const io = startServer(surfaceFor(), { maxLineBytes: Buffer.byteLength(line) });
    io.send(line);
    expect(await io.next()).toMatchObject({ id: 1, result: {} });
  });

  test('an oversized terminated line ends the loop unprocessed', async () => {
    const logs: string[] = [];
    const io = startServer(surfaceFor(), { maxLineBytes: 64, log: (l) => logs.push(l) });
    io.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: { pad: 'x'.repeat(100) } });
    await expect(io.server.done).resolves.toBe('oversized-line');
    await new Promise((settle) => setImmediate(settle));
    expect(io.received).toEqual([]);
    expect(logs.some((line) => line.includes('exceeds 64 bytes'))).toBe(true);
  });

  test('an oversized unterminated line ends the loop before it is ever complete', async () => {
    const io = startServer(surfaceFor(), { maxLineBytes: 64 });
    io.input.write('x'.repeat(40));
    io.input.write('x'.repeat(40)); // 80 buffered bytes, still no newline
    await expect(io.server.done).resolves.toBe('oversized-line');
    // Nothing after the break is processed, even a well-formed tail.
    io.input.write(`\n${JSON.stringify(request(1, 'ping'))}\n`);
    await new Promise((settle) => setImmediate(settle));
    expect(io.received).toEqual([]);
  });

  test('the byte cap counts UTF-8 bytes, not chars', async () => {
    // 30 × '€' = 30 chars but 90 bytes.
    const io = startServer(surfaceFor(), { maxLineBytes: 64 });
    io.input.write('€'.repeat(30));
    await expect(io.server.done).resolves.toBe('oversized-line');
  });

  test('EOF ends the loop with eof', async () => {
    const io = startServer(surfaceFor());
    io.send(request(1, 'ping'));
    expect(await io.next()).toMatchObject({ id: 1 });
    io.input.end();
    await expect(io.server.done).resolves.toBe('eof');
  });

  test('shutdown is idempotent and ends with shutdown', async () => {
    const io = startServer(surfaceFor());
    io.server.shutdown();
    io.server.shutdown();
    await expect(io.server.done).resolves.toBe('shutdown');
  });
});
