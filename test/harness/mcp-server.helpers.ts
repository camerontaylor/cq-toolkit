// Split provenance: test/harness/mcp-server.test.ts was split into the
// mcp-server.*.test.ts subject files; this module holds their shared
// in-memory PassThrough server harness, request builder and manifest
// fixtures (no tests). The original header's pins — the CLOSED JSON-RPC
// subset, FRAMING, CONCURRENCY + CANCELLATION, STARTUP — are asserted by the
// sibling subject files. "No output" is asserted by ORDERING: the server
// handles lines in arrival order, so a ping sent after the probe must be the
// next message out.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { onTestFinished } from 'vitest';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { serveStdio } from '../../src/harness/mcp/server.js';
import type { ServeOptions } from '../../src/harness/mcp/server.js';
import { createHarnessSurface, HarnessManifestSchema } from '../../src/harness/surface.js';
import type { HarnessManifest, HarnessSurface } from '../../src/harness/surface.js';

type Message = Record<string, unknown>;

/** A realpath'd scratch workspace (macOS /var → /private/var), removed after the test. */
export function scratch(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-mcp-server-')));
  onTestFinished(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function harnessWithRun(commandPatterns: string[]): HarnessConfig {
  return {
    ...defaultHarnessConfig,
    tools: {
      ...defaultHarnessConfig.tools,
      bash: { enabled: true, commandPatterns, timeoutMs: 60_000, maxOutputChars: 10_000 },
    },
  };
}

/** Mirror of the production read renderer (tools.ts): 6-wide line numbers under a `--- path ---` header. */
export const renderRead = (path: string, body: string): string => {
  const lines = body.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return [
    '--- ' + path + ' ---',
    ...lines.map((l, i) => `${String(i + 1).padStart(6)}: ${l}`),
  ].join('\n');
};

export function manifestFor(
  workspace: string,
  over: Partial<HarnessManifest> = {},
): HarnessManifest {
  return HarnessManifestSchema.parse({
    v: 1,
    workspace,
    sandbox: 'workspace-write',
    tools: ['read', 'bash'],
    harness: harnessWithRun(['sleep', 'echo']),
    envNames: [],
    ...over,
  });
}

/** An in-memory server over PassThrough streams, with a message reader. */
export function startServer(surface: HarnessSurface, options: ServeOptions = {}) {
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

export const request = (id: number | string, method: string, params?: unknown): Message => ({
  jsonrpc: '2.0',
  id,
  method,
  ...(params !== undefined ? { params } : {}),
});

export function surfaceFor(over: Partial<HarnessManifest> = {}): HarnessSurface {
  return createHarnessSurface(manifestFor(scratch(), over));
}
