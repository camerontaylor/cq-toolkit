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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  AiSdkDriver,
  DEFAULT_MAX_STEPS,
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
import { SessionStore } from '../../src/harness/session.js';
import type { OpInvocation, OutputSchema, WorkerResult } from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// generateText arg capture — a TRANSPARENT spy over the real 'ai' module:
// tests assert what the driver actually PASSED (composed system prompt,
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
      run: {
        ...defaultHarnessConfig.tools.run,
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

  test('structured output is decoupled from the tool loop: the final step disables tools (#203)', async () => {
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        const tools = options.tools;
        return tools !== undefined && tools.length > 0
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
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          outputSchema: toOutputSchema(
            'test/multi-step/v1',
            z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
          ),
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(result.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      // With tools live every step the model answers tool-calls forever and
      // never emits the object; the tool-free final step is what makes the
      // structured output reachable — the model is called exactly to the cap.
      expect(calls).toBe(DEFAULT_MAX_STEPS);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a missing structured object is repaired ONCE, then settles error/output-invalid (#203, W3.4)', async () => {
    let calls = 0;
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async (options) => {
        calls += 1;
        // The repair is TOOL-FREE: the mock answers it with another tool
        // call, so the repair's own parse misses too — the give-up path.
        if (options.tools !== undefined && options.tools.length > 0) {
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
      // ONE bounded repair attempt after the miss: 8 tool-loop steps + the
      // single repair step.
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
      expect(result.stopReason).toBe('error');
      // ADR-0002 §2.3: the uniform miss verdict — output-invalid, rejection
      // recorded in the bounded error text (both the miss and the repair).
      expect(result.errorClass).toBe('output-invalid');
      expect(
        result.error?.startsWith(
          'ai-sdk driver: structured output invalid after the repair attempt',
        ),
      ).toBe(true);
      expect(result.error).toContain('repair');
      // never a model score: no fabricated structuredOutput on an error verdict.
      expect(result.structuredOutput).toBeUndefined();
      // The usage covers BOTH calls: 8 tool-loop steps + 1 repair step,
      // each folding {100 in, 12 out, 15 cacheRead, 5 cacheWrite}.
      expect(result.usage).toEqual({ input: 900, output: 108, cacheRead: 135, cacheWrite: 45 });
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
        // Main loop tool-calls. The lane's TOOL-FREE FINAL LOOP STEP (and
        // then the tool-free REPAIR) is distinguished by counting: the
        // FIRST tool-free call must ALSO miss (else the loop's final step
        // completes the run and no repair fires); the SECOND — the repair —
        // answers with the valid object.
        if (options.tools !== undefined && options.tools.length > 0) {
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
      // 8 main steps end on the step cap (8 × 132 total tokens incl. cache
      // = 1056, under the 1100 cap — the loop ends on max-steps, so the
      // REPAIR fires), then the repair pushes the accumulated fold to
      // 9 × 132 = 1188 ≥ 1100: the repair's success is an honest 'budget'
      // verdict — the payload does not ride it, the spend evidence does.
      const budgeted = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 1100 },
          outputSchema: schema,
        }),
      );
      expect(calls).toBe(DEFAULT_MAX_STEPS + 1);
      expect(budgeted.stopReason).toBe('budget');
      expect(budgeted.structuredOutput).toBeUndefined();
      expect(budgeted.errorClass).toBeUndefined(); // a cap is not a failure
      expect(budgeted.usage).toEqual({ input: 900, output: 108, cacheRead: 135, cacheWrite: 45 });
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
          budget: { maxTokens: 5000 },
          outputSchema: schema,
        }),
      );
      expect(completed.stopReason).toBe('complete');
      expect(completed.structuredOutput).toEqual({ fixed: true, notes: 'ok' });
      // The repair really fired: 8 loop steps + 1 repair step.
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
        if (options.tools !== undefined && options.tools.length > 0) {
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

  test('composed system prompt: empty preamble → prompt alone, never past the budget (#18-3)', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const prompt = 'p'.repeat(50); // prompt.length === maxSystemPromptChars: no room at all
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'reply', text: 'ok' }) },
        sessionsDir: join(scratchDir, 'sessions'),
        harnessConfig: {
          ...defaultHarnessConfig,
          promptBudget: { ...defaultHarnessConfig.promptBudget, maxSystemPromptChars: 50 },
        },
      });
      await driver.run(invocation({ prompt }));
      const system = lastGenerateTextArgs().system;
      expect(system).toBeDefined();
      expect(system?.length).toBeLessThanOrEqual(50);
      expect(system?.endsWith(prompt)).toBe(true);
      expect(system).toBe(prompt); // no room → no preamble → NO separator either
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('defaultHarnessConfig is deeply frozen; the driver holds an isolated deep-frozen clone (#18-4)', async () => {
    // The shared default is frozen all the way down: a nested write throws
    // in strict mode instead of poisoning every later consumer.
    expect(Object.isFrozen(defaultHarnessConfig)).toBe(true);
    expect(Object.isFrozen(defaultHarnessConfig.promptBudget)).toBe(true);
    expect(Object.isFrozen(defaultHarnessConfig.tools.run)).toBe(true);
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
      const system = lastGenerateTextArgs().system;
      // Composed under the construction-time 60 (preamble truncated to
      // 57 + '\n\n' + the 1-char prompt = 60), NOT under the mutated 5
      // (which would compose the prompt alone) — the clone held.
      expect(system?.length).toBe(60);
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
      expect(DEFAULT_MAX_STEPS).toBe(8); // the documented tool-loop default
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
          (m) => m.role === 'assistant' && m.content.includes('prose instead of the JSON'),
        ),
      ).toBe(true);
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

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
