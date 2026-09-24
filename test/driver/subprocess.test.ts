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
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, onTestFinished, test } from 'vitest';
import { z } from 'zod';
import {
  SubprocessDriver,
  buildArgs,
  stopReasonOf,
  usageFromCli,
} from '../../src/driver/subprocess/index.js';
import type { SpawnFn, SubprocessDriverOptions } from '../../src/driver/subprocess/index.js';
import { fakeManagedSpawn, runFakeTool } from '../helpers/transport-fakes.js';
import type { JsonLineFrame, JsonLinePeer } from '../helpers/transport-fakes.js';
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
} from '../../src/driver/subprocess/process.js';
import { runDriverConformance } from './conformance.js';
import type { ConformanceSpec, ModelDirective } from './conformance.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER, CONFORMANCE_MODEL } from './conformance.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { stripMetaSchema } from '../../src/driver/json-schema.js';
import { SessionStore } from '../../src/harness/session.js';
import { realClock, runLadder } from '../../src/kernel/governor.js';
import type { Driver, OpInvocation } from '../../src/driver/types.js';

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
    harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
    spawn: recordingSpawn(calls, extraEnv),
  };
}

/** Fresh mock-backed SubprocessDriver honoring the ConformanceSpec contract. */
function fakeManagedScript(
  opts: { cwd: string; args: readonly string[] },
  directive: ModelDirective | undefined,
  hasOutputSchema: boolean,
): (frame: JsonLineFrame, peer: JsonLinePeer) => void {
  const modelIndex = opts.args.indexOf('--model');
  const model =
    modelIndex === -1 ? 'conformance-1' : (opts.args[modelIndex + 1] ?? 'conformance-1');
  const allowedIndex = opts.args.indexOf('--allowedTools');
  const allowed = new Set(
    allowedIndex === -1 ? [] : (opts.args[allowedIndex + 1] ?? '').split(' ').filter(Boolean),
  );
  const sessionId = `fake-cli-${Math.random().toString(36).slice(2)}`;
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
      peer.stderr('simulated hard failure');
      peer.finish(1);
      return;
    }
    peer.send({ type: 'system', subtype: 'init', session_id: sessionId, model });
    if (directive?.kind === 'tool-then-reply' && allowed.has(directive.tool)) {
      peer.send({
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'fake-tool', name: directive.tool, input: directive.input },
          ],
        },
      });
      void runFakeTool(opts.cwd, directive.tool, directive.input)
        .then((outcome) => {
          peer.send({
            type: 'user',
            message: {
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'fake-tool',
                  is_error: !outcome.ok,
                  content: outcome.text,
                },
              ],
            },
          });
          peer.send({
            type: 'assistant',
            message: { content: [{ type: 'text', text: directive.reply }] },
          });
          peer.send({
            type: 'result',
            subtype: 'success',
            is_error: false,
            session_id: sessionId,
            model,
            usage,
            ...(hasOutputSchema ? { structured_output: { answer: 'ok' } } : {}),
          });
          peer.finish();
        })
        .catch((error: unknown) => {
          peer.stderr(`fake tool error: ${String(error)}`);
          peer.finish(1);
        });
      return;
    }
    const text = directive?.kind === 'reply' ? directive.text : 'ok';
    peer.send({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
    peer.send({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      model,
      usage,
      ...(hasOutputSchema ? { structured_output: { answer: 'ok' } } : {}),
    });
    peer.finish();
  };
}

function makeDriver(spec: ConformanceSpec): Driver {
  return new SubprocessDriver({
    ...baseOptions(spec.scratchDir, directiveEnv(spec.directive), []),
    spawn: fakeManagedSpawn((opts) =>
      fakeManagedScript(opts, spec.directive, spec.outputSchema !== undefined),
    ),
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

describe('subprocess driver specifics (fake agent CLI)', () => {
  test('routeFor rejects prototype keys — constructor/toString are not providers (mirror of the claude-agent guard)', () => {
    expect(() =>
      routeFor({ provider: 'constructor', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'constructor'/);
    expect(() =>
      routeFor({ provider: 'toString', model: 'deepseek-chat' }, defaultRoutingTable()),
    ).toThrow(/unknown provider 'toString'/);
  });

  test('buildArgs: the exact headless argv — undocumented flags removed (#19-8)', () => {
    const route = {
      endpoint: 'conformance',
      baseUrl: 'http://127.0.0.1:1/anthropic',
      env: {
        ANTHROPIC_AUTH_TOKEN: 'CONFORMANCE_API_KEY',
        ANTHROPIC_API_KEY: 'CONFORMANCE_API_KEY',
      },
      model: 'conformance-1',
    };
    const args = buildArgs({
      route,
      allowedToolNames: ['read', 'edit'],
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
      '--allowedTools',
      'read edit',
      '--model',
      'conformance-1',
      '--resume',
      'cli-9',
    ]);
    // ToolPolicy mode 'none' shape: --allowedTools ALWAYS present with an
    // EMPTY value (nothing pre-approved; headless -p cannot prompt, so a
    // tool outside the list is CLI-DENIED — the WorkerResult.denials source).
    const none = buildArgs({
      route,
      allowedToolNames: [],
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
    expect(none).not.toContain('--permission-prompts'); // undocumented — removed (issue #19)
    expect(none).not.toContain('--bare'); // undocumented — removed (issue #19)
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
    // Real CLI resume argv plus the sidecar filesystem contract; this budget
    // covers two child process startups, not an in-process decision.
  }, 15_000);

  test('deny-tool: the CLI tool_result denial maps to the frozen {tool, reason} shape', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'deny-tool' }, []),
      );
      const result = await driver.run(invocation({ prompt: 'denial run' }));
      expect(result.denials).toEqual([
        { tool: 'edit', reason: 'permission denied: edit is not allowed' },
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
      expect(marker).toContain('"level":"workspace-write"');

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
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ignore-sigterm' }, calls),
        binary: ['node', FAKE_CLI, '--spawn-grandchild', pidFile],
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'group kill run' })),
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-group', attempt: 1 },
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
    // Structural OS-signal-ladder budget: SIGTERM grace, then SIGKILL, then
    // descendant teardown are each subject to host-load swings beyond the
    // five-second process-death poll above.
  }, 20_000);

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
      const probePath = join(scratchDir, 'env-probe.mjs');
      await writeFile(
        probePath,
        [
          'const env = { ...process.env };',
          "process.stdout.write('CQ_ENV_PROBE:' + JSON.stringify(env) + '\\n');",
          "process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'env-probe', model: 'conformance-1' }) + '\\n');",
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
          invocation({ prompt: 'env probe run' }),
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
        const expectedKey = process.env.CONFORMANCE_API_KEY as string;
        const expectedBaseUrl = process.env.CONFORMANCE_BASE_URL ?? 'http://127.0.0.1:1/anthropic';
        expect(typeof deniedEnv['PATH']).toBe('string');
        expect(deniedEnv['ANTHROPIC_BASE_URL']).toBe(expectedBaseUrl);
        expect(deniedEnv['ANTHROPIC_API_KEY']).toBe(expectedKey);
        expect(deniedEnv['ANTHROPIC_AUTH_TOKEN']).toBe(expectedKey);

        // The documented escape hatch is real end-to-end (r1): naming the
        // marker in envAllowlist copies ONLY that parent name back in.
        const allowed = await new SubprocessDriver({
          ...probeOptions,
          envAllowlist: ['CQ_ENV_LEAK_MARKER'],
        }).run(invocation({ prompt: 'allowlist probe run' }));
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
        const frozen = await frozenDriver.run(invocation({ prompt: 'frozen allowlist probe run' }));
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
