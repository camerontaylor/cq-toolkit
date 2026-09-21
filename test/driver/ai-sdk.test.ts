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
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises';
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
} from './conformance.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import { SessionStore } from '../../src/harness/session.js';
import type { OpInvocation } from '../../src/driver/types.js';

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
} {
  const last = captured.generateTextArgs[captured.generateTextArgs.length - 1];
  if (last === undefined) throw new Error('no generateText call was captured');
  return last as {
    system?: string;
    messages?: Array<{ role: string; content: string }>;
    stopWhen?: unknown;
    maxRetries?: number;
    timeout?: unknown;
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
      // A plain non-abort failure: the driver must return stopReason 'error'.
      return new MockLanguageModelV4({
        ...(servedModel === undefined ? {} : { modelId: servedModel }),
        doGenerate: async () => {
          throw new Error('scripted model failure');
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
    ...(spec.outputSchema !== undefined ? { outputSchema: spec.outputSchema } : {}),
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
  });
}

// ---------------------------------------------------------------------------
// 1. The conformance suite, mock-backed
// ---------------------------------------------------------------------------

runDriverConformance(makeDriver, { label: 'ai-sdk driver (mock model)' });

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
  test('unknown provider throws BEFORE dispatch — no session record is created', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const sessionsDir = join(scratchDir, 'sessions');
      await mkdir(sessionsDir, { recursive: true });
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor(undefined) },
        sessionsDir,
      });
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'nope', model: 'm' } })),
      ).rejects.toThrow(/unknown provider 'nope'/);
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
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'anthropic', model: 'claude-haiku-4-5' } })),
      ).rejects.toThrow(/ANTHROPIC_API_KEY/);
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
      await expect(
        driver.run(invocation({ modelSpec: { provider: 'ai-sdk', model: 'glm-5.3-flash' } })),
      ).rejects.toThrow(/provider 'ai-sdk' requires ZAI_API_KEY/);
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
        outputSchema: z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
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

  test('a missing structured object is an error verdict carrying the cause, never a model score (#203)', async () => {
    const alwaysToolCalls = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => toolCallResult('read', { path: 'absent.txt' }),
    });
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => alwaysToolCalls },
        sessionsDir: join(scratchDir, 'sessions'),
        outputSchema: z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
      );
      expect(result.stopReason).toBe('error');
      expect(typeof result.error).toBe('string');
      // #210: the miss is machine-classifiable — the stable token prefixes
      // the bounded cause text; the parse cause still rides after it.
      expect(result.error?.startsWith('ai-sdk driver: [structured-output-miss]')).toBe(true);
      expect(result.error).toContain('structured output was not produced');
      // never a model score: no fabricated structuredOutput on an error verdict.
      expect(result.structuredOutput).toBeUndefined();
      // The usage is the REAL per-step fold from every completed step — an
      // error verdict reporting zeros after real work would be dishonest
      // evidence (8 steps × {100 in, 12 out, 15 cacheRead, 5 cacheWrite}).
      expect(result.usage).toEqual({ input: 800, output: 96, cacheRead: 120, cacheWrite: 40 });
      expect(result.costUSD).toBeUndefined(); // never fabricated on a non-complete run
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
        outputSchema: z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
      });
      // Per-step usage folds 132 tokens, so the 200 cap trips after step 2 and
      // the final step stays on tool-calls — the missing object is the cap's
      // consequence, not a driver failure.
      const result = await driver.run(
        invocation({
          toolPolicy: { allow: ['read'], mode: 'allowlist' },
          budget: { maxTokens: 200 },
        }),
      );
      expect(result.stopReason).toBe('budget');
      expect(result.error).toBeUndefined();
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
        outputSchema: z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
        pricing: () => ({ input: 3, output: 15 }),
      });
      const result = await driver.run(
        invocation({ toolPolicy: { allow: ['read'], mode: 'allowlist' } }),
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

  test('an endpoint header timeout is classified [endpoint-timeout] on the outer catch', async () => {
    const timeoutModel = new MockLanguageModelV4({
      modelId: 'mock-1',
      // The exact transient class #210 observed (glm-5.3-flash 3/5). After
      // maxRetries: 1 is exhausted the SDK rethrows a message naming the
      // attempts; a plain throw here exercises the same classifier branch.
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
      expect(result.error?.startsWith('ai-sdk driver: [endpoint-timeout] run failed —')).toBe(true);
      expect(result.error).toContain('Cannot connect to API: Headers Timeout Error');
      expect(result.structuredOutput).toBeUndefined();
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('a RETRYABLE endpoint timeout is retried once, then classified [endpoint-timeout] (#210)', async () => {
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
      expect(result.error?.startsWith('ai-sdk driver: [endpoint-timeout] run failed —')).toBe(true);
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
        outputSchema: z.object({ fixed: z.boolean(), notes: z.string() }).strict(),
        // A priced model DISCRIMINATES the inner carve-out (full-result usage +
        // derived cost) from the outer catch (partial fold, never fabricated
        // cost) — so the test proves the branch, not just the verdict.
        pricing: () => ({ input: 3, output: 15 }),
      });
      const outcome = await runLadder(
        () =>
          driver.run(
            invocation({
              toolPolicy: { allow: ['read'], mode: 'allowlist' },
              budget: { maxTokens: 1 },
            }),
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

  test('a non-transient failure is classified [provider-error] on the outer catch', async () => {
    const scratchDir = await mkdtemp(join(tmpdir(), 'aidrv-'));
    try {
      const driver = new AiSdkDriver({
        providers: { mock: () => modelFor({ kind: 'fail' }) },
        sessionsDir: join(scratchDir, 'sessions'),
      });
      const result = await driver.run(invocation());
      expect(result.stopReason).toBe('error');
      expect(result.error?.startsWith('ai-sdk driver: [provider-error] run failed —')).toBe(true);
      expect(result.error).toContain('scripted model failure');
    } finally {
      await rm(scratchDir, { recursive: true, force: true });
    }
  });

  test('classifyRunFailure: structured-output miss wins, then the transient class, else provider-error', () => {
    // The miss FIRST — even when the message would otherwise look transient.
    const missByName = Object.assign(new Error('No object generated: could not parse'), {
      name: 'NoObjectGeneratedError',
    });
    expect(classifyRunFailure(missByName)).toBe('structured-output-miss');
    expect(
      classifyRunFailure(Object.assign(new Error('no output'), { name: 'NoOutputGeneratedError' })),
    ).toBe('structured-output-miss');

    // The SDK-retryable transient class — message and name variants.
    expect(classifyRunFailure(new Error('Cannot connect to API: Headers Timeout Error'))).toBe(
      'endpoint-timeout',
    );
    expect(classifyRunFailure(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('endpoint-timeout');
    expect(classifyRunFailure(new Error('read ECONNRESET'))).toBe('endpoint-timeout');
    expect(classifyRunFailure(new Error('socket hang up'))).toBe('endpoint-timeout');
    expect(classifyRunFailure(new Error('fetch failed'))).toBe('endpoint-timeout');
    // The SDK step-timeout DOMException carries name TimeoutError; a bare
    // `timeout` substring in a provider message is NOT a transient signal.
    expect(
      classifyRunFailure(
        Object.assign(new Error('Step timeout of 120000ms exceeded'), { name: 'TimeoutError' }),
      ),
    ).toBe('endpoint-timeout');
    expect(classifyRunFailure(new Error('Step timeout of 120000ms exceeded'))).toBe(
      'provider-error',
    );
    expect(
      classifyRunFailure(Object.assign(new Error('timed out'), { name: 'TimeoutError' })),
    ).toBe('endpoint-timeout');

    // Anything else — including a bare abort with no timeout wording (the
    // governed abort is handled before this classifier).
    expect(classifyRunFailure(new Error('scripted model failure'))).toBe('provider-error');
    expect(classifyRunFailure(new Error('Request was aborted'))).toBe('provider-error');
    expect(classifyRunFailure(new Error('op prompt is over budget'))).toBe('provider-error');
    expect(classifyRunFailure('a plain string failure')).toBe('provider-error');
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
