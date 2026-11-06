// Split provenance: test/driver/harness-parity.test.ts was split by subject into
// harness-parity.level1-calltool-result.test.ts, harness-parity.invalid-input.test.ts,
// harness-parity.level2-denials.test.ts and harness-parity.run-env.test.ts. This
// module holds the shared config, fixtures and the three paths' drivers — no
// tests, no describe.
//
// THE NORMATIVE two-level harness parity test — W1.4 (ADR-0002 Annex A.2).
//
// Both driver lanes serve ONE shared core (src/harness/surface.ts); only the
// transport differs. This file pins that claim at the two levels the ADR
// names:
//
//   LEVEL 1 — CallToolResult parity. One harness config, one scripted call
//   sequence (read ok, edit ok, path not allowed, path escape, file not
//   found, run ok, command not allowed, metacharacter command, and a
//   read-only-sandbox manifest's edit/run denials), run through THREE paths:
//     (a) the stdio `cq-harness-mcp` server, driven by the devDependency MCP
//         SDK Client over a real child process (the subprocess lane's
//         transport);
//     (b) the claude-agent lane's REGISTERED HANDLER, captured from the
//         driver through a mock SDK module's `tool()` and invoked by the
//         mock's `query()` (the in-process transport);
//     (c) `createHarnessSurface(manifest).call` directly (the core).
//   Every CallToolResult must be byte-identical (JSON.stringify) across the
//   three. Each path gets its OWN fresh workspace (same file contents) so
//   edits never interfere; the harness config and sandbox are the same.
//   Results carry workspace-RELATIVE text only, which is what makes
//   different workspace directories comparable — asserted below.
//
//   Schema-invalid input is asserted across the transports: the native
//   tools/call adapter receives raw arguments before the SDK's canonical
//   schema parse and routes them to the shared strict validator.
//
//   LEVEL 2 — WorkerResult.denials parity. The same sequence folded by each
//   lane: claude-agent runs the driver with the mock SDK executing the
//   scripted calls through its registered handlers; subprocess runs a REAL
//   ClaudeCodeDriver whose `spawn` override returns a fake CLI child that
//   emits realistic stream-json frames (init, tool_use, tool_result,
//   result) built from the SAME CallToolResults. Both lanes must report the
//   identical {tool, reason} list, in harness names ('read'/'edit'/'run').
//
// Every harness-parity file MUST NOT import from
// '@anthropic-ai/claude-agent-sdk' (I10).
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { realTmpDir } from '../helpers/tmp-dir.js';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, expect } from 'vitest';
import { ClaudeCodeDriver } from '../../src/driver/claude-code/index.js';
import { RoutingTableSchema as EndpointTableSchema } from '../../src/driver/claude-code/routing.js';
import type { SandboxLevel, ToolDenial, WorkerResult } from '../../src/driver/types.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { HarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';
import {
  buildManifest,
  createHarnessSurface,
  qualifiedToolName,
} from '../../src/harness/surface.js';
import type { HarnessManifest, McpCallToolResult } from '../../src/harness/surface.js';
import { CONFORMANCE_MODEL, CONFORMANCE_PROVIDER } from '../../src/driver/conformance.js';

process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

const LOADER = fileURLToPath(new URL('../helpers/ts-source-loader.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../../src/harness/mcp/bin.ts', import.meta.url));

// ---------------------------------------------------------------------------
// The one harness config + the scripted sequence
// ---------------------------------------------------------------------------

/** The SAME harness config every path binds (read/edit over note.txt + src/**, run over `echo`). */
export const HARNESS: HarnessConfig = {
  ...defaultHarnessConfig,
  tools: {
    read: { ...defaultHarnessConfig.tools.read, pathPatterns: ['note.txt', 'src/**'] },
    edit: { ...defaultHarnessConfig.tools.edit, pathPatterns: ['note.txt', 'src/**'] },
    write: { ...defaultHarnessConfig.tools.write, enabled: false, pathPatterns: [] },
    bash: { ...defaultHarnessConfig.tools.bash, commandPatterns: ['echo'] },
  },
};

type HarnessName = 'read' | 'edit' | 'run';

/** One scripted call. */
export interface Step {
  label: string;
  tool: HarnessName;
  input: Record<string, unknown>;
}

/** The workspace-write manifest's sequence. */
const WRITE_STEPS: readonly Step[] = [
  { label: 'read ok', tool: 'read', input: { path: 'note.txt' } },
  { label: 'read before edit', tool: 'read', input: { path: 'src/a.txt' } },
  {
    label: 'edit ok',
    tool: 'edit',
    input: { path: 'src/a.txt', oldText: 'alpha', newText: 'beta' },
  },
  { label: 'read after edit', tool: 'read', input: { path: 'src/a.txt' } },
  { label: 'path not allowed', tool: 'read', input: { path: 'secret.txt' } },
  { label: 'path escape (read)', tool: 'read', input: { path: '../x' } },
  {
    label: 'path escape (edit)',
    tool: 'edit',
    input: { path: '../x', oldText: 'a', newText: 'b' },
  },
  { label: 'file not found', tool: 'read', input: { path: 'src/missing.txt' } },
  { label: 'run ok', tool: 'run', input: { command: 'echo hi' } },
  { label: 'command not allowed', tool: 'run', input: { command: 'whoami' } },
  { label: 'metacharacter command', tool: 'run', input: { command: 'echo hi; whoami' } },
];

/** The read-only manifest's sequence (the sandbox denials). */
const READ_ONLY_STEPS: readonly Step[] = [
  { label: 'read-only: read ok', tool: 'read', input: { path: 'note.txt' } },
  {
    label: 'read-only: edit denied',
    tool: 'edit',
    input: { path: 'note.txt', oldText: 'hello', newText: 'bye' },
  },
  { label: 'read-only: run denied', tool: 'run', input: { command: 'echo hi' } },
];

/** The two bindings: same config, two sandbox levels. */
export const PHASES: ReadonlyArray<{ sandbox: SandboxLevel; steps: readonly Step[] }> = [
  { sandbox: 'workspace-write', steps: WRITE_STEPS },
  { sandbox: 'read-only', steps: READ_ONLY_STEPS },
];

export const NOTE_BODY = 'hello note\n';
export const A_BODY = 'alpha\n';

/** Mirror of the production read renderer (tools.ts): 6-wide line numbers under a `--- path ---` header. */
export const renderRead = (path: string, body: string): string => {
  const lines = body.split(/\r\n|\n|\r/);
  if (lines.at(-1) === '') lines.pop();
  return [
    '--- ' + path + ' ---',
    ...lines.map((l, i) => `${String(i + 1).padStart(6)}: ${l}`),
  ].join('\n');
};

// ---------------------------------------------------------------------------
// Scratch + workspace helpers
// ---------------------------------------------------------------------------

export let scratch: string;

beforeAll(async () => {
  scratch = await realTmpDir('cq-parity-');
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let workspaceCounter = 0;

/** A fresh realpath'd workspace with the fixture files (identical contents every time). */
export async function seededWorkspace(label: string): Promise<string> {
  workspaceCounter += 1;
  const dir = join(scratch, `ws-${label}-${workspaceCounter}`);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'note.txt'), NOTE_BODY);
  await writeFile(join(dir, 'src', 'a.txt'), A_BODY);
  await writeFile(join(dir, 'secret.txt'), 'not on the allowlist\n');
  return realpath(dir);
}

/** The manifest the drivers would build: the ONE manifest constructor, unrestricted policy. */
export async function manifestFor(
  workspace: string,
  sandbox: SandboxLevel,
): Promise<HarnessManifest> {
  const manifest = await buildManifest({
    workspace,
    sandbox,
    toolPolicy: { allow: [], mode: 'unrestricted' },
    harness: HARNESS,
  });
  if (manifest === undefined)
    throw new Error('empty selection — the parity config must serve tools');
  return manifest;
}

// ---------------------------------------------------------------------------
// Path (a): the stdio server via the MCP SDK Client
// ---------------------------------------------------------------------------

/**
 * The SDK client's result → the harness CallToolResult fields. Honest about
 * extras: the result must carry NO key beyond content/isError (so nothing is
 * silently stripped), and `isError` may only ever be `true` — our server
 * OMITS it on success (the SDK schema keeps an absent field absent), so an
 * `isError: false` would itself be a parity break, never normalized away.
 */
export function projectSdkResult(raw: Record<string, unknown>): McpCallToolResult {
  expect(Object.keys(raw).filter((key) => key !== 'content' && key !== 'isError')).toEqual([]);
  if ('isError' in raw) expect(raw['isError']).toBe(true);
  return {
    content: raw['content'] as McpCallToolResult['content'],
    ...(raw['isError'] === true ? { isError: true as const } : {}),
  };
}

/** Connect an SDK Client to a fresh stdio server bound to `manifest`. */
export async function stdioClient(
  manifest: HarnessManifest,
  env?: Record<string, string>,
): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', LOADER, BIN, JSON.stringify(manifest)],
    stderr: 'pipe',
    ...(env === undefined ? {} : { env }),
  });
  const client = new Client({ name: 'cq-parity', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** Run one phase's steps over stdio; returns the projected results + the workspace. */
export async function stdioPhase(
  sandbox: SandboxLevel,
  steps: readonly Step[],
): Promise<{ results: McpCallToolResult[]; workspace: string }> {
  const workspace = await seededWorkspace(`stdio-${sandbox}`);
  const client = await stdioClient(await manifestFor(workspace, sandbox));
  try {
    const results: McpCallToolResult[] = [];
    for (const step of steps) {
      const raw = await client.callTool({ name: step.tool, arguments: step.input });
      results.push(projectSdkResult(raw as Record<string, unknown>));
    }
    return { results, workspace };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// Path (b): the claude-agent native MCP callback via a mock SDK module
// ---------------------------------------------------------------------------

/** What the mock's `tool()` captured from the driver. */
interface CapturedTool {
  name: string;
  description: string;
  shape: unknown;
  inputSchema?: unknown;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

type RawToolCall = (
  request: { method: 'tools/call'; params: { name: string; arguments: unknown } },
  extra: unknown,
) => Promise<unknown>;

/**
 * A mock SDK module whose `query()` reports an HONEST init surface (derived
 * from the registered servers/tools and outputFormat), then invokes the
 * INTERCEPTED tools/call callback with the scripted inputs. Each is preceded
 * by the assistant tool_use frame the real SDK would emit. It records each
 * returned value verbatim, then yields a success result.
 */
function scriptedSdk(
  steps: ReadonlyArray<{ tool: string; input: unknown }>,
  sink: { tools: CapturedTool[]; results: unknown[] },
): Record<string, unknown> {
  let rawToolCall: RawToolCall | undefined;
  return {
    tool: (
      name: string,
      description: string,
      shape: unknown,
      handler: CapturedTool['handler'],
    ): CapturedTool => {
      const captured = { name, description, shape, handler };
      return captured;
    },
    createSdkMcpServer: (opts: { name: string; tools?: CapturedTool[] }) => {
      sink.tools = opts.tools ?? [];
      return {
        type: 'sdk',
        ...opts,
        // The actual SDK returns an McpServer instance. Its public server
        // installs the raw tools/call callback before query() starts.
        instance: {
          server: {
            setRequestHandler: (_schema: unknown, handler: RawToolCall): void => {
              rawToolCall = handler;
            },
          },
        },
      };
    },
    query: ({ options }: { prompt: string; options: Record<string, unknown> }) =>
      (async function* () {
        const servers = (options['mcpServers'] ?? {}) as Record<string, { tools?: CapturedTool[] }>;
        const tools = [
          ...(options['tools'] as string[]),
          ...Object.entries(servers).flatMap(([server, config]) =>
            (config.tools ?? []).map((t) => `mcp__${server}__${t.name}`),
          ),
          ...(options['outputFormat'] !== undefined ? ['StructuredOutput'] : []),
        ];
        const sessionId = 'agent-parity';
        yield {
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
          model: options['model'],
          tools,
          mcp_servers: Object.keys(servers).map((name) => ({ name, status: 'connected' })),
        };
        let n = 0;
        for (const step of steps) {
          n += 1;
          if (rawToolCall === undefined) throw new Error('mock: tools/call adapter not installed');
          yield {
            type: 'assistant',
            session_id: sessionId,
            message: {
              model: options['model'],
              content: [
                {
                  type: 'tool_use',
                  id: `use-${n}`,
                  name: qualifiedToolName(step.tool),
                  input: step.input,
                },
              ],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          };
          sink.results.push(
            await rawToolCall(
              { method: 'tools/call', params: { name: step.tool, arguments: step.input } },
              {},
            ),
          );
        }
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: sessionId,
          result: 'done',
          usage: { input_tokens: 1, output_tokens: 1 },
          permission_denials: [],
        };
      })(),
  };
}

/** A pre-seeded session so the driver binds OUR workspace (the sessionRef resume path). */
export async function seededSession(
  label: string,
  workspaceOverride?: string,
): Promise<{ sessionsDir: string; sessionId: string; workspace: string }> {
  const workspace = workspaceOverride ?? (await seededWorkspace(label));
  workspaceCounter += 1;
  const sessionsDir = join(scratch, `sessions-${label}-${workspaceCounter}`);
  const record = await new SessionStore(sessionsDir).create(workspace);
  return { sessionsDir, sessionId: record.sessionId, workspace };
}

const AGENT_ENDPOINTS = EndpointTableSchema.parse({
  endpoints: {
    [CONFORMANCE_PROVIDER]: {
      baseUrlEnv: 'CONFORMANCE_BASE_URL',
      baseUrlDefault: 'http://127.0.0.1:1/anthropic',
      keyEnv: 'CONFORMANCE_API_KEY',
      notes: 'parity test endpoint: the mock SDK module is the model; never contacted',
    },
  },
});

/** Run the claude-code sdk transport over one phase; returns handler results, the tools, the verdict. */
export async function claudeAgentPhase(
  sandbox: SandboxLevel,
  steps: ReadonlyArray<{ tool: string; input: unknown }>,
  options: {
    harnessConfig?: HarnessConfig;
    envAllowlist?: readonly string[];
    workspace?: string;
  } = {},
): Promise<{
  results: unknown[];
  tools: CapturedTool[];
  verdict: WorkerResult;
  workspace: string;
}> {
  const session = await seededSession(`agent-${sandbox}`, options.workspace);
  const sink: { tools: CapturedTool[]; results: unknown[] } = { tools: [], results: [] };
  const driver = new ClaudeCodeDriver({
    transport: 'sdk',
    sdkLoader: async () => scriptedSdk(steps, sink),
    routingTable: AGENT_ENDPOINTS,
    sessionsDir: session.sessionsDir,
    harnessConfig: options.harnessConfig ?? HARNESS,
    ...(options.envAllowlist === undefined ? {} : { envAllowlist: options.envAllowlist }),
  });
  const verdict = await driver.run({
    prompt: 'parity run',
    modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: sandbox },
    budget: {},
    sessionRef: session.sessionId,
  });
  return { results: sink.results, tools: sink.tools, verdict, workspace: session.workspace };
}

// ---------------------------------------------------------------------------
// Path (c): the core directly
// ---------------------------------------------------------------------------

export async function corePhase(
  sandbox: SandboxLevel,
  steps: readonly Step[],
): Promise<{ results: McpCallToolResult[]; denials: ToolDenial[]; workspace: string }> {
  const workspace = await seededWorkspace(`core-${sandbox}`);
  const surface = createHarnessSurface(await manifestFor(workspace, sandbox));
  const results: McpCallToolResult[] = [];
  const denials: ToolDenial[] = [];
  for (const step of steps) {
    const { result, outcome } = await surface.call(step.tool, step.input);
    results.push(result);
    if (!outcome.ok) denials.push(outcome.denial);
  }
  return { results, denials, workspace };
}
