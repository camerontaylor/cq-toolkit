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
import { describe, expect, test } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import { AiSdkDriver, stopReasonOf, usageFromSdk } from '../../src/driver/ai-sdk/index.js';
import type { AiSdkDriverOptions } from '../../src/driver/ai-sdk/index.js';
import { type ConformanceSpec, CONFORMANCE_PROVIDER, type ModelDirective, BANNED_VOCABULARY, SESSIONS_DIR, runDriverConformance } from './conformance.js';
import { WorkerResultSchema } from '../../src/kernel/schema.js';
import { defaultHarnessConfig } from '../../src/harness/config.js';
import type { OpInvocation } from '../../src/driver/types.js';

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
    content: [{ type: 'tool-call', toolCallId: 'conformance-call-1', toolName: tool, input: JSON.stringify(input) }],
    finishReason: { unified: 'tool-calls', raw: undefined },
    usage: mockUsage(),
    warnings: [],
  };
}

/**
 * Build the mock model for one directive (see conformance.ts for the script
 * contract). `servedModel` threads the factory's modelId so the mock's
 * response reports the REQUESTED id as served — the observed-model fact
 * WorkerResult.model carries.
 */
function modelFor(directive: ModelDirective | undefined, servedModel?: string): MockLanguageModelV4 {
  switch (directive?.kind) {
    case 'block-until-abort': {
      const abortError = (): Error =>
        Object.assign(new Error('run aborted by the governed signal'), { name: 'AbortError' });
      return new MockLanguageModelV4({
        modelId: servedModel,
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
        modelId: servedModel,
        doGenerate: async () => {
          throw new Error('scripted model failure');
        },
      });
    case 'tool-then-reply':
      return new MockLanguageModelV4({
        modelId: servedModel,
        doGenerate: [toolCallResult(directive.tool, directive.input), textResult(directive.reply)],
      });
    default:
      return new MockLanguageModelV4({ modelId: servedModel, doGenerate: textResult(directive?.text ?? 'ok') });
  }
}

/** Conformance harness config: the conformance write permitted via an anchored re: pattern (token patterns deny redirects by design); workspaces inside scratchDir. */
function conformanceHarnessConfig(scratchDir: string): AiSdkDriverOptions['harnessConfig'] {
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
      const driver = new AiSdkDriver({ providers: { mock: () => modelFor(undefined) }, sessionsDir });
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

  test('stopReason mapping table (checked in order: aborted → budget → error → complete)', () => {
    // 1. abort dominates every other condition.
    expect(stopReasonOf({ finishReason: 'length', aborted: true, tokenBudget: 10, totalTokens: 99 })).toBe('aborted');
    expect(stopReasonOf({ finishReason: 'error', aborted: true, tokenBudget: undefined, totalTokens: 0 })).toBe('aborted');
    // 2. the token budget (totalTokens >= maxTokens) trips before finish reasons.
    expect(stopReasonOf({ finishReason: 'stop', aborted: false, tokenBudget: 10, totalTokens: 10 })).toBe('budget');
    expect(stopReasonOf({ finishReason: 'tool-calls', aborted: false, tokenBudget: 10, totalTokens: 11 })).toBe('budget');
    // 3. SDK 'length' is a budget stop even without an explicit cap.
    expect(stopReasonOf({ finishReason: 'length', aborted: false, tokenBudget: undefined, totalTokens: 5 })).toBe('budget');
    // 4. SDK error / content-filter are driver-level errors.
    expect(stopReasonOf({ finishReason: 'error', aborted: false, tokenBudget: undefined, totalTokens: 0 })).toBe('error');
    expect(stopReasonOf({ finishReason: 'content-filter', aborted: false, tokenBudget: undefined, totalTokens: 0 })).toBe('error');
    // 5. everything else is a normal completion.
    expect(stopReasonOf({ finishReason: 'stop', aborted: false, tokenBudget: undefined, totalTokens: 0 })).toBe('complete');
    expect(stopReasonOf({ finishReason: 'tool-calls', aborted: false, tokenBudget: undefined, totalTokens: 0 })).toBe('complete');
    expect(stopReasonOf({ finishReason: 'other', aborted: false, tokenBudget: undefined, totalTokens: 0 })).toBe('complete');
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
        inputTokenDetails: { noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined },
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
        providers: { anthropic: () => modelFor({ kind: 'reply', text: 'ok' }) },
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
});

// ---------------------------------------------------------------------------
// 3. LIVE variant — opt-in only (LIVE_DRIVERS=1); real provider registry, tiny prompts
// ---------------------------------------------------------------------------

const liveCases: ReadonlyArray<[provider: string, model: string, keyName: string]> = [
  ['anthropic', 'claude-haiku-4-5', 'ANTHROPIC_API_KEY'],
  ['deepseek', 'deepseek-chat', 'DEEPSEEK_API_KEY'],
];

describe.skipIf(!process.env.LIVE_DRIVERS)('live ai-sdk driver (opt-in: LIVE_DRIVERS=1)', () => {
  test.each(liveCases)('%s %s replies within the budget cap', async (provider, model, keyName) => {
    if (process.env[keyName] === undefined || process.env[keyName] === '') {
      throw new Error(`LIVE_DRIVERS=1 but ${keyName} is not set — refusing to silently skip one leg`);
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
    // costUSD is derived-only: present exactly when the price map knows the
    // model — both live models are on the map, and the run must stay far
    // under the declared 2 USD cap.
    expect(parsed.costUSD).toBeDefined();
    expect(parsed.costUSD as number).toBeLessThan(2);
  }, 60_000);
});
