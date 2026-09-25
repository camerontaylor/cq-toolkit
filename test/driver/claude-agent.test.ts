// The claude-agent driver instantiation — T1.6 slice 1.
//
// Two layers, mirroring test/driver/ai-sdk.test.ts and
// test/driver/subprocess.test.ts:
//   1. THE CONFORMANCE SUITE (test/driver/conformance.ts, verbatim) run
//      against the real ClaudeAgentDriver with a MOCK SDK module injected
//      through the driver's `sdkLoader` seam — no @anthropic-ai/claude-agent-sdk
//      dependency, no network, no real CLI (the module is OUR code: plain
//      objects satisfying the driver's minimal structural AgentSdkModule).
//      The mock's fake `query` implements exactly the subset the driver
//      drives: init frame, assistant text, one tool call then reply (the
//      directed tool EXECUTES through the registered harness surface when
//      the policy allows it, or lands in permission_denials when it
//      doesn't), block-until-abort honoring the wired cancellation root's
//      signal, a fail directive, native structured output
//      (outputFormat → structured_output), usage numbers, and a response
//      model id equal to the requested model (leg m's observed-id echo).
//   2. DRIVER-SPECIFIC tests: the optional-peer pre-dispatch throws (a
//      throwing loader AND a surface-less module — each before any session
//      store mkdir), unknown provider, missing endpoint key env, the
//      stopReason mapping table (including the SDK's own cap subtypes →
//      budget), the exact usage mapping (+ reasoning from modelUsage),
//      pricing override → costUSD + costBasis 'modeled' / unpriced → both
//      absent, OBSERVED-model surfacing (a served id ≠ requested id is
//      surfaced, not hidden), the NO-ALLOWLIST rule (any model id
//      dispatches verbatim), resume via the relocated STORE sidecar →
//      Options.resume (never in the model-visible workspace, issue #26),
//      the env endpoint injection, the ToolPolicy mode-none surface (no MCP
//      server, empty allowedTools), the sandbox mapping, and the
//      structured-output schema rejection (a bad payload is dropped, never
//      trusted).
//
// This file MUST NOT import from '@anthropic-ai/claude-agent-sdk' (I10): the
// mock returns plain objects the driver's structural types accept.
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { stripMetaSchema } from '../../src/driver/json-schema.js';
import {
  AGENT_SESSION_FILE,
  allowedToolNames,
  ClaudeAgentDriver,
  foldMessage,
  HARNESS_ERROR_PREFIX,
  resultStatusOf,
  runHarnessTool,
  sandboxOption,
  stopReasonOf,
  usageFromAgent,
} from '../../src/driver/claude-agent/index.js';
import type {
  ClaudeAgentDriverOptions,
  StopReasonInputs,
} from '../../src/driver/claude-agent/index.js';
import {
  EndpointTableSchema,
  defaultEndpointTable,
  resolveEndpoint,
} from '../../src/driver/claude-agent/routing.js';
import type { EndpointTable } from '../../src/driver/claude-agent/routing.js';
import { runDriverConformance } from './conformance.js';
import type { ConformanceSpec, ModelDirective } from './conformance.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER } from './conformance.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';
import { buildManifest, createHarnessSurface } from '../../src/harness/surface.js';
import { runLadder } from '../../src/kernel/governor.js';
import type { OpInvocation } from '../../src/driver/types.js';

// The driver reads key VALUES from the environment at run() time (the
// endpoint carries names only); the conformance endpoint's fake key is set
// once here (the subprocess test's pattern — env is never mutated per-run).
process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

// ---------------------------------------------------------------------------
// The mock SDK module — OUR code, plain objects, zero vendor types
// ---------------------------------------------------------------------------

/** One MCP tool record as the driver's `sdk.tool()` adapter produces it. */
interface MockSdkTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

/** One recorded query call: the exact prompt + options the driver handed over. */
interface MockQueryCall {
  prompt: string;
  options: Record<string, unknown>;
}

/** The mock's per-step token usage — numbers the usage contract can assert on. */
const AGENT_USAGE = {
  input_tokens: 120,
  output_tokens: 12,
  cache_read_input_tokens: 15,
  cache_creation_input_tokens: 5,
};

function abortError(): Error {
  return Object.assign(new Error('run aborted by the governed signal'), { name: 'AbortError' });
}

/** The structured_output the mock reports when the driver sent an outputFormat. */
function structuredOutputOf(
  options: Record<string, unknown>,
  text: string,
): { structured_output?: unknown } {
  if (options['outputFormat'] === undefined) return {};
  try {
    return { structured_output: JSON.parse(text) as unknown };
  } catch {
    return {}; // unparseable reply text — no structured payload at all
  }
}

/** One `{name, status}` MCP server entry of an init frame. */
interface MockServerStatus {
  name: string;
  status: string;
}

/** The surface half of an SDK init frame. */
interface MockInitSurface {
  tools: string[];
  mcp_servers: MockServerStatus[];
}

/**
 * Stand-in for the SDK's default built-in preset (what `tools` omitted
 * would expose). The driver always passes `tools: []`, so these only ever
 * appear when that contract breaks.
 */
const MOCK_BUILTIN_PRESET = ['Bash', 'Read', 'Edit', 'Write'];

/**
 * The claude.ai connector surface subscription auth attaches when the
 * worker's surface is NOT closed (live leg A.5j) — the mock's model of the
 * leak `settingSources: []` + `strictMcpConfig: true` prevent.
 */
const MOCK_CONNECTOR_SERVER: MockServerStatus = { name: 'claude.ai Gmail', status: 'connected' };
const MOCK_CONNECTOR_TOOLS = [
  'mcp__claude_ai_Gmail__send_message',
  'mcp__claude_ai_Gmail__search_threads',
];

/**
 * The init surface the SDK would HONESTLY report for these query options —
 * derived from what the driver actually registered, never hardcoded per
 * test (the real 0.3.270 frame: `tools` lists every available tool, i.e.
 * the built-ins `options.tools` enables, every tool of every registered
 * MCP server as `mcp__<server>__<tool>`, and `StructuredOutput` when
 * `outputFormat` is set; `mcp_servers` lists each registered server with
 * its connection status). `allowedTools` is a permission list, not an
 * availability list, so it does not shape the surface. With
 * `subscriptionConnectors`, an UNCLOSED surface (settingSources not [] or
 * strictMcpConfig not true) also carries the account's claude.ai connector.
 */
function honestInitSurface(
  options: Record<string, unknown>,
  opts: { subscriptionConnectors?: boolean } = {},
): MockInitSurface {
  const tools: string[] = Array.isArray(options['tools'])
    ? [...(options['tools'] as string[])]
    : [...MOCK_BUILTIN_PRESET];
  const mcpServers: MockServerStatus[] = [];
  const registered = (options['mcpServers'] ?? {}) as Record<string, { tools?: MockSdkTool[] }>;
  for (const [serverName, config] of Object.entries(registered)) {
    mcpServers.push({ name: serverName, status: 'connected' });
    for (const registeredTool of config.tools ?? []) {
      tools.push(`mcp__${serverName}__${registeredTool.name}`);
    }
  }
  const closed =
    Array.isArray(options['settingSources']) &&
    (options['settingSources'] as unknown[]).length === 0 &&
    options['strictMcpConfig'] === true;
  if (opts.subscriptionConnectors === true && !closed) {
    mcpServers.push(MOCK_CONNECTOR_SERVER);
    tools.push(...MOCK_CONNECTOR_TOOLS);
  }
  if (options['outputFormat'] !== undefined) tools.push('StructuredOutput');
  return { tools, mcp_servers: mcpServers };
}

/** An honest `system/init` frame for these options (plus any extra fields). */
function initFrame(
  options: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    type: 'system',
    subtype: 'init',
    model: options['model'],
    cwd: options['cwd'],
    permissionMode: options['permissionMode'],
    ...honestInitSurface(options),
    ...extra,
  };
}

/** One scripted query: init → (tool phase) → assistant text → success result. */
async function* runScriptedQuery(
  script: {
    directive?: ModelDirective;
    servedModel?: string;
    calls: MockQueryCall[];
    /** Overrides the mock's usage — the LYING-USAGE tests ride this (review round 3). */
    usage?: Record<string, unknown>;
    /** Model subscription auth: connectors attach unless the surface is closed. */
    subscriptionConnectors?: boolean;
    /** Tamper with the honest init surface — a host that ignores the closing options. */
    tamperInit?: (surface: MockInitSurface) => MockInitSurface;
  },
  prompt: string,
  options: Record<string, unknown>,
): AsyncGenerator<unknown, void> {
  script.calls.push({ prompt, options });
  // The mock serves the REQUESTED id (Options.model) as the response's
  // model — unless the script overrides it (the observed-model test rides
  // that to prove the driver surfaces the SERVED id, never the requested).
  const model = script.servedModel ?? (options['model'] as string);
  const sessionId = `agent-cli-${script.calls.length}`;
  const surface = honestInitSurface(options, {
    ...(script.subscriptionConnectors === undefined
      ? {}
      : { subscriptionConnectors: script.subscriptionConnectors }),
  });
  yield {
    type: 'system',
    subtype: 'init',
    session_id: sessionId,
    model,
    cwd: options['cwd'],
    permissionMode: options['permissionMode'],
    ...(script.tamperInit === undefined ? surface : script.tamperInit(surface)),
  };
  const signal = (options['abortController'] as { signal?: AbortSignal } | undefined)?.signal;
  const directive = script.directive;
  if (directive?.kind === 'fail') {
    throw new Error('scripted model failure');
  }
  if (directive?.kind === 'block-until-abort') {
    if (signal?.aborted) throw abortError();
    await new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(abortError()), { once: true });
    });
    return; // unreachable: the abort rejection settles the query
  }
  const permissionDenials: Array<{ tool_name: string; tool_use_id: string; tool_input: unknown }> =
    [];
  if (directive?.kind === 'tool-then-reply') {
    // The governed-surface gate, agent-style: an un-registered tool is
    // refused by the permission gate (never executed) and recorded on the
    // result's permission_denials — exactly what the real permissionMode
    // 'default' headless posture produces.
    const server = (
      options['mcpServers'] as Record<string, { tools?: MockSdkTool[] }> | undefined
    )?.['cq-harness'];
    const toolRecord = server?.tools?.find((t) => t.name === directive.tool);
    if (toolRecord === undefined) {
      permissionDenials.push({
        tool_name: `mcp__cq-harness__${directive.tool}`,
        tool_use_id: 'mock-use-1',
        tool_input: directive.input,
      });
    } else {
      yield {
        type: 'assistant',
        session_id: sessionId,
        message: {
          model,
          content: [
            {
              type: 'tool_use',
              id: 'mock-use-1',
              name: `mcp__cq-harness__${directive.tool}`,
              input: directive.input,
            },
          ],
          usage: AGENT_USAGE,
        },
      };
      await toolRecord.handler(directive.input, undefined);
    }
  }
  const text =
    directive?.kind === 'tool-then-reply'
      ? directive.reply
      : directive?.kind === 'reply'
        ? directive.text
        : 'ok';
  const usage = script.usage ?? AGENT_USAGE;
  yield {
    type: 'assistant',
    session_id: sessionId,
    message: { model, content: [{ type: 'text', text }], usage },
  };
  yield {
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    result: text,
    usage,
    modelUsage: {
      [model]: {
        inputTokens: 120,
        outputTokens: 12,
        cacheReadInputTokens: 15,
        cacheCreationInputTokens: 5,
        thinkingTokens: 2, // realistic: the SDK counts thinking INSIDE output — the driver must not lift it into reasoning
        webSearchRequests: 0,
        costUSD: 0,
      },
    },
    permission_denials: permissionDenials,
    ...structuredOutputOf(options, text),
  };
}

/** The adapter half of the mock module (tool + server), shared by inline modules. */
const mockAdapters = {
  tool: (
    name: string,
    description: string,
    inputSchema: unknown,
    handler: MockSdkTool['handler'],
  ): MockSdkTool => ({
    name,
    description,
    inputSchema,
    handler,
  }),
  createSdkMcpServer: (opts: {
    name: string;
    version?: string;
    tools?: MockSdkTool[];
  }): Record<string, unknown> => ({
    type: 'sdk-mcp',
    ...opts,
  }),
};

/** Build the mock module for one directive; records every query call. */
function mockSdkModule(script: {
  directive?: ModelDirective;
  servedModel?: string;
  calls: MockQueryCall[];
  usage?: Record<string, unknown>;
  subscriptionConnectors?: boolean;
  tamperInit?: (surface: MockInitSurface) => MockInitSurface;
}): Record<string, unknown> {
  return {
    ...mockAdapters,
    query: ({
      prompt,
      options,
    }: {
      prompt: string;
      options: Record<string, unknown>;
    }): AsyncGenerator<unknown, void> => runScriptedQuery(script, prompt, options),
  };
}

// ---------------------------------------------------------------------------
// Conformance wiring — the suite's canonical handles, mock-backed
// ---------------------------------------------------------------------------

/**
 * The conformance endpoint table: the shipped default (zai / deepseek /
 * anthropic) extended with the suite's canonical provider handles —
 * `conformance` (never priced) and `conformance-priced` — pointed at a
 * black-hole URL no agent ever contacts (the mock module IS the model).
 */
function conformanceEndpointTable(): EndpointTable {
  return EndpointTableSchema.parse({
    endpoints: {
      ...defaultEndpointTable().endpoints,
      conformance: {
        baseUrlEnv: 'CONFORMANCE_BASE_URL',
        baseUrlDefault: 'http://127.0.0.1:1/anthropic',
        keyEnv: 'CONFORMANCE_API_KEY',
        notes: 'test endpoint: the mock SDK module is the model; the URL is never contacted',
      },
      'conformance-priced': {
        baseUrlEnv: 'CONFORMANCE_PRICED_BASE_URL',
        baseUrlDefault: 'http://127.0.0.1:1/anthropic',
        keyEnv: 'CONFORMANCE_API_KEY',
        notes: 'test endpoint for the derived-costUSD conformance leg',
      },
    },
  });
}

/** Conformance harness config: the conformance write permitted via an anchored re: pattern (token patterns deny redirects by design); workspaces inside scratchDir. */
function conformanceHarnessConfig(
  scratchDir: string,
): NonNullable<ClaudeAgentDriverOptions['harnessConfig']> {
  return {
    ...defaultHarnessConfig,
    workspaceRoot: join(scratchDir, 'workspaces'),
    tools: {
      ...defaultHarnessConfig.tools,
      run: {
        ...defaultHarnessConfig.tools.run,
        // `echo conformance-marker > note.txt` redirects — the shell-
        // metacharacter guard denies that under a token pattern, so the
        // conformance write rides the documented escape hatch: an anchored
        // re: pattern matching exactly the isolation write.
        commandPatterns: ['re:^echo .* > note\\.txt$'],
      },
    },
  };
}

/** Fresh mock-backed ClaudeAgentDriver honoring the ConformanceSpec contract. */
function makeDriver(spec: ConformanceSpec): ClaudeAgentDriver {
  return new ClaudeAgentDriver({
    sdkLoader: async () =>
      mockSdkModule({
        ...(spec.directive === undefined ? {} : { directive: spec.directive }),
        calls: [],
      }),
    endpointTable: conformanceEndpointTable(),
    ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
    // The priced handle flows through the price lookup so the conformance
    // suite can assert a derived costUSD; everything else stays unpriced.
    ...(spec.pricedModel !== undefined
      ? {
          pricing: (modelSpec: { provider: string; model: string }) =>
            modelSpec.provider === spec.pricedModel?.provider
              ? { input: 3, output: 15 }
              : undefined,
        }
      : {}),
    sessionsDir: join(spec.scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(spec.scratchDir),
  });
}

// ---------------------------------------------------------------------------
// 1. The conformance suite, mock-backed
// ---------------------------------------------------------------------------

runDriverConformance(makeDriver, { label: 'claude-agent driver (mock sdk)' });

// ---------------------------------------------------------------------------
// 2. Driver-specific unit tests
// ---------------------------------------------------------------------------

/** Minimal invocation for the driver-specific tests. */
function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'driver-specific run',
    modelSpec: { provider: CONFORMANCE_PROVIDER, model: 'conformance-1' },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: 'none' },
    budget: {},
    ...overrides,
  };
}

/** A recording driver + its captured query calls (options evidence). */
function driverWithCalls(
  scratchDir: string,
  opts: {
    directive?: ModelDirective;
    servedModel?: string;
    envAllowlist?: readonly string[];
  } = {},
): { driver: ClaudeAgentDriver; calls: MockQueryCall[] } {
  const calls: MockQueryCall[] = [];
  const driver = new ClaudeAgentDriver({
    sdkLoader: async () => mockSdkModule({ ...opts, calls }),
    endpointTable: conformanceEndpointTable(),
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(scratchDir),
    ...(opts.envAllowlist === undefined ? {} : { envAllowlist: opts.envAllowlist }),
  });
  return { driver, calls };
}

/** The options object of the Nth (0-based) recorded query call. */
function optionsOf(calls: MockQueryCall[], nth = 0): Record<string, unknown> {
  const options = calls[nth]?.options;
  if (options === undefined) throw new Error(`no recorded query call #${nth}`);
  return options;
}

describe('claude-agent driver specifics (mock sdk)', () => {
  test.each(['explicit', 'configured'])(
    'child env is scrubbed and passes through only %s named values',
    async (mode) => {
      const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-env-'));
      const secretName = 'CQ_CLAUDE_AGENT_SECRET_CANARY';
      const passthroughName = 'CQ_CLAUDE_AGENT_PASSTHROUGH_CANARY';
      const oldSecret = process.env[secretName];
      const oldPassthrough = process.env[passthroughName];
      const oldConfigured = process.env.CQ_RUN_ENV_PASSTHROUGH;
      process.env[secretName] = 'must-not-reach-sdk';
      process.env[passthroughName] = 'named-passthrough';
      process.env.CQ_RUN_ENV_PASSTHROUGH = mode === 'configured' ? passthroughName : '';
      const envAllowlist = mode === 'explicit' ? [passthroughName] : [];
      try {
        const { driver, calls } = driverWithCalls(scratchDir, {
          directive: { kind: 'reply', text: 'ok' },
          envAllowlist,
        });
        // Constructor snapshots the trusted declaration; caller mutation
        // cannot widen an already-built driver's process or tool surface.
        envAllowlist.push(secretName);
        await driver.run(invocation({ prompt: 'env canary' }));
        const env = optionsOf(calls)['env'] as Record<string, string>;
        expect(env[secretName]).toBeUndefined();
        expect(env[passthroughName]).toBe('named-passthrough');
      } finally {
        if (oldSecret === undefined) delete process.env[secretName];
        else process.env[secretName] = oldSecret;
        if (oldPassthrough === undefined) delete process.env[passthroughName];
        else process.env[passthroughName] = oldPassthrough;
        if (oldConfigured === undefined) delete process.env.CQ_RUN_ENV_PASSTHROUGH;
        else process.env.CQ_RUN_ENV_PASSTHROUGH = oldConfigured;
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  test.each(['BAD=VALUE', 'BAD NAME', '', 'BAD;NAME'])(
    'rejects invalid envAllowlist name %j before dispatch',
    (name) => {
      expect(() => new ClaudeAgentDriver({ envAllowlist: [name] })).toThrow(/envAllowlist/);
    },
  );

  test('peer ABSENT: a throwing loader throws pre-dispatch — before any session store mkdir', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => {
          throw new Error(`Cannot find package '${'@anthropic-ai/claude-agent-sdk'}'`);
        },
        endpointTable: conformanceEndpointTable(),
        sessionsDir,
      });
      await expect(driver.run(invocation())).rejects.toThrow(/optional peer dependency/);
      // The failure landed BEFORE any session existed: the store directory
      // was never even created (mkdir is the first store side effect).
      await expect(stat(sessionsDir)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('peer PRESENT but surface-less: capability detection throws pre-dispatch (feature check, never a version check)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({ query: 'not a function', version: '9.9.9-fake' }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir,
      });
      await expect(driver.run(invocation())).rejects.toThrow(/missing the driven surface/);
      await expect(
        readdir(sessionsDir).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('unknown provider throws BEFORE dispatch — no session record is created', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver } = driverWithCalls(scratchDir);
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'm' } })),
      ).rejects.toThrow(/unknown provider 'nope'/);
      await expect(
        readdir(join(scratchDir, SESSIONS_DIR)).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('missing endpoint key env throws BEFORE dispatch', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    const keyName = 'CQ_TEST_CLAUDE_AGENT_MISSING_KEY';
    const saved = process.env[keyName];
    delete process.env[keyName];
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => mockSdkModule({ calls: [] }),
        endpointTable: EndpointTableSchema.parse({
          endpoints: {
            conformance: {
              baseUrlEnv: 'CONFORMANCE_BASE_URL',
              baseUrlDefault: 'http://127.0.0.1:1/anthropic',
              keyEnv: keyName,
              notes: 'key-less endpoint for the missing-key pre-dispatch test',
            },
          },
        }),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
      });
      await expect(driver.run(invocation())).rejects.toThrow(new RegExp(`${keyName}`));
    } finally {
      if (saved !== undefined) process.env[keyName] = saved;
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('NO model allowlist: any model id dispatches verbatim — Options.model is untouched', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: CONFORMANCE_PROVIDER, model: 'any-gateway-id-at-all' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(optionsOf(calls)['model']).toBe('any-gateway-id-at-all');
      // The observed-model defence still reports what the endpoint served.
      expect(result.model).toBe('any-gateway-id-at-all');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('observed-model surfacing: a SERVED id different from the requested id is surfaced, not hidden', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
        servedModel: 'gateway-default-served-instead',
      });
      const result = await driver.run(
        invocation({ modelSpec: { provider: CONFORMANCE_PROVIDER, model: 'what-we-asked-for' } }),
      );
      expect(result.model).toBe('gateway-default-served-instead');
      expect(result.model).not.toBe('what-we-asked-for'); // the remap is VISIBLE
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('endpoint env injection: base URL + auth values ride the SDK env; the governed surface is the only surface', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'workspace-write' },
        }),
      );
      const options = optionsOf(calls);
      const env = options['env'] as Record<string, string | undefined>;
      expect(env['ANTHROPIC_BASE_URL']).toBe('http://127.0.0.1:1/anthropic'); // the endpoint default
      expect(env['ANTHROPIC_AUTH_TOKEN']).toBe(process.env['CONFORMANCE_API_KEY']);
      expect(env['ANTHROPIC_API_KEY']).toBe(process.env['CONFORMANCE_API_KEY']);
      // Built-ins always off; the allowlist surface is the whole surface.
      expect(options['tools']).toEqual([]);
      expect(options['allowedTools']).toEqual(['mcp__cq-harness__read']);
      expect(options['permissionMode']).toBe('default');
      const server = (options['mcpServers'] as Record<string, { tools: Array<{ name: string }> }>)[
        'cq-harness'
      ];
      if (server === undefined) throw new Error('missing cq-harness server');
      expect(server.tools.map((t) => t.name)).toEqual(['read']);
      // workspace-write sandbox → the defense-in-depth option.
      expect(options['sandbox']).toEqual({ enabled: true, failIfUnavailable: false });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('ToolPolicy mode none: no MCP server at all, empty allowedTools, no sandbox option on level none', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: {
          kind: 'tool-then-reply',
          tool: 'run',
          input: { command: 'echo x' },
          reply: 'unused',
        },
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: [], mode: 'none' }, sandboxPolicy: { level: 'none' } }),
      );
      const options = optionsOf(calls);
      expect(options['mcpServers']).toBeUndefined();
      expect(options['allowedTools']).toEqual([]);
      expect(options['sandbox']).toBeUndefined();
      // The withheld tool never executed — the result reports the refusal.
      expect(result.denials.some((d) => d.tool === 'run')).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('resume: the STORE sidecar agent session id rides Options.resume; the same workspace continues (#26)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'run one' },
      });
      const run1 = await driver.run(invocation({ prompt: 'resume run one' }));
      const record1 = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(
        run1.sessionId as string,
      );
      expect(record1).toBeDefined();
      // The agent's session id, sidecar-written BESIDE the session records
      // keyed by sessionId (issue #26 design (b)) — NOT in the model-visible
      // workspace, where the earlier placement was a tamper vector.
      const sidecarPath = join(
        scratchDir,
        SESSIONS_DIR,
        `${run1.sessionId as string}${AGENT_SESSION_FILE}`,
      );
      await expect(readFile(sidecarPath, 'utf8')).resolves.toBe('agent-cli-1\n');
      // 0o600 — the sidecar is evidence like the records it sits beside,
      // never world-readable (review thread: mode was umask-default 0o666).
      expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
      const noSidecarInWorkspace = async (): Promise<void> => {
        const files = await readdir(record1!.workspace);
        expect(files.filter((f) => f.endsWith(AGENT_SESSION_FILE))).toEqual([]);
      };
      await noSidecarInWorkspace();
      if (run1.sessionId === undefined) throw new Error('Expected a resumable session');
      const run2 = await driver.run(
        invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
      );
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(optionsOf(calls, 1)['resume']).toBe('agent-cli-1');
      expect(optionsOf(calls, 1)['cwd']).toBe(optionsOf(calls, 0)['cwd']); // the SAME workspace
      // The resumed run still leaves NO resume handle in the workspace.
      await noSidecarInWorkspace();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('structured output: the native json_schema option is sent; a schema-invalid payload is dropped to narration', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const schema = z.object({ answer: z.string() }).strict();
      const calls: MockQueryCall[] = [];
      const base = {
        endpointTable: conformanceEndpointTable(),
        outputSchema: schema,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      };
      // First run: a schema-valid payload — the happy path lands it.
      const ok = await new ClaudeAgentDriver({
        ...base,
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"answer":"ok"}' }, calls }),
      }).run(invocation({ prompt: 'structured ok' }));
      const sent = optionsOf(calls, 0)['outputFormat'] as {
        type: string;
        schema: Record<string, unknown>;
      };
      expect(sent.type).toBe('json_schema');
      // The draft-2020-12 meta `$schema` URI is stripped before the SDK
      // hands the schema to the CLI (the CLI rejects that URI pre-model,
      // #209); the schema body survives intact.
      expect(sent.schema['$schema']).toBeUndefined();
      expect(sent.schema).toEqual(stripMetaSchema(z.toJSONSchema(schema)));
      expect(ok.structuredOutput).toEqual({ answer: 'ok' });

      // Second run: a payload that fails the schema is dropped, never trusted.
      const bad = await new ClaudeAgentDriver({
        ...base,
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"nope":true}' }, calls }),
      }).run(invocation({ prompt: 'structured bad' }));
      expect(bad.structuredOutput).toBeUndefined();
      expect(bad.stopReason).toBe('complete');
      // The rejection is evidence, not silence: the driver persists the
      // narration marker into the SessionStore under its own sessionsDir
      // (the subprocess sibling's pattern).
      const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
      const record = await store.load(bad.sessionId as string);
      const narration = record?.messages.find(
        (m) => m.role === 'tool' && m.toolName === 'agent-narration',
      );
      expect(narration).toBeDefined();
      // The persisted narration is a JSON array of marker lines; the
      // structured-output-rejected marker carries the zod issue count and
      // the offending field paths. The bad payload {"nope":true} fails the
      // strict schema on the missing `answer` at least — the marker's shape
      // is pinned without assuming zod's issue ORDER.
      const lines = JSON.parse(narration?.content as string) as string[];
      const markerLine = lines.find((line) => line.includes('structured-output-rejected'));
      expect(markerLine).toBeDefined();
      const marker = JSON.parse(markerLine as string) as { issues: number; paths: string[] };
      expect(marker.issues).toBeGreaterThanOrEqual(1);
      expect(marker.paths).toContain('answer');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('pricing override: costUSD derived and labeled modeled; unpriced → both absent', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const priced = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: 'ok' }, calls: [] }),
        endpointTable: conformanceEndpointTable(),
        pricing: () => ({ input: 3, output: 15 }),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await priced.run(invocation());
      // usage {120, 12, 15, 5} at 3 / 15 per-million = (360 + 180) / 1e6.
      expect(result.costUSD).toBeCloseTo(0.00054, 12);
      expect(result.costBasis).toBe('modeled');

      const unpriced = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: 'ok' }, calls: [] }),
        endpointTable: conformanceEndpointTable(),
        pricing: () => undefined, // the map does not know the model
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const absent = await unpriced.run(invocation());
      expect(absent.costUSD).toBeUndefined(); // derived-only: never fabricated
      expect(absent.costBasis).toBeUndefined(); // no basis without a cost
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('unmeasured abort: zero usage and NO cost claim (never fabricate)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver } = driverWithCalls(scratchDir, { directive: { kind: 'block-until-abort' } });
      // The governor's own channel mechanics: the ladder fires its signal at
      // wallClockMs; the wired cancellation root settles the query 'aborted'.
      const outcome = await runLadder(
        () => driver.run(invocation({ budget: { maxTokens: 10_000 } })),
        { wallClockMs: 25 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return; // narrow for TS
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(outcome.value.costUSD).toBeUndefined(); // unmeasured: 0 would be a fabricated fact
      expect(outcome.value.costBasis).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('measured error verdict: a result event keeps its real usage and derived cost', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              calls.push({ prompt: 'n/a', options });
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        pricing: () => ({ input: 3, output: 15 }),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
      expect(result.costUSD).toBeCloseTo(0.00054, 12); // measured → derived cost is honest
      expect(result.costBasis).toBe('modeled');
      expect(calls).toHaveLength(1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a failed result frame derives its cause from the errors array (#204)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
                errors: ['boom one', 'boom two'],
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('boom one; boom two');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a failed result frame prefers the result string over the errors array (#204)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
                result: 'boom from result string',
                errors: ['ignored'],
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('boom from result string');
      expect(result.error).not.toContain('ignored');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a failed result frame with no text falls back to the subtype (#204)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              yield initFrame(options, { session_id: 'agent-cli-err' });
              yield {
                type: 'result',
                subtype: 'error_during_execution',
                is_error: true,
                session_id: 'agent-cli-err',
                usage: AGENT_USAGE,
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain("subtype 'error_during_execution'");
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a query throw surfaces its cause on the error verdict (#204)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: () => {
            throw new Error('sdk boundary exploded');
          },
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('sdk boundary exploded');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a query that yields no result event says so on the error verdict (#204)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: (): AsyncGenerator<unknown, void> => (async function* () {})(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('without a result event');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('non-positive budget.maxTokens throws pre-dispatch', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir);
      await expect(driver.run(invocation({ budget: { maxTokens: 0 } }))).rejects.toThrow(
        /maxTokens/,
      );
      await expect(driver.run(invocation({ budget: { maxTokens: -5 } }))).rejects.toThrow(
        /maxTokens/,
      );
      await expect(driver.run(invocation({ budget: { maxTokens: Number.NaN } }))).rejects.toThrow(
        /maxTokens/,
      );
      expect(calls).toEqual([]); // never dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('abort-verdict alignment: a CLEANLY-settling query still verdicts aborted once the governed signal has fired', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // A misbehaving agent that IGNORES the wired cancellation root: the
      // for-await loop settles cleanly (no abort-shaped throw), but ONLY
      // after the governed signal has actually fired (the generator waits
      // for the signal itself — deterministic under any machine load, no
      // fixed-sleep race). The mapping table says a fired governed signal →
      // 'aborted', so 'complete' would be a false verdict.
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              const signal = (options['abortController'] as { signal?: AbortSignal } | undefined)
                ?.signal;
              if (signal !== undefined) {
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else signal.addEventListener('abort', () => resolve(), { once: true });
                });
                await new Promise((resolve) => setTimeout(resolve, 10)); // a tick past the abort
              }
              yield initFrame(options, { session_id: 'agent-cli-clean' });
              yield {
                type: 'assistant',
                session_id: 'agent-cli-clean',
                message: {
                  model: options['model'],
                  content: [{ type: 'text', text: 'settled cleanly' }],
                  usage: AGENT_USAGE,
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 'agent-cli-clean',
                result: 'settled cleanly',
                usage: AGENT_USAGE,
                modelUsage: {},
                permission_denials: [],
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const outcome = await runLadder(
        () => driver.run(invocation()),
        { wallClockMs: 20 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return; // narrow for TS
      expect(outcome.value.stopReason).toBe('aborted');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('cost prices the SERVED model when one was observed (remap rates, not requested rates)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            servedModel: 'gateway-default-served-instead',
          }),
        endpointTable: conformanceEndpointTable(),
        // The price map knows ONLY the served id — pricing the REQUESTED id
        // would return undefined and the verdict would carry no cost.
        pricing: (modelSpec) =>
          modelSpec.model === 'gateway-default-served-instead'
            ? { input: 3, output: 15 }
            : undefined,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ modelSpec: { provider: CONFORMANCE_PROVIDER, model: 'what-we-asked-for' } }),
      );
      expect(result.model).toBe('gateway-default-served-instead'); // the remap was surfaced
      expect(result.costUSD).toBeCloseTo(0.00054, 12); // usage {120, 12} at the SERVED id's rates
      expect(result.costBasis).toBe('modeled');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('foldMessage drops SDK user frames: tool outcomes live in our vocabulary, narration carries no vendor frame JSON', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // A scripted round WITH a tool call: assistant tool_use → the
      // registered harness tool executes in-process → an SDKUserMessage
      // (type 'user') delivering the tool_result → success result. The
      // execute boundary records the outcome in OUR vocabulary; the user
      // frame must be dropped, not narrated as raw vendor JSON.
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              const sessionId = 'agent-cli-userframe';
              const model = options['model'] as string;
              yield initFrame(options, { session_id: sessionId, model });
              const server = (
                options['mcpServers'] as
                  | Record<
                      string,
                      {
                        tools?: Array<{
                          name: string;
                          handler: (args: unknown, extra: unknown) => Promise<unknown>;
                        }>;
                      }
                    >
                  | undefined
              )?.['cq-harness'];
              const toolRecord = server?.tools?.find((t) => t.name === 'read');
              yield {
                type: 'assistant',
                session_id: sessionId,
                message: {
                  model,
                  content: [
                    {
                      type: 'tool_use',
                      id: 'u1',
                      name: 'mcp__cq-harness__read',
                      input: { path: 'absent.txt' },
                    },
                  ],
                  usage: AGENT_USAGE,
                },
              };
              await toolRecord?.handler({ path: 'absent.txt' }, undefined);
              // The frame under test: an SDK user-role tool_result delivery.
              yield {
                type: 'user',
                session_id: sessionId,
                message: {
                  role: 'user',
                  content: [
                    {
                      type: 'tool_result',
                      tool_use_id: 'u1',
                      content: [{ type: 'text', text: 'file body' }],
                    },
                  ],
                },
              };
              yield {
                type: 'assistant',
                session_id: sessionId,
                message: { model, content: [{ type: 'text', text: 'done' }], usage: AGENT_USAGE },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: sessionId,
                result: 'done',
                usage: AGENT_USAGE,
                modelUsage: {},
                permission_denials: [],
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: [], mode: 'unrestricted' } }),
      );
      expect(result.stopReason).toBe('complete');
      const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
      const record = await store.load(result.sessionId as string);
      expect(record).toBeDefined();
      // The tool outcome IS recorded — in OUR vocabulary, at the execute
      // boundary (the read executed and was denied on the merits).
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(true);
      // The user frame did NOT become narration: no narration message at
      // all (every frame in this stream is folded), hence no raw
      // vendor 'tool_result' JSON in persisted session data.
      const narration = record?.messages.find(
        (m) => m.role === 'tool' && m.toolName === 'agent-narration',
      );
      expect(narration).toBeUndefined();
      expect(
        record?.messages.some((m) => m.role === 'tool' && m.content.includes('tool_result')),
      ).toBe(false);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a TEXT-bearing SDK user frame is narrated (unusual evidence, never silently dropped)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const unusualText = 'cq-unusual-user-text-evidence';
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              const sessionId = 'agent-cli-usertext';
              const model = options['model'] as string;
              yield initFrame(options, { session_id: sessionId, model });
              // The frame under test: a user frame whose MessageParam
              // content carries an ordinary TEXT block — the normal flow
              // never emits one.
              yield {
                type: 'user',
                session_id: sessionId,
                message: {
                  role: 'user',
                  content: [{ type: 'text', text: unusualText }],
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: sessionId,
                result: 'done',
                usage: AGENT_USAGE,
                modelUsage: {},
                permission_denials: [],
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
      const record = await store.load(result.sessionId as string);
      expect(record).toBeDefined();
      const narration = record?.messages.find(
        (m) => m.role === 'tool' && m.toolName === 'agent-narration',
      );
      expect(narration).toBeDefined(); // the unusual frame is preserved as evidence
      expect(narration?.content).toContain(unusualText); // our vocabulary: the text is IN the narration
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a MALFORMED SDK user frame (message not a record) is dropped — the subprocess lane drop-if-unshapeable posture', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              const sessionId = 'agent-cli-userjunk';
              const model = options['model'] as string;
              yield initFrame(options, { session_id: sessionId, model });
              // Malformed: message is a string, not a record — nothing
              // shapeable to fold (subprocess lane: content undefined →
              // return). Dropped, not narrated, never a crash.
              yield { type: 'user', session_id: sessionId, message: 'garbage-not-a-record' };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: sessionId,
                result: 'done',
                usage: AGENT_USAGE,
                modelUsage: {},
                permission_denials: [],
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
      const record = await store.load(result.sessionId as string);
      expect(record).toBeDefined();
      // Dropped silently (no narration for an unshapeable user frame), and
      // the run settled honestly regardless.
      expect(
        record?.messages.some((m) => m.role === 'tool' && m.toolName === 'agent-narration'),
      ).toBe(false);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('endpoint lookup rejects prototype keys — constructor/toString are not providers', () => {
    expect(() =>
      resolveEndpoint({ provider: 'constructor', model: 'm' }, defaultEndpointTable()),
    ).toThrow(/unknown provider 'constructor'/);
    expect(() =>
      resolveEndpoint({ provider: 'toString', model: 'm' }, defaultEndpointTable()),
    ).toThrow(/unknown provider 'toString'/);
  });

  test('unknown sessionRef throws pre-dispatch — never a fake resume', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir);
      await expect(driver.run(invocation({ sessionRef: 'ses-does-not-exist' }))).rejects.toThrow(
        /unknown sessionRef 'ses-does-not-exist'/,
      );
      expect(calls).toEqual([]); // never dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('stopReason mapping table (checked in order: aborted → budget → error → complete)', () => {
    const inputs = (over: Partial<StopReasonInputs>): StopReasonInputs => ({
      aborted: false,
      maxTokens: undefined,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      resultStatus: 'success',
      ...over,
    });
    // 1. abort dominates every other condition.
    expect(
      stopReasonOf(
        inputs({
          aborted: true,
          maxTokens: 1,
          usage: { input: 9, output: 0, cacheRead: 0, cacheWrite: 0 },
          resultStatus: 'error',
        }),
      ),
    ).toBe('aborted');
    // 2. the token budget (folded usage >= maxTokens) trips before statuses.
    expect(
      stopReasonOf(
        inputs({
          maxTokens: 10,
          usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0 },
          resultStatus: 'success',
        }),
      ),
    ).toBe('budget');
    expect(
      stopReasonOf(
        inputs({
          maxTokens: 10,
          usage: { input: 4, output: 4, cacheRead: 1, cacheWrite: 1, reasoning: 2 },
          resultStatus: 'error',
        }),
      ),
    ).toBe('budget');
    // 3. the SDK's own caps are budget stops (error_max_turns / error_max_budget_usd).
    expect(stopReasonOf(inputs({ resultStatus: 'cap' }))).toBe('budget');
    // 4. success (is_error ≠ true) is the only complete.
    expect(stopReasonOf(inputs({ resultStatus: 'success' }))).toBe('complete');
    // 5. everything else is an error: success-with-is_error, other subtypes, no result.
    expect(stopReasonOf(inputs({ resultStatus: 'error' }))).toBe('error');
    expect(stopReasonOf(inputs({ resultStatus: 'none' }))).toBe('error');
  });

  test('resultStatusOf: success / cap / error / none over the raw result event', () => {
    expect(resultStatusOf(undefined)).toBe('none');
    expect(resultStatusOf({ subtype: 'success', is_error: false })).toBe('success');
    expect(resultStatusOf({ subtype: 'success', is_error: true })).toBe('error'); // success-with-is_error
    expect(resultStatusOf({ subtype: 'error_max_turns', is_error: true })).toBe('cap');
    expect(resultStatusOf({ subtype: 'error_max_budget_usd', is_error: true })).toBe('cap');
    expect(resultStatusOf({ subtype: 'error_during_execution', is_error: true })).toBe('error');
    expect(resultStatusOf({ subtype: 'error_max_structured_output_retries', is_error: true })).toBe(
      'error',
    );
    expect(resultStatusOf({ subtype: 'something-new' })).toBe('error'); // unknown → not a success
  });

  test('usage mapping: agent vocabulary → frozen Usage; reasoning NEVER set (thinking tokens are a subset of output)', () => {
    // thinkingTokens reported → reasoning still ABSENT: the SDK counts
    // thinking INSIDE output_tokens, so a separate field would double-count
    // every total that sums the frozen Usage fields.
    expect(
      usageFromAgent({
        input_tokens: 90,
        output_tokens: 42,
        cache_read_input_tokens: 15,
        cache_creation_input_tokens: 5,
      }),
    ).toEqual({ input: 90, output: 42, cacheRead: 15, cacheWrite: 5 });
    expect(usageFromAgent({ input_tokens: 1, output_tokens: 2 })).not.toHaveProperty('reasoning');
    // Missing numeric fields map to 0.
    expect(usageFromAgent({ input_tokens: 10, output_tokens: 3 })).toEqual({
      input: 10,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // An unshaped usage is NO measurement.
    expect(usageFromAgent('garbage')).toBeUndefined();
    expect(usageFromAgent(undefined)).toBeUndefined();
    // Non-finite numbers are as absent as missing ones.
    expect(usageFromAgent({ input_tokens: Number.NaN, output_tokens: 1 })).toEqual({
      input: 0,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
    });
    // Lying measurements (issue #19-3 twin): negatives and fractions fold to
    // an honest 0 — never negative usage, never a negative-cost propagation.
    expect(
      usageFromAgent({
        input_tokens: -200_000,
        output_tokens: 150_000,
        cache_read_input_tokens: -3,
        cache_creation_input_tokens: 2.5,
      }),
    ).toEqual({ input: 0, output: 150_000, cacheRead: 0, cacheWrite: 0 });
  });

  test('a LYING usage report trips the maxTokens budget verdict instead of bypassing it (#19-3 twin)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'lying usage' },
            calls,
            // The lying SDK shape: a negative input masks real spend — the
            // OLD asNumber folded -200,000 (total −50,000, never `>= cap`)
            // and the budget verdict was bypassed forever.
            usage: {
              input_tokens: -200_000,
              output_tokens: 150_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ prompt: 'lying usage run', budget: { maxTokens: 1000 } }),
      );
      // The tightened fold: the negative field → 0, so the total is 150,000
      // ≥ 1000 — the budget verdict, not a silent bypass.
      expect(result.stopReason).toBe('budget');
      expect(result.usage).toEqual({ input: 0, output: 150_000, cacheRead: 0, cacheWrite: 0 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('budget classification uses the TRUE total — thinking tokens are not added on top of output', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // The mock's result usage totals 152 (120+12+15+5) and its modelUsage
      // reports thinkingTokens: 2. With the old double-count (152 + 2 = 154)
      // a cap of 153 would misclassify 'budget'; the true total is below it.
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: 'ok' }, calls: [] }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const below = await driver.run(invocation({ budget: { maxTokens: 153 } }));
      expect(below.stopReason).toBe('complete'); // 152 < 153 — the true total decides
      expect(below.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
      expect(below.usage.reasoning).toBeUndefined();
      const at = await driver.run(invocation({ budget: { maxTokens: 152 } }));
      expect(at.stopReason).toBe('budget'); // 152 >= 152 — the boundary still trips on the true total
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('pure helpers: allowedToolNames and sandboxOption', () => {
    expect(allowedToolNames(['read', 'edit', 'run'], { allow: [], mode: 'none' })).toEqual([]);
    expect(allowedToolNames(['read', 'edit', 'run'], { allow: [] })).toEqual([]); // default reading: allowlist
    expect(
      allowedToolNames(['read', 'edit', 'run'], { allow: ['run'], mode: 'allowlist' }),
    ).toEqual(['run']);
    expect(allowedToolNames(['read', 'edit', 'run'], { allow: [], mode: 'unrestricted' })).toEqual([
      'read',
      'edit',
      'run',
    ]);
    expect(sandboxOption('none')).toBeUndefined();
    expect(sandboxOption('workspace-write')).toEqual({ enabled: true, failIfUnavailable: false });
    expect(sandboxOption('read-only')).toEqual({ enabled: true, failIfUnavailable: false });
  });

  test('foldMessage: init/assistant/result fold; junk frames become narration, never crashes', () => {
    const observation = {
      agentSessionId: undefined as string | undefined,
      servedModel: undefined as string | undefined,
      transcript: [] as string[],
      narration: [] as string[],
      assistantUsage: undefined,
      result: undefined,
      error: undefined as string | undefined,
      deniedToolUseIds: new Set<string>(),
      denials: [],
      expectedSurface: undefined,
      initSeen: false,
      harnessFailure: undefined,
    };
    foldMessage(observation, 'not even an object');
    foldMessage(observation, { type: 'system', subtype: 'init', session_id: 's1', model: 'm-1' });
    foldMessage(observation, {
      type: 'assistant',
      session_id: 's1',
      message: {
        model: 'm-2',
        content: [{ type: 'text', text: 'hi' }],
        usage: { input_tokens: 1, output_tokens: 2 },
      },
    });
    foldMessage(observation, { type: 'system', subtype: 'something-new', payload: 'evidence' });
    foldMessage(observation, {
      type: 'result',
      session_id: 's1',
      subtype: 'success',
      is_error: false,
      usage: { input_tokens: 3 },
    });
    expect(observation.agentSessionId).toBe('s1');
    // The RESPONSE-reported id (m-2) wins over the init-reported one (m-1).
    expect(observation.servedModel).toBe('m-2');
    expect(observation.transcript).toEqual(['hi']);
    expect(observation.assistantUsage).toEqual({
      input: 1,
      output: 2,
      cacheRead: 0,
      cacheWrite: 0,
    });
    expect(observation.narration).toHaveLength(2); // the string + the unknown subtype
    expect(observation.result?.['subtype']).toBe('success');
  });
});

// ---------------------------------------------------------------------------
// 3. The fail-closed init-surface assertion (W1.4, ADR-0002 Annex A.2)
// ---------------------------------------------------------------------------

/** The narration marker objects persisted for one run (parsed JSON lines). */
async function narrationMarkers(
  scratchDir: string,
  sessionId: string | undefined,
): Promise<Array<Record<string, unknown>>> {
  const record = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(sessionId as string);
  const narration = record?.messages.find(
    (m) => m.role === 'tool' && m.toolName === 'agent-narration',
  );
  if (narration === undefined) return [];
  return (JSON.parse(narration.content) as string[]).flatMap((line) => {
    try {
      const parsed = JSON.parse(line) as unknown;
      return typeof parsed === 'object' && parsed !== null
        ? [parsed as Record<string, unknown>]
        : [];
    } catch {
      return [];
    }
  });
}

/** The session record's executed-tool messages (role 'tool', excluding narration). */
async function executedToolMessages(
  scratchDir: string,
  sessionId: string | undefined,
): Promise<string[]> {
  const record = await new SessionStore(join(scratchDir, SESSIONS_DIR)).load(sessionId as string);
  return (record?.messages ?? [])
    .filter((m) => m.role === 'tool' && m.toolName !== 'agent-narration')
    .map((m) => m.toolName ?? '');
}

describe('claude-agent init-surface assertion (mock sdk)', () => {
  test('options close the surface: settingSources [] and strictMcpConfig true', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const { driver, calls } = driverWithCalls(scratchDir, {
        directive: { kind: 'reply', text: 'ok' },
      });
      await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      await driver.run(invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }));
      for (const nth of [0, 1]) {
        expect(optionsOf(calls, nth)['settingSources']).toEqual([]);
        expect(optionsOf(calls, nth)['strictMcpConfig']).toBe(true);
      }
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('subscription connectors do NOT leak: the closing options keep the honest init surface exact → complete', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls,
            subscriptionConnectors: true,
          }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.error).toBeUndefined();
      // The mock's derivation is not vacuous: WITHOUT the closing options
      // the same subscription posture would attach the connector.
      const leaky = honestInitSurface(
        { ...optionsOf(calls), settingSources: undefined, strictMcpConfig: undefined },
        { subscriptionConnectors: true },
      );
      expect(leaky.tools).toContain('mcp__claude_ai_Gmail__send_message');
      expect(honestInitSurface(optionsOf(calls), { subscriptionConnectors: true })).toEqual({
        tools: ['mcp__cq-harness__read', 'mcp__cq-harness__edit', 'mcp__cq-harness__run'],
        mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('init MISMATCH (an extra claude.ai connector server + its tools) → error, harness prefix, narration marker; no later frame is consumed', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      let handlerCalled = false;
      let framesAfterInit = 0;
      let generatorClosed = false;
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              try {
                const surface = honestInitSurface(options);
                // A host that IGNORES the closing options: the account's
                // connector rides the worker's surface anyway.
                yield initFrame(options, {
                  session_id: 'agent-cli-leak',
                  tools: [...surface.tools, ...MOCK_CONNECTOR_TOOLS],
                  mcp_servers: [...surface.mcp_servers, MOCK_CONNECTOR_SERVER],
                });
                framesAfterInit += 1;
                const server = (options['mcpServers'] as Record<string, { tools?: MockSdkTool[] }>)[
                  'cq-harness'
                ];
                const runTool = server?.tools?.find((t) => t.name === 'run');
                yield {
                  type: 'assistant',
                  session_id: 'agent-cli-leak',
                  message: {
                    model: options['model'],
                    content: [
                      {
                        type: 'tool_use',
                        id: 'leak-1',
                        name: 'mcp__cq-harness__run',
                        input: { command: 'echo x > note.txt' },
                      },
                    ],
                    usage: AGENT_USAGE,
                  },
                };
                framesAfterInit += 1;
                handlerCalled = true;
                await runTool?.handler({ command: 'echo x > note.txt' }, undefined);
                yield {
                  type: 'result',
                  subtype: 'success',
                  is_error: false,
                  session_id: 'agent-cli-leak',
                  result: 'done',
                  usage: AGENT_USAGE,
                  permission_denials: [],
                };
              } finally {
                generatorClosed = true;
              }
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('init surface mismatch');
      expect(result.error).toContain('mcp__claude_ai_Gmail__send_message');
      // The loop broke on the init frame: the generator was returned
      // (closed) and never resumed — the later tool call never executed.
      expect(framesAfterInit).toBe(0);
      expect(handlerCalled).toBe(false);
      expect(generatorClosed).toBe(true);
      expect(await executedToolMessages(scratchDir, result.sessionId)).toEqual([]);
      const marker = (await narrationMarkers(scratchDir, result.sessionId)).find(
        (m) => m['cq'] === 'harness-surface-mismatch',
      );
      expect(marker).toMatchObject({
        cq: 'harness-surface-mismatch',
        errorClass: 'harness',
        expected: {
          mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
          tools: ['mcp__cq-harness__edit', 'mcp__cq-harness__read', 'mcp__cq-harness__run'],
        },
      });
      const observed = marker?.['observed'] as { mcp_servers: unknown; tools: string[] };
      expect(observed.mcp_servers).toContainEqual({ name: 'claude.ai Gmail', status: 'connected' });
      expect(observed.tools).toContain('mcp__claude_ai_Gmail__send_message');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the scripted mock with a tampered init: an extra server alone is a mismatch (tools exact)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({
            directive: {
              kind: 'tool-then-reply',
              tool: 'run',
              input: { command: 'echo x > note.txt' },
              reply: 'unused',
            },
            calls,
            tamperInit: (surface) => ({
              ...surface,
              mcp_servers: [...surface.mcp_servers, MOCK_CONNECTOR_SERVER],
            }),
          }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(await executedToolMessages(scratchDir, result.sessionId)).toEqual([]);
      expect(result.denials).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('MISSING harness server (status failed) → error with the harness prefix and marker', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            // A failed server contributes no tools and reports 'failed'.
            tamperInit: (surface) => ({
              tools: surface.tools.filter((t) => !t.startsWith('mcp__cq-harness__')),
              mcp_servers: surface.mcp_servers.map((server) => ({ ...server, status: 'failed' })),
            }),
          }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      const marker = (await narrationMarkers(scratchDir, result.sessionId)).find(
        (m) => m['cq'] === 'harness-surface-mismatch',
      );
      expect(marker).toMatchObject({
        errorClass: 'harness',
        expected: {
          mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
          tools: ['mcp__cq-harness__read'],
        },
        observed: { mcp_servers: [{ name: 'cq-harness', status: 'failed' }], tools: [] },
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a harness tool the init frame does not list (only a subset connected) → mismatch', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: (surface) => ({
              ...surface,
              tools: surface.tools.filter((t) => t !== 'mcp__cq-harness__run'),
            }),
          }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('MISSING init frame: a run with a result but no init → unverified harness error', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              yield {
                type: 'assistant',
                session_id: 'agent-cli-noinit',
                message: {
                  model: options['model'],
                  content: [{ type: 'text', text: 'looks fine' }],
                  usage: AGENT_USAGE,
                },
              };
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 'agent-cli-noinit',
                result: 'looks fine',
                usage: AGENT_USAGE,
                permission_denials: [],
                structured_output: { answer: 'ok' }, // schema-valid, but unverified
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        outputSchema: z.object({ answer: z.string() }).strict(),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('never reported its init surface');
      const markers = await narrationMarkers(scratchDir, result.sessionId);
      expect(markers).toContainEqual({ cq: 'harness-surface-unverified', errorClass: 'harness' });
      // A real measurement still rides the error verdict (usage is honest)…
      expect(result.usage).toEqual({ input: 120, output: 12, cacheRead: 15, cacheWrite: 5 });
      // …but the payload produced on an unverified surface never does (review r1).
      expect(result.structuredOutput).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('outputFormat set → StructuredOutput is part of the expected surface (present: complete; absent: mismatch)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const schema = z.object({ answer: z.string() }).strict();
      const base = {
        endpointTable: conformanceEndpointTable(),
        outputSchema: schema,
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      };
      const calls: MockQueryCall[] = [];
      const ok = await new ClaudeAgentDriver({
        ...base,
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"answer":"ok"}' }, calls }),
      }).run(invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }));
      expect(ok.stopReason).toBe('complete');
      expect(ok.structuredOutput).toEqual({ answer: 'ok' });
      expect(honestInitSurface(optionsOf(calls)).tools).toEqual([
        'mcp__cq-harness__read',
        'StructuredOutput',
      ]);

      const missing = await new ClaudeAgentDriver({
        ...base,
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: '{"answer":"ok"}' },
            calls: [],
            tamperInit: (surface) => ({
              ...surface,
              tools: surface.tools.filter((t) => t !== 'StructuredOutput'),
            }),
          }),
      }).run(invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }));
      expect(missing.stopReason).toBe('error');
      expect(missing.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(missing.structuredOutput).toBeUndefined();

      // And without outputFormat a StructuredOutput entry is an EXTRA tool.
      const extra = await new ClaudeAgentDriver({
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: (surface) => ({
              ...surface,
              tools: [...surface.tools, 'StructuredOutput'],
            }),
          }),
      }).run(invocation());
      expect(extra.stopReason).toBe('error');
      expect(extra.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('mode none expects NO servers and NO tools (or only StructuredOutput with outputFormat)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      const calls: MockQueryCall[] = [];
      const { driver } = driverWithCalls(scratchDir, { directive: { kind: 'reply', text: 'ok' } });
      const none = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(none.stopReason).toBe('complete');

      const structured = await new ClaudeAgentDriver({
        endpointTable: conformanceEndpointTable(),
        outputSchema: z.object({ answer: z.string() }),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({ directive: { kind: 'reply', text: '{"answer":"x"}' }, calls }),
      }).run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(structured.stopReason).toBe('complete');
      expect(honestInitSurface(optionsOf(calls))).toEqual({
        tools: ['StructuredOutput'],
        mcp_servers: [],
      });

      // Any server at all in mode none is a mismatch — even a connected harness.
      const leaked = await new ClaudeAgentDriver({
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: () => ({
              tools: ['mcp__cq-harness__read'],
              mcp_servers: [{ name: 'cq-harness', status: 'connected' }],
            }),
          }),
      }).run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(leaked.stopReason).toBe('error');
      expect(leaked.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);

      // A leaked builtin (tools: [] no longer stripping) is a mismatch too.
      const builtin = await new ClaudeAgentDriver({
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sdkLoader: async () =>
          mockSdkModule({
            directive: { kind: 'reply', text: 'ok' },
            calls: [],
            tamperInit: (surface) => ({ ...surface, tools: [...surface.tools, 'Bash'] }),
          }),
      }).run(invocation({ toolPolicy: { allow: [], mode: 'none' } }));
      expect(builtin.stopReason).toBe('error');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a governed abort still yields aborted — even when the SDK never sent an init frame', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'agtdrv-'));
    try {
      // Settles CLEANLY with a result but NO init frame, only after the
      // governed signal fired: aborted outranks the unverified check.
      const driver = new ClaudeAgentDriver({
        sdkLoader: async () => ({
          ...mockAdapters,
          query: ({
            options,
          }: {
            prompt: string;
            options: Record<string, unknown>;
          }): AsyncGenerator<unknown, void> =>
            (async function* () {
              const signal = (options['abortController'] as { signal?: AbortSignal } | undefined)
                ?.signal;
              if (signal !== undefined) {
                await new Promise<void>((resolve) => {
                  if (signal.aborted) resolve();
                  else signal.addEventListener('abort', () => resolve(), { once: true });
                });
              }
              yield {
                type: 'result',
                subtype: 'success',
                is_error: false,
                session_id: 'agent-cli-abort-noinit',
                result: 'late',
                usage: AGENT_USAGE,
                permission_denials: [],
              };
            })(),
        }),
        endpointTable: conformanceEndpointTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: conformanceHarnessConfig(scratchDir),
      });
      const outcome = await runLadder(
        () => driver.run(invocation()),
        { wallClockMs: 20 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.error).toBeUndefined();

      // And the scripted block-until-abort path (honest init first) too.
      const { driver: blocking } = driverWithCalls(scratchDir, {
        directive: { kind: 'block-until-abort' },
      });
      const blocked = await runLadder(
        () => blocking.run(invocation()),
        { wallClockMs: 20 },
        { op: 'claude-agent', jobKey: 'claude-agent', attempt: 1 },
      );
      expect(blocked.outcome).toBe('completed');
      if (blocked.outcome !== 'completed') return;
      expect(blocked.value.stopReason).toBe('aborted');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('foldMessage asserts only the FIRST init frame', () => {
    const observation: Parameters<typeof foldMessage>[0] = {
      agentSessionId: undefined,
      servedModel: undefined,
      transcript: [],
      narration: [],
      assistantUsage: undefined,
      result: undefined,
      error: undefined,
      deniedToolUseIds: new Set<string>(),
      denials: [],
      expectedSurface: { harness: true, tools: ['read'], internalTools: [] },
      initSeen: false,
      harnessFailure: undefined,
    };
    foldMessage(observation, {
      type: 'system',
      subtype: 'init',
      tools: ['mcp__cq-harness__read'],
      mcp_servers: [{ name: 'cq-harness', status: 'connected', source: 'sdk' }],
    });
    expect(observation.initSeen).toBe(true);
    expect(observation.harnessFailure).toBeUndefined(); // extra fields beyond {name,status} are ignored
    foldMessage(observation, { type: 'system', subtype: 'init', tools: ['Bash'], mcp_servers: [] });
    expect(observation.harnessFailure).toBeUndefined(); // a later init is not re-asserted
  });
});

describe('claude-agent harness calls are cancellable (W1.4 review cycle 1)', () => {
  test.skipIf(process.platform === 'win32')(
    'runHarnessTool forwards the signal: an abort kills a running `run` command group',
    async () => {
      const dir = await realpath(await mkdtemp(join(tmpdir(), 'cq-ca-cancel-')));
      try {
        const workspace = join(dir, 'ws');
        await mkdir(workspace);
        const manifest = await buildManifest({
          workspace,
          sandbox: 'none',
          toolPolicy: { allow: ['run'], mode: 'allowlist' },
          harness: {
            ...defaultHarnessConfig,
            tools: {
              ...defaultHarnessConfig.tools,
              run: { enabled: true, commandPatterns: ['sleep'], timeoutMs: 60_000 },
            },
          },
        });
        if (manifest === undefined) throw new Error('expected a manifest');
        const surface = createHarnessSurface(manifest);
        const store = new SessionStore(join(dir, 'sessions'));
        const record = await store.create(workspace);
        const denials: Array<{ tool: string; reason: string }> = [];
        const cancel = new AbortController();
        const started = Date.now();
        const pending = runHarnessTool(
          surface,
          'run',
          { command: 'sleep 30' },
          store,
          record,
          denials,
          cancel.signal,
        );
        setTimeout(() => cancel.abort(), 300);
        const result = await pending;
        expect(Date.now() - started).toBeLessThan(15_000);
        expect(result.isError).toBeUndefined();
        expect(result.content?.[0]?.text).toContain('killed by signal');
        expect(denials).toEqual([]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
