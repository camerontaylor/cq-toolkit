// Shared mock-SDK module and conformance wiring for the claude-code
// sdk-transport suites (sdk.*.test.ts in this directory). The mock is OUR
// code: plain objects satisfying the driver's minimal structural
// AgentSdkModule — no @anthropic-ai/claude-agent-sdk dependency (I10), no
// network, no real CLI. The driver reads key VALUES from the environment at
// run() time (the endpoint carries names only), hence the env seed below.
import { join } from 'node:path';
import type { ZodType } from 'zod';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import type { SdkTransportOptions } from '../../../src/driver/claude-code/sdk.js';
import {
  RoutingTableSchema,
  defaultRoutingTable,
} from '../../../src/driver/claude-code/routing.js';
import type { RoutingTable as EndpointTable } from '../../../src/driver/claude-code/routing.js';
import type { ModelDirective } from '../../../src/driver/conformance.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER } from '../../../src/driver/conformance.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import type { OpInvocation, OutputSchema } from '../../../src/driver/types.js';

// The driver reads key VALUES from the environment at run() time (the
// endpoint carries names only); the conformance endpoint's fake key is set
// once here (the subprocess test's pattern — env is never mutated per-run).
process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

// ---------------------------------------------------------------------------
// The mock SDK module — OUR code, plain objects, zero vendor types
// ---------------------------------------------------------------------------

/** One MCP tool record as the driver's `sdk.tool()` adapter produces it. */
export interface MockSdkTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<{ content?: Array<{ type: string; text?: string }>; isError?: boolean }>;
}

/** One recorded query call: the exact prompt + options the driver handed over. */
export interface MockQueryCall {
  prompt: string;
  options: Record<string, unknown>;
}

/** The mock's per-step token usage — numbers the usage contract can assert on. */
export const AGENT_USAGE = {
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
export const MOCK_CONNECTOR_SERVER: MockServerStatus = {
  name: 'claude.ai Gmail',
  status: 'connected',
};
export const MOCK_CONNECTOR_TOOLS = [
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
export function honestInitSurface(
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
export function initFrame(
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
    // The vendor's OWN quota-with-reset shape (the claude CLI's usage-limit
    // failure): the script behind the conformance suite's leg s quota
    // producer rule — the mock's fail emits the vendor quota signals where
    // the vendor supports them. The driver must still RETURN an error
    // verdict, never throw past the seam.
    throw new Error("You've hit your use limit · resets 1h30m");
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
        : // The output-invalid legs' script: prose that is NOT the JSON
          // object a structured-output schema demands (the other lanes'
          // mocks answer this directive with the same shape).
          directive?.kind === 'reply-invalid-json'
          ? 'this reply is prose, not the required JSON object'
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
        // The per-model aggregate derives from the SAME effective usage the
        // flat channel reports (no subagents in this mock): an override of
        // `usage` moves both channels together, which is what the
        // lying-usage and budget legs script.
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadInputTokens: usage.cache_read_input_tokens,
        cacheCreationInputTokens: usage.cache_creation_input_tokens,
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
export const mockAdapters = {
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
    instance: {
      server: {
        setRequestHandler: (_schema: unknown, _handler: unknown): void => {},
      },
    },
  }),
};

/** Build the mock module for one directive; records every query call. */
export function mockSdkModule(script: {
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
export function conformanceEndpointTable(): EndpointTable {
  return RoutingTableSchema.parse({
    endpoints: {
      ...defaultRoutingTable().endpoints,
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
export function conformanceHarnessConfig(
  scratchDir: string,
): NonNullable<SdkTransportOptions['harnessConfig']> {
  return {
    ...defaultHarnessConfig,
    workspaceRoot: join(scratchDir, 'workspaces'),
    tools: {
      ...defaultHarnessConfig.tools,
      bash: {
        ...defaultHarnessConfig.tools.bash,
        // `echo conformance-marker > note.txt` redirects — the shell-
        // metacharacter guard denies that under a token pattern, so the
        // conformance write rides the documented escape hatch: an anchored
        // re: pattern matching exactly the isolation write.
        commandPatterns: ['re:^echo .* > note\\.txt$'],
      },
    },
  };
}

/** Minimal invocation for the driver-specific tests. */
export function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
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
export function driverWithCalls(
  scratchDir: string,
  opts: {
    directive?: ModelDirective;
    servedModel?: string;
    envAllowlist?: readonly string[];
  } = {},
): { driver: ClaudeCodeDriver; calls: MockQueryCall[] } {
  const calls: MockQueryCall[] = [];
  const driver = new ClaudeCodeDriver({
    transport: 'sdk',
    sdkLoader: async () => mockSdkModule({ ...opts, calls }),
    routingTable: conformanceEndpointTable(),
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(scratchDir),
    ...(opts.envAllowlist === undefined ? {} : { envAllowlist: opts.envAllowlist }),
  });
  return { driver, calls };
}

/** The options object of the Nth (0-based) recorded query call. */
export function optionsOf(calls: MockQueryCall[], nth = 0): Record<string, unknown> {
  const options = calls[nth]?.options;
  if (options === undefined) throw new Error(`no recorded query call #${nth}`);
  return options;
}

/** A run that is expected to THROW — resolves with the thrown value (errorClassOf fodder). */
export async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (err) {
    return err;
  }
}

/** The invocation schema the §2.3 tests carry: `{answer: string}`, closed. */
export const ANSWER_OUTPUT_SCHEMA: OutputSchema = {
  name: 'test.answer/v1',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
};

/** A driver whose SDK mock replays ONE fixed frame list (init + others). */
export function streamDriver(
  scratchDir: string,
  frames: (options: Record<string, unknown>) => unknown[],
  opts: { outputSchema?: ZodType; directive?: ModelDirective } = {},
): ClaudeCodeDriver {
  return new ClaudeCodeDriver({
    transport: 'sdk',
    sdkLoader: async () => ({
      ...mockAdapters,
      query: ({
        options,
      }: {
        prompt: string;
        options: Record<string, unknown>;
      }): AsyncGenerator<unknown, void> =>
        (async function* () {
          yield initFrame(options);
          for (const frame of frames(options)) yield frame;
        })(),
    }),
    routingTable: conformanceEndpointTable(),
    ...(opts.outputSchema === undefined ? {} : { outputSchema: opts.outputSchema }),
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(scratchDir),
  });
}
