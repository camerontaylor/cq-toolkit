// The ai-sdk default providers' HTTP bound (S7 attempt F, partition 20).
//
// Node's bundled fetch gives up waiting for response headers after undici's
// default 300 s, so a non-streaming request to a reasoning model died there
// regardless of the configured step bound. The default providers now fetch
// through a per-driver undici dispatcher whose header/body timeouts track
// `stepTimeoutMs` (+ a margin, so the SDK's step timeout fires first).
// Scaled down: a local server that stalls before sending headers stands in
// for the provider, and short bounds stand in for 300 s / 20 min.
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
