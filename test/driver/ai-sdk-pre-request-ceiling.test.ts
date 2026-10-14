// The ai-sdk lane's STRICT pre-request token ceiling (pre-request-ceiling.ts)
// — focused unit + driver tests with a fake model and an INJECTED capability.
// No provider, no network. The driver ships NO built-in capability, so these
// tests supply one explicitly; the "no injection => refuse" legs pin that.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  isPreRequestCeilingRefusal,
  PreRequestCeiling,
  PreRequestCeilingRefusal,
  serializeRequestForCounting,
  UnrepresentableRequestError,
  wrapWithPreRequestCeiling,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import type {
  PreRequestCeilingRefusalReason,
  StrictTokenCapability,
  WireReservation,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { createDriverFactory } from '../../src/driver/factory.js';
import { DispatchError, errorClassOf } from '../../src/driver/errors.js';
import type { OpInvocation } from '../../src/driver/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A trusted test capability: utf8 byte count + applies maxOutputTokens. */
function fakeCapability(overrides: Partial<StrictTokenCapability> = {}): StrictTokenCapability {
  return {
    provenance: 'test:utf8-byte-count',
    count: (serialized) => Buffer.byteLength(serialized, 'utf8'),
    withOutputCeiling: (params, reserveOutputTokens) => ({
      ...params,
      maxOutputTokens: reserveOutputTokens,
    }),
    ...overrides,
  };
}

function userPrompt(text: string) {
  return { prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text }] }] };
}

function mockUsage(): LanguageModelV4GenerateResult['usage'] {
  return {
    inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 4, text: 4, reasoning: 0 },
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

/** A retryable provider error (the SDK's own retryable class). */
function retryableApiError(): APICallError {
  return new APICallError({
    message: 'endpoint hiccup',
    url: 'https://example.invalid/v1/messages',
    requestBodyValues: {},
    statusCode: 503,
    isRetryable: true,
  });
}

function invocation(overrides: Partial<OpInvocation> = {}): OpInvocation {
  return {
    prompt: 'strict ceiling run',
    modelSpec: { provider: 'anthropic', model: 'claude-test' },
    toolPolicy: { allow: [], mode: 'none' },
    sandboxPolicy: { level: 'none' },
    budget: {},
    ...overrides,
  };
}

async function refusalFrom(fn: () => Promise<unknown>): Promise<PreRequestCeilingRefusal> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof PreRequestCeilingRefusal) return err;
    throw err;
  }
  throw new Error('expected a PreRequestCeilingRefusal');
}

function reasonOfRefusal(err: PreRequestCeilingRefusal): PreRequestCeilingRefusalReason {
  return err.reason;
}

// ---------------------------------------------------------------------------
// 1. Serialization — complete params, deterministic, fail closed
// ---------------------------------------------------------------------------

describe('serializeRequestForCounting', () => {
  test('carries prompt, tools, response format, providerOptions, and token-relevant settings', () => {
    const serialized = serializeRequestForCounting({
      prompt: [
        { role: 'system', content: 'SYSTEM-MARKER' },
        { role: 'user', content: [{ type: 'text', text: 'USER-MARKER' }] },
      ],
      tools: [
        { type: 'function', name: 'TOOL-MARKER', inputSchema: { type: 'object', properties: {} } },
      ],
      toolChoice: { type: 'tool', toolName: 'TOOL-MARKER' },
      responseFormat: { type: 'json', name: 'RESPONSE-MARKER' },
      providerOptions: { anthropic: { instructions: 'PROVIDER-OPTIONS-MARKER' } },
      reasoning: 'high',
      stopSequences: ['STOP-MARKER'],
    });
    for (const marker of [
      'SYSTEM-MARKER',
      'USER-MARKER',
      'TOOL-MARKER',
      'RESPONSE-MARKER',
      'PROVIDER-OPTIONS-MARKER',
      '"reasoning":"high"',
      'STOP-MARKER',
    ]) {
      expect(serialized).toContain(marker);
    }
  });

  test('never serializes credential headers', () => {
    const serialized = serializeRequestForCounting({
      prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      headers: { authorization: 'Bearer SUPER-SECRET', 'x-api-key': 'SECRET-KEY' },
    });
    expect(serialized).not.toContain('SUPER-SECRET');
    expect(serialized).not.toContain('SECRET-KEY');
  });

  test('fails closed on a cyclic providerOptions shape', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: { provider: cyclic },
      }),
    ).toThrow(UnrepresentableRequestError);
  });

  test('fails closed on a bigint or function in providerOptions', () => {
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: { provider: { n: 1n } },
      }),
    ).toThrow(UnrepresentableRequestError);
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: { provider: { fn: () => 1 } },
      }),
    ).toThrow(UnrepresentableRequestError);
  });
});

// ---------------------------------------------------------------------------
// 2. The ceiling unit
// ---------------------------------------------------------------------------

describe('PreRequestCeiling (unit)', () => {
  test('applies the output ceiling FIRST, then counts the exact prepared request', async () => {
    const marker = 'INJECTED-AFTER-CEILING';
    const capability = fakeCapability({
      withOutputCeiling: (params, reserveOutputTokens) => ({
        ...params,
        maxOutputTokens: reserveOutputTokens,
        providerOptions: { injected: marker },
      }),
    });
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability,
    });
    const params = userPrompt('hello');
    const prepared = await ceiling.reserve(params);
    expect(prepared.maxOutputTokens).toBe(64);
    // The count covers the injected text: it is the serialization of what will
    // be sent, not of the pre-transform params.
    const expected = Buffer.byteLength(
      serializeRequestForCounting({
        ...params,
        maxOutputTokens: 64,
        providerOptions: { injected: marker },
      }),
      'utf8',
    );
    expect(ceiling.reservedTokens).toBe(expected + 64);
    const preTransform = Buffer.byteLength(serializeRequestForCounting(params), 'utf8');
    expect(expected).toBeGreaterThan(preTransform);
  });

  test('accumulates cumulatively across requests', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 100 },
      capability: fakeCapability(),
    });
    const params = userPrompt('hello');
    // The count is over the PREPARED request (the output ceiling is applied
    // before counting), so include it in the expectation.
    const counted = Buffer.byteLength(
      serializeRequestForCounting({ ...params, maxOutputTokens: 100 }),
      'utf8',
    );
    await ceiling.reserve(params);
    expect(ceiling.reservedTokens).toBe(counted + 100);
    expect(ceiling.requestCount).toBe(1);
    await ceiling.reserve(params);
    expect(ceiling.requestCount).toBe(2);
    expect(ceiling.reservedTokens).toBe(2 * (counted + 100));
  });

  test('refuses a request over the input ceiling and does not reserve', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 8, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const err = await refusalFrom(() => ceiling.reserve(userPrompt('far too long')));
    expect(reasonOfRefusal(err)).toBe('input-ceiling');
    expect(ceiling.reservedTokens).toBe(0);
    expect(ceiling.requestCount).toBe(0);
  });

  test('refuses a request whose existing output ceiling exceeds the reserve', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const err = await refusalFrom(() =>
      ceiling.reserve({ ...userPrompt('hi'), maxOutputTokens: 500 }),
    );
    expect(reasonOfRefusal(err)).toBe('output-reserve');
  });

  test('refuses when the capability does not apply an output ceiling', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability({ withOutputCeiling: (params) => params }),
    });
    const err = await refusalFrom(() => ceiling.reserve(userPrompt('hi')));
    expect(reasonOfRefusal(err)).toBe('output-ceiling-not-applied');
  });

  test('refuses when the capability throws on a shape it cannot bound', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability({
        count: () => {
          throw new Error('unbounded multimodal input');
        },
      }),
    });
    const err = await refusalFrom(() => ceiling.reserve(userPrompt('hi')));
    expect(reasonOfRefusal(err)).toBe('uncountable-request');
  });

  test('refuses a cyclic request as unrepresentable', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const err = await refusalFrom(() =>
      ceiling.reserve({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: { provider: cyclic },
      }),
    );
    expect(reasonOfRefusal(err)).toBe('unrepresentable-request');
  });

  test('refuses a cumulative reservation that exceeds the shared whole-job allowance', async () => {
    const params = userPrompt('hi');
    const perRequest =
      Buffer.byteLength(serializeRequestForCounting({ ...params, maxOutputTokens: 64 }), 'utf8') +
      64;
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      wholeJobTokenAllowance: perRequest,
    });
    await ceiling.reserve(params); // fits exactly
    const err = await refusalFrom(() => ceiling.reserve(params));
    expect(reasonOfRefusal(err)).toBe('whole-job-allowance');
    // No refunds: the first reservation still stands.
    expect(ceiling.reservedTokens).toBe(perRequest);
    expect(ceiling.requestCount).toBe(1);
  });

  test('calls the durable hook AFTER the local commit, with model identity and a request digest', async () => {
    let seen: WireReservation | undefined;
    let reservedWhenCalled = -1;
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      modelSpec: { provider: 'anthropic', model: 'claude-test' },
      onBeforeWireReserve: (receipt) => {
        seen = receipt;
        reservedWhenCalled = ceiling.reservedTokens;
      },
    });
    const params = userPrompt('hi');
    const counted = Buffer.byteLength(
      serializeRequestForCounting({ ...params, maxOutputTokens: 64 }),
      'utf8',
    );
    await ceiling.reserve(params);
    expect(seen?.tokens).toBe(counted + 64);
    expect(seen?.cumulativeTokens).toBe(counted + 64);
    expect(seen?.countedInput).toBe(counted);
    expect(seen?.reserveOutputTokens).toBe(64);
    expect(seen?.provider).toBe('anthropic');
    expect(seen?.model).toBe('claude-test');
    expect(seen?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    // The local charge was already committed when the hook ran.
    expect(reservedWhenCalled).toBe(counted + 64);
  });

  test('refuses when the durable hook throws, but keeps the local charge (no refund)', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: () => {
        throw new Error('ledger unavailable');
      },
    });
    const err = await refusalFrom(() => ceiling.reserve(userPrompt('hi')));
    expect(reasonOfRefusal(err)).toBe('reservation-not-written');
    expect(ceiling.requestCount).toBe(1);
    expect(ceiling.reservedTokens).toBeGreaterThan(0);
  });

  test('concurrent reserves cannot overrun the shared allowance (commit precedes the await)', async () => {
    const params = userPrompt('hi');
    const perRequest =
      Buffer.byteLength(serializeRequestForCounting({ ...params, maxOutputTokens: 64 }), 'utf8') +
      64;
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      wholeJobTokenAllowance: perRequest,
      // An async hook yields between the check and the wire; the local charge
      // must already be committed so the second call sees it.
      onBeforeWireReserve: async () => {
        await Promise.resolve();
      },
    });
    const results = await Promise.allSettled([ceiling.reserve(params), ceiling.reserve(params)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(ceiling.requestCount).toBe(1);
    expect(ceiling.reservedTokens).toBe(perRequest);
  });

  test('refuses an applied output ceiling that is not a safe positive integer', async () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const ceiling = new PreRequestCeiling({
        budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
        capability: fakeCapability({
          withOutputCeiling: (params) => ({ ...params, maxOutputTokens: bad }),
        }),
      });
      expect(reasonOfRefusal(await refusalFrom(() => ceiling.reserve(userPrompt('hi'))))).toBe(
        'output-ceiling-not-applied',
      );
    }
  });

  test('refuses an original output ceiling that is not a safe positive integer', async () => {
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const ceiling = new PreRequestCeiling({
        budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
        capability: fakeCapability(),
      });
      expect(
        reasonOfRefusal(
          await refusalFrom(() => ceiling.reserve({ ...userPrompt('hi'), maxOutputTokens: bad })),
        ),
      ).toBe('output-reserve');
    }
  });

  test('rejects unsafe-integer binds and counts, and overflow at every addition', async () => {
    expect(
      () =>
        new PreRequestCeiling({
          budget: { maxInputTokens: 2 ** 53, reserveOutputTokens: 64 },
          capability: fakeCapability(),
        }),
    ).toThrow(/maxInputTokens/);
    expect(
      () =>
        new PreRequestCeiling({
          budget: { maxInputTokens: 10, reserveOutputTokens: 0 },
          capability: fakeCapability(),
        }),
    ).toThrow(/reserveOutputTokens/);
    const unsafeCount = new PreRequestCeiling({
      budget: { maxInputTokens: Number.MAX_SAFE_INTEGER, reserveOutputTokens: 1 },
      capability: fakeCapability({ count: () => 2 ** 53 }),
    });
    expect(reasonOfRefusal(await refusalFrom(() => unsafeCount.reserve(userPrompt('hi'))))).toBe(
      'uncountable-request',
    );
    // input = MAX_SAFE, reserve 1 → the addition itself is unsafe.
    const overflow = new PreRequestCeiling({
      budget: { maxInputTokens: Number.MAX_SAFE_INTEGER, reserveOutputTokens: 1 },
      capability: fakeCapability({ count: () => Number.MAX_SAFE_INTEGER }),
    });
    expect(reasonOfRefusal(await refusalFrom(() => overflow.reserve(userPrompt('hi'))))).toBe(
      'reservation-overflow',
    );
  });
});

// ---------------------------------------------------------------------------
// 3. The SDK transport seam — the retry re-enters the wrapper (verified claim)
// ---------------------------------------------------------------------------

describe('pre-request ceiling on the SDK transport seam', () => {
  test('one SDK retry re-enters the middleware: requestCount === 2, no duplicate retry', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 32 },
      capability: fakeCapability(),
    });
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        if (calls === 1) throw retryableApiError();
        return textResult('ok');
      },
    });
    const result = await generateText({
      model: wrapWithPreRequestCeiling(mock, ceiling),
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 1,
    });
    expect(result.text).toBe('ok');
    expect(calls).toBe(2); // the SDK retried once...
    expect(ceiling.requestCount).toBe(2); // ...and the retry re-entered the ceiling
    expect(ceiling.reservedTokens).toBeGreaterThan(0);
  });

  test('without a retry the ceiling counts exactly one attempt', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 32 },
      capability: fakeCapability(),
    });
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        return textResult('ok');
      },
    });
    await generateText({
      model: wrapWithPreRequestCeiling(mock, ceiling),
      messages: [{ role: 'user', content: 'hi' }],
      maxRetries: 1,
    });
    expect(calls).toBe(1);
    expect(ceiling.requestCount).toBe(1);
  });

  test('a refusal is not retried and the model is never called', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 4, reserveOutputTokens: 32 },
      capability: fakeCapability(),
    });
    let calls = 0;
    const mock = new MockLanguageModelV4({
      modelId: 'mock-1',
      doGenerate: async () => {
        calls += 1;
        return textResult('ok');
      },
    });
    try {
      await generateText({
        model: wrapWithPreRequestCeiling(mock, ceiling),
        messages: [{ role: 'user', content: 'this request is far over the tiny ceiling' }],
        maxRetries: 1,
      });
      throw new Error('expected a refusal');
    } catch (err) {
      expect(isPreRequestCeilingRefusal(err)).toBe(true);
    }
    expect(calls).toBe(0);
    expect(ceiling.requestCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 4. Driver integration — injected capability, no built-in
// ---------------------------------------------------------------------------

describe('ai-sdk driver strictTokenBudget', () => {
  test('refuses pre-dispatch when no capability is injected — no session is created', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-none-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          mock: () => new MockLanguageModelV4({ modelId: 'mock-1', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
      });
      let caught: unknown;
      try {
        await driver.run(
          invocation({
            modelSpec: { provider: 'mock', model: 'mock-1' },
            budget: { strictTokenBudget: { maxInputTokens: 1000, reserveOutputTokens: 64 } },
          }),
        );
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(DispatchError);
      expect(errorClassOf(caught)).toBe('config');
      expect((caught as Error).message).toContain('no trusted token capability');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('applies the output wire ceiling and completes when the request fits', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-apply-'));
    try {
      let seenMaxOutputTokens: number | undefined;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async (options) => {
                seenMaxOutputTokens = options.maxOutputTokens;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(seenMaxOutputTokens).toBe(64);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a request over the input ceiling settles stopReason budget and never calls the model', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-cap-'));
    try {
      let calls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async () => {
                calls += 1;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 8, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('budget');
      expect(calls).toBe(0);
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a request that exceeds the shared whole-job reservation settles budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-shared-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { reservation: { id: 'r1', tokens: 1, overshootUsd: 0, class: 'hard' } },
      );
      expect(result.stopReason).toBe('budget');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('soft maxTokens is unchanged when strictTokenBudget is absent (no redefinition)', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-soft-'));
    try {
      let calls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async () => {
                calls += 1;
                return textResult('ok');
              },
            }),
        },
        sessionsDir: join(scratch, 'sessions'),
      });
      // A soft cap with no strict budget still dispatches and lets the
      // completed-step fold classify the run — the old semantics.
      const result = await driver.run(invocation({ budget: { maxTokens: 1 } }));
      expect(calls).toBe(1);
      expect(result.stopReason).toBe('budget');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('the driver passes model identity and a request digest to the durable hook', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-hook-'));
    try {
      let seen: WireReservation | undefined;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        strictTokenReservationHook: (receipt) => {
          seen = receipt;
        },
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(seen?.provider).toBe('anthropic');
      expect(seen?.model).toBe('claude-test');
      expect(seen?.reserveOutputTokens).toBe(64);
      expect(seen?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('the factory lane config plumbs the capability and durable hook to the driver', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-factory-'));
    try {
      let seen: WireReservation | undefined;
      const factory = createDriverFactory({
        sessionsDir: join(scratch, 'sessions'),
        lanes: {
          aiSdk: {
            providers: {
              anthropic: () =>
                new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
            },
            strictTokenCapability: () => fakeCapability(),
            strictTokenReservationHook: (receipt) => {
              seen = receipt;
            },
          },
        },
      });
      const { driver } = factory.resolve({
        role: 'fixer',
        modelSpec: { provider: 'anthropic', model: 'claude-test' },
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('complete');
      expect(seen?.requestDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
