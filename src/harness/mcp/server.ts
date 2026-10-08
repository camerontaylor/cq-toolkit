// The `cq-harness-mcp` stdio server — W1.4 (RS-12 design, ADR-0002 Annex
// A.3). Serves ONE bound harness surface (../surface.ts) over MCP's stdio
// transport. It is how the subprocess lane's `claude` CLI reaches the
// harness executors: the CLI launches this server from the driver's
// per-run MCP config, with every builtin tool disabled (`--tools ""`).
//
// HAND-ROLLED CLOSED SUBSET of JSON-RPC 2.0 — zero runtime dependencies
// (`@modelcontextprotocol/sdk` is a devDependency used only as the
// conformance CLIENT in tests). Exactly these methods exist:
//   initialize                → { protocolVersion, capabilities:{tools:
//                                {listChanged:false}}, serverInfo }; the
//                                client's version is echoed when supported,
//                                else the newest supported one is answered
//   notifications/initialized → nothing
//   notifications/cancelled   → abort the in-flight call with that id (its
//                                `run` process group is killed); no
//                                response is sent for a cancelled request
//   ping                      → {}
//   tools/list                → the served surface only, strict JSON
//                                Schemas, no pagination
//   tools/call                → surface.call → the CallToolResult; an
//                                unlisted name or malformed params → -32602
//   any other request → -32601; any other notification → ignored;
//   unparseable line → -32700 (id null); a batch array or non-object →
//   -32600. The server declares no resources/prompts/logging/completions/
//   sampling/elicitation/tasks capability, so none of those paths exist.
//
// FRAMING: UTF-8, one JSON message per line; stdout carries protocol only
// (diagnostics go to stderr, via the caller). An inbound line longer than
// `maxLineBytes` (1 MiB default) is a PROTOCOL BREAK: the server reports it
// and ends — it never truncates.
//
// LIFETIME: `serveStdio` resolves when input ends (EOF) or on a protocol
// break, after aborting every in-flight call. `shutdown()` does the same on
// demand (the bin's SIGTERM/SIGINT path). The server holds no session
// state: the driver is the only writer of session records.
import type { Readable, Writable } from 'node:stream';
import type { HarnessSurface } from '../surface.js';
import { HARNESS_MCP_SERVER_NAME } from '../surface.js';

/**
 * MCP protocol revisions this server speaks, oldest → newest (the schema
 * directory's revisions as of 2026-09-25). The tools subset used here is
 * unchanged across all of them.
 */
export const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = Object.freeze([
  '2024-11-05',
  '2025-03-26',
  '2025-06-18',
  '2025-11-25',
  '2026-07-28',
]);

/** The newest supported revision — answered when the client asks for an unknown one. */
export const LATEST_PROTOCOL_VERSION = '2026-07-28';

/**
 * The server version in `serverInfo`. Kept in lockstep with the root
 * `package.json` `version` (the same convention as the acp lane's client
 * version).
 */
export const SERVER_VERSION = '1.0.1';

/** The inbound line cap: 1 MiB. */
export const DEFAULT_MAX_LINE_BYTES = 1_048_576;

/** JSON-RPC error codes this server emits. */
export const JSONRPC_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
});

/** Server options — all optional. */
export interface ServeOptions {
  /** Inbound line cap in bytes. Default DEFAULT_MAX_LINE_BYTES. */
  maxLineBytes?: number;
  /** Diagnostics sink (one line per call). Default: none. */
  log?: (line: string) => void;
}

/** Why the serve loop ended. */
export type ServeEnd = 'eof' | 'oversized-line' | 'shutdown';

/** A running server: its end promise plus an on-demand shutdown. */
export interface StdioServer {
  /** Resolves once the loop ended and every in-flight call was aborted. */
  readonly done: Promise<ServeEnd>;
  /** Abort every in-flight call and end the loop (idempotent). */
  shutdown(): void;
}

type JsonRpcId = string | number;

/** A well-formed JSON-RPC id: a string or an integer. */
function isId(value: unknown): value is JsonRpcId {
  return typeof value === 'string' || (typeof value === 'number' && Number.isInteger(value));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Serve `surface` over newline-delimited JSON-RPC on `input`/`output`.
 * Requests are answered as they complete (a `ping` is answered while a
 * `tools/call` is running); tool calls themselves run one at a time inside
 * the surface.
 */
export function serveStdio(
  surface: HarnessSurface,
  input: Readable,
  output: Writable,
  options: ServeOptions = {},
): StdioServer {
  const maxLineBytes = options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const log = options.log ?? ((): void => {});
  /** In-flight tool calls by request id → their abort handle. */
  const inflight = new Map<JsonRpcId, AbortController>();
  let ended = false;
  let finish!: (end: ServeEnd) => void;
  const done = new Promise<ServeEnd>((resolve) => {
    finish = resolve;
  });

  const send = (message: Record<string, unknown>): void => {
    if (ended) return;
    output.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
  };
  const reply = (id: JsonRpcId, result: unknown): void => send({ id, result });
  const fail = (id: JsonRpcId | null, code: number, message: string): void =>
    send({ id, error: { code, message } });

  const end = (why: ServeEnd): void => {
    if (ended) return;
    ended = true;
    for (const controller of inflight.values()) controller.abort();
    inflight.clear();
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('error', onEnd);
    output.off('error', onEnd);
    finish(why);
  };

  const handleToolsCall = (id: JsonRpcId, params: Record<string, unknown> | undefined): void => {
    const name = params?.['name'];
    if (typeof name !== 'string') {
      fail(id, JSONRPC_ERRORS.invalidParams, 'tools/call: params.name must be a string');
      return;
    }
    if (!surface.has(name)) {
      fail(id, JSONRPC_ERRORS.invalidParams, `tools/call: unknown tool '${name}'`);
      return;
    }
    const rawArgs = params?.['arguments'];
    if (rawArgs !== undefined && asRecord(rawArgs) === undefined) {
      fail(id, JSONRPC_ERRORS.invalidParams, 'tools/call: params.arguments must be an object');
      return;
    }
    if (inflight.has(id)) {
      // A reused in-flight id would orphan the first call's abort handle.
      fail(id, JSONRPC_ERRORS.invalidRequest, 'invalid request: id already in flight');
      return;
    }
    const controller = new AbortController();
    inflight.set(id, controller);
    surface.call(name, rawArgs ?? {}, { signal: controller.signal }).then(
      ({ result }) => {
        const cancelled = controller.signal.aborted;
        if (inflight.get(id) === controller) inflight.delete(id);
        if (!cancelled) reply(id, result);
      },
      (err: unknown) => {
        if (inflight.get(id) === controller) inflight.delete(id);
        log(`cq-harness-mcp: tools/call '${name}' failed: ${String(err)}`);
        if (!controller.signal.aborted) {
          fail(id, JSONRPC_ERRORS.internal, 'tools/call: internal error');
        }
      },
    );
  };

  const handleMessage = (raw: string): void => {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      fail(null, JSONRPC_ERRORS.parse, 'parse error');
      return;
    }
    const message = asRecord(data);
    if (message === undefined) {
      // A batch (arrays are not part of MCP since 2025-06-18) or a scalar.
      fail(null, JSONRPC_ERRORS.invalidRequest, 'invalid request: expected one JSON-RPC object');
      return;
    }
    const id = message['id'];
    const method = message['method'];
    if (message['jsonrpc'] !== '2.0' || typeof method !== 'string') {
      // A response to a request we never sent carries no method: ignore it.
      if (method === undefined && ('result' in message || 'error' in message)) return;
      fail(isId(id) ? id : null, JSONRPC_ERRORS.invalidRequest, 'invalid request');
      return;
    }
    const params = asRecord(message['params']);
    if (id === undefined) {
      // Notifications: never answered.
      if (method === 'notifications/cancelled') {
        const target = params?.['requestId'];
        if (isId(target)) inflight.get(target)?.abort();
      }
      return;
    }
    if (!isId(id)) {
      fail(null, JSONRPC_ERRORS.invalidRequest, 'invalid request: bad id');
      return;
    }
    switch (method) {
      case 'initialize': {
        const requested = params?.['protocolVersion'];
        const protocolVersion =
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: HARNESS_MCP_SERVER_NAME, version: SERVER_VERSION },
        });
        return;
      }
      case 'ping':
        reply(id, {});
        return;
      case 'tools/list':
        reply(id, {
          tools: surface.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputJsonSchema,
          })),
        });
        return;
      case 'tools/call':
        handleToolsCall(id, params);
        return;
      default:
        fail(id, JSONRPC_ERRORS.methodNotFound, `method not found: ${method}`);
    }
  };

  // Byte-accurate line assembly: the cap counts UTF-8 bytes of the pending
  // (unterminated) line, so a single oversized line is refused before it is
  // ever buffered past the cap.
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  const onData = (chunk: Buffer | string): void => {
    let buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    while (!ended) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) {
        pendingBytes += buf.length;
        if (pendingBytes > maxLineBytes) {
          log(`cq-harness-mcp: inbound line exceeds ${maxLineBytes} bytes — protocol break`);
          end('oversized-line');
          return;
        }
        pending.push(buf);
        return;
      }
      const head = buf.subarray(0, nl);
      if (pendingBytes + head.length > maxLineBytes) {
        log(`cq-harness-mcp: inbound line exceeds ${maxLineBytes} bytes — protocol break`);
        end('oversized-line');
        return;
      }
      const line = Buffer.concat([...pending, head])
        .toString('utf8')
        .replace(/\r$/, '');
      pending = [];
      pendingBytes = 0;
      buf = buf.subarray(nl + 1);
      if (line.trim() !== '') handleMessage(line);
    }
  };
  const onEnd = (): void => end('eof');
  input.on('data', onData);
  input.on('end', onEnd);
  input.on('error', onEnd);
  // A dead peer surfaces as EPIPE on output: treat it as EOF so in-flight
  // calls are aborted (their process groups killed) instead of crashing.
  output.on('error', onEnd);

  return {
    done,
    shutdown(): void {
      end('shutdown');
    },
  };
}
