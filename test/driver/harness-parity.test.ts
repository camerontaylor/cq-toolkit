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
//   Schema-invalid input is asserted PER TRANSPORT (the one scoped
//   difference): stdio and core deny with 'invalid input:' and execute
//   nothing; on claude-agent the REAL SDK pre-validates the handler's
//   non-strict declared shape, which a mock cannot reproduce — so the test
//   pins what the handler itself does with raw invalid input (the core
//   denies it) and states the exception.
//
//   LEVEL 2 — WorkerResult.denials parity. The same sequence folded by each
//   lane: claude-agent runs the driver with the mock SDK executing the
//   scripted calls through its registered handlers; subprocess runs a REAL
//   SubprocessDriver whose `spawn` override returns a fake CLI child that
//   emits realistic stream-json frames (init, tool_use, tool_result,
//   result) built from the SAME CallToolResults. Both lanes must report the
//   identical {tool, reason} list, in harness names ('read'/'edit'/'run').
//
// This file MUST NOT import from '@anthropic-ai/claude-agent-sdk' (I10).
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { ClaudeAgentDriver } from '../../src/driver/claude-agent/index.js';
import { EndpointTableSchema } from '../../src/driver/claude-agent/routing.js';
import { SubprocessDriver } from '../../src/driver/subprocess/index.js';
import type {
  ManagedChild,
  ProcessClose,
  SpawnOptions,
} from '../../src/driver/subprocess/process.js';
import { RoutingTableSchema } from '../../src/driver/subprocess/routing.js';
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
import { CONFORMANCE_MODEL, CONFORMANCE_PROVIDER } from './conformance.js';

process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

const LOADER = fileURLToPath(new URL('../helpers/ts-source-loader.mjs', import.meta.url));
const BIN = fileURLToPath(new URL('../../src/harness/mcp/bin.ts', import.meta.url));

// ---------------------------------------------------------------------------
// The one harness config + the scripted sequence
// ---------------------------------------------------------------------------

/** The SAME harness config every path binds (read/edit over note.txt + src/**, run over `echo`). */
const HARNESS: HarnessConfig = {
  ...defaultHarnessConfig,
  tools: {
    read: { ...defaultHarnessConfig.tools.read, pathPatterns: ['note.txt', 'src/**'] },
    edit: { ...defaultHarnessConfig.tools.edit, pathPatterns: ['note.txt', 'src/**'] },
    run: { ...defaultHarnessConfig.tools.run, commandPatterns: ['echo'] },
  },
};

const ENV_HARNESS: HarnessConfig = {
  ...HARNESS,
  tools: {
    ...HARNESS.tools,
    run: { ...HARNESS.tools.run, commandPatterns: ['env'] },
  },
};

type HarnessName = 'read' | 'edit' | 'run';

/** One scripted call. */
interface Step {
  label: string;
  tool: HarnessName;
  input: Record<string, unknown>;
}

/** The workspace-write manifest's sequence. */
const WRITE_STEPS: readonly Step[] = [
  { label: 'read ok', tool: 'read', input: { path: 'note.txt' } },
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
const PHASES: ReadonlyArray<{ sandbox: SandboxLevel; steps: readonly Step[] }> = [
  { sandbox: 'workspace-write', steps: WRITE_STEPS },
  { sandbox: 'read-only', steps: READ_ONLY_STEPS },
];

const NOTE_BODY = 'hello note\n';
const A_BODY = 'alpha\n';

// ---------------------------------------------------------------------------
// Scratch + workspace helpers
// ---------------------------------------------------------------------------

let scratch: string;

beforeAll(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), 'cq-parity-')));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

let workspaceCounter = 0;

/** A fresh realpath'd workspace with the fixture files (identical contents every time). */
async function seededWorkspace(label: string): Promise<string> {
  workspaceCounter += 1;
  const dir = join(scratch, `ws-${label}-${workspaceCounter}`);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'note.txt'), NOTE_BODY);
  await writeFile(join(dir, 'src', 'a.txt'), A_BODY);
  await writeFile(join(dir, 'secret.txt'), 'not on the allowlist\n');
  return realpath(dir);
}

/** The manifest the drivers would build: the ONE manifest constructor, unrestricted policy. */
async function manifestFor(workspace: string, sandbox: SandboxLevel): Promise<HarnessManifest> {
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
function projectSdkResult(raw: Record<string, unknown>): McpCallToolResult {
  expect(Object.keys(raw).filter((key) => key !== 'content' && key !== 'isError')).toEqual([]);
  if ('isError' in raw) expect(raw['isError']).toBe(true);
  return {
    content: raw['content'] as McpCallToolResult['content'],
    ...(raw['isError'] === true ? { isError: true as const } : {}),
  };
}

/** Connect an SDK Client to a fresh stdio server bound to `manifest`. */
async function stdioClient(
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
async function stdioPhase(
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
// Path (b): the claude-agent registered handler via a mock SDK module
// ---------------------------------------------------------------------------

/** What the mock's `tool()` captured from the driver. */
interface CapturedTool {
  name: string;
  description: string;
  shape: unknown;
  handler: (args: unknown, extra: unknown) => Promise<unknown>;
}

/**
 * A mock SDK module whose `query()` reports an HONEST init surface (derived
 * from the registered servers/tools and outputFormat), then invokes the
 * CAPTURED handlers with the scripted inputs — each preceded by the
 * assistant tool_use frame the real SDK would emit — and records every
 * returned value verbatim, then yields a success result.
 */
function scriptedSdk(
  steps: ReadonlyArray<{ tool: string; input: unknown }>,
  sink: { tools: CapturedTool[]; results: unknown[] },
): Record<string, unknown> {
  return {
    tool: (
      name: string,
      description: string,
      shape: unknown,
      handler: CapturedTool['handler'],
    ): CapturedTool => {
      const captured = { name, description, shape, handler };
      sink.tools.push(captured);
      return captured;
    },
    createSdkMcpServer: (opts: { name: string; tools?: CapturedTool[] }) => ({
      type: 'sdk',
      ...opts,
    }),
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
        const registered = servers['cq-harness']?.tools ?? [];
        let n = 0;
        for (const step of steps) {
          n += 1;
          const handlerTool = registered.find((t) => t.name === step.tool);
          if (handlerTool === undefined) throw new Error(`mock: '${step.tool}' not registered`);
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
          sink.results.push(await handlerTool.handler(step.input, {}));
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
async function seededSession(
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

/** Run the claude-agent driver over one phase; returns handler results, the tools, the verdict. */
async function claudeAgentPhase(
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
  const driver = new ClaudeAgentDriver({
    sdkLoader: async () => scriptedSdk(steps, sink),
    endpointTable: AGENT_ENDPOINTS,
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

async function corePhase(
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

// ---------------------------------------------------------------------------
// The subprocess lane: a real SubprocessDriver over a fake CLI child
// ---------------------------------------------------------------------------

const SUBPROCESS_ROUTES = RoutingTableSchema.parse({
  endpoints: {
    [CONFORMANCE_PROVIDER]: {
      baseUrlEnv: 'CONFORMANCE_BASE_URL',
      baseUrlDefault: 'http://127.0.0.1:1/anthropic',
      keyEnv: 'CONFORMANCE_API_KEY',
      models: [CONFORMANCE_MODEL],
      notes: 'parity test endpoint: the fake CLI child is the model; never contacted',
    },
  },
});

/** A ManagedChild that emits `lines` on stdout (after the driver subscribed), then exits 0. */
function fakeCliChild(lines: readonly string[]): ManagedChild {
  const stdoutListeners: Array<(line: string) => void> = [];
  let exited = false;
  let settle: (close: ProcessClose) => void = () => undefined;
  const close = new Promise<ProcessClose>((resolve) => {
    settle = resolve;
  });
  // A macrotask: the driver subscribes synchronously right after spawn.
  setTimeout(() => {
    for (const line of lines) for (const listener of stdoutListeners) listener(line);
    exited = true;
    settle({ code: 0, signal: null, stdout: '', stderr: '', droppedBytes: 0 });
  }, 0);
  return {
    pid: 4242,
    close,
    get exited() {
      return exited;
    },
    onStdoutLine: (listener) => {
      stdoutListeners.push(listener);
    },
    onStderrLine: () => undefined,
    writeStdin: () => undefined,
    endStdin: () => undefined,
    kill: () => false,
  };
}

/** The value following `flag` in an argv. */
function argAfter(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
}

/**
 * Realistic stream-json for the scripted calls, built from the REFERENCE
 * CallToolResults: an init frame derived from the driver's per-run MCP
 * config (the server it names, the tools its manifest serves — what the CLI
 * would list after `tools/list`), then per call an assistant tool_use
 * (qualified name) and the user-envelope tool_result exactly as the CLI
 * relays an MCP result (success → text-block array; error → the text as a
 * plain string with is_error: true), then a success result.
 */
function streamJsonFor(
  manifest: HarnessManifest,
  serverNames: string[],
  steps: readonly Step[],
  results: readonly McpCallToolResult[],
): string[] {
  const sessionId = 'cli-parity';
  const lines: unknown[] = [
    {
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model: CONFORMANCE_MODEL,
      tools: manifest.tools.map(qualifiedToolName),
      mcp_servers: serverNames.map((name) => ({ name, status: 'connected' })),
    },
  ];
  steps.forEach((step, i) => {
    const result = results[i];
    if (result === undefined) throw new Error(`no reference result for step ${i}`);
    const id = `toolu_${i + 1}`;
    lines.push({
      type: 'assistant',
      session_id: sessionId,
      message: {
        model: CONFORMANCE_MODEL,
        content: [{ type: 'tool_use', id, name: qualifiedToolName(step.tool), input: step.input }],
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    });
    const text = result.content.map((block) => block.text).join('');
    lines.push({
      type: 'user',
      session_id: sessionId,
      message: {
        role: 'user',
        content: [
          result.isError === true
            ? { type: 'tool_result', tool_use_id: id, content: text, is_error: true }
            : { type: 'tool_result', tool_use_id: id, content: [{ type: 'text', text }] },
        ],
      },
    });
  });
  lines.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    model: CONFORMANCE_MODEL,
    result: 'done',
    usage: { input_tokens: 1, output_tokens: 1 },
  });
  return lines.map((line) => JSON.stringify(line));
}

/** Run a real SubprocessDriver over one phase with the fake CLI child. */
async function subprocessPhase(
  sandbox: SandboxLevel,
  steps: readonly Step[],
  referenceResults: readonly McpCallToolResult[],
): Promise<{ verdict: WorkerResult; manifest: HarnessManifest | undefined; workspace: string }> {
  const session = await seededSession(`subprocess-${sandbox}`);
  let seenManifest: HarnessManifest | undefined;
  const driver = new SubprocessDriver({
    binary: 'fake-claude',
    routingTable: SUBPROCESS_ROUTES,
    sessionsDir: session.sessionsDir,
    harnessConfig: HARNESS,
    spawn: (opts: SpawnOptions): ManagedChild => {
      // The per-run MCP config exists NOW (the driver deletes it once init
      // reports the server connected) — read the driver-authored manifest
      // from the server's argv, as the CLI would launch it.
      const configPath = argAfter(opts.args, '--mcp-config');
      if (configPath === undefined) throw new Error('fake CLI: no --mcp-config');
      const config = JSON.parse(readFileSync(configPath, 'utf8')) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      const serverArgs = config.mcpServers['cq-harness']?.args ?? [];
      const manifest = JSON.parse(serverArgs[serverArgs.length - 1] ?? 'null') as HarnessManifest;
      seenManifest = manifest;
      return fakeCliChild(
        streamJsonFor(manifest, Object.keys(config.mcpServers), steps, referenceResults),
      );
    },
  });
  const verdict = await driver.run({
    prompt: 'parity run',
    modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: sandbox },
    budget: {},
    sessionRef: session.sessionId,
  });
  return { verdict, manifest: seenManifest, workspace: session.workspace };
}

// ---------------------------------------------------------------------------
// LEVEL 1 — CallToolResult parity
// ---------------------------------------------------------------------------

describe('harness parity — Level 1: CallToolResult (stdio ≡ claude-agent handler ≡ core)', () => {
  for (const phase of PHASES) {
    test(`byte-identical results across the three paths — sandbox ${phase.sandbox}`, async () => {
      const core = await corePhase(phase.sandbox, phase.steps);
      const stdio = await stdioPhase(phase.sandbox, phase.steps);
      const agent = await claudeAgentPhase(phase.sandbox, phase.steps);

      // The claude-agent run itself was a clean, verified run.
      expect(agent.verdict.stopReason).toBe('complete');
      expect(agent.verdict.error).toBeUndefined();
      // The registered surface IS the core surface: same names, descriptions,
      // and the declared shape covers exactly the strict schema's keys.
      const coreSurface = createHarnessSurface(await manifestFor(core.workspace, phase.sandbox));
      expect(agent.tools.map((t) => t.name)).toEqual(coreSurface.tools.map((t) => t.name));
      expect(agent.tools.map((t) => t.description)).toEqual(
        coreSurface.tools.map((t) => t.description),
      );
      expect(agent.tools.map((t) => Object.keys(t.shape as object))).toEqual(
        coreSurface.tools.map((t) => Object.keys(t.inputSchema.shape)),
      );

      expect(core.results).toHaveLength(phase.steps.length);
      expect(stdio.results).toHaveLength(phase.steps.length);
      expect(agent.results).toHaveLength(phase.steps.length);
      phase.steps.forEach((step, i) => {
        const reference = JSON.stringify(core.results[i]);
        expect(JSON.stringify(stdio.results[i]), `stdio: ${step.label}`).toBe(reference);
        expect(JSON.stringify(agent.results[i]), `claude-agent: ${step.label}`).toBe(reference);
      });

      // The sequence exercised what it claims (not a vacuous all-ok parity).
      const texts = core.results.map((r) => r.content.map((b) => b.text).join(''));
      if (phase.sandbox === 'workspace-write') {
        expect(core.results.map((r) => r.isError === true)).toEqual([
          false,
          false,
          false,
          true,
          true,
          true,
          true,
          false,
          true,
          true,
        ]);
        expect(texts[0]).toBe(NOTE_BODY);
        expect(texts[1]).toBe("edited 'src/a.txt': replaced 1 occurrence");
        expect(texts[2]).toBe('beta\n');
        expect(texts[3]).toBe("path not allowed by harness config allowlist: 'secret.txt'");
        expect(texts[4]).toBe("path escape: '../x' resolves outside the workspace");
        expect(texts[5]).toBe("path escape: '../x' resolves outside the workspace");
        expect(texts[6]).toBe("file not found: 'src/missing.txt'");
        expect(texts[7]).toBe('exit 0\n--- stdout ---\nhi\n');
        expect(texts[8]).toBe("command not allowed by harness config allowlist: 'whoami'");
        expect(texts[9]?.startsWith('command allowlist: shell metacharacters')).toBe(true);
        // Post-state parity: every path's edit landed identically.
        for (const ws of [core.workspace, stdio.workspace, agent.workspace]) {
          await expect(readFile(join(ws, 'src', 'a.txt'), 'utf8')).resolves.toBe('beta\n');
        }
      } else {
        expect(texts).toEqual([NOTE_BODY, 'sandbox: read-only', 'sandbox: read-only']);
        expect(core.results.map((r) => r.isError === true)).toEqual([false, true, true]);
        for (const ws of [core.workspace, stdio.workspace, agent.workspace]) {
          await expect(readFile(join(ws, 'note.txt'), 'utf8')).resolves.toBe(NOTE_BODY);
        }
      }

      // Workspace-RELATIVE text is what makes the three different workspace
      // dirs comparable: no result embeds any workspace path (nor the
      // scratch root that contains them all).
      const all = JSON.stringify([core.results, stdio.results, agent.results]);
      for (const ws of [core.workspace, stdio.workspace, agent.workspace, scratch]) {
        expect(all.includes(ws)).toBe(false);
      }
      // The three paths really used three distinct workspaces.
      expect(new Set([core.workspace, stdio.workspace, agent.workspace]).size).toBe(3);
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// Schema-invalid input — asserted PER TRANSPORT
// ---------------------------------------------------------------------------

/** Schema-invalid calls: a type-invalid read, a read with an extra key, an edit with an extra key. */
const INVALID_STEPS: readonly Step[] = [
  { label: 'read {path: 5}', tool: 'read', input: { path: 5 } },
  { label: 'read + extra key', tool: 'read', input: { path: 'note.txt', extra: true } },
  {
    label: 'edit + extra key',
    tool: 'edit',
    input: { path: 'note.txt', oldText: 'hello', newText: 'EXECUTED', extra: 1 },
  },
];

/** Every result is an 'invalid input:' denial, and the edit never executed. */
async function expectInvalidDenials(results: readonly unknown[], workspace: string): Promise<void> {
  expect(results).toHaveLength(INVALID_STEPS.length);
  for (const result of results) {
    const r = result as McpCallToolResult;
    expect(r.isError).toBe(true);
    expect(r.content).toHaveLength(1);
    expect(r.content[0]?.text.startsWith('invalid input: ')).toBe(true);
  }
  await expect(readFile(join(workspace, 'note.txt'), 'utf8')).resolves.toBe(NOTE_BODY);
}

describe('harness parity — schema-invalid input (per transport)', () => {
  test('stdio server: isError "invalid input:", nothing executed', async () => {
    const stdio = await stdioPhase('workspace-write', INVALID_STEPS);
    await expectInvalidDenials(stdio.results, stdio.workspace);
  }, 30_000);

  test('core: isError "invalid input:", nothing executed', async () => {
    const core = await corePhase('workspace-write', INVALID_STEPS);
    await expectInvalidDenials(core.results, core.workspace);
    expect(core.denials.map((d) => d.tool)).toEqual(['read', 'read', 'edit']);
  });

  test('claude-agent handler: raw invalid input is denied by the core (SCOPED EXCEPTION: the real SDK pre-validates)', async () => {
    // SCOPED EXCEPTION (ADR-0002 Annex A.2): the claude-agent lane registers
    // the NON-strict zod shape with the SDK, and the REAL SDK validates
    // tool arguments against it before the handler runs — a type-invalid
    // call never reaches the handler, and extra keys are stripped. That
    // SDK-side validation cannot be reproduced with a mock, so this lane's
    // assertion is scoped to what the HANDLER does if raw invalid input does
    // reach it: the shared core denies it with 'invalid input:' and
    // executes nothing — the same outcome as the other transports, and
    // nothing executes on either side of the exception.
    const agent = await claudeAgentPhase('workspace-write', INVALID_STEPS);
    expect(agent.verdict.stopReason).toBe('complete');
    await expectInvalidDenials(agent.results, agent.workspace);
    expect(agent.verdict.denials.map((d) => d.tool)).toEqual(['read', 'read', 'edit']);
  });
});

// ---------------------------------------------------------------------------
// LEVEL 2 — WorkerResult.denials parity
// ---------------------------------------------------------------------------

describe('harness parity — Level 2: WorkerResult.denials (claude-agent fold ≡ subprocess fold)', () => {
  test('both lanes report the identical {tool, reason} list for the same sequence', async () => {
    const agentDenials: ToolDenial[] = [];
    const subprocessDenials: ToolDenial[] = [];
    const referenceDenials: ToolDenial[] = [];
    for (const phase of PHASES) {
      const core = await corePhase(phase.sandbox, phase.steps);
      referenceDenials.push(...core.denials);

      const agent = await claudeAgentPhase(phase.sandbox, phase.steps);
      expect(agent.verdict.stopReason).toBe('complete');
      agentDenials.push(...agent.verdict.denials);

      const sub = await subprocessPhase(phase.sandbox, phase.steps, core.results);
      expect(sub.verdict.stopReason, sub.verdict.error).toBe('complete');
      expect(sub.verdict.error).toBeUndefined();
      subprocessDenials.push(...sub.verdict.denials);
      // The subprocess lane bound the SAME manifest (modulo its own workspace).
      expect(sub.manifest).toEqual({
        ...(await manifestFor(sub.workspace, phase.sandbox)),
        workspace: sub.workspace,
      });
    }

    // Frozen shape: exactly {tool, reason}, harness names.
    for (const denial of [...agentDenials, ...subprocessDenials]) {
      expect(Object.keys(denial).sort()).toEqual(['reason', 'tool']);
      expect(['read', 'edit', 'run']).toContain(denial.tool);
    }
    expect(agentDenials).toEqual(referenceDenials);
    expect(subprocessDenials).toEqual(referenceDenials);
    expect(JSON.stringify(subprocessDenials)).toBe(JSON.stringify(agentDenials));
    // Non-vacuous: every denial class in the sequence is present.
    expect(referenceDenials.map((d) => d.tool)).toEqual([
      'read',
      'read',
      'edit',
      'read',
      'run',
      'run',
      'edit',
      'run',
    ]);
  }, 60_000);
});

describe('harness parity — run child environment', () => {
  test.each(['default', 'explicit', 'configured'] as const)(
    '%s allowlist: real env output matches core, stdio and claude-agent handlers',
    async (mode) => {
      const canaryName = 'CQ_PARITY_BENIGN_CANARY';
      const canaryValue = 'parity-benign-value';
      const secretNames = [
        'GH_TOKEN',
        'ANTHROPIC_API_KEY',
        'ANTHROPIC_AUTH_TOKEN',
        'OPENAI_API_KEY',
        'ZAI_API_KEY',
        'DEEPSEEK_API_KEY',
      ];
      for (const name of secretNames) vi.stubEnv(name, `parity-fake-${name}`);
      vi.stubEnv(canaryName, canaryValue);
      vi.stubEnv('CQ_RUN_ENV_PASSTHROUGH', mode === 'configured' ? canaryName : '');
      const envAllowlist = mode === 'explicit' ? [canaryName] : [];
      let client: Client | undefined;
      try {
        const workspace = await seededWorkspace(`env-${mode}`);
        const manifest = await buildManifest({
          workspace,
          sandbox: 'workspace-write',
          toolPolicy: { mode: 'unrestricted', allow: [] },
          harness: ENV_HARNESS,
          envNames: envAllowlist,
        });
        if (manifest === undefined) throw new Error('run env manifest missing');
        const core = await createHarnessSurface(manifest).call('run', { command: 'env' });
        // The real MCP server starts with the same host values, including
        // canary credentials; its startup and run executor must scrub them.
        const parentEnv = Object.fromEntries(
          Object.entries(process.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        );
        client = await stdioClient(manifest, parentEnv);
        const stdio = projectSdkResult(
          await client.callTool({ name: 'run', arguments: { command: 'env' } }),
        );
        const agent = await claudeAgentPhase(
          'workspace-write',
          [{ tool: 'run', input: { command: 'env' } }],
          { harnessConfig: ENV_HARNESS, envAllowlist, workspace },
        );
        expect(agent.verdict.stopReason, agent.verdict.error).toBe('complete');
        expect(agent.results).toHaveLength(1);
        const outputs = [core.result, stdio, agent.results[0] as McpCallToolResult].map(
          (result) => {
            expect(result.isError).toBeUndefined();
            const text = result.content.map((block) => block.text).join('');
            expect(text.startsWith('exit 0\n--- stdout ---\n')).toBe(true);
            // env enumeration order is immaterial; compare the complete set.
            return text.slice('exit 0\n--- stdout ---\n'.length).trim().split('\n').sort();
          },
        );
        expect(outputs[1]).toEqual(outputs[0]);
        expect(outputs[2]).toEqual(outputs[0]);
        for (const output of outputs) {
          for (const name of [...secretNames, 'CONFORMANCE_API_KEY']) {
            expect(
              output.some((line) => line.startsWith(`${name}=`)),
              name,
            ).toBe(false);
          }
          expect(output.includes(`${canaryName}=${canaryValue}`)).toBe(mode !== 'default');
        }
      } finally {
        await client?.close();
        vi.unstubAllEnvs();
      }
    },
    60_000,
  );
});
