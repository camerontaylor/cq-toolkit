// `cq-harness-mcp` server unit tests — W1.4 (src/harness/mcp/server.ts and
// src/harness/mcp/startup.ts), driven in memory over node:stream
// PassThrough pairs. Pins:
//   - the CLOSED JSON-RPC subset: initialize (version echo / newest
//     fallback, serverInfo, tools capability), ping, tools/list (served
//     tools only, strict schemas), tools/call (success, denial as isError,
//     -32602 on unknown tool / missing name / non-object arguments), -32601
//     for unknown methods, unknown notifications ignored, -32700 for an
//     unparseable line (id null), -32600 for batches and non-objects,
//     inbound responses ignored, CRLF tolerated;
//   - FRAMING: an oversized line is a protocol break (done 'oversized-line')
//     and is never processed truncated; EOF ends with 'eof';
//   - CONCURRENCY + CANCELLATION: ping is answered while a slow run is in
//     flight; notifications/cancelled kills the in-flight run and suppresses
//     its response; shutdown() aborts in-flight calls;
//   - STARTUP: checkStartup's refusals (one line each) and happy path, and
//     scrubEnvironment's allowlist (process.env saved/restored around it).
// "No output" is asserted by ORDERING: the server handles lines in arrival
// order, so a ping sent after the probe must be the next message out.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, onTestFinished, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import {
  JSONRPC_ERRORS,
  LATEST_PROTOCOL_VERSION,
  serveStdio,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '../../src/harness/mcp/server.js';
import type { ServeOptions } from '../../src/harness/mcp/server.js';
import { checkStartup, scrubEnvironment } from '../../src/harness/mcp/startup.js';
import { createHarnessSurface, HarnessManifestSchema } from '../../src/harness/surface.js';
import type { HarnessManifest, HarnessSurface } from '../../src/harness/surface.js';

type Message = Record<string, unknown>;

/** A realpath'd scratch workspace (macOS /var → /private/var), removed after the test. */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-mcp-server-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harnessWithRun(commandPatterns: string[]): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      run: { enabled: true, commandPatterns, timeoutMs: 60_000, maxOutputChars: 10_000 },
    },
  };
}

function manifestFor(workspace: string, over: Partial<HarnessManifest> = {}): HarnessManifest {
  return HarnessManifestSchema.parse({
    v: 1,
    workspace,
    sandbox: 'workspace-write',
    tools: ['read', 'run'],
    harness: harnessWithRun(['sleep', 'echo']),
    envNames: [],
    ...over,
  });
}

/** An in-memory server over PassThrough streams, with a message reader. */
function startServer(surface: HarnessSurface, options: ServeOptions = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  const received: Message[] = [];
  const waiters: Array<() => void> = [];
  let rawOut = '';
  output.on('data', (chunk: Buffer) => {
    rawOut += chunk.toString('utf8');
    let nl = rawOut.indexOf('\n');
    while (nl !== -1) {
      received.push(JSON.parse(rawOut.slice(0, nl)) as Message);
      rawOut = rawOut.slice(nl + 1);
      nl = rawOut.indexOf('\n');
    }
    for (const wake of waiters.splice(0)) wake();
  });
  const server = serveStdio(surface, input, output, options);
  onTestFinished(() => server.shutdown());
  let cursor = 0;
  return {
    server,
    input,
    received,
    /** Write one raw line (a string is sent verbatim; an object is JSON-encoded). */
    send(message: Message | string): void {
      input.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
    },
    /** The next message the server writes (in order), within `timeoutMs`. */
    async next(timeoutMs = 5_000): Promise<Message> {
      const deadline = Date.now() + timeoutMs;
      while (received.length <= cursor) {
        const left = deadline - Date.now();
        if (left <= 0) throw new Error('next: no message from the server');
        await new Promise<void>((wake) => {
          const timer = setTimeout(wake, left);
          waiters.push(() => {
            clearTimeout(timer);
            wake();
          });
        });
      }
      const message = received[cursor] as Message;
      cursor += 1;
      return message;
    },
  };
}

const request = (id: number | string, method: string, params?: unknown): Message => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

function surfaceFor(over: Partial<HarnessManifest> = {}): HarnessSurface {
  return createHarnessSurface(manifestFor(scratch(), over));
}

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

  test('ping → {} and notifications/initialized is silent', async () => {
    const io = startServer(surfaceFor());
    io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    io.send(request(7, 'ping'));
    expect(await io.next()).toEqual({ jsonrpc: '2.0', id: 7, result: {} });
  });
});

describe('tools/list + tools/call', () => {
  test('tools/list serves only the manifest tools, with strict schemas', async () => {
    const io = startServer(surfaceFor({ tools: ['run', 'read'] }));
    io.send(request(1, 'tools/list'));
    const reply = await io.next();
    const tools = (reply['result'] as { tools: Array<Record<string, unknown>> }).tools;
    expect(tools.map((tool) => tool['name'])).toEqual(['run', 'read']);
    for (const tool of tools) {
      expect(typeof tool['description']).toBe('string');
      const schema = tool['inputSchema'] as Record<string, unknown>;
      expect(schema['type']).toBe('object');
      expect(schema['additionalProperties']).toBe(false);
      expect('$schema' in schema).toBe(false);
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
      result: { content: [{ type: 'text', text: 'alpha' }] },
    });
  });

  test('a denial is a result with isError, not a JSON-RPC error', async () => {
    const io = startServer(surfaceFor());
    io.send(request(2, 'tools/call', { name: 'read', arguments: { path: '../escape' } }));
    const reply = await io.next();
    expect(reply['error']).toBeUndefined();
    expect(reply['result']).toMatchObject({ isError: true });
    const text = (reply['result'] as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text?.startsWith('path escape: ')).toBe(true);
  });

  test('omitted arguments are passed as {} (a schema denial, not a crash)', async () => {
    const io = startServer(surfaceFor());
    io.send(request(3, 'tools/call', { name: 'read' }));
    const reply = await io.next();
    expect(reply['result']).toMatchObject({ isError: true });
    const text = (reply['result'] as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text?.startsWith('invalid input: ')).toBe(true);
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

describe('concurrency and cancellation', () => {
  test('ping is answered while a slow run is in flight', async () => {
    const io = startServer(surfaceFor());
    io.send(request(1, 'tools/call', { name: 'run', arguments: { command: 'sleep 0.5' } }));
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
    io.send(request(5, 'tools/call', { name: 'run', arguments: { command: 'sleep 30' } }));
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
      has: (name: string): name is 'read' | 'run' => real.has(name),
      call: (name, args, opts) => {
        if (opts?.signal !== undefined) signals.push(opts.signal);
        return real.call(name, args, opts);
      },
    };
    const io = startServer(spying);
    io.send(request(1, 'tools/call', { name: 'run', arguments: { command: 'sleep 30' } }));
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
    io.send(request(1, 'tools/call', { name: 'run', arguments: { command: 'sleep 30' } }));
    io.send(request(2, 'ping'));
    expect(await io.next()).toMatchObject({ id: 2 });
    const started = Date.now();
    io.input.end();
    await expect(io.server.done).resolves.toBe('eof');
    await real.call('read', { path: 'nope.txt' });
    expect(Date.now() - started).toBeLessThan(10_000);
  }, 15_000);
});

describe('checkStartup', () => {
  test('happy path binds the surface', () => {
    const workspace = scratch();
    const result = checkStartup([JSON.stringify(manifestFor(workspace))]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.workspace).toBe(workspace);
      expect(result.surface.tools.map((tool) => tool.name)).toEqual(['read', 'run']);
    }
  });

  const refusal = (argv: readonly string[]): string => {
    const result = checkStartup(argv);
    if (result.ok) throw new Error('expected a startup refusal');
    expect(result.reason).not.toContain('\n');
    return result.reason;
  };

  test('wrong argument count', () => {
    expect(refusal([])).toBe('expected exactly one argument (the manifest JSON), got 0');
    expect(refusal(['{}', '{}'])).toBe('expected exactly one argument (the manifest JSON), got 2');
  });

  test('bad JSON', () => {
    expect(refusal(['{not json'])).toMatch(/^invalid manifest: /);
  });

  test('an unknown manifest key', () => {
    const manifest = { ...manifestFor(scratch()), extra: 1 };
    expect(refusal([JSON.stringify(manifest)])).toMatch(/^invalid manifest: /);
  });

  test('a symlinked workspace → realpath mismatch', () => {
    const dir = scratch();
    mkdirSync(join(dir, 'real'));
    symlinkSync(join(dir, 'real'), join(dir, 'link'));
    const manifest = manifestFor(join(dir, 'link'));
    expect(refusal([JSON.stringify(manifest)])).toBe(
      `workspace realpath mismatch: manifest '${join(dir, 'link')}', realpath '${join(dir, 'real')}'`,
    );
  });

  test('a non-directory workspace', () => {
    const file = join(scratch(), 'file.txt');
    writeFileSync(file, 'x');
    expect(refusal([JSON.stringify(manifestFor(file))])).toBe(
      `workspace '${file}' is not a directory`,
    );
  });

  test('a missing workspace', () => {
    const missing = join(scratch(), 'missing');
    expect(refusal([JSON.stringify(manifestFor(missing))])).toMatch(/^workspace unavailable: /);
  });

  test('a manifest naming a disabled tool → surface mismatch', () => {
    const harness: HarnessConfig = {
      ...defaultHarnessConfig,
      tools: { ...defaultHarnessConfig.tools, run: { enabled: false, commandPatterns: [] } },
    };
    const manifest = manifestFor(scratch(), { harness });
    expect(refusal([JSON.stringify(manifest)])).toMatch(/^surface mismatch: .*run/);
  });
});

describe('scrubEnvironment', () => {
  test('keeps the default allowlist plus envNames and drops everything else', () => {
    const saved = { ...process.env };
    try {
      process.env['ANTHROPIC_API_KEY'] = 'secret';
      process.env['CQ_TEST_EXTRA'] = 'kept';
      process.env['CQ_TEST_OTHER'] = 'dropped';
      process.env['PATH'] ??= '/usr/bin:/bin';
      const path = process.env['PATH'];
      scrubEnvironment(['CQ_TEST_EXTRA']);
      expect(process.env['ANTHROPIC_API_KEY']).toBeUndefined();
      expect(process.env['CQ_TEST_OTHER']).toBeUndefined();
      expect(process.env['CQ_TEST_EXTRA']).toBe('kept');
      expect(process.env['PATH']).toBe(path);
    } finally {
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, saved);
    }
  });
});

describe('lifecycle hardening (improvement pass)', () => {
  test('a reused in-flight id is refused with -32600 and the first call still completes', async () => {
    const io = startServer(surfaceFor());
    io.send(request(7, 'tools/call', { name: 'run', arguments: { command: 'sleep 1' } }));
    io.send(request(7, 'tools/call', { name: 'run', arguments: { command: 'echo dup' } }));
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
});
