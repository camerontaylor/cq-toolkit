// Split provenance: test/harness/mcp-server.test.ts was split into subject
// files; this one covers the initialize handshake (version echo / newest
// fallback, serverInfo, tools capability) and ping.
// Siblings: mcp-server.helpers.ts (shared fixtures) and the other
// mcp-server.*.test.ts files in this directory.
import { describe, expect, test } from 'vitest';
import {
  JSONRPC_ERRORS,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../src/harness/mcp/server.js';
import { request, startServer, surfaceFor } from './mcp-server.helpers.js';

describe('initialize + ping', () => {
  test('a supported protocol version is echoed', async () => {
    const io = startServer(surfaceFor());
    io.send(request(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {} }));
    const reply = await io.next();
    const version = (reply['result'] as { serverInfo?: { version?: unknown } }).serverInfo?.version;
    expect(typeof version).toBe('string');
    expect(reply).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'cq-harness', version },
      },
    });
  });

  test('every supported version is echoed; an unknown one gets the newest', async () => {
    const io = startServer(surfaceFor());
    for (const [i, version] of SUPPORTED_PROTOCOL_VERSIONS.entries()) {
      io.send(request(i, 'initialize', { protocolVersion: version }));
      expect(await io.next()).toMatchObject({ id: i, result: { protocolVersion: version } });
    }
    io.send(request('u', 'initialize', { protocolVersion: '1999-01-01' }));
    expect(await io.next()).toMatchObject({
      id: 'u',
      result: { protocolVersion: LATEST_PROTOCOL_VERSION },
    });
    io.send(request('m', 'initialize'));
    expect(await io.next()).toMatchObject({
      id: 'm',
      result: { protocolVersion: LATEST_PROTOCOL_VERSION },
    });
  });

  test('the stateless 2026-07-28 revision is not advertised; server/discover is not found', async () => {
    // 2026-07-28 drops initialize for server/discover, which this server does
    // not implement: a client asking for it negotiates down to the newest
    // initialize-based revision, and the discover probe gets -32601 so the
    // client falls back to initialize.
    expect(SUPPORTED_PROTOCOL_VERSIONS).not.toContain('2026-07-28');
    expect(LATEST_PROTOCOL_VERSION).toBe('2025-11-25');
    const io = startServer(surfaceFor());
    io.send(request('d', 'server/discover'));
    expect(await io.next()).toMatchObject({
      id: 'd',
      error: { code: JSONRPC_ERRORS.methodNotFound },
    });
    io.send(request('n', 'initialize', { protocolVersion: '2026-07-28' }));
    expect(await io.next()).toMatchObject({
      id: 'n',
      result: { protocolVersion: '2025-11-25' },
    });
  });

  test('ping → {} and notifications/initialized is silent', async () => {
    const io = startServer(surfaceFor());
    io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    io.send(request(7, 'ping'));
    expect(await io.next()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });
});
