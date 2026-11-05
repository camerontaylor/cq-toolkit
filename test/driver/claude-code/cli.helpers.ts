// Shared fixtures and helpers for the split claude-code CLI-transport suites
// (a pure move from the former test/driver/claude-code/cli.test.ts). Every
// test file imports this module FIRST so the launch-spec mock below registers
// before any driver import — the same file-wide effect the single original
// file had. (vi.hoisted is not available here: a plain module object is
// equivalent once the module is imported first.)
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import { ClaudeCodeDriver } from '../../../src/driver/claude-code/index.js';
import { handleStdoutLine } from '../../../src/driver/claude-code/cli.js';
import type { CliTransportOptions, SpawnFn } from '../../../src/driver/claude-code/cli.js';
import { fakeManagedSpawn } from '../../helpers/transport-fakes.js';
import type { JsonLineFrame, JsonLinePeer } from '../../helpers/transport-fakes.js';
import {
  RoutingTableSchema,
  defaultRoutingTable,
} from '../../../src/driver/claude-code/routing.js';
import type { RoutingTable } from '../../../src/driver/claude-code/routing.js';
import { spawnManaged } from '../../../src/shared/proc.js';
import type { ConformanceSpec, ModelDirective } from '../../../src/driver/conformance.js';
import {
  CONFORMANCE_MODEL,
  CONFORMANCE_PROVIDER,
  SESSIONS_DIR,
} from '../../../src/driver/conformance.js';
import { defaultHarnessConfig } from '../../../src/harness/config.js';
import { SessionStore } from '../../../src/harness/session.js';
import { canonicalToolName } from '../../../src/harness/tools.js';
import type { Driver, OpInvocation, OutputSchema } from '../../../src/driver/types.js';

// The harness MCP server runs from TypeScript SOURCE in these process-level
// runs (no build): the launch spec is mocked onto `node --import <the test
// TS loader> src/harness/mcp/bin.ts` — the real server, the real shared core.
// `launchControl.extraArgs` lets one test append a stray argument so the
// REAL server refuses its argv at startup (exit 78 → status 'failed').
export const launchControl: { extraArgs: string[] } = { extraArgs: [] };
vi.mock('../../../src/harness/mcp/launch.js', () => {
  const fromHere = (rel: string): string =>
    decodeURIComponent(new URL(rel, import.meta.url).pathname);
  return {
    harnessServerLaunch: () => ({
      command: process.execPath,
      args: [
        '--import',
        fromHere('../../../test/helpers/ts-source-loader.mjs'),
        fromHere('../../../src/harness/mcp/bin.ts'),
        ...launchControl.extraArgs,
      ],
    }),
  };
});

// Every run spawns TWO node processes (the fake CLI + the source-loaded MCP
// server); on a loaded machine that outgrows vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

// The fake CLI: node + the fixture script, spawned through the driver's
// argv template `binary` option (shell:false — argv is element-built).
export const FAKE_CLI = fileURLToPath(
  new URL('../../fixtures/fake-agent-cli.mjs', import.meta.url),
);

// The driver reads key VALUES from the environment at run() time (the route
// carries names only); the conformance endpoint's fake key is set once here.
process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

/**
 * The conformance routing table: the shipped default (zai / deepseek /
 * anthropic, as-of 2026-09) extended with the suite's canonical provider
 * handles — `conformance` (never priced) and `conformance-priced` — pointed
 * at a black-hole URL no child ever contacts (the fixture IS the model).
 */
export function conformanceRoutingTable(): RoutingTable {
  return RoutingTableSchema.parse({
    endpoints: {
      ...defaultRoutingTable().endpoints,
      conformance: {
        baseUrlEnv: 'CONFORMANCE_BASE_URL',
        baseUrlDefault: 'http://127.0.0.1:1/anthropic',
        keyEnv: 'CONFORMANCE_API_KEY',
        models: ['conformance-1'],
        notes: 'test endpoint: the fake agent CLI is the model; the URL is never contacted',
      },
      'conformance-priced': {
        baseUrlEnv: 'CONFORMANCE_PRICED_BASE_URL',
        baseUrlDefault: 'http://127.0.0.1:1/anthropic',
        keyEnv: 'CONFORMANCE_API_KEY',
        models: ['priced-1'],
        notes: 'test endpoint for the derived-costUSD conformance leg',
      },
    },
  });
}

/** The --allowedTools value of a built argv (the fixture's permission gate). */
export function allowedToolsArg(args: readonly string[]): string {
  const index = args.indexOf('--allowedTools');
  return index !== -1 && index + 1 < args.length ? (args[index + 1] as string) : '';
}

/** The parsed --json-schema value of a built argv (the CLI's structured-output contract). */
export function jsonSchemaArgOf(args: readonly string[]): Record<string, unknown> {
  const index = args.indexOf('--json-schema');
  if (index === -1 || index + 1 >= args.length) throw new Error('--json-schema missing from argv');
  return JSON.parse(args[index + 1] as string) as Record<string, unknown>;
}

/** One recorded spawn call: the exact argv + env the driver handed over. */
export interface SpawnCall {
  args: string[];
  env: Record<string, string>;
}

/**
 * A spawn override that records every call (argv/env evidence for the
 * resume and zero-spawn assertions) and merges `extraEnv` over the driver's
 * child env before delegating to the REAL spawnManaged — the fixture is a
 * real process in a real workspace, only the MODEL is fake.
 */
export function recordingSpawn(calls: SpawnCall[], extraEnv: Record<string, string> = {}): SpawnFn {
  return (opts) => {
    calls.push({ args: [...opts.args], env: { ...opts.env } });
    // The fixture's permission simulation reads FAKE_AGENT_ALLOWED, so the
    // driver's --allowedTools value is forwarded verbatim — the fixture now
    // simulates --permission-prompts none faithfully.
    const allowed = allowedToolsArg(opts.args);
    return spawnManaged({
      ...opts,
      env: { ...opts.env, ...extraEnv, FAKE_AGENT_ALLOWED: allowed },
    });
  };
}

/** Base driver options shared by every test: fake binary, conformance routes, scratch dirs. */
export function baseOptions(
  scratchDir: string,
  extraEnv: Record<string, string>,
  calls: SpawnCall[],
): CliTransportOptions {
  return {
    binary: ['node', FAKE_CLI],
    routingTable: conformanceRoutingTable(),
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(scratchDir),
    spawn: recordingSpawn(calls, extraEnv),
  };
}

/**
 * The harness config every fake-CLI run uses: workspaces inside scratchDir,
 * and the conformance isolation write (`echo … > note.txt`) permitted via an
 * anchored re: pattern (token patterns deny redirects by design) — the same
 * config the ai-sdk and claude-code sdk-transport instantiations use, because in harness
 * mode the REAL harness (served over MCP) executes the tool.
 */
export function conformanceHarnessConfig(
  scratchDir: string,
): NonNullable<CliTransportOptions['harnessConfig']> {
  return {
    ...defaultHarnessConfig,
    workspaceRoot: join(scratchDir, 'workspaces'),
    tools: {
      ...defaultHarnessConfig.tools,
      bash: { ...defaultHarnessConfig.tools.bash, commandPatterns: ['re:^echo .* > note\\.txt$'] },
    },
  };
}

let fakeManagedSessionCounter = 0;

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Tool-leg directive → FAKE_AGENT_* env for the REAL fixture CLI. Tool legs keep the
 * real process: in harness mode the harness MCP server the fixture spawns
 * executes the tool and records the session, a boundary an in-process fake
 * cannot honestly stand in for.
 */
function toolLegEnv(
  directive: Extract<ModelDirective, { kind: 'tool-then-reply' }>,
): Record<string, string> {
  return {
    FAKE_AGENT_MODE: 'tool-then-reply',
    FAKE_AGENT_TOOL: directive.tool,
    FAKE_AGENT_INPUT: JSON.stringify(directive.input),
    FAKE_AGENT_REPLY: directive.reply,
  };
}

/**
 * In-process stand-in for the stream-json CLI on the non-tool conformance
 * legs. It reports the init surface the fail-closed assertion demands:
 * exactly the driver's `--allowedTools` plus `StructuredOutput` under
 * `--json-schema`, and the `cq-harness` server connected when configured.
 */
function fakeManagedScript(
  opts: { cwd: string; args: readonly string[] },
  directive: ModelDirective | undefined,
): (frame: JsonLineFrame, peer: JsonLinePeer) => void {
  const modelIndex = opts.args.indexOf('--model');
  const model =
    modelIndex === -1 ? 'conformance-1' : (opts.args[modelIndex + 1] ?? 'conformance-1');
  const allowedIndex = opts.args.indexOf('--allowedTools');
  const allowed = (allowedIndex === -1 ? '' : (opts.args[allowedIndex + 1] ?? ''))
    .split(' ')
    .filter(Boolean)
    // The real CLI reports the MCP server's tools/list, which advertises
    // canonical names only; --allowedTools also carries the one-release
    // `run` alias, which the init surface must not duplicate.
    .map((name) =>
      name === 'mcp__cq-harness__run' ? 'mcp__cq-harness__bash' : canonicalToolName(name),
    )
    .filter((name, index, all) => all.indexOf(name) === index);
  const harnessMode = opts.args.includes('--tools');
  const hasSchema = opts.args.includes('--json-schema');
  const sessionId = `fake-cli-${fakeManagedSessionCounter++}`;
  const usage = {
    input_tokens: 10,
    output_tokens: 5,
    cache_read_input_tokens: 2,
    cache_creation_input_tokens: 3,
  };
  return (frame, peer) => {
    if (frame['method'] !== 'stdin') return;
    if (directive?.kind === 'block-until-abort') return;
    if (directive?.kind === 'fail') {
      // The fixture CLI's fail persona: the vendor quota-with-reset stderr
      // (conformance leg s classifies it `quota` and extracts resetAt).
      peer.stderr("You've hit your use limit · resets 1h30m");
      peer.finish(1);
      return;
    }
    peer.send({
      type: 'system',
      subtype: 'init',
      session_id: sessionId,
      model,
      ...(harnessMode
        ? {
            tools: [...(hasSchema ? ['StructuredOutput'] : []), ...allowed],
            mcp_servers: opts.args.includes('--mcp-config')
              ? [{ name: 'cq-harness', status: 'connected', source: 'dynamic' }]
              : [],
          }
        : {}),
    });
    const text =
      directive?.kind === 'reply'
        ? directive.text
        : directive?.kind === 'reply-invalid-json'
          ? 'this reply is prose, not the required JSON object'
          : 'ok';
    peer.send({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    // A schema'd run answers through the CLI's StructuredOutput tool with the
    // scripted reply's JSON; a non-JSON reply offers none, so the driver
    // reports output-invalid.
    const structured = hasSchema ? parseJson(text) : undefined;
    if (structured !== undefined) {
      peer.send({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'fake-structured',
              name: 'StructuredOutput',
              input: structured,
            },
          ],
        },
      });
      peer.send({
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'fake-structured',
              is_error: false,
              content: 'Structured output provided successfully',
            },
          ],
        },
      });
    }
    peer.send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      model,
      usage,
      ...(harnessMode ? { permission_denials: [] } : {}),
      ...(structured !== undefined ? { structured_output: structured } : {}),
    });
    peer.finish();
  };
}

/** Fresh ClaudeCodeDriver honoring the ConformanceSpec contract. */
export function makeDriver(spec: ConformanceSpec): Driver {
  const directive = spec.directive;
  const toolLeg = directive?.kind === 'tool-then-reply';
  return new ClaudeCodeDriver({
    ...baseOptions(spec.scratchDir, toolLeg ? toolLegEnv(directive) : {}, []),
    ...(toolLeg ? {} : { spawn: fakeManagedSpawn((opts) => fakeManagedScript(opts, directive)) }),
    // The priced handle flows through the price lookup so the conformance
    // suite can assert a derived costUSD; everything else stays unpriced.
    ...(spec.pricedModel !== undefined
      ? {
          pricing: (modelSpec: { provider: string; model: string }) =>
            modelSpec.provider === spec.pricedModel?.provider
              ? { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 }
              : undefined,
        }
      : {}),
  });
}

/** Minimal invocation for the driver-specific tests. */
export function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'driver-specific run',
    modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: 'workspace-write' },
    budget: {},
    ...overrides,
  };
}

/** Fresh scratch dir + store; cleaned up by the test's finally block. */
export async function withScratch(
  body: (scratchDir: string, store: SessionStore) => Promise<void>,
): Promise<void> {
  const scratchDir = await mkdtemp(join(tmpdir(), 'subdrv-'));
  const store = new SessionStore(join(scratchDir, SESSIONS_DIR));
  try {
    await body(scratchDir, store);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

/** The narration record message's parsed entries (termination markers etc.). */
export async function narrationOf(store: SessionStore, sessionId: string): Promise<string[]> {
  const record = await store.load(sessionId);
  const entry = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'cli-narration');
  return entry === undefined ? [] : (JSON.parse(entry.content) as string[]);
}

/** Parse the env-probe line a spawned worker wrote (issue #183 test). */
export function probeEnvOf(narration: readonly string[]): Record<string, string> {
  const line = narration.find((entry) => entry.startsWith('CQ_ENV_PROBE:'));
  if (line === undefined) throw new Error('env probe line missing from narration');
  return JSON.parse(line.slice('CQ_ENV_PROBE:'.length)) as Record<string, string>;
}

/** The conformance route as buildArgs sees it (argv-shape tests). */
export const TEST_ROUTE = {
  endpoint: 'conformance',
  baseUrl: 'http://127.0.0.1:1/anthropic',
  keyEnv: 'CONFORMANCE_API_KEY',
  model: 'conformance-1',
};

/** The --mcp-config value of a recorded argv (undefined when absent). */
export function mcpConfigArgOf(args: readonly string[]): string | undefined {
  const index = args.indexOf('--mcp-config');
  return index === -1 ? undefined : args[index + 1];
}

/** The parsed narration markers with a given `cq` tag. */
export async function markersOf(
  store: SessionStore,
  sessionId: string,
  cq: string,
): Promise<Array<Record<string, unknown>>> {
  return (await narrationOf(store, sessionId))
    .filter((line) => line.startsWith('{') && line.includes(`"cq":"${cq}"`))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The fixture's FAKE_AGENT_CONFIG_PROBE record. */
interface ConfigProbe {
  path: string | null;
  atStart: { present: boolean; mode?: number; symlink?: boolean };
  afterInit: { present: boolean };
}

export async function readProbe(path: string): Promise<ConfigProbe> {
  return JSON.parse(await readFile(path, 'utf8')) as ConfigProbe;
}

/** Poll until `pid` is gone (ESRCH); false if it outlives ~5s. */
export async function processGone(pid: number): Promise<boolean> {
  for (let i = 0; i < 200; i++) {
    try {
      process.kill(pid, 0);
      await new Promise((resolve) => setTimeout(resolve, 25));
    } catch {
      return true;
    }
  }
  return false;
}

/** A hand-built observation for the exported stdout fold (harness mode). */
type Observation = Parameters<typeof handleStdoutLine>[0];
export function harnessObservation(tools: string[]): Observation {
  return {
    cliSessionId: undefined,
    servedModel: undefined,
    transcript: [],
    narration: [],
    stderr: [],
    assistantUsage: undefined,
    result: undefined,
    close: undefined,
    toolUseNameById: new Map(),
    toolUses: [],
    toolResults: [],
    deniedToolUseIds: new Set(),
    denials: [],
    expectedSurface: { harness: true, tools },
    initSeen: false,
    harnessConnected: false,
    permissionDeniedIds: new Set(),
    harnessFailure: undefined,
    refusalSeen: false,
  };
}

export const line = (event: unknown): string => JSON.stringify(event);
export const initLine = (tools: string[]): string =>
  line({
    type: 'system',
    subtype: 'init',
    session_id: 'cli-1',
    model: 'conformance-1',
    tools,
    mcp_servers: [{ name: 'cq-harness', status: 'connected', source: 'dynamic' }],
  });
export const toolUseLine = (id: string, name: string): string =>
  line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: { path: 'x' } }] },
  });
export const toolResultLine = (id: string, content: unknown): string =>
  line({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] },
  });

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
export const S3_ANSWER_SCHEMA: OutputSchema = {
  name: 'test.answer/v1',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
};

/** The S3_USAGE the scripted streams report (the fixture's fixed numbers). */
export const S3_USAGE = {
  input_tokens: 10,
  output_tokens: 5,
  cache_read_input_tokens: 2,
  cache_creation_input_tokens: 3,
};

/** A harness-mode init line matching the expected surface (mode 'none'). */
export const s3InitLine = (tools: readonly string[]): string =>
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    session_id: 'cli-s3',
    model: CONFORMANCE_MODEL,
    tools: [...tools],
    mcp_servers: [],
  });

/** A failed result event line with the given overrides. */
export const s3ErrorResultLine = (overrides: Record<string, unknown>): string =>
  JSON.stringify({
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    session_id: 'cli-s3',
    model: CONFORMANCE_MODEL,
    usage: S3_USAGE,
    ...overrides,
  });

/** A spawn override that runs `node -e` emitting the given JSON lines. */
export function s3Child(lines: readonly string[], exitCode = 0): SpawnFn {
  return (opts) =>
    spawnManaged({
      ...opts,
      command: process.execPath,
      args: [
        '-e',
        `process.stdin.resume(); for (const l of ${JSON.stringify(lines)}) process.stdout.write(l + '\\n');` +
          (exitCode === 0 ? '' : ` process.exitCode = ${String(exitCode)};`),
      ],
    });
}

/** The S3 driver over a scripted stream (mode 'none' policy: no MCP server). */
export function s3Driver(
  scratchDir: string,
  lines: readonly string[],
  opts: {
    binary?: CliTransportOptions['binary'];
    exitCode?: number;
  } = {},
): ClaudeCodeDriver {
  return new ClaudeCodeDriver({
    ...baseOptions(scratchDir, {}, []),
    ...(opts.binary === undefined ? {} : { binary: opts.binary }),
    spawn: s3Child(lines, opts.exitCode ?? 0),
  });
}
