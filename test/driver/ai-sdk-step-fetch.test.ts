// The ai-sdk default providers' HTTP bound (S7 attempt F, partition 20).
//
// Node's bundled fetch gives up waiting for response headers after undici's
// default 300 s, so a non-streaming request to a reasoning model died there
// regardless of the configured step bound. The default providers now fetch
// through a per-driver undici dispatcher whose header/body timeouts track
// `stepTimeoutMs` (+ a margin, so the SDK's step timeout fires first).
// Scaled down: a local server that stalls before sending headers stands in
// for the provider, and short bounds stand in for 300 s / 20 min.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const agents = vi.hoisted(() => ({
  options: [] as unknown[],
  /** The real MockAgent (a supplied transport stand-in), captured before it is replaced. */
  MockAgent: undefined as unknown as typeof import('undici').MockAgent,
}));
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  agents.MockAgent = actual.MockAgent;
  class RecordingAgent extends actual.Agent {
    constructor(options?: ConstructorParameters<typeof actual.Agent>[0]) {
      agents.options.push(options);
      super(options);
    }
  }
  return { ...actual, Agent: RecordingAgent };
});

const { AiSdkDriver } = await import('../../src/driver/ai-sdk/index.js');
const { getGlobalDispatcher, setGlobalDispatcher } = await import('undici');
const { createDriverFactory } = await import('../../src/driver/factory.js');
const { createStepFetch } = await import('../../src/driver/ai-sdk/step-fetch.js');

const servers: Server[] = [];
const scratch: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  agents.options.length = 0;
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
  }
  await Promise.all(scratch.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A local provider stand-in: waits `stallMs` (forever when undefined) before answering. */
async function stallingServer(stallMs?: number): Promise<{ url: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    hits += 1;
    request.resume();
    if (stallMs === undefined) return;
    setTimeout(() => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          id: 'chatcmpl-1',
          object: 'chat.completion',
          created: 0,
          model: 'glm-test',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
      );
    }, stallMs);
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${String(port)}`, hits: () => hits };
}

describe('createStepFetch', () => {
  test('waits for headers only as long as the configured bound, not undici’s 300 s default', async () => {
    const { url } = await stallingServer();
    const started = Date.now();
    const failure = await createStepFetch(
      300,
      0,
    )(url).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as { cause?: { code?: string } }).cause?.code).toBe('UND_ERR_HEADERS_TIMEOUT');
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  test('a stall longer than a smaller bound succeeds under a larger configured bound', async () => {
    // undici's socket timers tick at ~1 s, so the scale is seconds. Keep the
    // stall more than a tick clear of the smaller bound: the 1 000 ms headers
    // timeout can fire ~1 s late (~2 000 ms), so a slower answer could win the
    // race on a jittery CI runner. 4 000 ms leaves ~2 s of slack for the
    // rejection, and the 6 000 ms bound below still exceeds the stall.
    const { url } = await stallingServer(4_000);
    // The smaller bound stands in for the old 300 s default…
    await expect(createStepFetch(1_000, 0)(url)).rejects.toThrow();
    // …and the configured bound replaces it.
    const response = await createStepFetch(6_000, 0)(url);
    expect(response.status).toBe(200);
  });

  test('honors Node startup proxy settings in a fresh process', async () => {
    let connects = 0;
    const proxy = createServer();
    proxy.on('connect', (_request, socket) => {
      connects++;
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      socket.once('data', () =>
        socket.end('HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nproxied'),
      );
    });
    servers.push(proxy);
    await new Promise<void>((done) => proxy.listen(0, '127.0.0.1', done));
    const { port } = proxy.address() as AddressInfo;
    const moduleUrl = pathToFileURL(join(process.cwd(), 'src/driver/ai-sdk/step-fetch.ts')).href;
    const source = `import { createStepFetch } from ${JSON.stringify(moduleUrl)}; const r = await createStepFetch(2000)('http://proxy-only.invalid/'); console.log(await r.text());`;
    const result = await promisify(execFile)(
      process.execPath,
      ['--experimental-transform-types', '--input-type=module', '-e', source],
      {
        env: {
          ...process.env,
          NODE_USE_ENV_PROXY: '1',
          HTTP_PROXY: `http://127.0.0.1:${String(port)}`,
          http_proxy: `http://127.0.0.1:${String(port)}`,
          NO_PROXY: '',
          no_proxy: '',
        },
        timeout: 10_000,
      },
    );
    expect(result.stdout.trim()).toBe('proxied');
    expect(connects).toBe(1);
  });

  test('uses the configured global dispatcher', async () => {
    const previous = getGlobalDispatcher();
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://global-proxy.invalid')
      .intercept({ path: '/', method: 'GET' })
      .reply(200, 'global');
    setGlobalDispatcher(transport);
    try {
      const response = await createStepFetch(1_000, 0)('http://global-proxy.invalid');
      expect(await response.text()).toBe('global');
      transport.assertNoPendingInterceptors();
    } finally {
      setGlobalDispatcher(previous);
      await transport.close();
    }
  });

  test('a native Request input is unpacked, not stringified', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://request-input.invalid')
      .intercept({ path: '/v1/x', method: 'POST', headers: { 'content-type': 'application/json' } })
      .reply(200, 'from-request');
    const request = new Request('http://request-input.invalid/v1/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    const response = await createStepFetch(1_000, 0, transport)(request);
    expect(await response.text()).toBe('from-request');
    transport.assertNoPendingInterceptors();
    await transport.close();
  });

  test('a native Request keeps its redirect policy (redirect: "error" rejects a redirect)', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://redirect.invalid')
      .intercept({ path: '/v1/x', method: 'GET' })
      .reply(302, '', { headers: { location: 'http://redirect.invalid/v1/y' } });
    // The target answers, so only the Request's own redirect policy can reject.
    transport
      .get('http://redirect.invalid')
      .intercept({ path: '/v1/y', method: 'GET' })
      .reply(200, 'followed');
    const request = new Request('http://redirect.invalid/v1/x', { redirect: 'error' });
    // A redirect failure, not merely any throw: without the Request unpacking undici throws
    // ERR_INVALID_URL for "[object Request]", which a bare rejects.toThrow() would accept.
    const failure = await createStepFetch(
      1_000,
      0,
      transport,
    )(request).then(
      () => undefined,
      (error: unknown) => error as { message: string; cause?: { message?: string; code?: string } },
    );
    expect(failure).toBeDefined();
    expect(failure?.cause?.code).not.toBe('ERR_INVALID_URL');
    expect(`${failure?.message} ${failure?.cause?.message ?? ''}`).toMatch(/redirect/i);
    await transport.close();
  });

  test('a native Request keeps its integrity metadata (a digest mismatch rejects)', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://integrity.invalid')
      .intercept({ path: '/v1/x', method: 'GET' })
      .reply(200, 'tampered bytes');
    // sha256 of different bytes: undici enforces SRI only when it is forwarded.
    const wrong = `sha256-${'A'.repeat(43)}=`;
    const request = new Request('http://integrity.invalid/v1/x', { integrity: wrong });
    const failure = await createStepFetch(
      1_000,
      0,
      transport,
    )(request).then(
      () => undefined,
      (error: unknown) => error as { message: string; cause?: { message?: string } },
    );
    // An integrity mismatch specifically, not any transport error.
    expect(failure).toBeDefined();
    expect(`${failure?.message} ${failure?.cause?.message ?? ''}`).toMatch(/integrity/i);
    await transport.close();
  });

  test('a native Request whose integrity digest matches the body succeeds (control)', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://integrity.invalid')
      .intercept({ path: '/v1/x', method: 'GET' })
      .reply(200, 'genuine bytes');
    const digest = createHash('sha256').update('genuine bytes').digest('base64');
    const request = new Request('http://integrity.invalid/v1/x', {
      integrity: `sha256-${digest}`,
    });
    const response = await createStepFetch(1_000, 0, transport)(request);
    expect(await response.text()).toBe('genuine bytes');
    await transport.close();
  });

  test('a native Request with the default redirect policy follows the redirect to the target', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://redirect.invalid')
      .intercept({ path: '/v1/x', method: 'GET' })
      .reply(302, '', { headers: { location: 'http://redirect.invalid/v1/y' } });
    transport
      .get('http://redirect.invalid')
      .intercept({ path: '/v1/y', method: 'GET' })
      .reply(200, 'followed');
    const response = await createStepFetch(
      1_000,
      0,
      transport,
    )(new Request('http://redirect.invalid/v1/x'));
    expect(await response.text()).toBe('followed');
    transport.assertNoPendingInterceptors();
    await transport.close();
  });

  test('aborting while a native Request body is still streaming rejects instead of hanging', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      }, // never closes
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request('http://stream.invalid/v1/x', {
      method: 'POST',
      body,
      duplex: 'half',
    } as RequestInit);
    const controller = new AbortController();
    const pending = createStepFetch(1_000, 0, transport)(request, { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('caller gave up')), 50);
    await expect(pending).rejects.toThrow('caller gave up');
    expect(cancelled).toBe(true);
    await transport.close();
  });

  /** Fail (not hang) when a regression leaves the call pending. */
  const within = <T>(work: Promise<T>, ms = 1_000): Promise<T> =>
    Promise.race([
      work,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`still pending after ${String(ms)}ms`)), ms),
      ),
    ]);

  test('an explicit init.body wins: an open streaming Request body is never buffered', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://init-body.invalid')
      .intercept({ path: '/v1/x', method: 'POST' })
      .reply(200, 'sent');
    const open = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'));
      }, // never closes: buffering it first would hang
    });
    const request = new Request('http://init-body.invalid/v1/x', {
      method: 'POST',
      body: open,
      duplex: 'half',
    } as RequestInit);
    const response = await within(
      createStepFetch(1_000, 0, transport)(request, { body: 'from-init' }),
    );
    expect(await response.text()).toBe('sent');
    await transport.close();
  });

  test('an explicit init.body wins over an already-consumed Request body', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://init-body.invalid')
      .intercept({ path: '/v1/x', method: 'POST' })
      .reply(200, 'sent');
    const request = new Request('http://init-body.invalid/v1/x', { method: 'POST', body: 'old' });
    await request.text(); // the body is now used; reading it again would reject "locked"
    const response = await within(
      createStepFetch(1_000, 0, transport)(request, { body: 'from-init' }),
    );
    expect(await response.text()).toBe('sent');
    await transport.close();
  });

  test('init.body undefined is "not set": the Request body is still sent', async () => {
    let received = '';
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', (chunk: Buffer) => (received += chunk.toString()));
      request.on('end', () => response.end('sent'));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const request = new Request(`http://127.0.0.1:${String(port)}/v1/x`, {
      method: 'POST',
      body: 'orig',
    });
    const response = await within(
      createStepFetch(1_000)(request, { body: undefined } as unknown as RequestInit),
    );
    expect(await response.text()).toBe('sent');
    expect(received).toBe('orig');
  });

  test('init.body null is "not set": the Request body is still sent', async () => {
    let received = '';
    const server = createServer((request: IncomingMessage, response: ServerResponse) => {
      request.on('data', (chunk: Buffer) => (received += chunk.toString()));
      request.on('end', () => response.end('sent'));
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    const { port } = server.address() as AddressInfo;
    const request = new Request(`http://127.0.0.1:${String(port)}/v1/x`, {
      method: 'POST',
      body: 'orig',
    });
    const response = await within(createStepFetch(1_000)(request, { body: null } as RequestInit));
    expect(await response.text()).toBe('sent');
    expect(received).toBe('orig');
  });

  test('init.signal null means no signal: an aborted Request signal does not reject', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://null-signal.invalid')
      .intercept({ path: '/v1/x', method: 'POST' })
      .reply(200, 'sent');
    const request = new Request('http://null-signal.invalid/v1/x', {
      method: 'POST',
      body: 'payload',
      signal: AbortSignal.abort(new Error('request signal aborted')),
    });
    const response = await within(createStepFetch(1_000, 0, transport)(request, { signal: null }));
    expect(await response.text()).toBe('sent');
    await transport.close();
  });

  test('init.signal undefined is "not set": the Request signal still aborts the call', async () => {
    const { url } = await stallingServer(); // never answers
    const controller = new AbortController();
    const request = new Request(`${url}/v1/x`, {
      method: 'POST',
      body: 'payload',
      signal: controller.signal,
    });
    const pending = createStepFetch(10_000)(request, {
      signal: undefined,
    } as unknown as RequestInit);
    setTimeout(() => controller.abort(new Error('request signal fired')), 50);
    await expect(within(pending)).rejects.toThrow('request signal fired');
  });

  test('undefined init.method and init.headers keep the Request method and headers', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://undef-init.invalid')
      .intercept({ path: '/v1/x', method: 'POST', headers: { 'x-from-request': 'yes' } })
      .reply(200, 'kept');
    const request = new Request('http://undef-init.invalid/v1/x', {
      method: 'POST',
      headers: { 'x-from-request': 'yes' },
      body: 'payload',
    });
    const response = await within(
      createStepFetch(
        1_000,
        0,
        transport,
      )(request, {
        method: undefined,
        headers: undefined,
      } as unknown as RequestInit),
    );
    expect(await response.text()).toBe('kept');
    transport.assertNoPendingInterceptors();
    await transport.close();
  });

  test('an already-consumed Request body with no init.body rejects instead of sending ""', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://used-body.invalid')
      .intercept({ path: '/v1/x', method: 'POST' })
      .reply(200, 'sent')
      .persist();
    const request = new Request('http://used-body.invalid/v1/x', { method: 'POST', body: 'old' });
    await request.text();
    await expect(within(createStepFetch(1_000, 0, transport)(request))).rejects.toThrow(TypeError);
    await transport.close();
  });

  test('a partly read Request body rejects instead of sending the remaining bytes', async () => {
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://partial-body.invalid')
      .intercept({ path: '/v1/x', method: 'POST' })
      .reply(200, 'sent')
      .persist();
    const encoder = new TextEncoder();
    const request = new Request('http://partial-body.invalid/v1/x', {
      method: 'POST',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('head-'));
          controller.enqueue(encoder.encode('tail'));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const reader = (request.body as ReadableStream<Uint8Array>).getReader();
    await reader.read(); // consume "head-" only
    reader.releaseLock();
    await expect(within(createStepFetch(1_000, 0, transport)(request))).rejects.toThrow(TypeError);
    await transport.close();
  });

  test('a supplied transport is used as is, never replaced by a minted Agent', async () => {
    // A supplied dispatcher (an operator's proxy agent, stood in for by a
    // MockAgent) must carry the request itself: the driver must not mint its
    // own Agent, which in a proxy-only environment would connect directly.
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://proxy-only.invalid')
      .intercept({ path: '/', method: 'GET' })
      .reply(200, 'via-configured-transport');
    const response = await createStepFetch(1_000, 0, transport)('http://proxy-only.invalid');
    expect(await response.text()).toBe('via-configured-transport');
    // No omission fallback: the owned Agent was never constructed.
    expect(agents.options).toEqual([]);
    await transport.close();
  });
});

describe('ai-sdk default providers', () => {
  const run = async (stepTimeoutMs: number, url: string) => {
    vi.stubEnv('ZAI_API_KEY', 'test-key');
    vi.stubEnv('ZAI_BASE_URL', url);
    const dir = await mkdtemp(join(tmpdir(), 'aidrv-fetch-'));
    scratch.push(dir);
    const driver = new AiSdkDriver({ stepTimeoutMs, sessionsDir: join(dir, 'sessions') });
    const invocation = {
      prompt: 'say ok',
      modelSpec: { provider: 'zai', model: 'glm-test' },
      toolPolicy: { allow: [], mode: 'none' as const },
      sandboxPolicy: { level: 'none' as const },
      budget: {},
    };
    return { driver, invocation };
  };

  test('factory forwards the configured dispatcher to the default provider', async () => {
    vi.stubEnv('ZAI_API_KEY', 'test-key');
    vi.stubEnv('ZAI_BASE_URL', 'http://proxy-only.invalid');
    const dir = await mkdtemp(join(tmpdir(), 'aidrv-proxy-'));
    scratch.push(dir);
    const transport = new agents.MockAgent();
    transport.disableNetConnect();
    transport
      .get('http://proxy-only.invalid')
      .intercept({ path: '/chat/completions', method: 'POST' })
      .reply(200, {
        id: 'chatcmpl-1',
        object: 'chat.completion',
        created: 0,
        model: 'glm-test',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    try {
      const modelSpec = { provider: 'zai', model: 'glm-test' };
      const factory = createDriverFactory({
        lanes: { aiSdk: { dispatcher: transport, sessionsDir: join(dir, 'sessions') } },
      });
      const result = await factory.resolve({ role: 'fixer', modelSpec }).driver.run({
        prompt: 'say ok',
        modelSpec,
        toolPolicy: { allow: [], mode: 'none' },
        sandboxPolicy: { level: 'none' },
        budget: {},
      });
      expect(result.stopReason).toBe('complete');
      expect(agents.options).toEqual([]);
      transport.assertNoPendingInterceptors();
    } finally {
      await transport.close();
    }
  });

  test('fetch through one dispatcher per driver bounded by stepTimeoutMs + margin', async () => {
    const server = await stallingServer(0);
    const { driver, invocation } = await run(1_500, server.url);
    expect((await driver.run(invocation)).stopReason).toBe('complete');
    expect((await driver.run(invocation)).stopReason).toBe('complete');
    expect(server.hits()).toBe(2);
    expect(agents.options).toEqual([]);
  });

  test('a provider that never answers is stopped by the step bound, not the socket', async () => {
    const server = await stallingServer();
    const { driver, invocation } = await run(1_500, server.url);
    const started = Date.now();
    const result = await driver.run(invocation);
    expect(result.stopReason).toBe('error');
    expect(result.errorClass).toBe('transient');
    expect(result.error).toContain('1500ms');
    expect(result.error).not.toContain('Headers Timeout');
    // Loose bound only: the assertions above already prove the step timeout
    // (not the socket timers) fired, and the error path after it — abort
    // propagation, session persistence, teardown — needs slack on a loaded
    // runner. 5 000 ms still fails fast if the 300 s default ever returned.
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
