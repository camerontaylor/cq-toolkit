// The ai-sdk driver instantiation — T1.4 slice 3.
//
// Two layers:
//   1. THE CONFORMANCE SUITE, run against the real AiSdkDriver with a MOCK
//      model (ai/test helpers) scripted per the suite's ModelDirective
//      contract — structured output, budget/abort, denials, usage, the
//      vendor-vocabulary ban, and the I6 isolation pairs.
//   2. DRIVER-SPECIFIC unit tests: pre-dispatch failures (unknown provider,
//      missing env key), the stopReason mapping table, the exact
//      ai@7.0.99 → frozen Usage mapping, and pricing integration (derived
//      costUSD for a known model, absent for an unknown one).
//
// LIVE VARIANT: `describe.skipIf(!process.env.LIVE_DRIVERS)` runs the REAL
// default provider registry (no mocks) with tiny prompts and a hard
// Budget.maxUsd 2 / maxTokens 2000. SKIPPED unless LIVE_DRIVERS=1 — CI never
// sets it (the workflow wiring is T1.7's). When opted in, a missing provider
// key fails loudly instead of silently passing.
import { mkdtemp, mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn as childSpawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { makeGitleaksFixture } from '../helpers/gitleaks-fixture.js';
import { bindingsFromDispatch } from '../../src/ops/sweep/unit.js';
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  AiSdkDriver,
  DEFAULT_MAX_STEPS,
  parseReplyJson,
  serializeRequestForScan,
  DEFAULT_STEP_TIMEOUT_MS,
  classifyRunFailure,
  providerSignalsFromError,
  providerSignalsFromHeaders,
  stopReasonOf,
  usageFromSdk,
} from '../../src/driver/ai-sdk/index.js';
import type { AiSdkDriverOptions } from '../../src/driver/ai-sdk/index.js';
import { runLadder } from '../../src/kernel/governor.js';
import type { Clock } from '../../src/kernel/governor.js';
import {
  type ConformanceSpec,
  CONFORMANCE_PROVIDER,
  type ModelDirective,
  BANNED_VOCABULARY,
  SESSIONS_DIR,
  runDriverConformance,
} from '../../src/driver/conformance.js';
import { runGovernedAbortLeg } from './conformance-kernel.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import {
  probeRgVersion as harnessProbeRg,
  parseRgVersion,
  versionAtLeast,
  RG_MINIMUM_VERSION,
} from '../../src/harness/tools.js';
import { SessionStore } from '../../src/harness/session.js';
import type { OpInvocation, OutputSchema, WorkerResult } from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// generateText arg capture — a TRANSPARENT spy over the real 'ai' module:
// tests assert what the driver actually PASSED (system preamble,
// stopWhen conditions, conversation messages) without signature churn.
// ---------------------------------------------------------------------------

const captured = vi.hoisted(() => ({ generateTextArgs: [] as unknown[] }));

vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>();
  return {
    ...actual,
    generateText: (args: Parameters<typeof actual.generateText>[0]) => {
      captured.generateTextArgs.push(args);
      return actual.generateText(args);
    },
  };
});

/** The args of the MOST RECENT generateText call (one per driver.run). */
function lastGenerateTextArgs(): {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
  stopWhen?: unknown;
  maxRetries?: number;
  timeout?: unknown;
  tools?: Record<string, unknown>;
} {
  const last = captured.generateTextArgs[captured.generateTextArgs.length - 1];
  if (last === undefined) throw new Error('no generateText call was captured');
  return last as {
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    stopWhen?: unknown;
    maxRetries?: number;
    timeout?: unknown;
    tools?: Record<string, unknown>;
  };
}

/**
 * The args of a generateText call counted from the END (0 = most recent,
 * 1 = the one before it — the main call of a run that also repaired).
 */
function generateTextArgsFromEnd(offsetFromEnd: number): {
  system?: string;
  messages?: Array<{ role: string; content: string }>;
  stopWhen?: unknown;
  maxRetries?: number;
  tools?: Record<string, unknown>;
} {
  const args = captured.generateTextArgs[captured.generateTextArgs.length - 1 - offsetFromEnd];
  if (args === undefined) throw new Error(`no generateText call at offset ${offsetFromEnd}`);
  return args as {
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    stopWhen?: unknown;
    maxRetries?: number;
    tools?: Record<string, unknown>;
  };
}

// ---------------------------------------------------------------------------
// Mock-model scripting (the conformance contract, wired onto ai/test mocks)
// ---------------------------------------------------------------------------

/** The scripted model's per-step token usage — numbers the usage contract can assert on. */
function mockUsage(): LanguageModelV4GenerateResult['usage'] {
  // The mock serves the REQUESTED id (its modelId) as the response's model —
  // the conformance observed-model check (leg m) asserts exactly that.
  return {
    inputTokens: { total: 120, noCache: 100, cacheRead: 15, cacheWrite: 5 },
    outputTokens: { total: 12, text: 10, reasoning: 2 },
  };
}

/**
 * Tools the model is still invited to call on this request. The tool set is
 * fixed per session (#502): the forced final step and the repair carry the same
 * definitions and differ only by their trailing instruction turn.
 */
function offeredToolCount(options: { tools?: readonly unknown[]; prompt?: unknown }): number {
  const promptText = JSON.stringify(options.prompt ?? '');
  const answerTurn =
    promptText.includes('This is your final step') ||
    promptText.includes('did not satisfy the required JSON contract');
  return answerTurn ? 0 : (options.tools?.length ?? 0);
}

function textResult(text: string): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

/** A text reply carrying provider limit headers on the response metadata (RS-14). */
function textResultWithHeaders(
  text: string,
  headers: Record<string, string>,
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: 'stop', raw: undefined },
    usage: mockUsage(),
    warnings: [],
    response: { headers },
  };
}

/** A RESOLVED step whose finish reason is a provider-level failure (no throw). */
function finishResult(
  unified: 'error' | 'content-filter',
  text = 'the reply never satisfied anything',
): LanguageModelV4GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified, raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

function toolCallResult(tool: string, input: unknown): LanguageModelV4GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: 'conformance-call-1',
        toolName: tool,
        input: JSON.stringify(input),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

/** A plain reply model carrying ARBITRARY per-step token usage (custom usage-shape tests). */
function usageModel(
  usage: LanguageModelV4GenerateResult['usage'],
  modelId = 'mock-1',
): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    modelId,
    doGenerate: {
      content: [{ type: 'text', text: 'ok' }],
      finishReason: { unified: 'stop', raw: undefined },
      usage,
      warnings: [],
    },
  });
}

/**
 * Build the mock model for one directive (see conformance.ts for the script
 * contract). `servedModel` threads the factory's modelId so the mock's
 * response reports the REQUESTED id as served — the observed-model fact
 * WorkerResult.model carries.
 */
function modelFor(
  directive: ModelDirective | undefined,
  servedModel?: string,
): MockLanguageModelV4 {
  switch (directive?.kind) {
    case 'block-until-abort': {
      const abortError = (): Error =>
        Object.assign(new Error('run aborted by the governed signal'), { name: 'AbortError' });
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: async (options) => {
          const signal = options.abortSignal;
          if (signal?.aborted) throw abortError();
          return new Promise<never>((_, reject) => {
            signal?.addEventListener('abort', () => reject(abortError()), { once: true });
          });
        },
      });
    }
    case 'fail':
      // The lane's OWN vendor quota-with-reset shape: a funded-allowance 429
      // whose response headers carry the claude unified window — the script
      // behind the conformance suite's leg s (the mock's fail emits the
      // vendor quota signals where the vendor supports them). The driver
      // must still RETURN stopReason 'error', never throw past the seam.
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: async () => {
          throw quota429Error();
        },
      });
    case 'tool-then-reply':
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: [toolCallResult(directive.tool, directive.input), textResult(directive.reply)],
      });
    case 'reply':
    case undefined:
    default:
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: textResult(directive?.text ?? 'ok'),
      });
    case 'reply-invalid-json':
      // A reply that is NOT the JSON object a structured-output schema
      // demands (the output-invalid legs' script — no legs ship yet).
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: textResult('this reply is prose, not the required JSON object'),
      });
  }
}

/** Conformance harness config: the conformance write permitted via an anchored re: pattern (token patterns deny redirects by design); workspaces inside scratchDir. */
function conformanceHarnessConfig(
  scratchDir: string,
): NonNullable<AiSdkDriverOptions['harnessConfig']> {
  return {
    ...defaultHarnessConfig,
    workspaceRoot: join(scratchDir, 'workspaces'),
    tools: {
      ...defaultHarnessConfig.tools,
      bash: {
        ...defaultHarnessConfig.tools.bash,
        // `echo conformance-marker > note.txt` redirects — the shell-
        // metacharacter guard (fix 1) denies that under a token pattern, so
        // the conformance write rides the documented escape hatch: an
        // anchored re: pattern matching exactly the isolation write.
        commandPatterns: ['re:^echo .* > note\\.txt$'],
      },
    },
  };
}

/** Fresh mock-backed AiSdkDriver honoring the ConformanceSpec contract. */
function makeDriver(spec: ConformanceSpec): AiSdkDriver {
  return new AiSdkDriver({
    // The suite's canonical modelSpec handle resolves to the scripted mock,
    // as does the priced handle when the suite brings one; the factory's
    // modelId IS the served id the mock reports (leg m).
    providers: {
      [CONFORMANCE_PROVIDER]: (modelId) => modelFor(spec.directive, modelId),
      ...(spec.pricedModel !== undefined
        ? { [spec.pricedModel.provider]: (modelId) => modelFor(spec.directive, modelId) }
        : {}),
    },
    // The priced handle flows through the price lookup so the conformance
    // suite can assert a derived costUSD; everything else stays unpriced.
    // PRICING KEYING (issue #18): the lookup matches provider AND model —
    // at the spec-declared rates when the suite declares them — so the
    // suite's exact-figure assertion computes from the same numbers.
    ...(spec.pricedModel !== undefined
      ? {
          pricing: (modelSpec: { provider: string; model: string }) =>
            modelSpec.provider === spec.pricedModel?.provider &&
            modelSpec.model === spec.pricedModel.model
              ? (spec.pricedModel.rates ?? { input: 3, output: 15 })
              : undefined,
        }
      : {}),
    sessionsDir: join(spec.scratchDir, SESSIONS_DIR),
    harnessConfig: conformanceHarnessConfig(spec.scratchDir),
    sandboxConfig: {
      mode: 'off',
      backend: 'auto',
      network: 'model-only',
      runTool: 'on',
      envPassthrough: [],
    },
  });
}

// ---------------------------------------------------------------------------
// 1. The conformance suite, mock-backed
// ---------------------------------------------------------------------------

runDriverConformance(
  makeDriver,
  { describe, test, expect },
  { label: 'ai-sdk driver (mock model)' },
);
runGovernedAbortLeg(makeDriver, { describe, test, expect });

// ---------------------------------------------------------------------------
// 2. Driver-specific unit tests
// ---------------------------------------------------------------------------

/** Minimal invocation for the driver-specific tests. */
function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'driver-specific run',
    modelSpec: { provider: 'mock', model: 'mock-1' },
    toolPolicy: { allow: [], mode: 'unrestricted' },
    sandboxPolicy: { level: 'none' },
    budget: {},
    ...overrides,
  };
}

describe('ai-sdk driver specifics (mock model)', () => {
  test.each([0, -1, 2.5, NaN, Infinity])(
    'rejects invalid maxSteps=%s before provider resolution, with abort precedence',
    async (maxSteps) => {
      const provider = vi.fn(() => modelFor({ kind: 'reply', text: 'must never run' }));
      const driver = new AiSdkDriver({ providers: { mock: provider } });
      await expect(driver.run(invocation({ budget: { maxSteps } }))).rejects.toMatchObject({
        name: 'DispatchError',
        message: `ai-sdk driver: budget.maxSteps must be a positive integer, got ${String(maxSteps)}`,
      });
      expect(provider).not.toHaveBeenCalled();
      const controller = new AbortController();
      controller.abort();
      const aborted = await driver.run(invocation({ budget: { maxSteps } }), {
        signal: controller.signal,
      });
      expect(aborted.stopReason).toBe('aborted');
      expect(aborted.steps).toBe(0);
      expect(provider).not.toHaveBeenCalled();
    },
  );

  test('an uncompilable outputSchema is the LOCAL output-invalid verdict before any provider call (PR #238 review round 2)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-preflight-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'model-only',
          runTool: 'on',
          envPassthrough: [],
        },
      });
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
        }),
      );
      // The uniform schema-miss verdict, compiled locally — the settle-time
      // miss flow's shape, but produced BEFORE the provider dispatch: the
      // pre-dispatch preflight's objection names the COMPILER (a dispatched
      // run would carry the mock's reply-miss text and a fresh sessionId).
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.error).toContain('test.broken/v1');
      expect(result.error).toContain('could not be compiled');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('I8 precedence: an already-aborted signal outranks an uncompilable outputSchema (PR #241)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-i8-'));
    try {
      let modelCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                modelCalls += 1;
                return textResult('must never run');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(
        invocation({
          outputSchema: { name: 'test.broken/v1', schema: { type: 'not-a-json-schema-type' } },
        }),
        { signal: controller.signal },
      );
      // The governed cancellation outranks the schema fault: the run settles
      // the plain abort verdict, never the LOCAL output-invalid one.
      expect(result.stopReason).toBe('aborted');
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      expect(modelCalls).toBe(0); // the scripted model was never called
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('omits run from the model surface when CQ policy withholds it', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-sandbox-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
        sandboxConfig: {
          mode: 'required',
          backend: 'auto',
          network: 'model-only',
          runTool: 'withheld',
          envPassthrough: [],
          configHint: 'CQ_SANDBOX=required needs a certified RS-13 backend',
        },
      });
      await driver.run(invocation());
      const tools = lastGenerateTextArgs().tools ?? {};
      expect(tools).not.toHaveProperty('run');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('preserves the run surface when CQ policy resolves it on', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-sandbox-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'model-only',
          runTool: 'on',
          envPassthrough: [],
        },
      });
      await driver.run(invocation());
      expect(lastGenerateTextArgs().tools).toHaveProperty('run');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('preserves the pre-W1.11 run surface when no sandbox policy is expressed', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-sandbox-'));
    const policyNames = [
      'CQ_SANDBOX',
      'CQ_SANDBOX_BACKEND',
      'CQ_SANDBOX_NETWORK',
      'CQ_RUN_TOOL',
      'CQ_RUN_ENV_PASSTHROUGH',
    ] as const;
    const saved = policyNames.map((name) => [name, process.env[name]] as const);
    try {
      for (const name of policyNames) delete process.env[name];
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await driver.run(invocation());
      expect(lastGenerateTextArgs().tools).toHaveProperty('run');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('unknown provider throws BEFORE dispatch — no session record is created', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor(undefined) },
        sessionsDir,
      });
      const err = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'm' } })),
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect((err as DispatchError).message).toContain("unknown provider 'nope'");
      // Seam v2: pre-dispatch misconfigurations carry their class (leg i-ii).
      expect(errorClassOf(err)).toBe('config');
      await expect(readdir(sessionsDir)).resolves.toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('missing env key throws BEFORE dispatch (default registry, env manipulated only in-process)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    const keyNames = ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ZAI_API_KEY', 'DEEPSEEK_API_KEY'];
    const saved = new Map(keyNames.map((name) => [name, process.env[name]]));
    try {
      for (const name of keyNames) delete process.env[name];
      const driver = new AiSdkDriver({ sessionsDir: join(scratchDir, 'sessions') });
      const err = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'anthropic', model: 'claude-haiku-4-5' } })),
      );
      expect((err as DispatchError).message).toContain('ANTHROPIC_API_KEY');
      expect(errorClassOf(err)).toBe('config');
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the ai-sdk provider handle is an alias for the zai factory (self-host driver-kind, review-debt #186)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    const saved = process.env.ZAI_API_KEY;
    try {
      delete process.env.ZAI_API_KEY;
      const driver = new AiSdkDriver({ sessionsDir: join(scratchDir, 'sessions') });
      // The self-host config names provider 'ai-sdk' (src/selfhost/config.ts);
      // the default registry must resolve it to the zai factory rather than
      // throwing unknown-provider. Without the key, the factory's own
      // missing-key error is the proof the alias routed (no network call —
      // the key check is pre-dispatch), and it names the handle the caller
      // configured ('ai-sdk'), not the internal factory.
      const err = await thrownBy(
        driver.run(invocation({ modelSpec: { provider: 'ai-sdk', model: 'glm-5.3-flash' } })),
      );
      expect((err as DispatchError).message).toContain("provider 'ai-sdk' requires ZAI_API_KEY");
      expect(errorClassOf(err)).toBe('config');
    } finally {
      if (saved !== undefined) process.env.ZAI_API_KEY = saved;
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('stopReason mapping table (checked in order: aborted → budget → error → complete)', () => {
    // 1. abort dominates every other condition.
    expect(
      stopReasonOf({ finishReason: 'length', aborted: true, tokenBudget: 10, totalTokens: 99 }),
    ).toBe('aborted');
    expect(
      stopReasonOf({
        finishReason: 'error',
        aborted: true,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('aborted');
    // 2. the token budget (totalTokens >= maxTokens) trips before finish reasons.
    expect(
      stopReasonOf({ finishReason: 'stop', aborted: false, tokenBudget: 10, totalTokens: 10 }),
    ).toBe('budget');
    expect(
      stopReasonOf({
        finishReason: 'tool-calls',
        aborted: false,
        tokenBudget: 10,
        totalTokens: 11,
      }),
    ).toBe('budget');
    // 3. SDK 'length' is a budget stop even without an explicit cap.
    expect(
      stopReasonOf({
        finishReason: 'length',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 5,
      }),
    ).toBe('budget');
    // 4. SDK error / content-filter are driver-level errors.
    expect(
      stopReasonOf({
        finishReason: 'error',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('error');
    expect(
      stopReasonOf({
        finishReason: 'content-filter',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('error');
    // 5. everything else is a normal completion.
    expect(
      stopReasonOf({
        finishReason: 'stop',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('complete');
    expect(
      stopReasonOf({
        finishReason: 'tool-calls',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('complete');
    expect(
      stopReasonOf({
        finishReason: 'other',
        aborted: false,
        tokenBudget: undefined,
        totalTokens: 0,
      }),
    ).toBe('complete');
  });

  test('usage mapping: details win over totals; no details → totals with cache at 0; reasoning NEVER set (subset of output)', () => {
    // The mock reports outputTokenDetails.reasoningTokens: 2 — realistic,
    // and deliberately so: reasoning is INSIDE outputTokens (the AI SDK's
    // totalTokens = inputTokens + outputTokens), so the fold must NOT lift
    // it into the separate frozen field (every summed total would diverge
    // from the SDK's totalTokens by exactly that amount).
    expect(
      usageFromSdk({
        inputTokens: 90,
        inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 15, cacheWriteTokens: 5 },
        outputTokens: 42,
        outputTokenDetails: { textTokens: 40, reasoningTokens: 2 },
        totalTokens: 132,
      }),
    ).toEqual({ input: 70, output: 42, cacheRead: 15, cacheWrite: 5 });
    expect(
      usageFromSdk({
        inputTokens: 90,
        inputTokenDetails: { noCacheTokens: 70, cacheReadTokens: 15, cacheWriteTokens: 5 },
        outputTokens: 42,
        outputTokenDetails: { textTokens: 40, reasoningTokens: 2 },
        totalTokens: 132,
      }),
    ).not.toHaveProperty('reasoning');
    expect(
      usageFromSdk({
        inputTokens: 10,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokens: 3,
        outputTokenDetails: { textTokens: 3, reasoningTokens: undefined },
        totalTokens: 13,
      }),
    ).toEqual({ input: 10, output: 3, cacheRead: 0, cacheWrite: 0 });
  });

  test('pricing integration: known model → derived costUSD number; unknown model → absent', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const known = new AiSdkDriver({
        // The mock must serve the REQUESTED id: pricing keys on the OBSERVED
        // served model id now (issue #24), so a mock serving its default id
        // would be — correctly — unpriced for the requested model.
        providers: {
          anthropic: () => modelFor({ kind: 'reply', text: 'ok' }, 'claude-sonnet-4-5'),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const knownResult = await known.run(
        invocation({ modelSpec: { provider: 'anthropic', model: 'claude-sonnet-4-5' } }),
      );
      // usage {input:100, output:12, cacheRead:15, cacheWrite:5} at
      // 3 / 15 / 0.3 / 3.75 per-million = (300 + 180 + 4.5 + 18.75) / 1e6.
      expect(knownResult.costUSD).toBeDefined();
      expect(knownResult.costUSD).toBeCloseTo(0.00050325, 10);

      const unknown = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const unknownResult = await unknown.run(invocation());
      expect(unknownResult.costUSD).toBeUndefined(); // derived-only: never fabricated
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('structured output is decoupled from the tool loop: the final step asks for the answer (#203, #502)', async () => {
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        return offeredToolCount(options) > 0
          ? toolCallResult('read', { path: 'absent.txt' })
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const request = invocation({
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
        outputSchema: toOutputSchema(
          'test/multi-step/v1',
          z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
        ),
      });
      const result = await driver.run(request);
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      expect(result.steps).toBe(DEFAULT_MAX_STEPS); // omitted maxSteps preserves the default
      // With tools live every step the model answers tool-calls forever and
      // never emits the object; the final-step instruction turn is what makes the
      // structured output reachable — the model is called exactly to the cap.
      expect(calls).toBe(DEFAULT_MAX_STEPS);
      calls = 0;
      const clamped = await driver.run({
        ...request,
        budget: { maxSteps: DEFAULT_MAX_STEPS + 1 },
      });
      expect(clamped.steps).toBe(DEFAULT_MAX_STEPS);
      expect(calls).toBe(DEFAULT_MAX_STEPS); // a caller cannot raise the hard SDK ceiling
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a small maxSteps budget is honoured: the last step is invited to answer instead of calling tools', async () => {
    const toolCounts: number[] = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        const tools = offeredToolCount(options);
        toolCounts.push(tools);
        return tools > 0
          ? toolCallResult('read', { path: 'absent.txt' })
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-small-steps-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          budget: { maxSteps: 3 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/small-steps/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      expect(result.steps).toBe(3);
      expect(toolCounts.map((count) => count > 0)).toEqual([true, true, false]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the session request is fixed: the final step and the repair keep tools, toolChoice and system (#502)', async () => {
    const requests: { tools: number; choice: string | undefined; system: string; tail: string }[] =
      [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        const system = options.prompt.find((message) => message.role === 'system');
        const last = options.prompt.at(-1);
        requests.push({
          tools: options.tools?.length ?? 0,
          choice: options.toolChoice?.type,
          system: typeof system?.content === 'string' ? system.content : '',
          tail: last?.role === 'user' ? JSON.stringify(last.content) : String(last?.role),
        });
        if (offeredToolCount(options) > 0) return toolCallResult('read', { path: 'absent.txt' });
        // The final step's text misses the schema, so the repair call runs too.
        return requests.length === 3
          ? textResult('not a JSON object')
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-final-fixed-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          budget: { maxSteps: 3 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/final-fixed/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(requests).toHaveLength(4);
      // Every request, final step and repair included, has the same shape.
      for (const request of requests) {
        expect(request.tools).toBe(1);
        expect(request.choice).toBe('auto');
        expect(request.system).toBe(requests[0]?.system);
      }
      expect(requests[0]?.system).toContain('use the available tools');
      // Only the trailing instruction turn differs.
      expect(requests[2]?.tail).toContain('This is your final step');
      expect(requests[3]?.tail).toContain('did not satisfy the required JSON contract');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a tool call on the final step is denied, not executed (#502)', async () => {
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        // Ignores the final-step instruction and calls a tool anyway.
        if (calls <= 2) return toolCallResult('read', { path: 'absent.txt' });
        if (JSON.stringify(options.prompt).includes('This is your final step') && calls === 3) {
          return toolCallResult('read', { path: 'final.txt' });
        }
        return textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-final-deny-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          budget: { maxSteps: 3 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/final-deny/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      const finalDenials = result.denials.filter((denial) =>
        denial.reason.includes('disabled on the final step'),
      );
      expect(finalDenials).toEqual([
        {
          tool: 'read',
          reason: 'tool calls are disabled on the final step; reply with the answer',
        },
      ]);
      // The two earlier reads ran (and were denied as absent), the final one never executed.
      expect(result.denials.filter((denial) => denial.reason.includes('final.txt'))).toEqual([]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a tool call inside the repair is not executed and settles output-invalid (#502)', async () => {
    let calls = 0;
    const executed: string[] = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        // Main loop: prose instead of the object; repair: a tool call instead of the object.
        return calls === 1
          ? textResult('not a JSON object')
          : toolCallResult('read', { path: 'evidence.txt' });
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-repair-tool-'));
    try {
      await writeFile(join(scratchDir, 'evidence.txt'), 'must not be read by the repair');
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, _contents, context) => {
          if (context?.kind === 'tool-output') executed.push('tool-output');
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: scratchDir },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema('test/repair-tool/v1', z.object({ answer: z.string() })),
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(calls).toBe(2);
      expect(result.steps).toBe(2); // one main step, plus the one repair step
      expect(executed).toEqual([]); // the repair's tool call never ran
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the repair sends the same tool names as the main loop, aliases included (#502)', async () => {
    const toolNames: string[][] = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        toolNames.push((options.tools ?? []).map((t) => ('name' in t ? t.name : '')).sort());
        return toolNames.length === 1
          ? textResult('not a JSON object')
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-repair-alias-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          workspace: { path: scratchDir },
          toolPolicy: { allow: ['read', 'bash'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/repair-alias/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(toolNames).toHaveLength(2);
      expect(toolNames[0]).toContain('run');
      expect(toolNames[1]).toEqual(toolNames[0]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('maxSteps=1 makes the final step the first main step and counts the repair step separately', async () => {
    const toolCounts: number[] = [];
    const hookKinds: string[] = [];
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        toolCounts.push(offeredToolCount(options));
        return toolCounts.length === 1
          ? textResult('not a JSON object')
          : textResult('{"fixed":true,"notes":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-max-steps-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, _contents, context) => {
          hookKinds.push(context?.kind ?? 'missing');
        },
      });
      const result = await driver.run(
        invocation({
          budget: { maxSteps: 1 },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/max-steps/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.steps).toBe(2); // one main step, plus the one repair step
      expect(toolCounts).toHaveLength(2);
      expect(toolCounts[0]).toBe(0); // maxSteps=1 makes the first main step the final step
      expect(toolCounts[1]).toBe(0); // repair remains one step that executes no tools
      expect(hookKinds).toEqual(['model-request', 'model-request']);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('prompted-schema providers never send response_format: the schema rides the prompt and the reply text is validated (dogfood C, 2026-10-25)', async () => {
    const formats: unknown[] = [];
    const contracts: boolean[] = [];
    const promptCopies: number[] = [];
    const scans: string[] = [];
    let toolFree = 0;
    const gateway = new MockLanguageModelV4({
      modelId: 'deepseek-v4.1-flash',
      doGenerate: async (options) => {
        const promptText = JSON.stringify(options.prompt);
        formats.push(options.responseFormat);
        contracts.push(promptText.includes('Use the tools to complete the task first'));
        promptCopies.push(promptText.match(/driver-specific run/g)?.length ?? 0);
        if (offeredToolCount(options) > 0 && formats.length === 1) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        toolFree += 1;
        return toolFree === 1
          ? textResult('Done.\n```json\n{"fixed":"yes"}\n```')
          : textResult('```json\n{"fixed":true,"notes":"ok"}\n```');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-prompted-'));
    try {
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => gateway, mock: () => gateway },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (text) => {
          scans.push(text);
        },
      });
      const schema = toOutputSchema(
        'test/prompted/v1',
        z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
      );
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'opencode-go', model: 'deepseek-v4.1-flash' },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: schema,
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      // tool step, schema-invalid final text, one repair (same tools and system, #502)
      expect(formats).toHaveLength(3);
      expect(formats.every((format) => format === undefined)).toBe(true);
      expect(promptCopies).toEqual(formats.map(() => 1));
      const promptedArgs = lastGenerateTextArgs();
      expect(promptedArgs.system).toBe(
        'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.',
      );
      expect(promptedArgs.system).not.toContain('driver-specific run');
      expect(
        promptedArgs.messages?.filter(
          (message) => message.role === 'user' && message.content === 'driver-specific run',
        ),
      ).toHaveLength(1);
      expect(contracts).toEqual([true, true, false]); // the repair turn carries its own JSON contract
      expect(scans.some((text) => text.includes('Use the tools to complete the task first'))).toBe(
        true,
      );
      // CONTROL: a native-schema provider still sends the json response format.
      formats.length = 0;
      contracts.length = 0;
      promptCopies.length = 0;
      scans.length = 0;
      toolFree = 1;
      await driver.run(invocation({ outputSchema: schema }));
      expect(formats[0]).toMatchObject({ type: 'json' });
      expect(contracts.length).toBeGreaterThan(0);
      expect(contracts.every((present) => !present)).toBe(true);
      expect(promptCopies).toEqual(formats.map(() => 1));
      const nativeArgs = lastGenerateTextArgs();
      expect(nativeArgs.system).not.toContain('driver-specific run');
      expect(
        nativeArgs.messages?.filter(
          (message) => message.role === 'user' && message.content === 'driver-specific run',
        ),
      ).toHaveLength(1);
      expect(
        scans.every((text) => !text.includes('Use the tools to complete the task first')),
      ).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each([false, true])('main wording matches offered tools: %s (#483)', async (hasTools) => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-tool-wording-'));
    const schema = toOutputSchema('test/wording/v1', z.object({ answer: z.string() }));
    try {
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => modelFor({ kind: 'reply', text: '{"answer":"ok"}' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await driver.run(
        invocation({
          prompt: 'Review the supplied patch.',
          modelSpec: { provider: 'opencode-go', model: 'mock-1' },
          toolPolicy: hasTools
            ? { mode: 'allowlist', allow: ['read'] }
            : { mode: 'none', allow: [] },
          outputSchema: schema,
        }),
      );
      const args = lastGenerateTextArgs();
      const preamble = hasTools
        ? 'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.'
        : 'You are a cq-toolkit worker executing one task. You have no tools: everything you need is in the messages below. Answer directly.';
      expect(args.system).toBe(preamble);
      expect(args.system).not.toContain('Review the supplied patch.');
      expect(args.tools === undefined).toBe(!hasTools);
      const userPromptTurns = args.messages?.filter(
        (message) => message.role === 'user' && message.content === 'Review the supplied patch.',
      );
      expect(userPromptTurns).toHaveLength(1);
      const prefix = hasTools
        ? 'Use the tools to complete the task first. When you are done, reply with ONLY one JSON object — no prose, no code fences —'
        : 'Reply with ONLY one JSON object — no prose, no code fences, no tool calls —';
      expect(args.messages?.at(-1)?.content).toBe(
        `${prefix} that validates against this JSON Schema (draft 2020-12):\n${JSON.stringify(schema.schema)}`,
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each(['mock', 'opencode-go'])(
    'repair retains tool evidence exactly once: %s (#483)',
    async (provider) => {
      const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-evidence-'));
      await writeFile(join(scratchDir, 'evidence.txt'), 'observed evidence 483');
      let calls = 0;
      const mock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          calls += 1;
          if (calls === 1) return toolCallResult('read', { path: 'evidence.txt' });
          return textResult(
            calls === 2 ? 'I reviewed the evidence.' : '{"answer":"observed evidence 483"}',
          );
        },
      });
      try {
        const driver = new AiSdkDriver({
          providers: { [provider]: () => mock },
          sessionsDir: join(scratchDir, 'sessions'),
        });
        const result = await driver.run(
          invocation({
            modelSpec: { provider, model: 'mock-1' },
            workspace: { path: scratchDir },
            toolPolicy: { mode: 'allowlist', allow: ['read'] },
            outputSchema: toOutputSchema('test/evidence/v1', z.object({ answer: z.string() })),
          }),
        );
        expect(result.stopReason).toBe('complete');
        expect(calls).toBe(3);
        const args = lastGenerateTextArgs();
        // The repair keeps the session's definitions, without executors (#502).
        expect(Object.keys(args.tools ?? {})).toEqual(['read']);
        expect(
          (args.tools as Record<string, { execute?: unknown }> | undefined)?.read?.execute,
        ).toBeUndefined();
        expect(args.system).toBe(
          'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.',
        );
        expect(args.system).not.toContain('driver-specific run');
        const messages = args.messages ?? [];
        expect(
          messages.filter(
            (message) => message.role === 'user' && message.content === 'driver-specific run',
          ),
        ).toHaveLength(1);
        expect(messages.filter((message) => message.role === 'tool')).toHaveLength(1);
        const serialized = JSON.stringify(messages);
        expect(serialized.match(/conformance-call-1/g)).toHaveLength(2);
        expect(serialized.match(/I reviewed the evidence\./g)).toHaveLength(1);
        expect(serialized).toContain('observed evidence 483');
        expect(serialized).not.toContain('Use the tools to complete');
        expect(messages.at(-1)?.content).toContain('no tool calls');
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  test('read upload scanning uses normalized executor provenance for file_path', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-read-provenance-'));
    await writeFile(join(scratchDir, 'secret.ts'), 'api_key = "fixture-secret"\n', 'utf8');
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        if (calls === 1 && offeredToolCount(options) > 0) {
          return toolCallResult('read', { file_path: 'secret.ts', offset: 1, limit: 1 });
        }
        return textResult('read complete');
      },
    });
    const guarded: { text: string; path?: string }[] = [];
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, contents = []) => {
          guarded.push(...contents);
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: scratchDir },
          toolPolicy: { mode: 'allowlist', allow: ['read'] },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      const guardedSecret = guarded.find((content) => content.path === 'secret.ts');
      expect(guardedSecret).toBeDefined();
      expect(guardedSecret?.text).toContain('fixture-secret');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('grep upload scanning uses normalized executor provenance for matched files', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-grep-provenance-'));
    await writeFile(join(scratchDir, 'secret.ts'), 'api_key = "fixture-secret"\n', 'utf8');
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        if (calls === 1 && offeredToolCount(options) > 0) {
          return toolCallResult('grep', { pattern: 'fixture-secret' });
        }
        return textResult('search complete');
      },
    });
    const guarded: { text: string; path?: string }[] = [];
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        // The provenance test needs grep SERVED: inject an ok rg (the host's
        // rg may be older than the documented minimum).
        resolveRg: async () => ({ ok: true, version: '15.2.0' }),
        beforeRequest: async (_text, contents = []) => {
          guarded.push(...contents);
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: scratchDir },
          toolPolicy: { mode: 'allowlist', allow: ['grep'] },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      const guardedSecret = guarded.find((content) => content.path === 'secret.ts');
      expect(guardedSecret).toBeDefined();
      expect(guardedSecret?.text).toContain('fixture-secret');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('forced final step keeps the request and adds the final-step turn (#468, #502)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-final-contract-'));
    const hookKinds: string[] = [];
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        const text = JSON.stringify(options.prompt);
        expect(text.match(/driver-specific run/g)).toHaveLength(1);
        if (offeredToolCount(options) > 0) {
          expect(text).toContain('Use the tools to complete the task first');
          return toolCallResult('read', { path: 'evidence.txt' });
        }
        expect(options.tools?.length).toBe(1);
        expect(text).not.toContain('You have no tools:');
        expect(text).toContain('Use the tools to complete the task first');
        expect(text.match(/This is your final step: do not call any more tools/g)).toHaveLength(1);
        expect(text).toContain('validates against this JSON Schema');
        return textResult('{"answer":"ok"}');
      },
    });
    try {
      await writeFile(join(scratchDir, 'evidence.txt'), 'safe tool output');
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        beforeRequest: async (_text, _contents, context) => {
          hookKinds.push(context?.kind ?? 'missing');
        },
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'opencode-go', model: 'mock-1' },
          workspace: { path: scratchDir },
          toolPolicy: { mode: 'allowlist', allow: ['read'] },
          outputSchema: toOutputSchema('test/final/v1', z.object({ answer: z.string() })),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(calls).toBe(DEFAULT_MAX_STEPS);
      expect(hookKinds.filter((kind) => kind === 'model-request')).toHaveLength(DEFAULT_MAX_STEPS);
      expect(hookKinds).toContain('tool-output');
      expect(hookKinds.at(-1)).toBe('model-request');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each(['<｜DSML｜ calls>', '<|DSML| calls>', '<tool_call>', '<function_call>'])(
    'markup parse failure has a precise diagnostic: %s',
    (markup) =>
      expect(() => parseReplyJson(`${markup}not JSON`)).toThrow(
        'model emitted tool-call markup instead of the JSON reply',
      ),
  );

  test.each(['<｜DSML｜ calls>', '<|DSML| calls>', '<tool_call>', '<function_call>'])(
    'markup-wrapped schema-shaped JSON is rejected: %s',
    (markup) =>
      expect(() => parseReplyJson(`${markup}{"answer":"ok"}</tool_call>`)).toThrow(
        'model emitted tool-call markup instead of the JSON reply',
      ),
  );

  test('literal markup inside a JSON value remains ordinary data', () => {
    const value = { answer: '<tool_call>' };
    for (const text of [
      JSON.stringify(value),
      `\`\`\`json\n${JSON.stringify(value)}\n\`\`\``,
      `Answer: ${JSON.stringify(value)}`,
    ]) {
      expect(parseReplyJson(text)).toEqual(value);
    }
  });

  test('markup parse failure is repaired once and survives a failed repair (#483)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-markup-'));
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        return textResult('<｜DSML｜ calls>not JSON');
      },
    });
    try {
      const driver = new AiSdkDriver({
        providers: { 'opencode-go': () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          modelSpec: { provider: 'opencode-go', model: 'mock-1' },
          toolPolicy: { mode: 'none', allow: [] },
          outputSchema: toOutputSchema('test/markup/v1', z.object({ answer: z.string() })),
        }),
      );
      expect(calls).toBe(2);
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('model emitted tool-call markup instead of the JSON reply');
      expect(lastGenerateTextArgs().system).toBe(generateTextArgsFromEnd(1).system);
      expect(JSON.stringify(lastGenerateTextArgs())).not.toContain('Use the tools to complete');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('parseReplyJson accepts bare, fenced and embedded objects and refuses prose', () => {
    expect(parseReplyJson('{"a":1}')).toEqual({ a: 1 });
    expect(parseReplyJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseReplyJson('Result: {"a":{"b":2}} done')).toEqual({ a: { b: 2 } });
    expect(() => parseReplyJson('no json here')).toThrow();
  });

  test('a missing structured object is repaired ONCE, then settles error/output-invalid (#203, W3.4)', async () => {
    let calls = 0;
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        // The repair is TOOL-FREE: the mock answers it with another tool
        // call, so the repair's own parse misses too — the give-up path.
        if (offeredToolCount(options) > 0) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        return textResult('still not an object');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => alwaysToolCalls },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/repair-once/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      // ONE bounded repair attempt after the miss: DEFAULT_MAX_STEPS
      // tool-loop steps + the single repair step.
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
      expect(result.stopReason).toBe('error');
      // ADR-0002 §2.3: the uniform miss verdict — output-invalid, rejection
      // recorded in the bounded error text (both the miss and the repair).
      expect(result.errorClass).toBe('output-invalid');
      expect(result.steps).toBe(DEFAULT_MAX_STEPS + 1); // includes the failed repair step
      expect(
        result.error?.startsWith(
          'ai-sdk driver: structured output invalid after the repair attempt',
        ),
      ).toBe(true);
      expect(result.error).toContain('repair');
      // never a model score: no fabricated structuredOutput on an error verdict.
      expect(result.structuredOutput).toBeUndefined();
      // The usage covers BOTH calls: DEFAULT_MAX_STEPS tool-loop steps +
      // 1 repair step, each folding {100 in, 12 out, 15 cacheRead, 5 cacheWrite}.
      expect(result.usage).toEqual({
        input: 100 * (DEFAULT_MAX_STEPS + 1),
        output: 12 * (DEFAULT_MAX_STEPS + 1),
        cacheRead: 15 * (DEFAULT_MAX_STEPS + 1),
        cacheWrite: 5 * (DEFAULT_MAX_STEPS + 1),
      });
      expect(result.costUSD).toBeUndefined(); // never fabricated on a non-complete run
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a SUCCESSFUL repair is still judged by the token cap: the accumulated fold trips budget (cycle-2)', async () => {
    let calls = 0;
    let toolFreeCalls = 0;
    const repairSucceeds = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        // Main loop tool-calls. The lane's FINAL LOOP STEP (and
        // then the REPAIR) is distinguished by counting: the
        // FIRST tool-free call must ALSO miss (else the loop's final step
        // completes the run and no repair fires); the SECOND — the repair —
        // answers with the valid object.
        if (offeredToolCount(options) > 0) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        toolFreeCalls += 1;
        return toolFreeCalls === 1
          ? textResult('prose with no json at all')
          : textResult('{\"fixed\":true,\"notes\":\"ok\"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => repairSucceeds },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const schema = toOutputSchema(
        'test/repair-budget/v1',
        z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
      );
      // DEFAULT_MAX_STEPS main steps end on the step cap (each 132 total
      // tokens incl. cache, under the cap — the loop ends on max-steps, so
      // the REPAIR fires), then the repair pushes the accumulated fold one
      // step past the cap: the repair's success is an honest 'budget'
      // verdict — the payload does not ride it, the spend evidence does.
      const budgeted = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 132 * DEFAULT_MAX_STEPS + 66 },
          outputSchema: schema,
        }),
      );
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
      expect(budgeted.stopReason).toBe('budget');
      expect(budgeted.structuredOutput).toBeUndefined();
      expect(budgeted.errorClass).toBeUndefined(); // a cap is not a failure
      expect(budgeted.usage).toEqual({
        input: 100 * (DEFAULT_MAX_STEPS + 1),
        output: 12 * (DEFAULT_MAX_STEPS + 1),
        cacheRead: 15 * (DEFAULT_MAX_STEPS + 1),
        cacheWrite: 5 * (DEFAULT_MAX_STEPS + 1),
      });
      // CONTROL: the same successful repair under a cap it never reaches →
      // complete WITH the payload. toolFreeCalls resets too — the control
      // must follow the SAME invalid-final-step path (miss → repair →
      // object), not complete on the loop's final step.
      calls = 0;
      toolFreeCalls = 0;
      const free = new AiSdkDriver({
        providers: { mock: () => repairSucceeds },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const completed = await free.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 132 * (DEFAULT_MAX_STEPS + 1) * 4 },
          outputSchema: schema,
        }),
      );
      expect(completed.stopReason).toBe('complete');
      expect(completed.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      // The repair really fired: DEFAULT_MAX_STEPS loop steps + 1 repair step.
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a repair with an UNOBSERVED model id fails closed; its fresher limit headers win (PR #238 review round 2)', async () => {
    let calls = 0;
    let toolFreeCalls = 0;
    const repairShadow = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        if (offeredToolCount(options) > 0) {
          return toolCallResult('read', { path: 'absent.txt' });
        }
        toolFreeCalls += 1;
        if (toolFreeCalls === 1) return textResult('prose with no json at all');
        // The REPAIR: a valid object, but the provider metadata reports an
        // EMPTY model id (unobserved) and a FRESH retry-after header — the
        // second request consumed capacity after the first.
        return {
          ...textResult('{\"fixed\":true,\"notes\":\"ok\"}'),
          response: { modelId: '', headers: { 'retry-after': '99' } },
        };
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => repairShadow },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/repair-shadow/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      // The main call observed 'mock-1'; the payload's producer reported NO
      // id — the intra-run guard fails closed exactly like the wrapper's
      // default requireObserved would.
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('served-model-mismatch');
      expect(result.error).toContain('reported no model id');
      // Spend evidence kept; the mixed-identity fold is unpriced.
      expect(result.structuredOutput).toBeUndefined();
      expect(result.usage.input).toBeGreaterThan(0);
      // The REPAIR's fresher limit header, not the main response's absence.
      expect(result.providerSignals).toEqual({ retryAfterMs: 99_000 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('repair identity judgment: repair-only observation is REPORTED for the wrapper; a mixed identity is unpriced on every repair path (PR #238 round 3)', async () => {
    const schema = z.object({ fixed: z.boolean(), notes: z.string() }).strict();
    // 1. REPAIR-ONLY: the main call never observes an id (empty provider
    //    metadata on every main step); the repair reports 'repair-served-1'.
    //    The verdict reports the repair's id — the outer wrapper's default
    //    requireObserved then judges THAT id (here: a bare lane, so the
    //    propagation itself is the assertion).
    let toolFree1 = 0;
    const d1 = new AiSdkDriver({
      providers: {
        mock: () =>
          new MockLanguageModelV4({
            modelId: 'mock-1',
            doGenerate: async (options: { tools?: unknown[] }) => {
              if (offeredToolCount(options) > 0) {
                return {
                  ...toolCallResult('read', { path: 'absent.txt' }),
                  response: { modelId: '' },
                };
              }
              toolFree1 += 1;
              if (toolFree1 === 1) {
                return { ...textResult('prose, no json'), response: { modelId: '' } };
              }
              return {
                ...textResult('{\"fixed\":true,\"notes\":\"ok\"}'),
                response: { modelId: 'repair-served-1' },
              };
            },
          }),
      },
      sessionsDir: join(mkdtempSync(join(tmpdir(), 'aidrv-id1-')), 'sessions'),
    });
    const r1 = await d1.run(
      invocation({
        outputSchema: toOutputSchema('test/identity-1/v1', schema),
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
      }),
    );
    expect(r1.stopReason).toBe('complete');
    expect(r1.model).toBe('repair-served-1'); // the payload's producer, for the wrapper to judge
    expect(r1.structuredOutput).toEqual({ fixed: true, notes: 'ok' });

    // 2. MIXED on the INVALID-repair path: the main observed 'mock-1', the
    //    repair reports 'other-id' and its object misses: the output-invalid
    //    verdict keeps the usage but the PRICED fold is suppressed — pricing
    //    under the main id would attribute the repair's tokens to it.
    let toolFree2 = 0;
    const priced = new AiSdkDriver({
      providers: {
        mock: () =>
          new MockLanguageModelV4({
            modelId: 'mock-1',
            doGenerate: async (options: { tools?: unknown[] }) => {
              if (offeredToolCount(options) > 0) {
                return toolCallResult('read', { path: 'absent.txt' });
              }
              toolFree2 += 1;
              if (toolFree2 === 1) return textResult('prose, no json');
              return { ...textResult('still no object'), response: { modelId: 'other-id' } };
            },
          }),
      },
      pricing: () => ({ input: 3, output: 15 }),
      sessionsDir: join(mkdtempSync(join(tmpdir(), 'aidrv-id2-')), 'sessions'),
    });
    const r2 = await priced.run(
      invocation({
        outputSchema: toOutputSchema('test/identity-2/v1', schema),
        toolPolicy: { allow: ['read'], mode: 'allowlist' },
      }),
    );
    expect(r2.stopReason).toBe('error');
    expect(r2.errorClass).toBe('output-invalid');
    expect(r2.model).toBe('mock-1'); // the main observation, as evidence
    expect(r2.usage.input).toBeGreaterThan(0);
    expect(r2.costUSD).toBeUndefined(); // a mixed-identity fold is NEVER priced
  });

  test('a token cap that leaves the final step on tool-calls reports budget, not error (#203)', async () => {
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => toolCallResult('read', { path: 'absent.txt' }),
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => alwaysToolCalls },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      // Per-step usage folds 132 tokens, so the 200 cap trips after step 2 and
      // the final step stays on tool-calls — the missing object is the cap's
      // consequence, not a driver failure.
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 200 },
          outputSchema: toOutputSchema(
            'test/token-cap/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('budget');
      expect(result.error).toBeUndefined();
      // The carve-out is NOT a failure verdict: no errorClass rides it
      // (the one-directional producer rule — classes only on 'error').
      expect(result.errorClass).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a priced structured-output miss derives cost from the full result usage (#203)', async () => {
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => toolCallResult('read', { path: 'absent.txt' }),
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => alwaysToolCalls },
        sessionsDir: join(scratchDir, 'sessions'),
        pricing: () => ({ input: 3, output: 15 }),
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/priced-miss/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(typeof result.costUSD).toBe('number');
      expect(result.costBasis).toBe('modeled');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// #210 — one retry per step request + per-request step timeout +
// machine-classifiable failure classes (`WorkerResult.error` tokens)
// ---------------------------------------------------------------------------

describe('ai-sdk driver failure classes (#210)', () => {
  test('the SDK call runs one retry per step request and a per-request step timeout', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await driver.run(invocation());
      const args = lastGenerateTextArgs();
      // ONE retry per step request for the SDK-retryable transient class —
      // the exhausted-retry error still names the attempt count and last
      // error (and the bound is per step, so ≤ DEFAULT_MAX_STEPS per run).
      expect(args.maxRetries).toBe(1);
      // Per-request bound for EACH step of the tool loop.
      expect(args.timeout).toEqual({ stepMs: DEFAULT_STEP_TIMEOUT_MS });
      expect(DEFAULT_STEP_TIMEOUT_MS).toBeGreaterThanOrEqual(600_000);
      // The bound is configurable per driver and validated.
      const tuned = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        stepTimeoutMs: 900_000,
      });
      await tuned.run(invocation());
      expect(lastGenerateTextArgs().timeout).toEqual({ stepMs: 900_000 });
      expect(() => new AiSdkDriver({ stepTimeoutMs: 0 })).toThrow(/stepTimeoutMs/);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an SDK-retryable endpoint failure is classified transient with providerSignals from the error headers', async () => {
    const transient = new APICallError({
      message: 'Cannot connect to API: Headers Timeout Error',
      url: 'https://example.test',
      requestBodyValues: {},
      isRetryable: true,
    });
    const timeoutModel = new MockLanguageModelV4({
      modelId: 'mock-1',
      // The exact transient class #210 observed (glm-5.3-flash 3/5): the
      // SDK-retryable class. After maxRetries: 1 is exhausted the SDK
      // rethrows a RetryError naming the attempts; the classifier digs the
      // wrapped APICallError out of the chain — a STRUCTURED signal.
      doGenerate: async () => {
        throw transient;
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => timeoutModel },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // ADR-0002 §2.2: errorClass on every error verdict; the error text is
      // bounded human diagnostics (the [token] prefix contract is retired).
      expect(result.errorClass).toBe('transient');
      expect(result.error?.startsWith('ai-sdk driver: run failed —')).toBe(true);
      expect(result.error).toContain('Cannot connect to API: Headers Timeout Error');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.providerSignals).toBeUndefined(); // no headers on this error
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an UNSTRUCTURED endpoint failure classifies unknown — never a guessed transient', async () => {
    const timeoutModel = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        throw new Error('Cannot connect to API: Headers Timeout Error');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => timeoutModel },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // A plain Error carries no status, no provider code, no SDK class:
      // the structured-only rule leaves it 'unknown' (ADR §2.2 — anything
      // unresolved is unknown, never guessed into 'transient').
      expect(result.errorClass).toBe('unknown');
      expect(result.error?.startsWith('ai-sdk driver: run failed —')).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a RETRYABLE endpoint timeout is retried once, then classified transient (#210)', async () => {
    // The SDK's own retry machinery classifies this APICallError retryable:
    // attempt 1 fails, the SDK backs off, attempt 2 fails, and the exhausted
    // retry throws a RetryError naming the attempt count and the last error.
    const retryable = new APICallError({
      message: 'Cannot connect to API: Headers Timeout Error',
      url: 'https://example.test',
      requestBodyValues: {},
      isRetryable: true,
    });
    let calls = 0;
    const retryableModel = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        throw retryable;
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => retryableModel },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(calls).toBe(2); // maxRetries: 1 really retried the transient class
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('transient');
      expect(result.error).toContain('Failed after 2 attempts');
      expect(result.error).toContain('Headers Timeout Error');
      expect(result.structuredOutput).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  }, 15_000);

  test('a governed abort that leaves the final step on tool-calls settles aborted, not a miss (#210)', async () => {
    // Deterministic governed-context mechanics: an injected clock CAPTURES the
    // ladder's rung-1 callback WITHOUT arming a real timer, so the mock model
    // fires the abort synchronously on its single step. The token cap then ends
    // the loop on that tool-call step (no next iteration re-checks the signal),
    // generateText resolves, result.output throws, and stopReasonOf sees
    // `aborted` FIRST — the INNER miss catch's carve-out, not the outer catch
    // (which the conformance abort test already covers).
    let fireGovernedSignal: (() => void) | undefined;
    const manualClock: Clock = {
      now: () => 0,
      setTimeout: (fn) => {
        fireGovernedSignal ??= fn; // rung 1 only; rungs 2/3 never arm
        return 0;
      },
      clearTimeout: () => {},
    };
    const toolCallThenAbort = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        fireGovernedSignal?.();
        return toolCallResult('read', { path: 'absent.txt' });
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => toolCallThenAbort },
        sessionsDir: join(scratchDir, 'sessions'),
        // A priced model DISCRIMINATES the inner carve-out (full-result usage +
        // derived cost) from the outer catch (partial fold, never fabricated
        // cost) — so the test proves the branch, not just the verdict.
        pricing: () => ({ input: 3, output: 15 }),
      });
      const outcome = await runLadder(
        async (ctx) =>
          driver.run(
            invocation({
              toolPolicy: { allow: ['read'], mode: 'allowlist' },
              budget: { maxTokens: 1 },
              outputSchema: toOutputSchema(
                'test/abort-priced/v1',
                z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
              ),
            }),
            { signal: ctx.signal },
          ),
        { wallClockMs: 1_000 },
        { op: 'ai-sdk-failure-class', jobKey: 'ai-sdk-failure-class', attempt: 1 },
        { clock: manualClock },
      );
      expect(outcome.outcome).toBe('completed');
      if (outcome.outcome !== 'completed') return; // narrow for TS
      expect(fireGovernedSignal).toBeDefined(); // the rung really was captured
      expect(outcome.value.stopReason).toBe('aborted');
      expect(outcome.value.steps).toBe(1); // the completed tool-call step is retained on abort
      expect(outcome.value.error).toBeUndefined();
      expect(outcome.value.structuredOutput).toBeUndefined();
      // The inner carve-out priced the FULL result usage — the outer catch
      // would have no costUSD (and no served model).
      expect(typeof outcome.value.costUSD).toBe('number');
      expect(outcome.value.costBasis).toBe('modeled');
      expect(outcome.value.model).toBe('mock-1');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an unstructured scripted failure classifies unknown (no structured signal — never guessed)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      // An inline PLAIN Error (the conformance mock's fail now scripts the
      // vendor quota shape — this row pins the UNCLASSIFIED path): a plain
      // Error has no status/code/class, so the verdict stays 'unknown'.
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                throw new Error('scripted model failure');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      // PRODUCER RULE: the error verdict carries a class — an honest
      // 'unknown' (a plain scripted Error has no status/code/class).
      expect(result.errorClass).toBe('unknown');
      expect(result.error?.startsWith('ai-sdk driver: run failed —')).toBe(true);
      expect(result.error).toContain('scripted model failure');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a resolved run ending on finishReason error/content-filter carries a class too', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: finishResult('error'),
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('unknown'); // no structured cause — never guessed
      expect(result.error).toContain("finishReason 'error'");

      // A content filter is a provider-reported permanent refusal.
      const filtered = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: finishResult('content-filter'),
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const filteredResult = await filtered.run(invocation());
      expect(filteredResult.stopReason).toBe('error');
      expect(filteredResult.errorClass).toBe('provider-error');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  /** An APICallError fixture with only the structured fields a case needs. */
  function apiError(opts: {
    statusCode?: number;
    url?: string;
    headers?: Record<string, string>;
    data?: unknown;
    responseBody?: string;
    isRetryable?: boolean;
    message?: string;
  }): APICallError {
    return new APICallError({
      message: opts.message ?? 'provider error',
      url: opts.url ?? 'https://provider.test/v1/messages',
      requestBodyValues: {},
      ...(opts.statusCode !== undefined ? { statusCode: opts.statusCode } : {}),
      ...(opts.headers !== undefined ? { responseHeaders: opts.headers } : {}),
      ...(opts.data !== undefined ? { data: opts.data } : {}),
      ...(opts.responseBody !== undefined ? { responseBody: opts.responseBody } : {}),
      isRetryable: opts.isRetryable ?? false,
    });
  }

  test('classifyRunFailure: the ADR §2.2 limit cuts, structured signals only', () => {
    // ---- cut 3: 401/403 → auth.
    expect(classifyRunFailure(apiError({ statusCode: 401 }))).toBe('auth');
    expect(classifyRunFailure(apiError({ statusCode: 403 }))).toBe('auth');

    // ---- cut 2: funded-allowance codes are quota WHATEVER the status —
    // even on a 429 that also carries a retry-after (code outranks).
    expect(
      classifyRunFailure(
        apiError({
          statusCode: 429,
          data: { error: { code: 'insufficient_quota' } },
          headers: { 'retry-after': '10' },
        }),
      ),
    ).toBe('quota');
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, data: { error: { code: 'credit_balance_exhausted' } } }),
      ),
    ).toBe('quota');
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, data: { code: 'enforced_spend_limit_reached' } }),
      ),
    ).toBe('quota');
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, data: { error: { code: 'deepseek_spend_limit_exceeded' } } }),
      ),
    ).toBe('quota');
    // The code also wins when it only rides the JSON response body.
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, responseBody: '{"error":{"code":"insufficient_quota"}}' }),
      ),
    ).toBe('quota');
    // HTTP 402 → quota (DeepSeek / OpenCode Zen funded balance).
    expect(classifyRunFailure(apiError({ statusCode: 402 }))).toBe('quota');
    // The Z.AI coding wire's 429 is the plan-funded quota wall (URL signal).
    expect(
      classifyRunFailure(
        apiError({ statusCode: 429, url: 'https://api.z.ai/api/coding/paas/v4/chat/completions' }),
      ),
    ).toBe('quota');

    // ---- cut 4: the 429 discrimination — quota vs rate-limit.
    // Another 429 WITH retry-after → rate-limit.
    expect(
      classifyRunFailure(apiError({ statusCode: 429, headers: { 'Retry-After': '3741' } })),
    ).toBe('rate-limit');
    // A 429 whose retry-after exists ELSEWHERE in the wrapped chain.
    const inner429 = apiError({ statusCode: 429, headers: { 'retry-after': '5' } });
    const retryWrapper = Object.assign(new Error('Failed after 2 attempts. Last error: 429'), {
      cause: inner429,
    });
    expect(classifyRunFailure(retryWrapper)).toBe('rate-limit');
    // A bare 429 with NO retry-after anywhere and no funded code: not a
    // throttle claim — 'provider-error'.
    expect(classifyRunFailure(apiError({ statusCode: 429 }))).toBe('provider-error');

    // ---- cut 5: 408/5xx → transient.
    expect(classifyRunFailure(apiError({ statusCode: 408 }))).toBe('transient');
    expect(classifyRunFailure(apiError({ statusCode: 500 }))).toBe('transient');
    expect(classifyRunFailure(apiError({ statusCode: 503 }))).toBe('transient');
    expect(classifyRunFailure(apiError({ statusCode: 529 }))).toBe('transient');

    // ---- cut 6: SDK class signals without a status.
    // The SDK's retryable class (network / endpoint header timeout).
    expect(classifyRunFailure(apiError({ isRetryable: true }))).toBe('transient');
    // The step-timeout DOMException.
    expect(
      classifyRunFailure(
        Object.assign(new Error('Step timeout of 120000ms exceeded'), { name: 'TimeoutError' }),
      ),
    ).toBe('transient');

    // ---- permanent provider failures.
    expect(classifyRunFailure(apiError({ statusCode: 400 }))).toBe('provider-error');
    expect(classifyRunFailure(apiError({ statusCode: 404 }))).toBe('provider-error');
    expect(classifyRunFailure(apiError({}))).toBe('provider-error');

    // ---- anything unresolved → 'unknown', NEVER a guessed 'transient'.
    // (The old unanchored \b(408|409|429|5\d\d)\b message regex is deleted:
    // a status number embedded in prose is not a status code.)
    expect(classifyRunFailure(new Error('request failed with 429 somewhere'))).toBe('unknown');
    expect(classifyRunFailure(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('unknown');
    expect(classifyRunFailure(new Error('read ECONNRESET'))).toBe('unknown');
    expect(classifyRunFailure(new Error('socket hang up'))).toBe('unknown');
    expect(classifyRunFailure(new Error('fetch failed'))).toBe('unknown');
    expect(classifyRunFailure(new Error('Step timeout of 120000ms exceeded'))).toBe('unknown');
    expect(classifyRunFailure(new Error('op prompt is over budget'))).toBe('unknown');
    expect(classifyRunFailure('a plain string failure')).toBe('unknown');
    // A bare abort never reaches this classifier (the catch short-circuits
    // to 'aborted'), so it stays unresolved here — 'unknown'.
    expect(classifyRunFailure(new Error('Request was aborted'))).toBe('unknown');
  });

  test('providerSignalsFromHeaders maps the recognized limit-header families, only what is present', () => {
    // The claude unified plan windows: percent-REMAINING → used fraction.
    const unified = providerSignalsFromHeaders({
      'anthropic-ratelimit-unified-5h-percent-remaining': '12.5',
      'anthropic-ratelimit-unified-5h-reset': '2026-09-28T12:00:00Z',
      'anthropic-ratelimit-unified-7d-percent-remaining': '80',
    });
    expect(unified?.windows).toHaveLength(2);
    const fiveHour = unified?.windows?.find((w) => w.id === '5h');
    expect(fiveHour?.utilization).toBeCloseTo(0.875, 12);
    expect(fiveHour?.resetAt).toBe('2026-09-28T12:00:00.000Z');
    const sevenDay = unified?.windows?.find((w) => w.id === '7d');
    expect(sevenDay?.utilization).toBeCloseTo(0.2, 12);
    expect(sevenDay?.resetAt).toBeUndefined();
    // The per-minute API family: remaining/limit counts → utilization.
    const perMinute = providerSignalsFromHeaders({
      'x-ratelimit-limit-requests': '100',
      'x-ratelimit-remaining-requests': '45',
      'x-ratelimit-reset-requests': '6m0s',
      'x-ratelimit-limit-tokens': '10000',
      'x-ratelimit-remaining-tokens': '9000',
      'x-ratelimit-reset-tokens': '1s',
    });
    const perMinuteWindows = perMinute?.windows ?? [];
    expect(perMinuteWindows).toHaveLength(2);
    const requestsWindow = perMinuteWindows.find((w) => w.id === 'requests');
    expect(requestsWindow?.utilization).toBeCloseTo(0.55, 12);
    expect(requestsWindow?.remaining).toEqual({ requests: 45 });
    expect(requestsWindow?.resetAt).toBeDefined(); // derived from the 6m0s duration
    expect(typeof requestsWindow?.resetAt).toBe('string');
    const tokensWindow = perMinuteWindows.find((w) => w.id === 'tokens');
    expect(tokensWindow?.utilization).toBeCloseTo(0.1, 12);
    expect(tokensWindow?.remaining).toEqual({ tokens: 9000 });
    // retry-after (delay-seconds form) joins the windows.
    const withRetry = providerSignalsFromHeaders({
      'retry-after': '3741',
      'x-ratelimit-remaining-tokens': '1',
    });
    expect(withRetry?.retryAfterMs).toBe(3_741_000);
    // A remaining COUNT is a nonnegative integer: malformed header values
    // are dropped, never recorded as fabricated quota evidence (PR #238
    // review round 2 — the mirror now rejects fractional/negative counts).
    const malformed = providerSignalsFromHeaders({
      'x-ratelimit-remaining-requests': '45.5',
      'x-ratelimit-remaining-tokens': '-3',
    });
    expect(malformed?.windows).toBeUndefined();
    const zeroCount = providerSignalsFromHeaders({ 'x-ratelimit-remaining-requests': '0' });
    expect(zeroCount?.windows?.[0]?.remaining).toEqual({ requests: 0 });
    // Case-insensitive header names.
    expect(providerSignalsFromHeaders({ 'RETRY-AFTER': '2' })?.retryAfterMs).toBe(2000);
    // HTTP-date form parses against the current clock.
    const httpDate = providerSignalsFromHeaders({
      'retry-after': new Date(Date.now() + 60_000).toUTCString(),
    });
    expect(httpDate?.retryAfterMs).toBeGreaterThan(0);
    expect(httpDate?.retryAfterMs).toBeLessThanOrEqual(60_000);
    // Nothing recognized → absent; never invented.
    expect(providerSignalsFromHeaders({ 'x-request-id': 'abc' })).toBeUndefined();
    expect(providerSignalsFromHeaders(undefined)).toBeUndefined();
    // An ambiguous bare-digit reset value is NOT guessed into a resetAt.
    const ambiguous = providerSignalsFromHeaders({
      'anthropic-ratelimit-unified-5h-reset': '3741',
    });
    expect(ambiguous?.windows?.[0]?.resetAt).toBeUndefined();
  });

  test('providerSignalsFromError digs the APICallError headers out of a wrapped chain', () => {
    const inner = new APICallError({
      message: 'Too Many Requests',
      url: 'https://provider.test/v1/messages',
      requestBodyValues: {},
      statusCode: 429,
      responseHeaders: {
        'retry-after': '30',
        'anthropic-ratelimit-unified-5h-percent-remaining': '0',
        'anthropic-ratelimit-unified-5h-reset': '2026-09-28T12:00:00Z',
      },
    });
    const wrapped = Object.assign(new Error('Failed after 2 attempts. Last error: 429'), {
      cause: inner,
    });
    expect(providerSignalsFromError(wrapped)).toEqual({
      retryAfterMs: 30_000,
      windows: [{ id: '5h', utilization: 1, resetAt: '2026-09-28T12:00:00.000Z' }],
    });
    expect(providerSignalsFromError(new Error('no structure'))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// RD-B review debt (#18/#24) — usage evidence on failure, budget folds,
// config isolation, the always-on tool loop, resume dedupe, served-id pricing
// ---------------------------------------------------------------------------

describe('ai-sdk driver review fixes (#18/#24)', () => {
  test('a mid-run failure keeps the COMPLETED steps usage — not zeros (#18-1)', async () => {
    // Step 1 completes (tool call); step 2's model call throws. The
    // always-on stopWhen follows the tool call up into step 2 — exactly the
    // multi-step shape whose usage the old zeroUsage return discarded.
    let calls = 0;
    const stepThenFail = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) return toolCallResult('read', { path: 'absent-step-one.txt' });
        throw new Error('scripted step-two failure');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => stepThenFail },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation({ prompt: 'fails on step two' }));
      expect(calls).toBe(2); // step 1 completed, step 2 threw
      expect(result.stopReason).toBe('error');
      expect(result.error).toContain('scripted step-two failure');
      // step 1's usage (folded through onStepFinish → usageFromSdk), NOT zeros.
      // reasoning is absent by design (merge-queue 11ea275): it is a subset of
      // outputTokens, so the frozen field stays unset on this lane.
      expect(result.usage).toEqual({ input: 100, output: 12, cacheRead: 15, cacheWrite: 5 });
      expect(result.steps).toBe(1); // the completed first step is counted before the next request fails
      // cost stays UNFABRICATED on the error path — no figure, no basis
      expect(result.costUSD).toBeUndefined();
      expect(result.costBasis).toBeUndefined();
      // the step-1 tool call really ran (its denial is the evidence)
      expect(result.denials.some((d) => d.tool === 'read')).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('the token cap folds reasoning ONCE, via output: cap 35 trips, cap 40 does not (#18-2)', async () => {
    // mapped Usage {input:10, output:20, cacheRead:5, cacheWrite:0, reasoning:8}
    // → fold 35 (10+20+5+0). The old fold added reasoning ON TOP (43).
    const reasoningUsage: LanguageModelV4GenerateResult['usage'] = {
      inputTokens: { total: 15, noCache: 10, cacheRead: 5, cacheWrite: 0 },
      outputTokens: { total: 20, text: 12, reasoning: 8 },
    };
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => usageModel(reasoningUsage) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      // AT the cap: the fold (35) >= 35 trips exactly.
      expect((await driver.run(invocation({ budget: { maxTokens: 35 } }))).stopReason).toBe(
        'budget',
      );
      // Headroom: 35 < 40 — the old 43-fold would have tripped here too.
      expect((await driver.run(invocation({ budget: { maxTokens: 40 } }))).stopReason).toBe(
        'complete',
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('provider cancellation outranks an oversized prompt without creating a session', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-abort-prompt-'));
    const controller = new AbortController();
    let calls = 0;
    try {
      const driver = new AiSdkDriver({
        providers: {
          mock: () => {
            controller.abort();
            return new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                calls += 1;
                return textResult('must never run');
              },
            });
          },
        },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: {
          ...defaultHarnessConfig,
          promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 50 },
        },
      });
      const result = await driver.run(invocation({ prompt: 'p'.repeat(51) }), {
        signal: controller.signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.sessionId).toBeUndefined();
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(calls).toBe(0);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('prompt budget applies to the user turn and leaves the system preamble intact (#18-3)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const prompt = 'p'.repeat(50); // prompt.length === maxSystemPromptChars
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: {
          ...defaultHarnessConfig,
          promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 50 },
        },
      });
      await driver.run(invocation({ prompt, toolPolicy: { mode: 'none', allow: [] } }));
      const args = lastGenerateTextArgs();
      expect(args.system).toBe(
        'You are a cq-toolkit worker executing one task. You have no tools: everything you need is in the messages below. Answer directly.',
      );
      expect(
        args.messages?.filter((message) => message.role === 'user' && message.content === prompt),
      ).toHaveLength(1);
      await expect(
        driver.run(invocation({ prompt: 'p'.repeat(51), toolPolicy: { mode: 'none', allow: [] } })),
      ).rejects.toThrow(/51 chars, over the harness prompt budget of 50/);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('defaultHarnessConfig is deeply frozen; the driver holds an isolated deep-frozen clone (#18-4)', async () => {
    // The shared default is frozen all the way down: a nested write throws
    // in strict mode instead of poisoning every later consumer.
    expect(Object.isFrozen(defaultHarnessConfig)).toBe(true);
    expect(Object.isFrozen(defaultHarnessConfig.promptBudget)).toBe(true);
    expect(Object.isFrozen(defaultHarnessConfig.tools.bash)).toBe(true);
    const chars = defaultHarnessConfig.promptBudget.maxSystemPromptChars;
    expect(() => {
      (defaultHarnessConfig.promptBudget as { maxSystemPromptChars: number }).maxSystemPromptChars =
        1;
    }).toThrow(TypeError);
    expect(defaultHarnessConfig.promptBudget.maxSystemPromptChars).toBe(chars);

    // The driver CLONED its effective config at construction: mutating the
    // CALLER's object afterwards cannot reach the run.
    const callerConfig = {
      ...defaultHarnessConfig,
      promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 60 },
    };
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: callerConfig,
      });
      callerConfig.promptBudget.maxSystemPromptChars = 5; // post-construction mutation
      await driver.run(invocation({ prompt: 'p' }));
      const args = lastGenerateTextArgs();
      expect(args.system).toBe(
        'You are a cq-toolkit worker executing one task. Work inside the provided workspace directory; use the available tools to read, edit, and run. Tool refusals arrive as denial text — adapt instead of retrying the same call.',
      );
      expect(
        args.messages?.filter((message) => message.role === 'user' && message.content === 'p'),
      ).toHaveLength(1);
      await expect(driver.run(invocation({ prompt: 'p'.repeat(61) }))).rejects.toThrow(
        /61 chars, over the harness prompt budget of 60/,
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('stopWhen is ALWAYS passed: the tool loop is bounded even without maxTokens (#18-5)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      // No maxTokens: the SDK's own default is stepCountIs(1) — a single
      // step, under which tool calls are never followed up. The driver must
      // pass its own bound.
      await driver.run(invocation());
      let stopWhen = lastGenerateTextArgs().stopWhen;
      expect(Array.isArray(stopWhen)).toBe(true);
      expect(stopWhen as unknown[]).toHaveLength(1); // the step-count bound alone
      // With maxTokens: the token condition AND the step-count bound (the
      // SDK accepts an array — any condition met stops).
      await driver.run(invocation({ budget: { maxTokens: 500 } }));
      stopWhen = lastGenerateTextArgs().stopWhen;
      expect(stopWhen as unknown[]).toHaveLength(2);
      expect(DEFAULT_MAX_STEPS).toBe(40); // the documented tool-loop default
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a failed prompt already persisted is NOT re-appended on the resumed retry (#18-6)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const store = new SessionStore(join(scratchDir, 'sessions'));
      // Run 1 fails mid-model-call: the record ends with the bare user
      // prompt (no assistant turn followed the failure).
      const failDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'fail' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const failed = await failDriver.run(invocation({ prompt: 'retry-me-once' }));
      expect(failed.stopReason).toBe('error');
      const failedArgs = lastGenerateTextArgs();
      expect(failedArgs.system).not.toContain('retry-me-once');
      expect(
        failedArgs.messages?.filter(
          (message) => message.role === 'user' && message.content === 'retry-me-once',
        ),
      ).toHaveLength(1);
      const before = await store.load(failed.sessionId as string);
      expect(before?.messages.at(-1)).toMatchObject({ role: 'user', content: 'retry-me-once' });

      // Run 2 resumes with the SAME prompt: the trailing turn is REUSED —
      // one store append skipped, one prompt message skipped.
      const retryDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'recovered' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      await retryDriver.run(
        invocation({ prompt: 'retry-me-once', sessionRef: failed.sessionId as string }),
      );
      const messages = lastGenerateTextArgs().messages ?? [];
      expect(
        messages.filter((m) => m.role === 'user' && m.content === 'retry-me-once'),
      ).toHaveLength(1);
      expect(lastGenerateTextArgs().system).not.toContain('retry-me-once');
      const after = await store.load(failed.sessionId as string);
      expect(
        after?.messages.filter((m) => m.role === 'user' && m.content === 'retry-me-once'),
      ).toHaveLength(1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('costUSD is priced off the SERVED model id; the provider handle stays modelSpec.provider (#24-7)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const pricingKeys: Array<{ provider: string; model: string }> = [];
      const driver = new AiSdkDriver({
        // The factory IGNORES the requested id and serves 'deepseek-flash' —
        // the silent-remap shape (modelSpec.model is 'deepseek-chat').
        providers: { mock: () => usageModel(mockUsage(), 'deepseek-flash') },
        sessionsDir: join(scratchDir, 'sessions'),
        pricing: (modelSpec) => {
          pricingKeys.push({ provider: modelSpec.provider, model: modelSpec.model });
          return { input: 1, output: 2 };
        },
      });
      const result = await driver.run(
        invocation({ modelSpec: { provider: 'mock', model: 'deepseek-chat' } }),
      );
      expect(result.model).toBe('deepseek-flash'); // WorkerResult.model keeps the served id
      // The price lookup got the SERVED id with the REQUESTED provider.
      expect(pricingKeys).toEqual([{ provider: 'mock', model: 'deepseek-flash' }]);
      // usage {input:100, output:12, cacheRead:15, cacheWrite:5} at 1/2 per
      // million (no cache rates → zero terms) = 124/1e6.
      expect(result.costUSD).toBeCloseTo(124 / 1_000_000, 12);
      expect(result.costBasis).toBe('modeled');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Seam v2 (ADR-0002 §2.1/§2.4) — RunOptions.signal + the workspace binding
// ---------------------------------------------------------------------------

/** A run that is expected to THROW — resolves with the thrown value (errorClassOf fodder). */
async function thrownBy(run: Promise<unknown>): Promise<unknown> {
  try {
    await run;
    return undefined;
  } catch (err) {
    return err;
  }
}

describe('ai-sdk driver seam v2: RunOptions.signal + workspace binding', () => {
  test('a PRE-ABORTED options.signal never dispatches: aborted, zero usage, no session state', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s2-'));
    try {
      let modelCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                modelCalls += 1;
                return textResult('must never run');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const controller = new AbortController();
      controller.abort();
      const result = await driver.run(invocation(), { signal: controller.signal });
      expect(result.stopReason).toBe('aborted');
      // ZERO usage, no denials, and NO sessionId: no record was created for
      // a run that never dispatched.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.denials).toEqual([]);
      expect(result.sessionId).toBeUndefined();
      expect(modelCalls).toBe(0); // the scripted model was never called
      // No session state either — the store directory was never created.
      await expect(
        readdir(join(scratchDir, 'sessions')).catch((err: NodeJS.ErrnoException) => err),
      ).resolves.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('an options.signal fired MID-RUN settles aborted — no governor in the loop', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s2-'));
    try {
      // No runLadder: the ambient governed context is UNDEFINED here, so the
      // only cancellation source is options.signal — the seam-v2 wiring.
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor({ kind: 'block-until-abort' }, modelId) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 10);
      const result = await driver.run(invocation({ toolPolicy: { allow: [], mode: 'none' } }), {
        signal: controller.signal,
      });
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined(); // the cancellation is not a failure
      // Usage observed so far: no step completed before the abort → zeros.
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace binding: the tool write lands in workspace.path; the record stays in sessionsDir recording the realpath', async () => {
    // realpath the scratch parent so the bound dir IS its own realpath
    // (macOS /var → /private/var) — the assertions then read literally.
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'aidrv-s2-')));
    try {
      const workspaceDir = join(scratchDir, 'ws');
      await mkdir(workspaceDir);
      const driver = new AiSdkDriver({
        providers: {
          mock: (modelId) =>
            modelFor(
              {
                kind: 'tool-then-reply',
                tool: 'run',
                input: { command: 'echo conformance-marker > note.txt' },
                reply: 'wrote note.txt',
              },
              modelId,
            ),
        },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: conformanceHarnessConfig(scratchDir),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'model-only',
          runTool: 'on',
          envPassthrough: [],
        },
      });
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['run'], mode: 'allowlist' },
          sandboxPolicy: { level: 'workspace-write' },
          workspace: { path: workspaceDir },
        }),
      );
      expect(result.stopReason).toBe('complete');
      // The record was created in the LANE's sessionsDir — never in the
      // workspace — and records the bound REALPATH as its workspace.
      const record = await new SessionStore(join(scratchDir, 'sessions')).load(
        result.sessionId as string,
      );
      expect(record?.workspace).toBe(workspaceDir);
      // The run tool really executed INSIDE the bound workspace.
      await expect(readFile(join(workspaceDir, 'note.txt'), 'utf8')).resolves.toContain(
        'conformance-marker',
      );
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace + sessionRef: the same realpath resumes; a different one throws config PRE-DISPATCH', async () => {
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'aidrv-s2-')));
    try {
      const workspaceDir = join(scratchDir, 'ws');
      const otherDir = join(scratchDir, 'other');
      await mkdir(workspaceDir);
      await mkdir(otherDir);
      let modelCalls = 0;
      const freshDriver = (): AiSdkDriver =>
        new AiSdkDriver({
          providers: {
            mock: () =>
              new MockLanguageModelV4({
                modelId: 'mock-1',
                doGenerate: async () => {
                  modelCalls += 1;
                  return textResult('ok');
                },
              }),
          },
          sessionsDir: join(scratchDir, 'sessions'),
        });
      const run1 = await freshDriver().run(invocation({ workspace: { path: workspaceDir } }));
      expect(run1.stopReason).toBe('complete');
      const callsAfterRun1 = modelCalls;
      expect(callsAfterRun1).toBe(1);

      // The SAME workspace for its OWN session: resumes bound to the same dir.
      const run2 = await freshDriver().run(
        invocation({ workspace: { path: workspaceDir }, sessionRef: run1.sessionId as string }),
      );
      expect(run2.stopReason).toBe('complete');
      expect(run2.sessionId).toBe(run1.sessionId);
      expect(modelCalls).toBe(callsAfterRun1 + 1);

      // A DIFFERENT workspace for the same session: a caller bug — a
      // pre-dispatch config throw; the model was never contacted.
      const err = await thrownBy(
        freshDriver().run(
          invocation({ workspace: { path: otherDir }, sessionRef: run1.sessionId as string }),
        ),
      );
      expect(err).toBeInstanceOf(DispatchError);
      expect(errorClassOf(err)).toBe('config');
      expect(modelCalls).toBe(callsAfterRun1 + 1); // unchanged — never dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('workspace.path that is relative or not an existing directory → DispatchError config, never dispatched', async () => {
    const scratchDir = await realpath(await mkdtemp(join(tmpdir(), 'aidrv-s2-')));
    try {
      const aFile = join(scratchDir, 'plain-file.txt');
      await writeFile(aFile, 'not a directory', 'utf8');
      let modelCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                modelCalls += 1;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      for (const badPath of ['relative/workspace', join(scratchDir, 'absent'), aFile]) {
        const err = await thrownBy(driver.run(invocation({ workspace: { path: badPath } })));
        expect(errorClassOf(err), `workspace.path '${badPath}'`).toBe('config');
      }
      expect(modelCalls).toBe(0); // none of them ever dispatched
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Seam v2 §2.3 (S3) — invocation outputSchema, the uniform output-invalid
// verdict, the W3.4 bounded repair, and providerSignals on any verdict
// ---------------------------------------------------------------------------

/** The invocation schema the §2.3 tests carry: `{answer: string}`, closed. */
const ANSWER_OUTPUT_SCHEMA: OutputSchema = {
  name: 'test.answer/v1',
  schema: {
    type: 'object',
    properties: { answer: { type: 'string' } },
    required: ['answer'],
    additionalProperties: false,
  },
};

/** A quota 429 with the claude unified limit headers (RS-14 §1.2 shape). */
function quota429Error(): APICallError {
  return new APICallError({
    message: 'rate limit exceeded: insufficient quota',
    url: 'https://provider.test/v1/messages',
    requestBodyValues: {},
    statusCode: 429,
    responseHeaders: {
      'anthropic-ratelimit-unified-5h-percent-remaining': '0',
      'anthropic-ratelimit-unified-5h-reset': '2026-09-28T12:00:00Z',
    },
    data: { error: { code: 'insufficient_quota' } },
    isRetryable: false,
  });
}

describe('ai-sdk driver seam v2 §2.3: invocation outputSchema + repair + providerSignals', () => {
  test('round-trip: a schema-valid reply completes with the validated plain JSON', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        return textResult('{"answer":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }));
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'ok' });
      // PRODUCER RULE: no class (and no error) on a non-error verdict.
      expect(result.errorClass).toBeUndefined();
      expect(result.error).toBeUndefined();
      // A valid object means NO repair: exactly one model call.
      expect(modelCalls).toBe(1);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('W3.4 repair: ONE tool-free repair call with the schema restated, then complete; usage covers BOTH calls', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        return modelCalls === 1
          ? textResult('I wrote prose instead of the JSON object, sorry')
          : textResult('{"answer":"repaired"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(
        invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA, toolPolicy: { allow: [], mode: 'none' } }),
      );
      expect(modelCalls).toBe(2); // the main call + exactly ONE repair
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ answer: 'repaired' });
      expect(result.errorClass).toBeUndefined();
      // The repair is a REAL extra model call: both calls' usage lands in
      // the verdict (2 × {100 in, 12 out, 15 cacheRead, 5 cacheWrite}).
      expect(result.usage).toEqual({ input: 200, output: 24, cacheRead: 30, cacheWrite: 10 });
      // The REPAIR call is the most recent generateText: tool-free, one
      // attempt, one step, the schema restated, over the transcript.
      const repairArgs = generateTextArgsFromEnd(0);
      expect(repairArgs.tools).toBeUndefined();
      expect(repairArgs.maxRetries).toBe(0);
      expect(repairArgs.stopWhen).toHaveLength(1); // stepCountIs(1): no budget set
      const repairTurns = repairArgs.messages ?? [];
      const repairTurn = repairTurns[repairTurns.length - 1];
      expect(repairTurn?.role).toBe('user');
      expect(repairTurn?.content).toContain('JSON Schema (draft 2020-12)');
      expect(repairTurn?.content).toContain('"answer"'); // the schema restated
      // The model sees what it produced: the transcript + its own reply ride.
      expect(
        repairTurns.some(
          (m) =>
            m.role === 'assistant' &&
            JSON.stringify(m.content).includes('prose instead of the JSON'),
        ),
      ).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test.each(['provider', 'abort'] as const)(
    'failed repair keeps observed usage unpriced: %s',
    async (failure) => {
      let modelCalls = 0;
      const mock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          modelCalls += 1;
          if (modelCalls === 1) return textResult('{"wrong":true}');
          const error = new Error('repair failed');
          if (failure === 'abort') error.name = 'AbortError';
          throw error;
        },
      });
      const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-repair-failed-'));
      try {
        const driver = new AiSdkDriver({
          providers: { mock: () => mock },
          sessionsDir: join(scratchDir, 'sessions'),
          pricing: () => ({ input: 3, output: 15 }),
        });
        const result = await driver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }));
        expect(modelCalls).toBe(2);
        expect(result.stopReason).toBe(failure === 'abort' ? 'aborted' : 'error');
        expect(result.usage).toEqual({ input: 100, output: 12, cacheRead: 15, cacheWrite: 5 });
        expect(result.costUSD).toBeUndefined();
        expect(result.costBasis).toBeUndefined();
      } finally {
        await rm(scratchDir, { recursive: true, force: true });
      }
    },
  );

  test('W3.4 repair exhausted: still invalid → error/output-invalid, usage and derived cost over BOTH calls', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        // PARSEABLE but schema-invalid — both the main call and the repair.
        return textResult('{"wrong":true}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
        pricing: () => ({ input: 3, output: 15 }),
      });
      const result = await driver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA }));
      expect(modelCalls).toBe(2); // one repair attempt, exactly
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBe('output-invalid');
      expect(result.structuredOutput).toBeUndefined();
      // The verdict keeps the spend evidence of BOTH calls, and the derived
      // cost is computed over the folded usage.
      expect(result.usage).toEqual({ input: 200, output: 24, cacheRead: 30, cacheWrite: 10 });
      expect(typeof result.costUSD).toBe('number');
      expect(result.costBasis).toBe('modeled');
      // The rejection is recorded in the bounded text: main miss + repair miss.
      expect(result.error).toContain("does not validate against schema 'test.answer/v1'");
      expect(result.error).toContain('repair:');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('no schema requested: structuredOutput is ABSENT even when the reply is JSON', async () => {
    let modelCalls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        modelCalls += 1;
        return textResult('{"answer":"ok"}');
      },
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => mock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toBeUndefined();
      expect(result.errorClass).toBeUndefined();
      expect(modelCalls).toBe(1); // no schema → no repair machinery at all
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('providerSignals ride ANY verdict: response-metadata headers on success, error headers on a quota 429', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    try {
      // SUCCESS: the response metadata headers the SDK exposes.
      const okMock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () =>
          textResultWithHeaders('ok', {
            'retry-after': '30',
            'x-ratelimit-limit-requests': '100',
            'x-ratelimit-remaining-requests': '50',
          }),
      });
      const okDriver = new AiSdkDriver({
        providers: { mock: () => okMock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const okResult = await okDriver.run(invocation());
      expect(okResult.stopReason).toBe('complete');
      expect(okResult.providerSignals).toEqual({
        retryAfterMs: 30_000,
        windows: [{ id: 'requests', utilization: 0.5, remaining: { requests: 50 } }],
      });
      expect(okResult.errorClass).toBeUndefined();

      // FAILURE: a quota 429 whose headers carry the claude unified window —
      // quota class WITH the window's resetAt (the §2.2 rule-5 producer rule).
      const quotaMock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          throw quota429Error();
        },
      });
      const quotaDriver = new AiSdkDriver({
        providers: { mock: () => quotaMock },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const quotaResult = await quotaDriver.run(invocation());
      expect(quotaResult.stopReason).toBe('error');
      expect(quotaResult.errorClass).toBe('quota');
      expect(quotaResult.providerSignals).toEqual({
        windows: [{ id: '5h', utilization: 1, resetAt: '2026-09-28T12:00:00.000Z' }],
      });
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('producer rule: errorClass rides every error verdict and NO non-error verdict; the mirror still parses them', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-s3-'));
    let sessionsDirCounter = 0;
    const freshDir = (): string => join(scratchDir, `run-${(sessionsDirCounter += 1)}`);
    try {
      const runs: Array<{ label: string; result: WorkerResult }> = [];

      // 1. provider failure → error (class from the structured cuts).
      const failDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'fail' }) },
        sessionsDir: freshDir(),
      });
      runs.push({ label: 'fail', result: await failDriver.run(invocation()) });

      // 2. output-invalid → error/'output-invalid'.
      const invalidMock = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => textResult('{"wrong":true}'),
      });
      const invalidDriver = new AiSdkDriver({
        providers: { mock: () => invalidMock },
        sessionsDir: freshDir(),
      });
      runs.push({
        label: 'output-invalid',
        result: await invalidDriver.run(invocation({ outputSchema: ANSWER_OUTPUT_SCHEMA })),
      });

      // 3. a quota 429 → error/'quota' with providerSignals.
      const quotaDriver = new AiSdkDriver({
        providers: {
          mock: () =>
            new MockLanguageModelV4({
              modelId: 'mock-1',
              doGenerate: async () => {
                throw quota429Error();
              },
            }),
        },
        sessionsDir: freshDir(),
      });
      runs.push({ label: 'quota', result: await quotaDriver.run(invocation()) });

      // 4. complete → NO class.
      const okDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'plain prose' }) },
        sessionsDir: freshDir(),
      });
      runs.push({ label: 'complete', result: await okDriver.run(invocation()) });

      // 5. pre-aborted → 'aborted', NO class (a cancellation is not a failure).
      const dead = new AbortController();
      dead.abort();
      const abortedDriver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'never runs' }) },
        sessionsDir: freshDir(),
      });
      runs.push({
        label: 'aborted',
        result: await abortedDriver.run(invocation(), { signal: dead.signal }),
      });

      for (const { label, result } of runs) {
        if (result.stopReason === 'error') {
          expect(result.errorClass, `${label}: error verdicts carry a class`).toBeDefined();
        } else {
          expect(result.errorClass, `${label}: non-error verdicts carry none`).toBeUndefined();
        }
        // The strict v2 mirror parses every verdict (errorClass is
        // one-directional: present ⇒ error).
        const reparsed = WorkerResultSchema.parse(JSON.parse(JSON.stringify(result)));
        expect(reparsed.stopReason).toBe(result.stopReason);
      }
      expect(runs.map((r) => r.result.stopReason)).toEqual([
        'error',
        'error',
        'error',
        'complete',
        'aborted',
      ]);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 3. LIVE variant — opt-in only (LIVE_DRIVERS=1); real provider registry, tiny prompts
// ---------------------------------------------------------------------------

// The deepseek wire SERVES `deepseek-flash` for a `deepseek-chat` request
// (observed live 2026-09-14, docs/eval-axes-demo.md) — eval/live wires
// request the id the wire actually serves (conductor decision, STATUS
// Deviations 2026-09-14), so the observed-model identity holds and the cost
// fold keys on the model that really ran.
const liveCases: ReadonlyArray<[provider: string, model: string, keyName: string]> = [
  ['anthropic', 'claude-haiku-4-5', 'ANTHROPIC_API_KEY'],
  ['deepseek', 'deepseek-flash', 'DEEPSEEK_API_KEY'],
];

describe.skipIf(!process.env.LIVE_DRIVERS)('live ai-sdk driver (opt-in: LIVE_DRIVERS=1)', () => {
  test.each(liveCases)(
    '%s %s replies within the budget cap',
    async (provider, model, keyName) => {
      if (process.env[keyName] === undefined || process.env[keyName] === '') {
        throw new Error(
          `LIVE_DRIVERS=1 but ${keyName} is not set — refusing to silently skip one leg`,
        );
      }
      const driver = new AiSdkDriver(); // the REAL default registry, no mocks
      const result = await driver.run({
        prompt: 'Reply with the word ok.',
        modelSpec: { provider, model },
        toolPolicy: { allow: [], mode: 'none' },
        sandboxPolicy: { level: 'none' },
        budget: { maxUsd: 2, maxTokens: 2000 },
      });
      // The live assertions are the conformance invariants that make sense
      // over the wire: usage present, no vendor vocabulary, the strict mirror
      // parses the result, and a tiny prompt completes inside the cap.
      const serialized = JSON.stringify(result);
      for (const banned of BANNED_VOCABULARY) {
        expect(serialized).not.toContain(banned);
      }
      const parsed = WorkerResultSchema.parse(JSON.parse(serialized));
      expect(typeof parsed.usage.input).toBe('number');
      expect(typeof parsed.usage.output).toBe('number');
      expect(parsed.stopReason).toBe('complete');
      // Every live leg is now priced — `deepseek-flash` was vendored from
      // models.dev (fetched 2026-09-21), closing the old no-published-rates
      // gap — so each leg asserts a real derived figure under the declared
      // maxUsd cap. The observed-model identity asserts what the SDK
      // SURFACES (a remap it does not surface is recorded, not caught — the
      // fold falls back to the requested id).
      expect(parsed.costUSD).toBeDefined();
      expect(parsed.costUSD as number).toBeLessThan(2);
      expect(parsed.model).toBe(model);
    },
    60_000,
  );
});

test.each(['initial', 'read', 'run'] as const)(
  'upload gate refuses %s bytes before the next provider send',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-upload-'));
    let sends = 0;
    const scanned: string[] = [];
    try {
      await writeFile(join(root, 'secret.txt'), 'DO_NOT_UPLOAD');
      const command = process.execPath + ' -e "process.stdout.write(\'DO_NOT_UPLOAD\')"';
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          sends++;
          return mode === 'read'
            ? toolCallResult('read', { path: 'secret.txt' })
            : mode === 'run'
              ? toolCallResult('run', { command })
              : textResult('ok');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        sandboxConfig: {
          mode: 'off',
          backend: 'auto',
          network: 'allow',
          runTool: 'on',
          envPassthrough: [],
        },
        harnessConfig: {
          ...defaultHarnessConfig,
          tools: {
            ...defaultHarnessConfig.tools,
            bash: { ...defaultHarnessConfig.tools.bash, commandPatterns: ['re:^.*$'] },
          },
        },
        beforeRequest: async (text) => {
          scanned.push(text);
          if (text.includes('DO_NOT_UPLOAD')) throw new Error('upload refused');
        },
      });
      const result = await driver.run(
        invocation({
          prompt: mode === 'initial' ? 'DO_NOT_UPLOAD' : 'safe',
          workspace: { path: root },
          budget: {},
        }),
      );
      expect(result.stopReason).not.toBe('complete');
      expect(sends).toBe(mode === 'initial' ? 0 : 1);
      expect(scanned.at(-1)).toContain('DO_NOT_UPLOAD');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test('upload serialization preserves undefined slots and refuses lossy or cyclic payloads', () => {
  expect(serializeRequestForScan({ prompt: ['safe', undefined], optional: undefined })).toBe(
    '{"prompt":["safe","[undefined]"],"optional":"[undefined]"}',
  );
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  for (const bad of [
    undefined,
    { text: NaN },
    { text: Infinity },
    { text: () => 'hidden' },
    { text: Symbol('hidden') },
    { text: 1n },
    { text: new Map([['hidden', 'secret']]) },
    { text: { hidden: 'secret', toJSON: () => 'safe' } },
    cyclic,
  ])
    expect(() => serializeRequestForScan(bad)).toThrow();
});

test.each(['private', 'public', 'newline', 'prompt'] as const)(
  'configured upload policy preserves source paths and decoded text (%s)',
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-path-upload-'));
    const gitleaks = await makeGitleaksFixture();
    vi.stubEnv('PATH', gitleaks.path);
    let sends = 0;
    try {
      await writeFile(
        join(root, 'patterns.yml'),
        [
          'rules:',
          '  - id: private-path',
          '    description: private fixture path',
          "    regex: '.+'",
          "    path: '(^|/)private\\.txt$'",
          "    sample: 'ordinary private bytes'",
          '  - id: bounded-word',
          '    description: bounded fixture token',
          "    regex: '\\bBLOCKEDWORD\\b'",
          "    sample: 'BLOCKEDWORD'",
          'clean_probes:',
          "  - 'ordinary public bytes'",
          '',
        ].join('\n'),
      );
      const file = mode === 'private' ? 'private.txt' : 'public.txt';
      await writeFile(
        join(root, file),
        mode === 'newline' ? '\nBLOCKEDWORD' : 'ordinary private bytes',
      );
      const bindings = bindingsFromDispatch(
        {
          repoRoot: root,
          runPrefix: 'fixture',
          base: 'HEAD',
          package: 'fixture',
          fixer: 'fixture',
          files: [],
          mutex: { lockPath: join(root, 'mutex') },
          driver: { provider: 'mock', model: 'mock-1', budget: { wallClockMs: 10000 } },
          check: { adapter: 'vitest-json', command: 'node', args: [] },
          taskLoop: { denylistPatternsFile: 'patterns.yml' },
        },
        {
          resolve: ({ modelSpec }) => ({
            modelSpec,
            lane: 'ai-sdk',
            driver: {
              run: async () => {
                throw new Error('unused');
              },
            },
          }),
        },
      );
      expect(bindings.scanPrompt).toBeDefined();
      await expect(bindings.scanPrompt?.('safe')).resolves.toBeUndefined();
      await expect(bindings.scanPrompt?.('\nBLOCKEDWORD')).rejects.toThrow(
        'worker upload refused by denylist scan',
      );
      vi.stubEnv('CQ_TEST_GITLEAKS_EXIT', '2');
      await expect(bindings.scanPrompt?.('safe')).rejects.toThrow('gitleaks failed to run');
      vi.stubEnv('CQ_TEST_GITLEAKS_EXIT', '0');
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async () => {
          sends++;
          return sends === 1 && mode !== 'prompt'
            ? toolCallResult('read', { path: file })
            : textResult('done');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        ...(bindings.scanPrompt === undefined ? {} : { beforeRequest: bindings.scanPrompt }),
      });
      const result = await driver.run(
        invocation({
          prompt: mode === 'prompt' ? '\nBLOCKEDWORD' : 'safe',
          workspace: { path: root },
          budget: {},
        }),
      );
      expect(sends).toBe(mode === 'public' ? 2 : mode === 'prompt' ? 0 : 1);
      expect(result.stopReason === 'complete').toBe(mode === 'public');
      if (mode === 'prompt') expect(result.error).toContain('worker upload refused by scan');
      expect((await gitleaks.calls()).length).toBeGreaterThan(3);
    } finally {
      vi.unstubAllEnvs();
      await rm(gitleaks.root, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  },
);

// ---------------------------------------------------------------------------
// N. rg capability seam (injected resolver, deterministic)
// ---------------------------------------------------------------------------

describe('rg capability seam (injected resolveRg)', () => {
  test('rg ok: grep/glob stay on the surface; result records probe ok with no advisory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-ok-'));
    try {
      let probes = 0;
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => {
          probes++;
          return { ok: true, version: '14.1.1' };
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.capabilities?.rg).toEqual({
        available: true,
        version: '14.1.1',
        minimum: '11.0.0',
        probe: 'ok',
      });
      expect(result.advisories).toBeUndefined();
      expect(probes).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rg absent: grep/glob WITHHELD, capability records absent, advisory carries the not-found line', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-absent-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => ({ ok: false, reason: 'absent' }),
      });
      const result = await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.capabilities?.rg).toEqual({
        available: false,
        minimum: '11.0.0',
        probe: 'absent',
      });
      expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('rg old: capability carries found; advisory names the minimum', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-old-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => ({ ok: false, reason: 'old', found: '10.5.0' }),
      });
      const result = await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.capabilities?.rg).toEqual({
        available: false,
        found: '10.5.0',
        minimum: '11.0.0',
        probe: 'old',
      });
      expect(result.advisories).toEqual([
        'search tools unavailable: ripgrep older than minimum 11.0.0',
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('a policy that does not request grep never probes and records nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-silent-'));
    try {
      let probes = 0;
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => {
          probes++;
          return { ok: false, reason: 'absent' };
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.capabilities).toBeUndefined();
      expect(result.advisories).toBeUndefined();
      expect(probes).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('the mirror accepts a result carrying the seam fields and one without (conformance absent-field rule)', async () => {
    const base = {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'complete' as const,
    };
    expect(WorkerResultSchema.parse(base)).toBeDefined();
    expect(
      WorkerResultSchema.parse({
        ...base,
        capabilities: {
          rg: { available: false, found: '13.0.0', minimum: '15.2.0', probe: 'old' },
        },
        advisories: ['search tools unavailable: ripgrep not found'],
      }).capabilities?.rg?.probe,
    ).toBe('old');
  });
});

describe('rg runtime floor boundary — PRODUCTION comparator', () => {
  // The PRODUCTION versionAtLeast/parseRgVersion, not a test-local mirror:
  // these pin the exact comparison the driver ships.
  test.each([
    ['10.5.0', false],
    ['11.0.0', true],
    ['11.1.3', true],
    ['14.1.1', true],
    ['15.2.0', true],
  ])('versionAtLeast(%s, 11.0.0) === %s', (found, expected) => {
    expect(versionAtLeast(found, '11.0.0')).toBe(expected);
  });

  test.each([
    ['ripgrep 15.2.0 (rev e89fff89ac)', '15.2.0'],
    ['ripgrep 14.1.1 (rev 4649aa9700)', '14.1.1'],
    ['ripgrep 11.0.0', '11.0.0'],
  ])('parseRgVersion(%s) === %s', (line, expected) => {
    expect(parseRgVersion(line)).toBe(expected);
  });

  test.each([
    ['', undefined],
    ['not a version line', undefined],
    ['ripgrep 15', undefined],
  ])('parseRgVersion(%j) is undefined', (line, expected) => {
    expect(parseRgVersion(line)).toBe(expected);
  });

  test('defaultResolveRg drives the production comparator through a fake rg executable', async () => {
    // A fake `rg` on PATH whose first stdout line is scripted: proves the
    // default resolver parses the REAL executable's output with the
    // PRODUCTION comparator — no test-local mirror anywhere in the path.
    const binDir = await mkdtemp(join(tmpdir(), 'aidrv-fake-rg-'));
    const script = async (body: string): Promise<string> => {
      const path = join(binDir, 'rg');
      await writeFile(path, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return path;
    };
    const originalPath = process.env.PATH;
    const runWithFake = async (body: string): Promise<WorkerResult> => {
      await script(body);
      // The default resolver spawns `rg` from PATH: prepend the fake bin for
      // the duration of the run and restore after (vi.stubEnv restores too).
      process.env.PATH = `${binDir}:${originalPath ?? ''}`;
      const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-fake-'));
      try {
        const driver = new AiSdkDriver({
          providers: { mock: (modelId) => modelFor(undefined, modelId) },
          sessionsDir: join(root, 'sessions'),
          harnessConfig: conformanceHarnessConfig(root),
          resolveRg: harnessProbeRg,
        });
        return await driver.run(
          invocation({
            workspace: { path: root },
            toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
            sandboxPolicy: { level: 'read-only' },
          }),
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    };
    try {
      // serves: 14.1.1 >= floor 11.0.0
      const serving = await runWithFake(`echo 'ripgrep 14.1.1 (rev 4649aa9700)'`);
      expect(serving.capabilities?.rg).toMatchObject({
        available: true,
        version: '14.1.1',
        probe: 'ok',
      });
      // withheld: 10.5.0 < floor
      const withheld = await runWithFake(`echo 'ripgrep 10.5.0'`);
      expect(withheld.capabilities?.rg).toMatchObject({
        available: false,
        found: '10.5.0',
        probe: 'old',
      });
      expect(withheld.advisories).toEqual([
        'search tools unavailable: ripgrep older than minimum 11.0.0',
      ]);
      // absent: nonzero exit
      const absent = await runWithFake(`exit 2`);
      expect(absent.capabilities?.rg).toMatchObject({ available: false, probe: 'absent' });
    } finally {
      process.env.PATH = originalPath;
      await rm(binDir, { recursive: true, force: true });
    }
  });

  test('CI guard: on CI a missing/old real rg FAILS the search-tool surface outright (no skip)', async () => {
    const onCi =
      process.env.CI !== undefined && process.env.CI !== '' && process.env.CI !== 'false';
    if (!onCi) {
      // Off CI this test simply returns (developers may lack rg); ON CI the
      // precondition below fails the test when rg is absent/old. Any truthy
      // CI value guards (CI=1 is common).
      return;
    }
    const bin = await new Promise<string | undefined>((resolve) => {
      const child = childSpawn('rg', ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      let head = '';
      child.stdout?.on('data', (c: Buffer) => {
        if (head === '') head = c.toString('utf8');
      });
      child.on('error', () => resolve(undefined));
      child.on('close', (code) => resolve(code === 0 ? head : undefined));
    });
    const version = parseRgVersion(bin?.split('\n')[0]);
    // THE GUARD: on CI, rg must exist AND satisfy the runtime floor.
    expect(version).toBeDefined();
    expect(versionAtLeast(version as string, RG_MINIMUM_VERSION)).toBe(true);
  });
});

describe('rg policy seam regressions (probe decision from candidates)', () => {
  const runCase = async (
    toolPolicy: OpInvocation['toolPolicy'],
    sandbox: 'none' | 'workspace-write' | 'read-only',
  ): Promise<{ result: WorkerResult; probes: number }> => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-seam-'));
    try {
      let probes = 0;
      const driver = new AiSdkDriver({
        providers: { mock: (modelId) => modelFor(undefined, modelId) },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg: async () => {
          probes++;
          return { ok: false, reason: 'absent' };
        },
      });
      const result = await driver.run(
        invocation({ workspace: { path: root }, toolPolicy, sandboxPolicy: { level: sandbox } }),
      );
      return { result, probes };
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test('glob-only allowlist still probes and withholds BOTH search tools', async () => {
    const { result, probes } = await runCase(
      { allow: ['read', 'glob'], mode: 'allowlist' },
      'read-only',
    );
    expect(probes).toBe(1);
    expect(result.capabilities?.rg?.available).toBe(false);
    expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
  });

  test('unrestricted policy probes (candidates include search on read-only)', async () => {
    const { result, probes } = await runCase({ allow: [], mode: 'unrestricted' }, 'read-only');
    expect(probes).toBe(1);
    expect(result.capabilities?.rg?.available).toBe(false);
  });

  test('workspace-write sandbox withholds search from candidates: NO probe, silent', async () => {
    const { result, probes } = await runCase(
      { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
      'workspace-write',
    );
    expect(probes).toBe(0);
    expect(result.capabilities).toBeUndefined();
    expect(result.advisories).toBeUndefined();
  });

  test('read/search-only policy (no search tool) never probes: silent', async () => {
    const { result, probes } = await runCase({ allow: ['read'], mode: 'allowlist' }, 'read-only');
    expect(probes).toBe(0);
    expect(result.capabilities).toBeUndefined();
    expect(result.advisories).toBeUndefined();
  });
});

describe('read/grep raw scan provenance + persist stripping', () => {
  test('read: guard receives RAW unformatted lines under the real path (line-anchored rules match)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rawread-'));
    try {
      // The numbered display shifts the line: '^CONFIDENTIAL:' anchors on the
      // RAW source line, which the display '     1: CONFIDENTIAL: x' breaks.
      await writeFile(join(root, 'secret.txt'), 'CONFIDENTIAL: top-secret-value\n', 'utf8');
      const guarded: { text: string; path?: string }[] = [];
      let modelCalls = 0;
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async (options) => {
          modelCalls++;
          if (modelCalls === 1 && offeredToolCount(options) > 0) {
            return toolCallResult('read', { path: 'secret.txt' });
          }
          return textResult('done');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        beforeRequest: async (_text, contents = []) => {
          guarded.push(...contents);
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      const raw = guarded.find((c) => c.path === 'secret.txt');
      expect(raw).toBeDefined();
      // The RAW line: a ^CONFIDENTIAL: rule matches; the numbered display line would not.
      expect(raw?.text).toBe('CONFIDENTIAL: top-secret-value');
      expect(raw?.text).not.toContain('     1:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('read: sourceContents are scan-only — NOT persisted into the session transcript', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-nopersist-'));
    try {
      await writeFile(join(root, 'secret.txt'), 'CONFIDENTIAL: top-secret-value\n', 'utf8');
      let modelCalls = 0;
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async (options) => {
          modelCalls++;
          if (modelCalls === 1 && offeredToolCount(options) > 0) {
            return toolCallResult('read', { path: 'secret.txt' });
          }
          return textResult('done');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        beforeRequest: async () => {}, // guard present (scan runs), contract unconditional
      });
      await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      // Every persisted tool message: no sourceContents key anywhere.
      const storeDir = join(root, 'sessions');
      const persisted: string[] = [];
      const walk = async (dir: string): Promise<void> => {
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          const p = join(dir, entry.name);
          if (entry.isDirectory()) await walk(p);
          else if (entry.name.endsWith('.jsonl')) persisted.push(await readFile(p, 'utf8'));
        }
      };
      await walk(storeDir);
      expect(persisted.length).toBeGreaterThan(0);
      for (const body of persisted) expect(body).not.toContain('sourceContents');
      // The DISPLAY output is persisted (the model needs it on replay).
      expect(persisted.some((b) => b.includes('CONFIDENTIAL: top-secret-value'))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('grep: guard receives RAW matched lines (anchors intact), display stays numbered', async () => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rawgrep-'));
    try {
      await writeFile(join(root, 'secret.txt'), 'CONFIDENTIAL: grep-secret-value\n', 'utf8');
      const guarded: { text: string; path?: string }[] = [];
      let modelCalls = 0;
      const model = new MockLanguageModelV4({
        modelId: 'mock-1',
        doGenerate: async (options) => {
          modelCalls++;
          if (modelCalls === 1 && offeredToolCount(options) > 0) {
            return toolCallResult('grep', { pattern: 'grep-secret-value' });
          }
          return textResult('done');
        },
      });
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        beforeRequest: async (_text, contents = []) => {
          guarded.push(...contents);
        },
      });
      const result = await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['grep'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
        }),
      );
      expect(result.stopReason).toBe('complete');
      const raw = guarded.find((c) => c.path === 'secret.txt');
      expect(raw).toBeDefined();
      expect(raw?.text).toBe('CONFIDENTIAL: grep-secret-value');
      expect(raw?.text).not.toContain('     1:');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('rg probe evidence on EVERY post-probe verdict', () => {
  const runAbsentoK = async (
    model: MockLanguageModelV4,
    resolveRg: NonNullable<AiSdkDriverOptions['resolveRg']>,
  ) => {
    const root = await mkdtemp(join(tmpdir(), 'aidrv-rg-verdict-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => model },
        sessionsDir: join(root, 'sessions'),
        harnessConfig: conformanceHarnessConfig(root),
        resolveRg,
      });
      return await driver.run(
        invocation({
          workspace: { path: root },
          toolPolicy: { allow: ['read', 'grep', 'glob'], mode: 'allowlist' },
          sandboxPolicy: { level: 'read-only' },
          outputSchema: {
            name: 'test.verdict/v1',
            schema: {
              type: 'object',
              properties: { reply: { type: 'string' } },
              required: ['reply'],
              additionalProperties: false,
            },
          },
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  test('REPAIR SUCCESS: the miss-flow verdict still carries the probe evidence', async () => {
    let calls = 0;
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls++;
        // First (main) call returns unparseable text; the repair returns valid JSON.
        return calls === 1
          ? textResult('this is not the requested object')
          : textResult('{"reply":"repaired"}');
      },
    });
    const result = await runAbsentoK(model, async () => ({ ok: false, reason: 'absent' }));
    expect(result.stopReason).toBe('complete');
    expect(result.capabilities?.rg).toMatchObject({ available: false, probe: 'absent' });
    expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
  });

  test('REPAIR FAILURE: the error verdict still carries the probe evidence', async () => {
    const model = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => textResult('still not the object'),
    });
    const result = await runAbsentoK(model, async () => ({ ok: false, reason: 'absent' }));
    expect(result.stopReason).toBe('error');
    expect(result.errorClass).toBe('output-invalid');
    expect(result.capabilities?.rg).toMatchObject({ available: false, probe: 'absent' });
    expect(result.advisories).toEqual(['search tools unavailable: ripgrep not found']);
  });
});
