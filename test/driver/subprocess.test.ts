// The subprocess driver instantiation — T1.5 slice 2.
//
// Two layers, mirroring test/driver/ai-sdk.test.ts:
//   1. THE CONFORMANCE SUITE (test/driver/conformance.ts, verbatim) run
//      against the real SubprocessDriver spawning a FAKE agent CLI
//      (test/fixtures/fake-agent-cli.mjs) through the driver's `spawn`
//      override — no real `claude` binary, no network, no vendor SDK. The
//      suite's ModelDirective maps onto FAKE_AGENT_* env vars for the
//      fixture; the fixture's scripted tool_use is EXECUTED FOR REAL
//      against the invocation workspace (read/run/edit with harness-
//      matching denial reasons), which is what makes the I6 isolation pair
//      observable through a genuine filesystem.
//   2. DRIVER-SPECIFIC tests: THE REMAP TEST (an unknown model name on the
//      default routing table throws BEFORE any spawn — the spawn-hook
//      counter stays at zero), the SIGTERM→SIGKILL grace ladder (both rungs
//      observed in order against a real stubborn child), the graceful
//      single-rung abort, junk-line tolerance, --resume argv + sidecar
//      continuation, denial/structured/usage/cost mapping, and the
//      budget-usage + unknown-model-mode error paths.
//
// All runs ride the conformance routing table (a 'conformance' +
// 'conformance-priced' endpoint extension of the default table) so no test
// needs a real provider key; the remap test alone uses the DEFAULT table to
// pin the DeepSeek footgun to the shipped config.
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { z } from 'zod';
import {
  HARNESS_ERROR_PREFIX,
  HARNESS_MCP_CONFIG_FILE,
  SubprocessDriver,
  buildArgs,
  handleStdoutLine,
  stopReasonOf,
  usageFromCli,
} from '../../src/driver/subprocess/index.js';
import type { SpawnFn, SubprocessDriverOptions } from '../../src/driver/subprocess/index.js';
import { CLI_SESSION_FILE } from '../../src/driver/subprocess/index.js';
import {
  RoutingTableSchema,
  defaultRoutingTable,
  routeFor,
} from '../../src/driver/subprocess/routing.js';
import type { RoutingTable } from '../../src/driver/subprocess/routing.js';
import {
  DEFAULT_CHILD_ENV_ALLOWLIST,
  DEFAULT_MAX_RETAINED_BYTES,
  buildChildEnv,
  spawnManaged,
  terminateActiveChildrenOnExit,
} from '../../src/driver/subprocess/process.js';
import type { ProcessClose } from '../../src/driver/subprocess/process.js';
import { runDriverConformance } from './conformance.js';
import type { ConformanceSpec, ModelDirective } from './conformance.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER, CONFORMANCE_MODEL } from './conformance.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { stripMetaSchema } from '../../src/driver/json-schema.js';
import { SessionStore } from '../../src/harness/session.js';
import { realClock, runLadder } from '../../src/kernel/governor.js';
import type { Driver, OpInvocation } from '../../src/driver/types.js';

// The harness MCP server runs from TypeScript SOURCE in these process-level
// runs (no build): the launch spec is mocked onto `node --import <the test
// TS loader> src/harness/mcp/bin.ts` — the real server, the real shared core.
// `launchControl.extraArgs` lets one test append a stray argument so the
// REAL server refuses its argv at startup (exit 78 → status 'failed').
const launchControl = vi.hoisted(() => ({ extraArgs: [] as string[] }));
vi.mock('../../src/harness/mcp/launch.js', () => {
  const fromHere = (rel: string): string =>
    decodeURIComponent(new URL(rel, import.meta.url).pathname);
  return {
    harnessServerLaunch: () => ({
      command: process.execPath,
      args: [
        '--import',
        fromHere('../helpers/ts-source-loader.mjs'),
        fromHere('../../src/harness/mcp/bin.ts'),
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
const FAKE_CLI = fileURLToPath(new URL('../fixtures/fake-agent-cli.mjs', import.meta.url));

// The driver reads key VALUES from the environment at run() time (the route
// carries names only); the conformance endpoint's fake key is set once here.
process.env.CONFORMANCE_API_KEY ??= 'conformance-fake-key';

// ---------------------------------------------------------------------------
// Routing: the default table + the suite's canonical handles as endpoints
// ---------------------------------------------------------------------------

/**
 * The conformance routing table: the shipped default (zai / deepseek /
 * anthropic, as-of 2026-09) extended with the suite's canonical provider
 * handles — `conformance` (never priced) and `conformance-priced` — pointed
 * at a black-hole URL no child ever contacts (the fixture IS the model).
 */
function conformanceRoutingTable(): RoutingTable {
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

// ---------------------------------------------------------------------------
// Directive → FAKE_AGENT_* env (the conformance script contract, scripted
// into the fixture). The spawn override injects these per driver instance —
// process.env is never mutated per-run (vitest runs tests sequentially
// within a file and `fileParallelism: false` serializes files; per-driver
// env keeps runs isolated).
// ---------------------------------------------------------------------------

function directiveEnv(directive: ModelDirective | undefined): Record<string, string> {
  switch (directive?.kind) {
    case 'block-until-abort':
      return { FAKE_AGENT_MODE: 'block-until-abort' };
    case 'fail':
      return { FAKE_AGENT_MODE: 'fail' };
    case 'tool-then-reply':
      return {
        FAKE_AGENT_MODE: 'tool-then-reply',
        FAKE_AGENT_TOOL: directive.tool,
        FAKE_AGENT_INPUT: JSON.stringify(directive.input),
        FAKE_AGENT_REPLY: directive.reply,
      };
    case 'reply':
      return { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_REPLY: directive.text };
    case undefined:
    default:
      return { FAKE_AGENT_MODE: 'ok' };
  }
}

/** The --allowedTools value of a built argv (the fixture's permission gate). */
function allowedToolsArg(args: readonly string[]): string {
  const index = args.indexOf('--allowedTools');
  return index !== -1 && index + 1 < args.length ? (args[index + 1] as string) : '';
}

/** The parsed --json-schema value of a built argv (the CLI's structured-output contract). */
function jsonSchemaArgOf(args: readonly string[]): Record<string, unknown> {
  const index = args.indexOf('--json-schema');
  if (index === -1 || index + 1 >= args.length) throw new Error('--json-schema missing from argv');
  return JSON.parse(args[index + 1] as string) as Record<string, unknown>;
}

/** One recorded spawn call: the exact argv + env the driver handed over. */
interface SpawnCall {
  args: string[];
  env: Record<string, string>;
}

/**
 * A spawn override that records every call (argv/env evidence for the
 * resume and zero-spawn assertions) and merges `extraEnv` over the driver's
 * child env before delegating to the REAL spawnManaged — the fixture is a
 * real process in a real workspace, only the MODEL is fake.
 */
function recordingSpawn(calls: SpawnCall[], extraEnv: Record<string, string> = {}): SpawnFn {
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
function baseOptions(
  scratchDir: string,
  extraEnv: Record<string, string>,
  calls: SpawnCall[],
): SubprocessDriverOptions {
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
 * config the ai-sdk and claude-agent instantiations use, because in harness
 * mode the REAL harness (served over MCP) executes the tool.
 */
function conformanceHarnessConfig(
  scratchDir: string,
): NonNullable<SubprocessDriverOptions['harnessConfig']> {
  return {
    ...defaultHarnessConfig,
    workspaceRoot: join(scratchDir, 'workspaces'),
    tools: {
      ...defaultHarnessConfig.tools,
      run: { ...defaultHarnessConfig.tools.run, commandPatterns: ['re:^echo .* > note\\.txt$'] },
    },
  };
}

/** Fresh mock-backed SubprocessDriver honoring the ConformanceSpec contract. */
function makeDriver(spec: ConformanceSpec): Driver {
  const calls: SpawnCall[] = [];
  return new SubprocessDriver({
    ...baseOptions(spec.scratchDir, directiveEnv(spec.directive), calls),
    ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
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

// ---------------------------------------------------------------------------
// 1. The conformance suite, fake-CLI-backed
// ---------------------------------------------------------------------------

runDriverConformance(makeDriver, { label: 'subprocess driver (fake agent CLI)' });

// ---------------------------------------------------------------------------
// 2. Driver-specific tests
// ---------------------------------------------------------------------------

/** Minimal invocation for the driver-specific tests. */
function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
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
async function withScratch(
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
async function narrationOf(store: SessionStore, sessionId: string): Promise<string[]> {
  const record = await store.load(sessionId);
  const entry = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'cli-narration');
  return entry === undefined ? [] : (JSON.parse(entry.content) as string[]);
}

/** Parse the env-probe line a spawned worker wrote (issue #183 test). */
function probeEnvOf(narration: readonly string[]): Record<string, string> {
  const line = narration.find((entry) => entry.startsWith('CQ_ENV_PROBE:'));
  if (line === undefined) throw new Error('env probe line missing from narration');
  return JSON.parse(line.slice('CQ_ENV_PROBE:'.length)) as Record<string, string>;
}

/** The conformance route as buildArgs sees it (argv-shape tests). */
const TEST_ROUTE = {
  endpoint: 'conformance',
  baseUrl: 'http://127.0.0.1:1/anthropic',
  env: {
    ANTHROPIC_AUTH_TOKEN: 'CONFORMANCE_API_KEY',
    ANTHROPIC_API_KEY: 'CONFORMANCE_API_KEY',
  },
  model: 'conformance-1',
};

describe('subprocess driver specifics (fake agent CLI)', () => {
  test('routeFor rejects prototype keys — constructor/toString are not providers (mirror of the claude-agent guard)', () => {
    expect(() =>
      routeFor({ provider: 'constructor', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'constructor'/);
    expect(() =>
      routeFor({ provider: 'toString', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'toString'/);
  });

  test('buildArgs: the exact CLOSED-surface headless argv (harness default) — undocumented flags removed (#19-8, W1.4)', () => {
    const args = buildArgs({
      route: TEST_ROUTE,
      allowedToolNames: ['mcp__cq-harness__read', 'mcp__cq-harness__edit'],
      mcpConfigPath: '/sessions/s-1.cq-harness-mcp.json',
      outputJsonSchema: '{"type":"object"}',
      resumeCliSessionId: 'cli-9',
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose', // the real CLI refuses stream-json print mode without it (found live, T1.6)
      '--json-schema',
      '{"type":"object"}',
      '--tools', // every builtin ABSENT (not merely denied)
      '',
      '--setting-sources', // no ambient settings
      '',
      '--strict-mcp-config', // no ambient MCP servers
      '--mcp-config',
      '/sessions/s-1.cq-harness-mcp.json',
      '--allowedTools',
      'mcp__cq-harness__read mcp__cq-harness__edit', // ONE element, SPACE-joined
      '--model',
      'conformance-1',
      '--resume',
      'cli-9',
    ]);
    // The allowlist is never comma-joined: a comma list silently pre-approves
    // only its first entry (RS-1b b9/b10).
    expect(args.some((arg) => arg.includes(','))).toBe(false);
    // Without --json-schema the flag pair is simply absent.
    const noSchema = buildArgs({
      route: TEST_ROUTE,
      allowedToolNames: ['mcp__cq-harness__read'],
      mcpConfigPath: '/sessions/s-1.cq-harness-mcp.json',
      outputJsonSchema: undefined,
      resumeCliSessionId: undefined,
    });
    expect(noSchema).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--mcp-config',
      '/sessions/s-1.cq-harness-mcp.json',
      '--allowedTools',
      'mcp__cq-harness__read',
      '--model',
      'conformance-1',
    ]);
    // Empty selection (ToolPolicy mode 'none'): NO --mcp-config, and
    // --allowedTools ALWAYS present with an EMPTY value as ONE element.
    const none = buildArgs({
      route: TEST_ROUTE,
      allowedToolNames: [],
      outputJsonSchema: undefined,
      resumeCliSessionId: undefined,
    });
    expect(none).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--tools',
      '',
      '--setting-sources',
      '',
      '--strict-mcp-config',
      '--allowedTools',
      '',
      '--model',
      'conformance-1',
    ]);
    expect(none).not.toContain('--mcp-config');
    expect(none).not.toContain('--permission-prompts'); // undocumented — removed (issue #19)
    expect(none).not.toContain('--bare'); // undocumented — removed (issue #19)
  });

  test('buildArgs STOCK surface: the legacy argv byte-exact — no closed-surface flags, raw harness names (D6)', () => {
    const args = buildArgs({
      route: TEST_ROUTE,
      toolSurface: 'stock',
      allowedToolNames: ['read', 'edit'],
      outputJsonSchema: '{"type":"object"}',
      resumeCliSessionId: 'cli-9',
    });
    expect(args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--json-schema',
      '{"type":"object"}',
      '--allowedTools',
      'read edit',
      '--model',
      'conformance-1',
      '--resume',
      'cli-9',
    ]);
    const none = buildArgs({
      route: TEST_ROUTE,
      toolSurface: 'stock',
      allowedToolNames: [],
      // Ignored on the stock surface: the config only exists in harness mode.
      mcpConfigPath: '/sessions/ignored.json',
      outputJsonSchema: undefined,
      resumeCliSessionId: undefined,
    });
    expect(none).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--allowedTools',
      '',
      '--model',
      'conformance-1',
    ]);
  });

  test('THE REMAP TEST: unknown model on the default routing table throws BEFORE any spawn', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      // DEFAULT table — the shipped deepseek endpoint config, no overrides.
      const driver = new SubprocessDriver({
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
        spawn: recordingSpawn(calls),
      });
      // DeepSeek-style gateways silently serve their default model for ANY
      // model name; the driver refuses to dispatch an unknown name instead.
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'deepseek', model: 'gpt-9-imaginary' } })),
      ).rejects.toThrow(
        /not on the deepseek allowlist .* silently remap unknown model names; refusing to dispatch/,
      );
      // The same rule is table-wide: unknown names on ANY endpoint refuse.
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'zai', model: 'gpt-9-imaginary' } })),
      ).rejects.toThrow(/silently remap unknown model names; refusing to dispatch/);
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'whatever' } })),
      ).rejects.toThrow(/unknown provider 'nope'/);
      // Pre-dispatch means PRE-dispatch: zero spawns — the sessions dir is
      // never even created (store.create would have mkdir'd it).
      expect(calls).toEqual([]);
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({
        code: 'ENOENT',
      });

      // The routeFor throw is only the OUTER guard; a gateway can still remap
      // an ALLOWED name server-side. The driver therefore surfaces the model
      // the endpoint actually served — the fact the shared conformance suite's
      // observed-model check (leg m) keys on — and a remapped run fails that
      // check loudly.
      const remapping = new SubprocessDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_SERVED_MODEL: 'actually-served-model' },
          [],
        ),
      );
      const remapped = await remapping.run(
        invocation({ modelSpec: { provider: CONFORMANCE_PROVIDER, model: CONFORMANCE_MODEL } }),
      );
      expect(remapped.model).toBe('actually-served-model'); // the honest observation
      expect(remapped.model).not.toBe(CONFORMANCE_MODEL); // the suite's leg m fails this run loudly
    });
  });

  test('grace ladder: a SIGTERM-ignoring child escalates to SIGKILL — both rungs observed in order', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      let deadline: (() => void) | undefined;
      const deadlineHandle = Symbol('readiness-gated deadline');
      const spawn = recordingSpawn(calls, { FAKE_AGENT_MODE: 'ignore-sigterm' });
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, calls),
        spawn: (options) => {
          const child = spawn(options);
          onTestFinished(() => {
            child.kill('SIGKILL');
          });
          child.onStdoutLine((line) => {
            // Init is emitted only after the fixture installs its SIGTERM handler.
            if (line.includes('"subtype":"init"')) queueMicrotask(() => deadline?.());
          });
          return child;
        },
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'stubborn run' })),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-ladder', attempt: 1 },
        {
          clock: {
            now: realClock.now,
            setTimeout: (fn, ms) => {
              if (deadline === undefined) {
                deadline = fn;
                return deadlineHandle;
              }
              return realClock.setTimeout(fn, ms);
            },
            clearTimeout: (handle) => {
              if (handle !== deadlineHandle) realClock.clearTimeout(handle);
            },
          },
        },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      // The driver's own ladder markers, recorded as session narration:
      // SIGTERM first (ignored by the fixture), then SIGKILL.
      const sessionId = outcome.value.sessionId as string;
      const narration = await narrationOf(store, sessionId);
      const rungs = narration
        .filter((line) => line.includes('"termination-rung"'))
        .map((line) => JSON.parse(line) as { rung: string });
      expect(rungs.map((r) => r.rung)).toEqual(['sigterm', 'sigkill']);
      const termination = narration.find((line) => line.includes('"termination"'));
      expect(termination !== undefined && termination.includes('"killed"')).toBe(true);
      // The child really was SIGKILLed: exactly one spawn, never completed.
      expect(calls).toHaveLength(1);
    });
  }, 20_000);

  test('graceful abort: a default-disposition child dies on SIGTERM — one rung, no SIGKILL', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'slow-exit-ms', FAKE_AGENT_SLOW_EXIT_MS: '10000' },
          [],
        ),
        termGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'slow run' })),
        // > node startup: the abort must land after the driver attached the
        // ladder (an abort before the spawn path returns the early-aborted
        // verdict with no narration)
        { wallClockMs: 300 },
        { op: 'subprocess', jobKey: 'subprocess-graceful', attempt: 1 },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      // error rides only stopReason 'error' (frozen WorkerResultSchema contract).
      expect(outcome.value.error).toBeUndefined();
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      const rungs = narration
        .filter((line) => line.includes('"termination-rung"'))
        .map((line) => JSON.parse(line) as { rung: string });
      expect(rungs.map((r) => r.rung)).toEqual(['sigterm']); // no SIGKILL rung
      const termination = narration.find((line) => line.includes('"termination"'));
      expect(termination !== undefined && termination.includes('"terminated"')).toBe(true);
    });
  }, 20_000);

  test('junk lines are narration, never a crash: the result event still parses', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'emit-junk' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'junky run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
      const record = await store.load(result.sessionId as string);
      const narration = record?.messages.find(
        (m) => m.role === 'tool' && m.toolName === 'cli-narration',
      );
      expect(narration?.content).toContain('transient bootstrapping noise');
      // The non-contract system event is narration too — unknown subtypes
      // never crash the fold.
      expect(narration?.content).toContain('worthless non-contract event');
    });
  });

  test('resume: the second run passes --resume; the sidecar lives in the STORE, not the workspace (#19-12/#26)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const first = new SubprocessDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await first.run(invocation({ prompt: 'resume run one' }));
      expect(calls[0]?.args).not.toContain('--resume'); // fresh run: no resume flag
      // The sidecar is RELOCATED (issue #26, design (b)): beside the session
      // records, keyed by sessionId — never in the model-visible workspace.
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const sidecarPath = join(
        scratchDir,
        SESSIONS_DIR,
        `${run1.sessionId as string}${CLI_SESSION_FILE}`,
      );
      const cliId = (await readFile(sidecarPath, 'utf8')).trim();
      expect(cliId).toMatch(/^fake-cli-/);
      // 0o600 — the sidecar is evidence like the records it sits beside,
      // never world-readable (review thread: mode was umask-default 0o666).
      expect((await stat(sidecarPath)).mode & 0o777).toBe(0o600);
      const noSidecarInWorkspace = async (): Promise<void> => {
        const files = await readdir(workspace);
        expect(files.filter((f) => f.endsWith(CLI_SESSION_FILE))).toEqual([]);
      };
      await noSidecarInWorkspace();

      // The resumed run forwards the recorded CLI session id as --resume
      // (proven by the fixture echoing it) and reuses the SAME workspace.
      const calls2: SpawnCall[] = [];
      const second = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'resume-echo' }, calls2),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(
        invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }),
      );
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(run2.stopReason).toBe('complete');
      expect(calls2[0]?.args).toContain('--resume');
      const resumeIndex = calls2[0]?.args.indexOf('--resume') ?? -1;
      expect(calls2[0]?.args[resumeIndex + 1]).toBe(cliId);

      // ONE session record carries both runs' turns; the store sidecar is
      // stable, and the workspace still carries NO resume handle.
      const record = await store.load(run1.sessionId as string);
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run one'),
      ).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'user' && m.content === 'resume run two'),
      ).toBe(true);
      expect(
        record?.messages.some(
          (m) => m.role === 'assistant' && m.content.includes(`resumed from cli session ${cliId}`),
        ),
      ).toBe(true);
      expect((await readFile(sidecarPath, 'utf8')).trim()).toBe(cliId);
      await noSidecarInWorkspace();
    });
  });

  test('deny-tool: the CLI permission denial maps to the frozen {tool, reason} shape under the HARNESS name', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'denial run' }));
      // The CLI's permission gate refused mcp__cq-harness__edit (frame +
      // its own text); the denial speaks OUR vocabulary — the harness name.
      expect(result.denials).toEqual([
        {
          tool: 'edit',
          reason:
            "Claude requested permissions to use mcp__cq-harness__edit, but you haven't granted it yet.",
        },
      ]);
      // result.is_error:true → an error verdict even though the stream closed cleanly.
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
    });
  });

  test('result-event error path: the error verdict names the result cause and stays bounded (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'result error run' }));
      expect(result.stopReason).toBe('error');
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      // The failed result frame (is_error:true, subtype error_during_execution)
      // is what the journal must show — not a bare "no cause".
      expect(error).toContain('result event error');
      expect(error).toContain('error_during_execution');
      // boundedErrorText contract: ≤500 chars, or the truncation marker.
      expect(/… \[truncated\]$/.test(error) || error.length <= 513).toBe(true);
    });
  });

  test('result-event cause precedence: result string wins over errors over subtype (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const resultString = await new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'error-result' }, []),
      ).run(invocation({ prompt: 'result-string run' }));
      // The `result` string outranks the `errors` entries and the subtype.
      expect(resultString.error).toContain('result-string-cause');
      expect(resultString.error).not.toContain('errors-entry-cause');

      const errorsOnly = await new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'error-errors' }, []),
      ).run(invocation({ prompt: 'errors run' }));
      // No `result` string → the joined `errors` entries are the cause.
      expect(errorsOnly.error).toContain('errors-entry-cause');
      expect(errorsOnly.error).not.toContain('error_during_execution');
    });
  });

  test('structured output: --json-schema + the fixture structured_output land in the result', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const schema = z.object({ answer: z.string() }).strict();
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'structured-ok' }, calls),
        outputSchema: schema,
      });
      const result = await driver.run(invocation({ prompt: 'structured run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // The serialized --json-schema arg carries NO draft-2020-12 meta key —
      // the CLI rejects that URI before the model runs (#209).
      const arg = jsonSchemaArgOf(calls[0]?.args ?? []);
      expect(arg['$schema']).toBeUndefined();
      expect(arg).toEqual(stripMetaSchema(z.toJSONSchema(schema)));
    });
  });

  test('structured output: a schema-violating payload is dropped to narration, never trusted', async () => {
    await withScratch(async (scratchDir, store) => {
      // The fixture emits the raw payload verbatim (a lying CLI — no fixture
      // schema checking), so the driver's own settle-time validation is what
      // stands between the vendor field and the seam.
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'structured-ok', FAKE_AGENT_STRUCTURED_RAW: '{"answer":42}' },
          [],
        ),
        outputSchema: z.object({ answer: z.string() }).strict(),
      });
      const result = await driver.run(invocation({ prompt: 'lying CLI run' }));
      // The run itself succeeded; only the unrepresentable payload is gone.
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      // The rejection is evidence, not silence: a plain-JSON narration
      // marker carrying the zod issue count and paths.
      const narration = await narrationOf(store, result.sessionId as string);
      const rejected = narration.find((line) => line.includes('"structured-output-rejected"'));
      expect(rejected !== undefined && rejected.includes('"issues":1')).toBe(true);
      expect(rejected !== undefined && rejected.includes('"paths":["answer"]')).toBe(true);
    });
  });

  test('usage mapping: the fixed fixture numbers become the frozen Usage shape', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const result = await driver.run(invocation({ prompt: 'usage run' }));
      expect(result.stopReason).toBe('complete');
      // error rides only stopReason 'error' (frozen WorkerResultSchema contract).
      expect(result.error).toBeUndefined();
      expect(result.usage).toEqual({ input: 10, output: 5, cacheRead: 2, cacheWrite: 3 });
      expect(typeof result.sessionId).toBe('string');
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'assistant' && m.content === 'ok')).toBe(true);
    });
  });

  test('costUSD via the pricing override: derived from real usage; unpriced → absent', async () => {
    await withScratch(async (scratchDir) => {
      const priced = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        pricing: (modelSpec) =>
          modelSpec.provider === CONFORMANCE_PROVIDER
            ? { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 }
            : undefined,
      });
      const result = await priced.run(invocation({ prompt: 'priced run' }));
      // (10 + 5) tokens at 2 USD per million (cache terms at 0) = 30 / 1e6.
      expect(result.costUSD).toBeDefined();
      expect(result.costUSD).toBeCloseTo(0.00003, 12);

      const unpriced = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const unknown = await unpriced.run(invocation({ prompt: 'unpriced run' }));
      expect(unknown.costUSD).toBeUndefined(); // derived-only: never fabricated
    });
  });

  test('budget: maxTokens trips on the folded result usage (pre-verdict check only)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'budget-usage' }, []),
      );
      const result = await driver.run(
        invocation({ prompt: 'budget run', budget: { maxTokens: 1000 } }),
      );
      expect(result.stopReason).toBe('budget');
      // error rides only stopReason 'error' (frozen WorkerResultSchema contract).
      expect(result.error).toBeUndefined();
      expect(result.usage.input).toBe(120_000);
    });
  });

  test('unknown-model mode: a nonzero CLI exit with no result event is an honest error verdict', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'unknown-model' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'doomed run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.costUSD).toBeUndefined(); // no cost claim without a measurement
      // #208: the verdict POPULATES WorkerResult.error — the nonzero exit code
      // plus the CLI's stderr text — instead of an unexplained "no cause".
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      expect(error).toMatch(/exited with code 1/);
      expect(error).toContain('fake-agent-cli');
      expect(error).toContain('not served by this endpoint');
    });
  });

  test('error-cause text is bounded and never echoes an environment secret (#208)', async () => {
    const secret = 'cq-test-secret-value-9f3a';
    process.env.CQ_TEST_API_KEY = secret;
    onTestFinished(() => {
      delete process.env.CQ_TEST_API_KEY;
    });
    await withScratch(async (scratchDir) => {
      // POSITIVE redaction + bound exercise: a spawn failure whose message
      // carries the secret value and overshoots the 500-char bound, so the
      // persisted cause must contain the redaction marker AND the truncation
      // marker (the shared boundedErrorText contract).
      const throwingSpawn: SpawnFn = () => {
        throw new Error(`spawn blew up with ${secret}: ${'x'.repeat(600)}`);
      };
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: throwingSpawn,
      });
      const result = await driver.run(invocation({ prompt: 'secret run' }));
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      expect(error).not.toContain(secret);
      expect(error).toContain('[redacted]');
      expect(error.length).toBeLessThanOrEqual(513);
      expect(error.endsWith('… [truncated]')).toBe(true);
    });
  });

  test('a signal death with no result event names the signal in error (#208)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'self-kill' }, []),
      );
      // NOT a governed run: no governor signal fires, so this cannot settle
      // 'aborted' — the child dies by its own real SIGKILL and the error
      // cause must name the signal.
      const result = await driver.run(invocation({ prompt: 'signal run' }));
      expect(result.stopReason).toBe('error');
      const error = result.error;
      if (error === undefined) throw new Error('an error verdict must carry a cause (#208)');
      expect(error).toContain('killed by signal');
      expect(error).toContain('SIGKILL');
    });
  });

  test('echo-workspace: the fixture executes a real read in the resumed workspace', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const first = new SubprocessDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await first.run(invocation({ prompt: 'seed run' }));
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      await writeFile(join(workspace, 'note.txt'), 'hello note', 'utf8');

      const second = new SubprocessDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'echo-workspace', FAKE_AGENT_PATH: 'note.txt' },
          [],
        ),
      );
      if (run1.sessionId === undefined) throw new Error('first run must create a session');
      const run2 = await second.run(invocation({ prompt: 'echo run', sessionRef: run1.sessionId }));
      expect(run2.stopReason).toBe('complete');
      expect(run2.denials).toEqual([]); // the file is really there
      const record = await store.load(run1.sessionId as string);
      const toolMessage = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'read');
      expect(toolMessage === undefined).toBe(false);
      const folded = JSON.parse((toolMessage?.content ?? '{}') as string) as {
        input: { path: string };
        ok: boolean;
        output: string;
      };
      expect(folded.input.path).toBe('note.txt');
      expect(folded.ok).toBe(true);
      expect(folded.output).toBe('hello note');
    });
  });

  // -------------------------------------------------------------------------

  test('served-model pricing + mismatch marker: the price lookup gets the SERVED id (#19-1/#24, #19-2)', async () => {
    await withScratch(async (scratchDir, store) => {
      const pricedKeys: Array<{ provider: string; model: string }> = [];
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_SERVED_MODEL: 'actually-served-model' },
          [],
        ),
        pricing: (modelSpec) => {
          pricedKeys.push({ provider: modelSpec.provider, model: modelSpec.model });
          return { input: 2, output: 2, cacheRead: 0, cacheWrite: 0 };
        },
      });
      const result = await driver.run(invocation({ prompt: 'served pricing run' }));
      // WorkerResult.model keeps the observed served id…
      expect(result.model).toBe('actually-served-model');
      // …and the price lookup was keyed on the SERVED id with the REQUESTED
      // provider (pricing the requested id would attribute the wrong rates).
      expect(pricedKeys).toEqual([
        { provider: CONFORMANCE_PROVIDER, model: 'actually-served-model' },
      ]);
      // usage {10,5,2,3} at 2/2 per million (cache terms 0) = 30 / 1e6.
      expect(result.costUSD).toBeCloseTo(0.00003, 12);
      // The mismatch is OBSERVABLE, not silent (issue #19): a narration
      // marker naming requested and served, persisted via the diagnostics
      // path (the conformance suite fails this run loudly; production records it).
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"served-model-mismatch"'));
      expect(marker).toBeDefined();
      expect(marker).toContain('"requested":"conformance-1"');
      expect(marker).toContain('"served":"actually-served-model"');
    });
  });

  test('CLI token fields must be finite non-negative integers: lying fields fold to 0 (#19-3)', () => {
    expect(
      usageFromCli({
        input_tokens: -200_000,
        output_tokens: 150_000,
        cache_read_input_tokens: -3,
        cache_creation_input_tokens: 2.5,
      }),
    ).toEqual({ input: 0, output: 150_000, cacheRead: 0, cacheWrite: 0 });
    // The bypass is closed: the OLD fold read -50,000 total (negative
    // input masking real spend), which could never trip `>= maxTokens`;
    // the tightened fold counts the real magnitude.
    const lying = usageFromCli({ input_tokens: -200_000, output_tokens: 150_000 });
    expect(lying).toBeDefined();
    if (lying === undefined) return;
    expect(
      stopReasonOf({ aborted: false, maxTokens: 1000, usage: lying, resultStatus: 'success' }),
    ).toBe('budget');
  });

  test('binary validation: an empty template throws at construction, never at spawn (#19-4)', () => {
    expect(() => new SubprocessDriver({ binary: [] })).toThrow(
      /non-empty string or a non-empty array of non-empty strings/,
    );
    expect(() => new SubprocessDriver({ binary: ['node', ''] })).toThrow(
      /non-empty string or a non-empty array of non-empty strings/,
    );
    expect(() => new SubprocessDriver({ binary: '' })).toThrow(/non-empty string/);
    // The valid forms still construct.
    expect(() => new SubprocessDriver({ binary: 'claude' })).not.toThrow();
    expect(() => new SubprocessDriver({ binary: ['node', FAKE_CLI] })).not.toThrow();
  });

  test.each([
    { aborted: true, harnessFailure: true, oversizedLine: true, expected: 'aborted' },
    { aborted: false, harnessFailure: true, oversizedLine: true, expected: 'error' },
    { aborted: false, harnessFailure: true, oversizedLine: false, expected: 'error' },
    { aborted: false, harnessFailure: false, oversizedLine: true, expected: 'error' },
    { aborted: false, harnessFailure: false, oversizedLine: false, expected: 'budget' },
  ])('stop reason precedence over budget: %j', ({ expected, ...flags }) => {
    expect(
      stopReasonOf({
        ...flags,
        maxTokens: 1,
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
        resultStatus: 'success',
      }),
    ).toBe(expected);
  });

  test.each(['harness', 'stock'] as const)(
    '%s: harness failure precedes oversized-line cause; both precede budget',
    async (toolSurface) => {
      await withScratch(async (scratchDir, store) => {
        // No init + a success frame creates the unverified-surface failure
        // only in harness mode. Both runs really exceed the line bound and
        // token budget, so stock is the oversized-line control.
        const frame = JSON.stringify({
          type: 'result',
          subtype: 'success',
          usage: { input_tokens: 10, output_tokens: 5 },
          structured_output: { answer: 'must be voided on harness failure' },
        });
        let childClose: Promise<ProcessClose> | undefined;
        const driver = new SubprocessDriver({
          ...baseOptions(scratchDir, {}, []),
          toolSurface,
          spawn: (options) => {
            const child = spawnManaged({
              ...options,
              command: process.execPath,
              args: [
                '-e',
                `process.stdin.resume(); process.stdout.write('x'.repeat(2048) + '\\n' + ${JSON.stringify(frame)} + '\\n');`,
              ],
              maxRetainedBytes: 1024,
            });
            childClose = child.close;
            return child;
          },
        });
        const result = await driver.run(
          invocation({ toolPolicy: { allow: [], mode: 'none' }, budget: { maxTokens: 1 } }),
        );
        if (childClose === undefined) throw new Error('expected the driver to spawn a child');
        expect((await childClose).oversizedLine).toBe(true);
        expect(result.stopReason).toBe('error');
        expect(result.usage.input).toBe(10);
        if (toolSurface === 'harness') {
          expect(result.error).toMatch(/^subprocess driver: harness failure/);
          expect(result.error).toContain('never reported its init surface');
          expect(result.error).not.toContain('oversized');
          expect(result.structuredOutput).toBeUndefined();
          expect(
            await markersOf(store, result.sessionId as string, 'harness-surface-unverified'),
          ).toEqual([{ cq: 'harness-surface-unverified', errorClass: 'harness' }]);
        } else {
          expect(result.error).toContain('oversized stdout/stderr line');
        }
      });
    },
  );

  test('a SYNCHRONOUS spawn failure is an error verdict, not a rejection (#19-5)', async () => {
    await withScratch(async (scratchDir, store) => {
      const throwingSpawn: SpawnFn = () => {
        throw new TypeError('spawn args must be strings');
      };
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: throwingSpawn,
      });
      // The run RESOLVES with an honest error verdict — the spawn throw is
      // contained behind the frozen seam.
      const result = await driver.run(invocation({ prompt: 'boom run' }));
      expect(result.stopReason).toBe('error');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.costUSD).toBeUndefined(); // nothing was measured — no cost claim
      // #208: the spawn cause reaches WorkerResult.error too, not just narration.
      expect(result.error).toContain('spawn failed');
      expect(result.error).toContain('spawn args must be strings');
      // The failure is narrated best-effort (same swallow rule as persistence).
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"spawn-failed"'));
      expect(marker).toBeDefined();
      expect(marker).toContain('spawn args must be strings');
    });
  });

  test('grace validation: negative/NaN/Infinity/fractional graces throw at construction (#19-6)', () => {
    expect(() => new SubprocessDriver({ termGraceMs: -1 })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ termGraceMs: Number.NaN })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ termGraceMs: Number.POSITIVE_INFINITY })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ termGraceMs: 0.5 })).toThrow(
      /termGraceMs must be an integer >= 0/,
    );
    expect(() => new SubprocessDriver({ killGraceMs: -5 })).toThrow(
      /killGraceMs must be an integer >= 0/,
    );
    // Zero and positive integers are legitimate.
    expect(() => new SubprocessDriver({ killGraceMs: 0 })).not.toThrow();
    expect(() => new SubprocessDriver({ termGraceMs: 100, killGraceMs: 200 })).not.toThrow();
  });

  test('sandbox-level-unenforced marker: a requested level is recorded as unenforced (#19-7)', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      // The default invocation requests workspace-write — the marker must
      // record that THIS driver does not enforce it (trust statement, header).
      const result = await driver.run(invocation({ prompt: 'sandbox marker run' }));
      const narration = await narrationOf(store, result.sessionId as string);
      const marker = narration.find((line) => line.includes('"sandbox-level-unenforced"'));
      expect(marker).toBeDefined();
      // Harness mode: the harness enforces the TOOL-level sandbox mapping on
      // this lane, so the marker narrows to OS confinement.
      expect(JSON.parse(marker as string)).toEqual({
        cq: 'sandbox-level-unenforced',
        level: 'workspace-write',
        layer: 'os',
      });

      // Stock mode (null-hypothesis evals): nothing the harness enforces
      // applies — the LEGACY marker, no layer.
      const stockDriver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        toolSurface: 'stock',
      });
      const stockResult = await stockDriver.run(invocation({ prompt: 'stock sandbox marker run' }));
      expect(stockResult.stopReason).toBe('complete');
      const stockMarker = (await narrationOf(store, stockResult.sessionId as string)).find((line) =>
        line.includes('"sandbox-level-unenforced"'),
      );
      expect(JSON.parse(stockMarker as string)).toEqual({
        cq: 'sandbox-level-unenforced',
        level: 'workspace-write',
      });

      // level 'none' asks for nothing extra → no marker…
      const noneDriver = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const noneResult = await noneDriver.run(
        invocation({ prompt: 'no sandbox run', sandboxPolicy: { level: 'none' } }),
      );
      const noneNarration = await narrationOf(store, noneResult.sessionId as string);
      expect(noneNarration.some((line) => line.includes('"sandbox-level-unenforced"'))).toBe(false);
      // …and a level over an EMPTY tool surface (mode 'none': nothing
      // pre-approved, headless-denied) has nothing unenforced to observe —
      // no marker (the conformance contract also pins such records to zero
      // tool-role messages).
      const emptySurface = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const emptyResult = await emptySurface.run(
        invocation({ prompt: 'empty surface run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      const emptyNarration = await narrationOf(store, emptyResult.sessionId as string);
      expect(emptyNarration.some((line) => line.includes('"sandbox-level-unenforced"'))).toBe(
        false,
      );
    });
  });

  test('abort kills the whole process GROUP: a fixture-spawned grandchild dies with the CLI (#19-9)', async () => {
    await withScratch(async (scratchDir) => {
      const pidFile = join(scratchDir, 'grandchild.pid');
      const calls: SpawnCall[] = [];
      // The binary template carries the fixture-only probe flag: the CLI
      // spawns a sleeping grandchild in ITS process group and records the
      // pid, then ignores SIGTERM (forcing the SIGKILL rung).
      // Readiness-gated deadline: the governed abort fires only once the
      // grandchild pid is on disk (the harness-mode CLI connects its MCP
      // server before init, so a fixed wall clock would race node startup).
      let deadline: (() => void) | undefined;
      const deadlineHandle = Symbol('pid-file-gated deadline');
      const firePidReady = async (): Promise<void> => {
        for (let i = 0; i < 1_000; i++) {
          try {
            await stat(pidFile);
            deadline?.();
            return;
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      };
      const spawn = recordingSpawn(calls, { FAKE_AGENT_MODE: 'ignore-sigterm' });
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, calls),
        binary: ['node', FAKE_CLI, '--spawn-grandchild', pidFile],
        spawn: (options) => {
          const child = spawn(options);
          onTestFinished(() => {
            child.kill('SIGKILL');
          });
          child.onStdoutLine((line) => {
            if (line.includes('"subtype":"init"')) firePidReady().catch(() => undefined);
          });
          return child;
        },
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'group kill run' })),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-group', attempt: 1 },
        {
          clock: {
            now: realClock.now,
            setTimeout: (fn, ms) => {
              if (deadline === undefined) {
                deadline = fn;
                return deadlineHandle;
              }
              return realClock.setTimeout(fn, ms);
            },
            clearTimeout: (handle) => {
              if (handle !== deadlineHandle) realClock.clearTimeout(handle);
            },
          },
        },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');

      // The grandchild pid was recorded; after the group kill it is DEAD —
      // poll process.kill(pid, 0) until ESRCH. A direct-child-only kill
      // would leave the (non-detached, group-inheriting) grandchild running.
      const grandchildPid = Number((await readFile(pidFile, 'utf8')).trim());
      expect(Number.isInteger(grandchildPid) && grandchildPid > 0).toBe(true);
      let dead = false;
      for (let i = 0; i < 200 && !dead; i++) {
        try {
          process.kill(grandchildPid, 0);
          await new Promise((resolve) => setTimeout(resolve, 25));
        } catch {
          dead = true; // ESRCH — the process is gone
        }
      }
      expect(dead).toBe(true);
    });
  }, 30_000);

  test('stdout retention is a bounded TAIL: droppedBytes counted, every line still observed (#19-10)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 64 * 1024;
      const lines = 20_000;
      const last = `line-${String(lines - 1).padStart(8, '0')}`;
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `for (let i = 0; i < ${lines}; i++) process.stdout.write('line-' + String(i).padStart(8, '0') + '\\n');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      // The buffer is evidence HYGIENE: past the cap only the tail is kept…
      expect(close.droppedBytes).toBeGreaterThan(0);
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.stdout.endsWith(`${last}\n`)).toBe(true); // …the END of the stream
      // …while the line callbacks saw EVERY line.
      expect(seen).toHaveLength(lines);
      expect(seen[0]).toBe('line-00000000');
      expect(seen[lines - 1]).toBe(last);
      // The shipped default.
      expect(DEFAULT_MAX_RETAINED_BYTES).toBe(1_048_576);
    });
  });

  test('a single unterminated line ~3x the cap stays bounded: head dropped, tail emitted (review 3)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 16 * 1024;
      const tailMark = 'TAIL-MARKER';
      // ONE line of exactly 3× cap with NO trailing newline — the shape the
      // review flagged: the pending line used to grow `rest` unbounded.
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('${'x'.repeat(3 * cap - tailMark.length - 1)}' + '-${tailMark}');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      // The memory bound is ABSOLUTE: after each chunk, BOTH buffers (the
      // retained tail and the pending line) are ≤ cap — at close only the
      // tail remains, ≤ cap, so total retained never approaches 3× cap.
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBeGreaterThan(0); // the head was really dropped
      // The flushed pending line is its retained TAIL, not the dropped head.
      expect(seen).toHaveLength(1);
      expect(seen[0]?.endsWith(`-${tailMark}`)).toBe(true);
      expect(seen[0]?.startsWith('x')).toBe(true); // the kept bytes are the line's own tail
    });
  }, 20_000);

  test('an unterminated final line is retained EXACTLY once — flush adds no phantom drops (review 4)', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write('complete line\\n'); process.stdout.write('final-fragment');`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: 64 * 1024,
      });
      const seen: string[] = [];
      child.onStdoutLine((line) => seen.push(line));
      const close = await child.close;
      expect(seen).toEqual(['complete line', 'final-fragment']);
      // Nothing exceeded the cap → zero REAL drops; the old flush re-appended
      // the pending line to the already-retained text (double retention and,
      // past a cap, phantom droppedBytes).
      expect(close.droppedBytes).toBe(0);
      expect(close.stdout).toBe('complete line\nfinal-fragment');
      expect(close.stdout.split('final-fragment')).toHaveLength(2); // exactly one occurrence
    });
  }, 20_000);

  test('oversized lines fail loudly while retention stays bounded', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', `process.stdout.write('x'.repeat(256) + '\\n');`],
        cwd: scratchDir,
        maxRetainedBytes: 32,
      });
      const close = await child.close;
      expect(close.oversizedLine).toBe(true);
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(32);
      expect(close.droppedBytes).toBeGreaterThan(0);
    });
  });

  test('the exit hook terminates an active detached child', async () => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        cwd: scratchDir,
      });
      await new Promise((resolve) => setTimeout(resolve, 30));
      terminateActiveChildrenOnExit();
      const close = await child.close;
      expect(close.signal).toBe('SIGTERM');
    });
  });

  test.each([
    [1, '🦄', ''],
    [2, '🦄', ''],
    [3, '🦄', ''],
    [4, '🦄', '🦄'],
    [5, '🦄🦄', '🦄'],
    [3, 'x�', '�'],
    [4, 'x�!', '�!'],
  ])('UTF-8 retention cap %i preserves complete code points in %s', async (cap, text, expected) => {
    await withScratch(async (scratchDir) => {
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '-e',
          `process.stdout.write(${JSON.stringify(text)}); process.stderr.write(${JSON.stringify(text)});`,
        ],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const out: string[] = [];
      const err: string[] = [];
      child.onStdoutLine((line) => out.push(line));
      child.onStderrLine((line) => err.push(line));
      const close = await child.close;
      expect(close.stdout).toBe(expected);
      expect(close.stderr).toBe(expected);
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(Buffer.byteLength(close.stderr)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBe(2 * (Buffer.byteLength(text) - Buffer.byteLength(expected)));
      expect(out).toEqual(expected === '' ? [] : [expected]);
      expect(err).toEqual(expected === '' ? [] : [expected]);
    });
  });

  test('importing driver and runCli does not install signal handlers', async () => {
    await withScratch(async (scratchDir) => {
      const processUrl = new URL('../../src/driver/subprocess/process.ts', import.meta.url).href;
      const cliUrl = new URL('../../src/cli/main.ts', import.meta.url).href;
      const loader = fileURLToPath(new URL('../helpers/ts-source-loader.mjs', import.meta.url));
      const child = spawnManaged({
        command: process.execPath,
        args: [
          '--experimental-transform-types',
          '--import',
          loader,
          '--input-type=module',
          '-e',
          `
          const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
          const before = signals.map(s => process.listenerCount(s));
          await import(${JSON.stringify(processUrl)});
          await import(${JSON.stringify(cliUrl)});
          console.log(JSON.stringify({before, after: signals.map(s => process.listenerCount(s))}));
        `,
        ],
        cwd: scratchDir,
      });
      const close = await child.close;
      expect(close.code, close.stderr).toBe(0);
      const counts = JSON.parse(close.stdout) as { before: number[]; after: number[] };
      expect(counts.after).toEqual(counts.before);
    });
  });

  test.skipIf(process.platform === 'win32').each(['SIGINT', 'SIGTERM', 'SIGHUP'] as const)(
    'CLI parent %s cleans detached workers and descendants from driver and in-process run',
    async (signal) => {
      await withScratch(async (scratchDir) => {
        const loader = fileURLToPath(new URL('../helpers/ts-source-loader.mjs', import.meta.url));
        const bin = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));
        const processUrl = new URL('../../src/driver/subprocess/process.ts', import.meta.url).href;
        const runUrl = new URL('../../src/harness/run.ts', import.meta.url).href;
        const preload = join(scratchDir, 'owned-child.mjs');
        const runWorker = join(scratchDir, 'run-worker.cjs');
        const runPidFile = join(scratchDir, 'run-pids.json');
        const descendantCode =
          "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)";
        const workerCode = `
          const { spawn } = require('node:child_process');
          process.on('SIGTERM', () => {});
          const descendant = spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], {stdio: ['ignore', 'pipe', 'inherit']});
          descendant.stdout.once('data', () => console.log(JSON.stringify([process.pid, descendant.pid])));
          setInterval(() => {}, 1000);
        `;
        await writeFile(
          runWorker,
          workerCode.replace(
            'console.log(JSON.stringify([process.pid, descendant.pid]))',
            `require('node:fs').writeFileSync(${JSON.stringify(runPidFile)}, JSON.stringify([process.pid, descendant.pid]))`,
          ),
        );
        const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
        const runCommand = `exec ${shellQuote(process.execPath)} ${shellQuote(runWorker)}`;
        await writeFile(
          preload,
          `
          import { spawnManaged, buildChildEnv } from ${JSON.stringify(processUrl)};
          import { runShellCommand } from ${JSON.stringify(runUrl)};
          void runShellCommand(${JSON.stringify(runCommand)}, {env: buildChildEnv(process.env), cwd: ${JSON.stringify(scratchDir)}, maxBytes: 1000});
          const child = spawnManaged({ command: process.execPath, args: ['-e', ${JSON.stringify(workerCode)}], cwd: ${JSON.stringify(scratchDir)} });
          child.onStdoutLine(line => process.stdout.write(line + '\\n'));
        `,
        );
        const parent = spawn(
          process.execPath,
          ['--experimental-transform-types', '--import', loader, '--import', preload, bin],
          {
            stdio: ['ignore', 'pipe', 'pipe'],
          },
        );
        let out = '';
        let err = '';
        parent.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString();
        });
        parent.stderr.on('data', (chunk: Buffer) => {
          err += chunk.toString();
        });
        const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (resolve) => {
            parent.on('close', (code, endedSignal) => resolve({ code, signal: endedSignal }));
          },
        );
        let pids: number[] = [];
        let runPids: number[] = [];
        const alive = (pid: number): boolean => {
          try {
            process.kill(pid, 0);
            return true;
          } catch (error) {
            return (error as NodeJS.ErrnoException).code !== 'ESRCH';
          }
        };
        try {
          await vi.waitFor(
            async () => {
              expect(err).toContain('missing subcommand'); // actual CLI installed its handlers
              expect(out).toContain('\n'); // managed descendant installed its TERM trap
              runPids = JSON.parse(await readFile(runPidFile, 'utf8')) as number[];
              expect(runPids).toHaveLength(2); // run descendant installed its TERM trap
            },
            { timeout: 10_000 },
          );
          pids = [...(JSON.parse(out.trim()) as number[]), ...runPids];
          expect(pids).toHaveLength(4);
          expect(pids.every(alive)).toBe(true);
          parent.kill(signal);
          expect(await closed).toEqual({ code: null, signal });
          await vi.waitFor(() => expect(pids.some(alive)).toBe(false), { timeout: 3_000 });
        } finally {
          for (const groupLeader of [pids[0], runPids[0]]) {
            if (groupLeader === undefined) continue;
            try {
              process.kill(-groupLeader, 'SIGKILL');
            } catch {
              /* already gone */
            }
          }
          parent.kill('SIGKILL');
          await closed;
        }
      });
    },
    20_000,
  );

  test('astral characters past the cap: byte-exact trim, no lone surrogate at the head (review 9-1)', async () => {
    await withScratch(async (scratchDir) => {
      const cap = 64 * 1024;
      // The whole stream is one giant unterminated line of emoji (4 UTF-8
      // bytes each) — the tail region is FULL of astral pairs, the exact
      // shape where a code-unit trim mis-measured 3+3 instead of 4 bytes
      // per pair, under-counted, and let the retained text exceed the cap.
      const child = spawnManaged({
        command: process.execPath,
        args: ['-e', `process.stdout.write('🦄'.repeat(40_000));`],
        cwd: scratchDir,
        maxRetainedBytes: cap,
      });
      const close = await child.close;
      // The documented absolute bound holds BYTE-exactly.
      expect(Buffer.byteLength(close.stdout)).toBeLessThanOrEqual(cap);
      expect(close.droppedBytes).toBeGreaterThan(0);
      // The retained head starts with a COMPLETE code point — a code-unit
      // cut between the halves of a pair would strand a lone surrogate.
      expect(close.stdout.codePointAt(0)).toBe(0x1f984); // 🦄
    });
  }, 20_000);

  // -------------------------------------------------------------------------
  // Child env is default-deny (issue #183)
  // -------------------------------------------------------------------------

  test('buildChildEnv: CQ_RUN_ENV_PASSTHROUGH copies only validated, configured names', () => {
    const parent = { FOO: 'foo', BAR: 'bar', MISSING: undefined, GH_TOKEN: 'must-not-copy' };
    const child = buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'FOO BAR,MISSING' });
    expect(child['FOO']).toBe('foo');
    expect(child['BAR']).toBe('bar');
    expect(child['MISSING']).toBeUndefined();
    expect(child['GH_TOKEN']).toBeUndefined();
    expect(() => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'A=1' })).toThrow(
      /CQ_RUN_ENV_PASSTHROUGH entries must be env var names matching/,
    );
    expect(() => buildChildEnv({ ...parent, CQ_RUN_ENV_PASSTHROUGH: 'BAD.NAME' })).toThrow(
      /CQ_RUN_ENV_PASSTHROUGH entries must be env var names matching/,
    );
  });

  test('buildChildEnv: allowlisted basics + explicit route values pass, credential-shaped parent names are withheld (#183)', () => {
    const parent = {
      PATH: '/usr/bin',
      HOME: '/home/worker',
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      PWD: '/parent/dir',
      NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
      HTTPS_PROXY: 'http://proxy.example:8080',
      https_proxy: 'http://proxy.example:8080',
      GH_TOKEN: 'ghp_marker_secret',
      CQ_ENV_LEAK_MARKER: 'do-not-leak',
      AWS_SECRET_ACCESS_KEY: 'aws-marker',
      NPM_TOKEN: 'npm-marker',
      SSH_AUTH_SOCK: '/tmp/agent.sock',
      NODE_OPTIONS: '--require=/tmp/evil.cjs',
      NODE_PATH: '/tmp/evil-modules',
    };
    const child = buildChildEnv(parent, { ANTHROPIC_API_KEY: 'route-key-value' });
    // Allowlisted basics are inherited…
    expect(child['PATH']).toBe('/usr/bin');
    expect(child['HOME']).toBe('/home/worker');
    expect(child['TERM']).toBe('xterm-256color');
    expect(child['LANG']).toBe('en_US.UTF-8');
    // …including network-egress/TLS config a routed CLI needs (r1)…
    expect(child['NODE_EXTRA_CA_CERTS']).toBe('/etc/ssl/corp.pem');
    expect(child['HTTPS_PROXY']).toBe('http://proxy.example:8080');
    // …both proxy spellings: curl ignores uppercase HTTP_PROXY and honors
    // only lowercase (r2).
    expect(child['https_proxy']).toBe('http://proxy.example:8080');
    // …the explicit route value passes (it is composed deliberately, so the
    // allowlist must never filter it)…
    expect(child['ANTHROPIC_API_KEY']).toBe('route-key-value');
    // …and every credential-shaped parent name is withheld.
    expect(child['GH_TOKEN']).toBeUndefined();
    expect(child['CQ_ENV_LEAK_MARKER']).toBeUndefined();
    expect(child['AWS_SECRET_ACCESS_KEY']).toBeUndefined();
    expect(child['NPM_TOKEN']).toBeUndefined();
    expect(child['SSH_AUTH_SOCK']).toBeUndefined();
    expect(child['NODE_OPTIONS']).toBeUndefined(); // code-execution vector, deliberately excluded
    expect(child['NODE_PATH']).toBeUndefined(); // module-resolution vector
    // PWD is NOT inherited: spawn does not rewrite it for cwd, so a copied
    // PWD would be the parent's stale directory (CodeRabbit r1).
    expect(child['PWD']).toBeUndefined();
    // The override layer ALWAYS wins over a copied allowlist value (r1).
    expect(buildChildEnv(parent, { PATH: '/route/bin' })['PATH']).toBe('/route/bin');
    // The shipped allowlist itself must not carry credential-shaped names —
    // an explicit deny-set (the regex alone misses AWS_PROFILE,
    // GOOGLE_APPLICATION_CREDENTIALS, SSH_AUTH_SOCK, …) plus a shape guard.
    for (const name of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'NPM_TOKEN',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'SSH_AUTH_SOCK',
      'KRB5CCNAME',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'DEEPSEEK_API_KEY',
      'ZAI_API_KEY',
      'NODE_OPTIONS',
      'NODE_PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
    ]) {
      expect(DEFAULT_CHILD_ENV_ALLOWLIST).not.toContain(name);
    }
    expect(
      DEFAULT_CHILD_ENV_ALLOWLIST.some((name) => /TOKEN|SECRET|KEY|PASSWORD/i.test(name)),
    ).toBe(false);
    // FROZEN (r1): an in-process push cannot weaken default-deny for later spawns.
    expect(Object.isFrozen(DEFAULT_CHILD_ENV_ALLOWLIST)).toBe(true);
    // The explicit extra allowlist is the only route for a non-default name.
    const extended = buildChildEnv(parent, undefined, ['CQ_ENV_LEAK_MARKER']);
    expect(extended['CQ_ENV_LEAK_MARKER']).toBe('do-not-leak');
    expect(extended['GH_TOKEN']).toBeUndefined();
    // A malformed extra name is rejected at the seam, not silently no-oped (r1/r2).
    expect(() => buildChildEnv(parent, undefined, [''])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => buildChildEnv(parent, undefined, ['A=B'])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => buildChildEnv(parent, undefined, ['BAD NAME'])).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    // A null-prototype child carries a `__proto__` override as an OWN property
    // instead of silently dropping it through the inherited setter (r2).
    const protoOverride = Object.create(null) as Record<string, string>;
    protoOverride['__proto__'] = 'carried';
    const protoChild = buildChildEnv(parent, protoOverride);
    expect(Object.prototype.hasOwnProperty.call(protoChild, '__proto__')).toBe(true);
    expect(protoChild['__proto__']).toBe('carried');
    // The parent env object is never mutated.
    expect(parent.GH_TOKEN).toBe('ghp_marker_secret');
  });

  test('a REAL spawned worker cannot see a marker secret in the entry env, while route env still reaches it; envAllowlist opts a name back in (#183)', async () => {
    await withScratch(async (scratchDir, store) => {
      // A probe worker: dumps its OWN process.env as a narration line (the
      // driver folds non-JSON lines into the session record) and then emits
      // the minimal stream-json run so the invocation completes.
      // The probe is a CLI of its own (no MCP client), so it runs over the
      // EMPTY harness surface (ToolPolicy mode 'none': no server, no tools)
      // and reports exactly that init surface — the closed-surface assertion
      // still runs and passes.
      const EMPTY_SURFACE = { allow: [] as string[], mode: 'none' as const };
      const probePath = join(scratchDir, 'env-probe.mjs');
      await writeFile(
        probePath,
        [
          'const env = { ...process.env };',
          "process.stdout.write('CQ_ENV_PROBE:' + JSON.stringify(env) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'env-probe', model: 'conformance-1', tools: [], mcp_servers: [] }) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: 'env-probe', usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, model: 'conformance-1' }) + '\\n');",
        ].join('\n'),
        'utf8',
      );
      const marker = 'cq-env-leak-marker-7f3a';
      const savedMarker = process.env.CQ_ENV_LEAK_MARKER;
      const savedGh = process.env.GH_TOKEN;
      // GLOBAL process.env mutation, deliberately: the real spawnManaged path
      // reads the LIVE parent env, so withholding can only be proven against
      // it. Restored in finally; this file's tests run sequentially (no
      // vitest .concurrent), so no concurrent test observes the markers.
      process.env.CQ_ENV_LEAK_MARKER = marker;
      process.env.GH_TOKEN = 'ghp_marker_secret';
      const probeOptions: SubprocessDriverOptions = {
        binary: ['node', probePath],
        routingTable: conformanceRoutingTable(),
        sessionsDir: join(scratchDir, SESSIONS_DIR),
        harnessConfig: {
          ...defaultHarnessConfig,
          workspaceRoot: join(scratchDir, 'workspaces'),
        },
      };
      try {
        // NO spawn override: this is the production spawnManaged path.
        const denied = await new SubprocessDriver(probeOptions).run(
          invocation({ prompt: 'env probe run', toolPolicy: EMPTY_SURFACE }),
        );
        expect(denied.stopReason).toBe('complete');
        const deniedEnv = probeEnvOf(await narrationOf(store, denied.sessionId as string));
        // The marker secret never reaches the worker…
        expect(deniedEnv['CQ_ENV_LEAK_MARKER']).toBeUndefined();
        expect(deniedEnv['GH_TOKEN']).toBeUndefined();
        expect(JSON.stringify(deniedEnv)).not.toContain(marker);
        // …while terminal basics and the configured route env do. Derive the
        // expected values from the live env so an ambient CONFORMANCE_* var
        // cannot flip this test (r2).
        const expectedBaseUrl = process.env.CONFORMANCE_BASE_URL ?? 'http://127.0.0.1:1/anthropic';
        expect(typeof deniedEnv['PATH']).toBe('string');
        expect(deniedEnv['ANTHROPIC_BASE_URL']).toBe(expectedBaseUrl);
        // Diagnostics are redacted before persistence, so the route key is
        // observable as present but never recoverable from the session log.
        expect(deniedEnv['ANTHROPIC_API_KEY']).toBe('[redacted]');
        expect(deniedEnv['ANTHROPIC_AUTH_TOKEN']).toBe('[redacted]');

        // The documented escape hatch is real end-to-end (r1): naming the
        // marker in envAllowlist copies ONLY that parent name back in.
        const allowed = await new SubprocessDriver({
          ...probeOptions,
          envAllowlist: ['CQ_ENV_LEAK_MARKER'],
        }).run(invocation({ prompt: 'allowlist probe run', toolPolicy: EMPTY_SURFACE }));
        expect(allowed.stopReason).toBe('complete');
        const allowedEnv = probeEnvOf(await narrationOf(store, allowed.sessionId as string));
        expect(allowedEnv['CQ_ENV_LEAK_MARKER']).toBe(marker);
        expect(allowedEnv['GH_TOKEN']).toBeUndefined(); // only the named extra is added

        // The per-instance list is a FROZEN COPY (r2): mutating the caller's
        // array after construction cannot weaken later spawns.
        const mutableAllowlist = ['CQ_ENV_LEAK_MARKER'];
        const frozenDriver = new SubprocessDriver({
          ...probeOptions,
          envAllowlist: mutableAllowlist,
        });
        mutableAllowlist.push('GH_TOKEN');
        const frozen = await frozenDriver.run(
          invocation({ prompt: 'frozen allowlist probe run', toolPolicy: EMPTY_SURFACE }),
        );
        const frozenEnv = probeEnvOf(await narrationOf(store, frozen.sessionId as string));
        expect(frozenEnv['CQ_ENV_LEAK_MARKER']).toBe(marker);
        expect(frozenEnv['GH_TOKEN']).toBeUndefined(); // pushed AFTER construction — not honored
      } finally {
        if (savedMarker === undefined) delete process.env.CQ_ENV_LEAK_MARKER;
        else process.env.CQ_ENV_LEAK_MARKER = savedMarker;
        if (savedGh === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = savedGh;
      }
    });
  }, 20_000);

  test('envAllowlist validation: malformed names throw at construction (#183)', () => {
    expect(() => new SubprocessDriver({ envAllowlist: [''] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new SubprocessDriver({ envAllowlist: ['A=B'] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new SubprocessDriver({ envAllowlist: ['BAD NAME'] })).toThrow(
      /envAllowlist entries must be env var names matching/,
    );
    expect(() => new SubprocessDriver({ envAllowlist: ['CLAUDE_CONFIG_DIR'] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 3. The CLOSED tool surface (W1.4): the real cq-harness MCP server behind the
//    fake CLI's MCP client, the per-run config lifecycle, and the fail-closed
//    init-surface / is_error classification.
// ---------------------------------------------------------------------------

/** The --mcp-config value of a recorded argv (undefined when absent). */
function mcpConfigArgOf(args: readonly string[]): string | undefined {
  const index = args.indexOf('--mcp-config');
  return index === -1 ? undefined : args[index + 1];
}

/** The parsed narration markers with a given `cq` tag. */
async function markersOf(
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

async function readProbe(path: string): Promise<ConfigProbe> {
  return JSON.parse(await readFile(path, 'utf8')) as ConfigProbe;
}

/** Poll until `pid` is gone (ESRCH); false if it outlives ~5s. */
async function processGone(pid: number): Promise<boolean> {
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
function harnessObservation(tools: string[]): Observation {
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
  };
}

const line = (event: unknown): string => JSON.stringify(event);
const initLine = (tools: string[]): string =>
  line({
    type: 'system',
    subtype: 'init',
    session_id: 'cli-1',
    model: 'conformance-1',
    tools,
    mcp_servers: [{ name: 'cq-harness', status: 'connected', source: 'dynamic' }],
  });
const toolUseLine = (id: string, name: string): string =>
  line({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id, name, input: { path: 'x' } }] },
  });
const toolResultLine = (id: string, content: unknown): string =>
  line({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content }] },
  });

describe('subprocess driver: the closed harness tool surface (W1.4)', () => {
  test('toolSurface validation: anything but harness/stock throws at construction', () => {
    expect(() => new SubprocessDriver({ toolSurface: 'builtin' as unknown as 'harness' })).toThrow(
      /toolSurface must be 'harness' or 'stock'/,
    );
    expect(() => new SubprocessDriver({ toolSurface: 'harness' })).not.toThrow();
    expect(() => new SubprocessDriver({ toolSurface: 'stock' })).not.toThrow();
  });

  test('a real run: byte-exact closed argv; the 0600 config lives in sessionsDir, is deleted once init reports connected, and is gone after settle', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const probe = join(scratchDir, 'config-probe.json');
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_CONFIG_PROBE: probe }, calls),
      );
      const result = await driver.run(invocation({ prompt: 'closed surface run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.error).toBeUndefined();
      const sessionId = result.sessionId as string;
      const sessionsDir = join(scratchDir, SESSIONS_DIR);
      expect(calls).toHaveLength(1);
      const configArg = calls[0]?.args.indexOf('--mcp-config') ?? -1;
      const configPath = calls[0]?.args[configArg + 1] as string;
      // Unique per run: <sessionId>.<uuid>.cq-harness-mcp.json.
      expect(configPath.slice(sessionsDir.length + 1)).toMatch(
        new RegExp(`^${sessionId}\\.[0-9a-f-]{36}\\.cq-harness-mcp\\.json$`),
      );
      expect(calls[0]?.args).toEqual([
        FAKE_CLI,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--tools',
        '',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--mcp-config',
        configPath,
        '--allowedTools',
        'mcp__cq-harness__read mcp__cq-harness__edit mcp__cq-harness__run',
        '--model',
        'conformance-1',
      ]);
      // Beside the session records — never in the model-visible workspace.
      const workspace = (await store.load(sessionId))?.workspace as string;
      expect(dirname(configPath)).toBe(sessionsDir);
      expect(configPath.startsWith(workspace)).toBe(false);
      const recorded = await readProbe(probe);
      expect(recorded.path).toBe(configPath);
      // It existed as a REGULAR 0600 file when the CLI started…
      expect(recorded.atStart).toEqual({ present: true, mode: 0o600, symlink: false });
      // …was deleted as soon as init reported the harness connected, while
      // the run was still live…
      expect(recorded.afterInit).toEqual({ present: false });
      // …and is gone after settle.
      await expect(lstat(configPath)).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(workspace)).some((f) => f.endsWith(HARNESS_MCP_CONFIG_FILE))).toBe(
        false,
      );
      expect((await readdir(sessionsDir)).some((f) => f.endsWith(HARNESS_MCP_CONFIG_FILE))).toBe(
        false,
      );
    });
  });

  test('empty selection (mode none): no --mcp-config, --allowedTools "" as ONE element, no config file, init [] passes', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls),
      );
      const result = await driver.run(
        invocation({ prompt: 'empty surface run', toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(result.stopReason).toBe('complete');
      expect(calls[0]?.args).toEqual([
        FAKE_CLI,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--tools',
        '',
        '--setting-sources',
        '',
        '--strict-mcp-config',
        '--allowedTools',
        '',
        '--model',
        'conformance-1',
      ]);
      expect(
        (await readdir(join(scratchDir, SESSIONS_DIR))).some((f) =>
          f.endsWith(HARNESS_MCP_CONFIG_FILE),
        ),
      ).toBe(false);
    });
  });

  test("per-run config names: concurrent runs on ONE session never share, replace or delete each other's binding; files at other names are never touched", async () => {
    await withScratch(async (scratchDir) => {
      const seed = await new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, []),
      ).run(invocation({ prompt: 'seed run' }));
      const sessionId = seed.sessionId as string;
      const sessionsDir = join(scratchDir, SESSIONS_DIR);
      // A file and a planted symlink at the legacy fixed name are inert:
      // never followed, never written, never deleted.
      const legacyPath = join(sessionsDir, `${sessionId}${HARNESS_MCP_CONFIG_FILE}`);
      await writeFile(legacyPath, 'foreign — not ours', { mode: 0o644 });
      const victim = join(scratchDir, 'victim.json');
      await writeFile(victim, 'victim-content', 'utf8');
      const linkPath = join(sessionsDir, `${sessionId}.planted${HARNESS_MCP_CONFIG_FILE}`);
      await symlink(victim, linkPath);
      // Two runs on the SAME session at once, with different sandbox levels.
      const callsA: SpawnCall[] = [];
      const callsB: SpawnCall[] = [];
      const probeA = join(scratchDir, 'probe-a.json');
      const probeB = join(scratchDir, 'probe-b.json');
      const [a, b] = await Promise.all([
        new SubprocessDriver(
          baseOptions(
            scratchDir,
            { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_CONFIG_PROBE: probeA },
            callsA,
          ),
        ).run(
          invocation({
            prompt: 'run A',
            sessionRef: sessionId,
            sandboxPolicy: { level: 'read-only' },
          }),
        ),
        new SubprocessDriver(
          baseOptions(
            scratchDir,
            { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_CONFIG_PROBE: probeB },
            callsB,
          ),
        ).run(invocation({ prompt: 'run B', sessionRef: sessionId })),
      ]);
      expect(a.stopReason).toBe('complete');
      expect(b.stopReason).toBe('complete');
      const pathOf = (calls: SpawnCall[]): string => {
        const args = calls[0]?.args ?? [];
        return args[args.indexOf('--mcp-config') + 1] as string;
      };
      const pathA = pathOf(callsA);
      const pathB = pathOf(callsB);
      expect(pathA).not.toBe(pathB);
      // Each CLI saw its OWN regular 0600 file at start.
      expect((await readProbe(probeA)).atStart).toEqual({
        present: true,
        mode: 0o600,
        symlink: false,
      });
      expect((await readProbe(probeB)).atStart).toEqual({
        present: true,
        mode: 0o600,
        symlink: false,
      });
      // Both per-run files are gone; the foreign files are untouched.
      await expect(lstat(pathA)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(lstat(pathB)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(await readFile(legacyPath, 'utf8')).toBe('foreign — not ours');
      expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
      expect(await readFile(victim, 'utf8')).toBe('victim-content');
    });
  });

  test('init mismatch: an unstripped builtin in init.tools → error, harness prefix, surface-mismatch marker', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_INIT_EXTRA_TOOL: 'Bash' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'leaky builtin run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('init surface mismatch');
      expect(result.error).toContain('Bash');
      const [marker, ...rest] = await markersOf(
        store,
        result.sessionId as string,
        'harness-surface-mismatch',
      );
      expect(rest).toEqual([]);
      expect(marker).toMatchObject({ cq: 'harness-surface-mismatch', errorClass: 'harness' });
      expect(JSON.stringify(marker?.['observed'])).toContain('Bash');
    });
  });

  test('init mismatch: an extra connected MCP server → error with the harness prefix', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_INIT_EXTRA_SERVER: 'ambient-connector' },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'leaky server run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('ambient-connector');
      const markers = await markersOf(
        store,
        result.sessionId as string,
        'harness-surface-mismatch',
      );
      expect(markers).toHaveLength(1);
      expect(markers[0]?.['errorClass']).toBe('harness');
    });
  });

  test('the REAL server refusing its argv at startup (exit 78) → init reports failed → error/harness', async () => {
    launchControl.extraArgs = ['stray-argument']; // bin.ts demands exactly one argument
    onTestFinished(() => {
      launchControl.extraArgs = [];
    });
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'tool-then-reply', FAKE_AGENT_TOOL: 'read' },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'refused server run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.denials).toEqual([]); // no tool ever ran
      const [marker] = await markersOf(
        store,
        result.sessionId as string,
        'harness-surface-mismatch',
      );
      expect(marker?.['observed']).toEqual({
        mcp_servers: [{ name: 'cq-harness', status: 'failed' }],
        tools: [],
      });
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(false);
    });
  });

  test('no init event at all in harness mode → harness-surface-unverified error, never a model outcome', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok', FAKE_AGENT_NO_INIT: '1' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'silent init run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('never reported its init surface');
      expect(
        await markersOf(store, result.sessionId as string, 'harness-surface-unverified'),
      ).toEqual([{ cq: 'harness-surface-unverified', errorClass: 'harness' }]);
    });
  });

  test('a harness failure voids structured output: an unverified run never exposes the payload (review r1)', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          { FAKE_AGENT_MODE: 'structured-ok', FAKE_AGENT_NO_INIT: '1' },
          [],
        ),
        outputSchema: z.object({ answer: z.string() }).strict(),
      });
      const result = await driver.run(invocation({ prompt: 'unverified structured run' }));
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.structuredOutput).toBeUndefined();
    });
  });

  test('a RELATIVE sessionsDir still yields an absolute --mcp-config the CLI (cwd = workspace) can open (review r1)', async () => {
    await withScratch(async (scratchDir) => {
      const calls: SpawnCall[] = [];
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls),
        sessionsDir: relative(process.cwd(), join(scratchDir, SESSIONS_DIR)),
      });
      const result = await driver.run(invocation({ prompt: 'relative sessionsDir run' }));
      expect(result.stopReason).toBe('complete');
      const args = calls[0]?.args ?? [];
      expect(isAbsolute(args[args.indexOf('--mcp-config') + 1] as string)).toBe(true);
    });
  });

  test('the server dying mid-run → transport failure: error/harness, NOT a denial', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'read',
            FAKE_AGENT_INPUT: JSON.stringify({ path: 'note.txt' }),
            FAKE_AGENT_KILL_SERVER: '1',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'dead server run' }));
      expect(result.stopReason).toBe('error');
      expect(result.denials).toEqual([]);
      expect(result.error?.startsWith(HARNESS_ERROR_PREFIX)).toBe(true);
      expect(result.error).toContain('transport failure');
      expect(result.error).toContain('MCP error -32000: Connection closed');
      expect(
        await markersOf(store, result.sessionId as string, 'harness-transport-failure'),
      ).toEqual([
        {
          cq: 'harness-transport-failure',
          errorClass: 'harness',
          tool: 'read',
          text: 'MCP error -32000: Connection closed',
        },
      ]);
    });
  });

  test('a REAL harness denial (path escape) is a denial under the harness name; the run completes', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'read',
            FAKE_AGENT_INPUT: JSON.stringify({ path: '../../outside-secret.txt' }),
            FAKE_AGENT_REPLY: 'noted the refusal',
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'escape run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.error).toBeUndefined();
      expect(result.denials).toHaveLength(1);
      expect(result.denials[0]?.tool).toBe('read');
      expect(result.denials[0]?.reason.startsWith('path escape:')).toBe(true);
      // The session record speaks harness names, never the qualified spelling.
      const record = await store.load(result.sessionId as string);
      const toolMessages = record?.messages.filter(
        (m) => m.role === 'tool' && m.toolName !== 'cli-narration',
      );
      expect(toolMessages?.map((m) => m.toolName)).toEqual(['read']);
      const folded = JSON.parse(toolMessages?.[0]?.content ?? '{}') as { ok: boolean };
      expect(folded.ok).toBe(false);
    });
  });

  test('a harness-served tool that SUCCEEDS lands as a role-tool message with the server text', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(
        baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'run',
            FAKE_AGENT_INPUT: JSON.stringify({ command: 'echo served-marker > note.txt' }),
          },
          [],
        ),
      );
      const result = await driver.run(invocation({ prompt: 'served run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.denials).toEqual([]);
      const record = await store.load(result.sessionId as string);
      expect(await readFile(join(record?.workspace as string, 'note.txt'), 'utf8')).toBe(
        'served-marker\n',
      );
      const message = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'run');
      expect(JSON.parse(message?.content ?? '{}')).toMatchObject({
        input: { command: 'echo served-marker > note.txt' },
        ok: true,
      });
    });
  });

  test('stdout fold: a CLI permission denial (frame or CLI text) is a denial; unknown is_error text is a transport failure', () => {
    const read = 'mcp__cq-harness__read';
    const edit = 'mcp__cq-harness__edit';

    // (a) The permission_denied FRAME names the tool_use: whatever the text,
    // the errored result is a permission denial.
    const framed = harnessObservation(['read', 'edit']);
    handleStdoutLine(framed, initLine([read, edit]));
    expect(framed.harnessConnected).toBe(true);
    expect(framed.harnessFailure).toBeUndefined();
    handleStdoutLine(framed, toolUseLine('t1', edit));
    handleStdoutLine(
      framed,
      line({ type: 'system', subtype: 'permission_denied', tool_name: edit, tool_use_id: 't1' }),
    );
    handleStdoutLine(framed, toolResultLine('t1', 'denied by policy'));
    expect(framed.denials).toEqual([{ tool: 'edit', reason: 'denied by policy' }]);
    expect(framed.harnessFailure).toBeUndefined();

    // (b) No frame, but the CLI's own permission text → a denial too.
    const texted = harnessObservation(['read', 'edit']);
    handleStdoutLine(texted, initLine([read, edit]));
    handleStdoutLine(texted, toolUseLine('t2', edit));
    const cliText = `Claude requested permissions to use ${edit}, but you haven't granted it yet.`;
    handleStdoutLine(texted, toolResultLine('t2', cliText));
    expect(texted.denials).toEqual([{ tool: 'edit', reason: cliText }]);
    expect(texted.harnessFailure).toBeUndefined();

    // (c) A stable harness denial prefix (text-block form) → a denial.
    const harnessDenied = harnessObservation(['read']);
    handleStdoutLine(harnessDenied, initLine([read]));
    handleStdoutLine(harnessDenied, toolUseLine('t3', read));
    handleStdoutLine(
      harnessDenied,
      toolResultLine('t3', [{ type: 'text', text: "file not found: 'x'" }]),
    );
    expect(harnessDenied.denials).toEqual([{ tool: 'read', reason: "file not found: 'x'" }]);
    expect(harnessDenied.harnessFailure).toBeUndefined();

    // (d) Anything else on a harness tool → transport failure, never a denial.
    const broken = harnessObservation(['read']);
    handleStdoutLine(broken, initLine([read]));
    handleStdoutLine(broken, toolUseLine('t4', read));
    handleStdoutLine(broken, toolResultLine('t4', 'MCP error -32001: Request timed out'));
    expect(broken.denials).toEqual([]);
    expect(broken.harnessFailure).toEqual({
      cq: 'harness-transport-failure',
      errorClass: 'harness',
      tool: 'read',
      text: 'MCP error -32001: Request timed out',
    });

    // (e) Only the FIRST init is asserted, and an extra builtin fails it.
    const leaky = harnessObservation(['read']);
    handleStdoutLine(leaky, initLine([read, 'Bash']));
    handleStdoutLine(leaky, initLine([read]));
    expect(leaky.harnessConnected).toBe(false);
    expect(leaky.harnessFailure?.cq).toBe('harness-surface-mismatch');
  });

  test('governed abort in harness mode → aborted (not a harness error), and no server process survives', async () => {
    await withScratch(async (scratchDir, store) => {
      const pidFile = join(scratchDir, 'server.pid');
      let deadline: (() => void) | undefined;
      const deadlineHandle = Symbol('init-gated deadline');
      const spawn = recordingSpawn([], {
        FAKE_AGENT_MODE: 'block-until-abort',
        FAKE_AGENT_SERVER_PID_FILE: pidFile,
      });
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, {}, []),
        spawn: (options) => {
          const child = spawn(options);
          onTestFinished(() => {
            child.kill('SIGKILL');
          });
          child.onStdoutLine((l) => {
            if (l.includes('"subtype":"init"')) queueMicrotask(() => deadline?.());
          });
          return child;
        },
        termGraceMs: 500,
        killGraceMs: 500,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'governed harness run' })),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-harness-abort', attempt: 1 },
        {
          clock: {
            now: realClock.now,
            setTimeout: (fn, ms) => {
              if (deadline === undefined) {
                deadline = fn;
                return deadlineHandle;
              }
              return realClock.setTimeout(fn, ms);
            },
            clearTimeout: (handle) => {
              if (handle !== deadlineHandle) realClock.clearTimeout(handle);
            },
          },
        },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return;
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.error).toBeUndefined();
      const narration = await narrationOf(store, outcome.value.sessionId as string);
      expect(narration.some((l) => l.includes('"errorClass":"harness"'))).toBe(false);
      const pids = (await readFile(pidFile, 'utf8'))
        .split('\n')
        .filter((l) => l !== '')
        .map(Number);
      expect(pids).toHaveLength(1);
      for (const pid of pids) expect(await processGone(pid)).toBe(true);
      // The config is gone even though the run never completed.
      expect(
        (await readdir(join(scratchDir, SESSIONS_DIR))).some((f) =>
          f.endsWith(HARNESS_MCP_CONFIG_FILE),
        ),
      ).toBe(false);
    });
  });

  test('STOCK surface run: the legacy argv and the legacy in-process tool path (raw names, no MCP)', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const driver = new SubprocessDriver({
        ...baseOptions(
          scratchDir,
          {
            FAKE_AGENT_MODE: 'tool-then-reply',
            FAKE_AGENT_TOOL: 'read',
            FAKE_AGENT_INPUT: JSON.stringify({ path: 'missing.txt' }),
          },
          calls,
        ),
        toolSurface: 'stock',
      });
      const result = await driver.run(invocation({ prompt: 'stock run' }));
      expect(result.stopReason).toBe('complete');
      expect(calls[0]?.args).toEqual([
        FAKE_CLI,
        '-p',
        '--output-format',
        'stream-json',
        '--verbose',
        '--allowedTools',
        'read edit run',
        '--model',
        'conformance-1',
      ]);
      expect(mcpConfigArgOf(calls[0]?.args ?? [])).toBeUndefined();
      expect(result.denials).toEqual([{ tool: 'read', reason: "file not found: 'missing.txt'" }]);
      const record = await store.load(result.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'tool' && m.toolName === 'read')).toBe(true);
      // No init surface is asserted on the stock surface.
      expect(
        (await narrationOf(store, result.sessionId as string)).some((l) =>
          l.includes('"errorClass":"harness"'),
        ),
      ).toBe(false);

      // The legacy deny-tool shape still maps on the stock surface.
      const denied = await new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
        toolSurface: 'stock',
      }).run(invocation({ prompt: 'stock denial run' }));
      expect(denied.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
      ]);
      expect(denied.stopReason).toBe('error');
    });
  });
});
