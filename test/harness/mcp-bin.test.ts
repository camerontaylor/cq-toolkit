// `cq-harness-mcp` process-level tests — W1.4 (src/harness/mcp/bin.ts).
// The server runs as a REAL child process straight from the TypeScript
// sources (`node --import test/helpers/ts-source-loader.mjs bin.ts …`), so
// these pin what only a process can show:
//   - exit statuses: startup refusal → 78 with exactly ONE stderr line and
//     no stdout; stdin EOF → 0; an oversized line → 65; SIGTERM → 143 (or
//     the signal) after killing the in-flight `run` process group — a forked
//     GRANDCHILD dies with it;
//   - the ENV SCRUB: a provider credential in the server's environment never
//     reaches a `run` child, while PATH and a manifest envNames entry do;
//   - SDK ROUND-TRIP CONFORMANCE: the official @modelcontextprotocol/sdk
//     Client negotiates, lists exactly the served tools with strict schemas,
//     gets a read result, a denial (isError), and an error for an unlisted
//     tool.
import { spawn } from 'node:child_process';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { describe, expect, onTestFinished, test } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { HarnessManifestSchema } from '../../src/harness/surface.js';
import type { HarnessManifest } from '../../src/harness/surface.js';

const LOADER = fileURLToPath(new URL('../helpers/ts-source-loader.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../../src/harness/mcp/bin.ts', import.meta.url));

/** A realpath'd scratch workspace (macOS /var → /private/var), removed after the test. */
function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-mcp-bin-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function manifestFor(
  workspace: string,
  commandPatterns: string[] = [],
  over: Partial<HarnessManifest> = {},
): HarnessManifest {
  const harness: HarnessConfig = {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      run: { enabled: true, commandPatterns, timeoutMs: 60_000, maxOutputChars: 100_000 },
    },
  };
  return HarnessManifestSchema.parse({
    v: 1,
    workspace,
    sandbox: 'workspace-write',
    tools: ['read', 'run'],
    harness,
    envNames: [],
    ...over,
  });
}

/** The parent env minus the passthrough knob (which would widen the scrub). */
function baseEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && name !== 'CQ_RUN_ENV_PASSTHROUGH') env[name] = value;
  }
  return { ...env, ...extra };
}

interface ServerProcess {
  child: ChildProcessWithoutNullStreams;
  stdout(): string;
  stderr(): string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  send(message: Record<string, unknown>): void;
  /** The first stdout JSON message with this id. */
  response(id: number, timeoutMs?: number): Promise<Record<string, unknown>>;
}

/** Spawn the server from source with `args` (normally one manifest JSON string). */
function startBin(args: string[], env: Record<string, string> = baseEnv()): ServerProcess {
  const child = spawn(process.execPath, ['--import', LOADER, BIN, ...args], {
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (chunk: Buffer) => {
    out += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    err += chunk.toString('utf8');
  });
  child.stdin.on('error', () => {}); // EPIPE after the server exits is expected in some tests
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((settle) => {
    child.on('close', (code, signal) => settle({ code, signal }));
  });
  onTestFinished(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });
  const messages = (): Array<Record<string, unknown>> =>
    out
      .split('\n')
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    send(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async response(id, timeoutMs = 10_000) {
      return pollFor(async () => messages().find((message) => message['id'] === id), timeoutMs);
    },
  };
}

/** Poll `probe` until it yields a value (not undefined) or `timeoutMs` passes. */
async function pollFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('pollFor: timed out');
    await new Promise((settle) => setTimeout(settle, 25));
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

const textOf = (response: Record<string, unknown>): string =>
  (response['result'] as { content: Array<{ text: string }> }).content[0]?.text ?? '';

describe('startup refusal', () => {
  test.each([
    ['no arguments', (): string[] => []],
    ['invalid JSON', (): string[] => ['{nope']],
    [
      'a symlinked workspace',
      (): string[] => {
        const dir = scratch();
        mkdirSync(join(dir, 'real'));
        symlinkSync(join(dir, 'real'), join(dir, 'link'));
        return [JSON.stringify(manifestFor(join(dir, 'link')))];
      },
    ],
  ])(
    '%s → exit 78, one stderr line, no stdout',
    async (_label, argv) => {
      const server = startBin(argv());
      const { code } = await server.exited;
      expect(code).toBe(78);
      expect(server.stdout()).toBe('');
      const lines = server
        .stderr()
        .split('\n')
        .filter((line) => line !== '');
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/^cq-harness-mcp: refusing to start — /);
    },
    20_000,
  );
});

describe('lifetime', () => {
  test('stdin EOF exits 0 after flushing the last response', async () => {
    const server = startBin([JSON.stringify(manifestFor(scratch()))]);
    server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    server.child.stdin.end();
    expect(await server.exited).toEqual({ code: 0, signal: null });
    expect(JSON.parse(server.stdout().trim())).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
  }, 20_000);

  test('an oversized line exits 65 without answering it', async () => {
    const server = startBin([JSON.stringify(manifestFor(scratch()))]);
    server.child.stdin.write('x'.repeat(1_048_576 + 1024)); // > 1 MiB, no newline
    const { code } = await server.exited;
    expect(code).toBe(65);
    expect(server.stdout()).toBe('');
    expect(server.stderr()).toContain('protocol break');
  }, 20_000);

  test.skipIf(process.platform === 'win32')(
    'SIGTERM exits and kills the in-flight run process group (grandchild included)',
    async () => {
      const workspace = scratch();
      const server = startBin([JSON.stringify(manifestFor(workspace, ['re:^sh -c .*$']))]);
      server.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
      await server.response(1); // server is up and serving
      server.send({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'run',
          arguments: { command: "sh -c 'sleep 60 & echo $! > pid.txt; wait'" },
        },
      });
      const pid = await pollFor(async () => {
        const text = (() => {
          try {
            return readFileSync(join(workspace, 'pid.txt'), 'utf8');
          } catch {
            return '';
          }
        })();
        return text.endsWith('\n') ? Number(text.trim()) : undefined;
      });
      expect(alive(pid)).toBe(true);
      server.child.kill('SIGTERM');
      const { code, signal } = await server.exited;
      expect(code === 143 || signal === 'SIGTERM').toBe(true);
      await pollFor(async () => (alive(pid) ? undefined : true), 2_000);
      // The cancelled call is never answered.
      expect(server.stdout()).not.toContain('"id":2');
    },
    20_000,
  );
});

describe('env scrub', () => {
  test('a provider credential never reaches a run child; PATH and envNames do', async () => {
    const workspace = scratch();
    const server = startBin(
      [JSON.stringify(manifestFor(workspace, ['env'], { envNames: ['CQ_TEST_KEEP'] }))],
      baseEnv({ ANTHROPIC_API_KEY: 'secret', CQ_TEST_KEEP: 'kept', CQ_TEST_DROP: 'dropped' }),
    );
    server.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'run', arguments: { command: 'env' } },
    });
    const text = textOf(await server.response(1));
    expect(text.startsWith('exit 0')).toBe(true);
    expect(text).not.toContain('ANTHROPIC_API_KEY');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('CQ_TEST_DROP');
    expect(text).toContain('CQ_TEST_KEEP=kept');
    expect(text).toMatch(/^PATH=/m);
    server.child.stdin.end();
    expect((await server.exited).code).toBe(0);
  }, 20_000);
});

describe('SDK round-trip conformance (@modelcontextprotocol/sdk Client)', () => {
  test('negotiates, lists, calls, denies, and rejects an unlisted tool', async () => {
    const workspace = scratch();
    writeFileSync(join(workspace, 'a.txt'), 'alpha');
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', LOADER, BIN, JSON.stringify(manifestFor(workspace))],
      stderr: 'pipe',
    });
    const client = new Client({ name: 'cq-conformance', version: '0.0.0' });
    try {
      await client.connect(transport);
      expect(client.getServerVersion()?.name).toBe('cq-harness');
      expect(client.getServerCapabilities()?.tools).toEqual({ listChanged: false });

      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(['read', 'run']);
      for (const tool of tools) {
        expect(tool.inputSchema.type).toBe('object');
        expect(tool.inputSchema['additionalProperties']).toBe(false);
      }

      const read = await client.callTool({ name: 'read', arguments: { path: 'a.txt' } });
      expect(read.isError).toBeFalsy();
      expect(read.content).toEqual([{ type: 'text', text: 'alpha' }]);

      const denied = await client.callTool({ name: 'read', arguments: { path: '../outside' } });
      expect(denied.isError).toBe(true);
      const deniedContent = denied.content as Array<{ type: string; text: string }>;
      expect(deniedContent[0]?.text.startsWith('path escape:')).toBe(true);

      await expect(client.callTool({ name: 'edit', arguments: {} })).rejects.toThrow(
        /unknown tool 'edit'/,
      );
    } finally {
      await client.close();
    }
  }, 30_000);
});
