// Split provenance: test/harness/mcp-server.test.ts was split into subject
// files; this one covers tools/list (served tools only, strict schemas) and
// tools/call (success, denial as isError, -32602 on unknown tool / missing
// name / non-object arguments, -32603 on a throwing surface).
// Siblings: mcp-server.helpers.ts (shared fixtures) and the other
// mcp-server.*.test.ts files in this directory.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { JSONRPC_ERRORS } from '../../src/harness/mcp/server.js';
import { createHarnessSurface } from '../../src/harness/surface.js';
import type { HarnessSurface } from '../../src/harness/surface.js';
import {
  manifestFor,
  renderRead,
  request,
  scratch,
  startServer,
  surfaceFor,
} from './mcp-server.helpers.js';

describe('tools/list + tools/call', () => {
  test('tools/list serves only the manifest tools, with strict schemas', async () => {
    const io = startServer(surfaceFor({ tools: ['bash', 'read'] }));
    io.send(request(1, 'tools/list'));
    const reply = await io.next();
    const tools = (reply['result'] as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((tool) => tool['name'])).toEqual(['bash', 'read']);
    for (const tool of tools) {
      expect(typeof tool['description']).toBe('string');
      const schema = tool['inputSchema'] as Record<string, unknown>;
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
      expect('$schema' in schema).toBe(false);
      expect(schema['required']).toEqual(tool['name'] === 'read' ? ['file_path'] : ['command']);
      expect(Object.keys(schema['properties'] as object)).not.toContain('timeoutMs');
    }
  });

  test('a successful call returns the text content', async () => {
    const workspace = scratch();
    writeFileSync(join(workspace, 'a.txt'), 'alpha');
    const io = startServer(createHarnessSurface(manifestFor(workspace)));
    io.send(request(1, 'tools/call', { name: 'read', arguments: { path: 'a.txt' } }));
    expect(await io.next()).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { content: [{ type: 'text', text: renderRead('a.txt', 'alpha') }] },
    });
  });

  test('a denial is a result with isError, not a JSON-RPC error', async () => {
    const io = startServer(surfaceFor());
    io.send(request(2, 'tools/call', { name: 'read', arguments: { path: '../escape' } }));
    const reply = await io.next();
    expect(reply['error']).toBeUndefined();
    expect(reply['result']).toMatchObject({ isError: true });
    const text = (reply['result'] as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text?.startsWith('PATH_ESCAPE: path escape: ')).toBe(true);
  });

  test('omitted arguments are passed as {} (a schema denial, not a crash)', async () => {
    const io = startServer(surfaceFor());
    io.send(request(3, 'tools/call', { name: 'read' }));
    const reply = await io.next();
    expect(reply['result']).toMatchObject({ isError: true });
    const text = (reply['result'] as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text?.startsWith('INPUT_INVALID: invalid input: ')).toBe(true);
  });

  test.each([
    ['an unlisted tool', { name: 'edit', arguments: {} }],
    ['a foreign tool', { name: 'Bash', arguments: {} }],
    ['a missing name', { arguments: {} }],
    ['a non-string name', { name: 5 }],
    ['array arguments', { name: 'read', arguments: ['a.txt'] }],
    ['string arguments', { name: 'read', arguments: 'a.txt' }],
    ['null arguments', { name: 'read', arguments: null }],
  ])('%s → -32602', async (_label, params) => {
    const io = startServer(surfaceFor());
    io.send(request(9, 'tools/call', params));
    expect(await io.next()).toMatchObject({
      id: 9,
      error: { code: JSONRPC_ERRORS.invalidParams },
    });
  });

  test('missing params → -32602', async () => {
    const io = startServer(surfaceFor());
    io.send(request(10, 'tools/call'));
    expect(await io.next()).toMatchObject({ id: 10, error: { code: -32602 } });
  });

  test('a surface that throws → -32603 and a log line', async () => {
    const logs: string[] = [];
    const real = surfaceFor();
    const throwing: HarnessSurface = {
      manifest: real.manifest,
      tools: real.tools,
      has: (name: string): name is 'read' => name === 'read',
      call: () => Promise.reject(new Error('boom')),
    };
    const io = startServer(throwing, { log: (line) => logs.push(line) });
    io.send(request(11, 'tools/call', { name: 'read', arguments: {} }));
    expect(await io.next()).toMatchObject({ id: 11, error: { code: JSONRPC_ERRORS.internal } });
    expect(logs.some((line) => line.includes('boom'))).toBe(true);
  });
});
