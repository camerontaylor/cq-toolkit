// Split provenance: test/harness/mcp-server.test.ts was split into subject
// files; this one covers protocol errors and ignored traffic: -32601 for
// unknown methods, unknown notifications ignored, -32700 for an unparseable
// line (id null), -32600 for batches and non-objects, inbound responses
// ignored, CRLF tolerated.
// Siblings: mcp-server.helpers.ts (shared fixtures) and the other
// mcp-server.*.test.ts files in this directory.
import { describe, expect, test } from 'vitest';
import { JSONRPC_ERRORS } from '../../src/harness/mcp/server.js';
import { request, startServer, surfaceFor } from './mcp-server.helpers.js';

describe('protocol errors and ignored traffic', () => {
  test('an unknown method → -32601', async () => {
    const io = startServer(surfaceFor());
    io.send(request(1, 'resources/list'));
    expect(await io.next()).toMatchObject({
      id: 1,
      error: { code: JSONRPC_ERRORS.methodNotFound },
    });
  });

  test('an unknown notification is ignored', async () => {
    const io = startServer(surfaceFor());
    io.send({ jsonrpc: '2.0', method: 'notifications/whatever', params: {} });
    io.send(request(2, 'ping'));
    expect(await io.next()).toMatchObject({ id: 2, result: {} });
  });

  test('an unparseable line → -32700 with id null, and the server keeps going', async () => {
    const io = startServer(surfaceFor());
    io.send('{"jsonrpc": "2.0", "id": 1, ');
    expect(await io.next()).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: JSONRPC_ERRORS.parse, message: 'parse error' },
    });
    io.send(request(2, 'ping'));
    expect(await io.next()).toMatchObject({ id: 2, result: {} });
  });

  test.each([
    ['a batch array', JSON.stringify([request(1, 'ping'), request(2, 'ping')])],
    ['a number', '42'],
    ['a string', '"ping"'],
    ['null', 'null'],
  ])('%s → -32600 with id null', async (_label, line) => {
    const io = startServer(surfaceFor());
    io.send(line);
    expect(await io.next()).toMatchObject({
      id: null,
      error: { code: JSONRPC_ERRORS.invalidRequest },
    });
  });

  test('a missing jsonrpc tag → -32600 echoing a valid id', async () => {
    const io = startServer(surfaceFor());
    io.send({ id: 4, method: 'ping' });
    expect(await io.next()).toMatchObject({ id: 4, error: { code: -32600 } });
  });

  test('a malformed id → -32600 with id null', async () => {
    const io = startServer(surfaceFor());
    io.send({ jsonrpc: '2.0', id: 1.5, method: 'ping' });
    expect(await io.next()).toMatchObject({ id: null, error: { code: -32600 } });
    io.send({ jsonrpc: '2.0', id: { x: 1 }, method: 'ping' });
    expect(await io.next()).toMatchObject({ id: null, error: { code: -32600 } });
  });

  test('inbound response objects are ignored', async () => {
    const io = startServer(surfaceFor());
    io.send({ jsonrpc: '2.0', id: 99, result: {} });
    io.send({ jsonrpc: '2.0', id: 98, error: { code: -1, message: 'x' } });
    io.send(request(3, 'ping'));
    expect(await io.next()).toMatchObject({ id: 3, result: {} });
  });

  test('CRLF line endings, blank lines, split and coalesced chunks are tolerated', async () => {
    const io = startServer(surfaceFor());
    const ping = JSON.stringify(request(1, 'ping'));
    io.input.write(`\r\n\n${ping}\r\n`);
    expect(await io.next()).toMatchObject({ id: 1, result: {} });
    const split = JSON.stringify(request(2, 'ping'));
    io.input.write(split.slice(0, 10));
    io.input.write(`${split.slice(10)}\n${JSON.stringify(request(3, 'ping'))}\n`);
    expect(await io.next()).toMatchObject({ id: 2 });
    expect(await io.next()).toMatchObject({ id: 3 });
  });
});
