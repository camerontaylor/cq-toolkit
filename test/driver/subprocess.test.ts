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
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import { SubprocessDriver } from '../../src/driver/subprocess/index.js';
import type { SpawnFn, SubprocessDriverOptions } from '../../src/driver/subprocess/index.js';
import { CLI_SESSION_FILE } from '../../src/driver/subprocess/index.js';
import { RoutingTableSchema, defaultRoutingTable } from '../../src/driver/subprocess/routing.js';
import type { RoutingTable } from '../../src/driver/subprocess/routing.js';
import { spawnManaged } from '../../src/driver/subprocess/process.js';
import { runDriverConformance } from './conformance.js';
import type { ConformanceSpec, ModelDirective } from './conformance.js';
import { SESSIONS_DIR, CONFORMANCE_PROVIDER, CONFORMANCE_MODEL } from './conformance.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';
import { runLadder } from '../../src/kernel/governor.js';
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
// process.env is never mutated per-run (vitest runs tests concurrently
// within a file's worker; per-driver env keeps runs isolated).
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
    default:
      return { FAKE_AGENT_MODE: 'ok' };
  }
}

/** The --allowedTools value of a built argv (the fixture's permission gate). */
function allowedToolsArg(args: readonly string[]): string {
  const index = args.indexOf('--allowedTools');
  return index !== -1 && index + 1 < args.length ? (args[index + 1] as string) : '';
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
function baseOptions(scratchDir: string, extraEnv: Record<string, string>, calls: SpawnCall[]): SubprocessDriverOptions {
  return {
    binary: ['node', FAKE_CLI],
    routingTable: conformanceRoutingTable(),
    sessionsDir: join(scratchDir, SESSIONS_DIR),
    harnessConfig: { ...defaultHarnessConfig, workspaceRoot: join(scratchDir, 'workspaces') },
    spawn: recordingSpawn(calls, extraEnv),
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
async function withScratch(body: (scratchDir: string, store: SessionStore) => Promise<void>): Promise<void> {
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

describe('subprocess driver specifics (fake agent CLI)', () => {
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
      ).rejects.toThrow(/not on the deepseek allowlist .* silently remap unknown model names; refusing to dispatch/);
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
      await expect(readdir(join(scratchDir, SESSIONS_DIR))).rejects.toMatchObject({ code: 'ENOENT' });
    });
  });

  test('grace ladder: a SIGTERM-ignoring child escalates to SIGKILL — both rungs observed in order', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ignore-sigterm' }, calls),
        termGraceMs: 200,
        killGraceMs: 200,
      });
      const outcome = await runLadder(
        () => driver.run(invocation({ prompt: 'stubborn run' })),
        // > node startup: the fixture's ignore handler is installed before
        // the SIGTERM arrives (a 100ms budget raced node boot and killed the
        // child by default disposition)
        { wallClockMs: 1000 },
        { op: 'subprocess', jobKey: 'subprocess-ladder', attempt: 1 },
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
      const narration = record?.messages.find((m) => m.role === 'tool' && m.toolName === 'cli-narration');
      expect(narration?.content).toContain('transient bootstrapping noise');
      // The non-contract system event is narration too — unknown subtypes
      // never crash the fold.
      expect(narration?.content).toContain('worthless non-contract event');
    });
  });

  test('resume: the second run passes --resume; the workspace sidecar carries the CLI handle', async () => {
    await withScratch(async (scratchDir, store) => {
      const calls: SpawnCall[] = [];
      const first = new SubprocessDriver(baseOptions(scratchDir, { FAKE_AGENT_MODE: 'ok' }, calls));
      const run1 = await first.run(invocation({ prompt: 'resume run one' }));
      expect(calls[0]?.args).not.toContain('--resume'); // fresh run: no resume flag
      const workspace = (await store.load(run1.sessionId as string))?.workspace as string;
      const cliId = (await readFile(join(workspace, CLI_SESSION_FILE), 'utf8')).trim();
      expect(cliId).toMatch(/^fake-cli-/);

      // The resumed run forwards the recorded CLI session id as --resume
      // (proven by the fixture echoing it) and reuses the SAME workspace.
      const calls2: SpawnCall[] = [];
      const second = new SubprocessDriver(
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'resume-echo' }, calls2),
      );
      const run2 = await second.run(invocation({ prompt: 'resume run two', sessionRef: run1.sessionId }));
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(run2.stopReason).toBe('complete');
      expect(calls2[0]?.args).toContain('--resume');
      const resumeIndex = calls2[0]?.args.indexOf('--resume') ?? -1;
      expect(calls2[0]?.args[resumeIndex + 1]).toBe(cliId);

      // ONE session record carries both runs' turns; the sidecar is stable.
      const record = await store.load(run1.sessionId as string);
      expect(record?.messages.some((m) => m.role === 'user' && m.content === 'resume run one')).toBe(true);
      expect(record?.messages.some((m) => m.role === 'user' && m.content === 'resume run two')).toBe(true);
      expect(
        record?.messages.some((m) => m.role === 'assistant' && m.content.includes(`resumed from cli session ${cliId}`)),
      ).toBe(true);
      expect((await readFile(join(workspace, CLI_SESSION_FILE), 'utf8')).trim()).toBe(cliId);
    });
  });

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

  test('structured output: --json-schema + the fixture structured_output land in the result', async () => {
    await withScratch(async (scratchDir) => {
      const driver = new SubprocessDriver({
        ...baseOptions(scratchDir, { FAKE_AGENT_MODE: 'structured-ok' }, []),
        outputSchema: z.object({ answer: z.string() }).strict(),
      });
      const result = await driver.run(invocation({ prompt: 'structured run' }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
    });
  });

  test('usage mapping: the fixed fixture numbers become the frozen Usage shape', async () => {
    await withScratch(async (scratchDir, store) => {
      const driver = new SubprocessDriver(baseOptions(scratchDir, {}, []));
      const result = await driver.run(invocation({ prompt: 'usage run' }));
      expect(result.stopReason).toBe('complete');
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
      const result = await driver.run(invocation({ prompt: 'budget run', budget: { maxTokens: 1000 } }));
      expect(result.stopReason).toBe('budget');
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
        baseOptions(scratchDir, { FAKE_AGENT_MODE: 'echo-workspace', FAKE_AGENT_PATH: 'note.txt' }, []),
      );
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
});
