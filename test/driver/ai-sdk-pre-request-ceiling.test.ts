// The ai-sdk lane's STRICT pre-request token ceiling (pre-request-ceiling.ts)
// — focused unit + driver tests with a fake model and an INJECTED capability.
// No provider, no network. The driver ships NO built-in capability, so these
// tests supply one explicitly; the "no injection => refuse" legs pin that.
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { generateText } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import { z } from 'zod';
import { APICallError } from '@ai-sdk/provider';
import type { LanguageModelV4CallOptions, LanguageModelV4GenerateResult } from '@ai-sdk/provider';
import {
  isPreRequestCeilingRefusal,
  PreRequestCeiling,
  PreRequestCeilingRefusal,
  serializeRequestForCounting,
  UnrepresentableRequestError,
  wrapWithPreRequestCeiling,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import type {
  PreRequestCeilingRefusalKind,
  PreRequestCeilingRefusalReason,
  StrictTokenCapability,
  WireReservation,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import { AiSdkDriver } from '../../src/driver/ai-sdk/index.js';
import { toOutputSchema } from '../../src/driver/common/structured.js';
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

/** The mutable text part of a probe prompt (index-safe for the mutation tests). */
function firstTextPart(params: { prompt: unknown }): { text: string } {
  const prompt = params.prompt as Array<{ content: Array<{ text?: string }> }>;
  const part = prompt[0]?.content[0];
  if (part === undefined || typeof part.text !== 'string') {
    throw new Error('probe prompt has no text part');
  }
  return part as { text: string };
}

/**
 * A deliberately JSON-INVALID providerOptions payload for the fail-closed
 * legs only (a cycle, a bigint, a function). The RUNTIME guard — the
 * fail-closed serializer or structuredClone — is what must reject it; this
 * narrow, test-only assertion is how a JSON-invalid value reaches that guard.
 * Never used for a fixture that is expected to serialize.
 */
function invalidProviderOptions(
  value: unknown,
): NonNullable<LanguageModelV4CallOptions['providerOptions']> {
  return value as NonNullable<LanguageModelV4CallOptions['providerOptions']>;
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
        providerOptions: invalidProviderOptions({ provider: cyclic }),
      }),
    ).toThrow(UnrepresentableRequestError);
  });

  test('fails closed on a bigint or function in providerOptions', () => {
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: invalidProviderOptions({ provider: { n: 1n } }),
      }),
    ).toThrow(UnrepresentableRequestError);
    expect(() =>
      serializeRequestForCounting({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: invalidProviderOptions({ provider: { fn: () => 1 } }),
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
        providerOptions: { injected: { marker } },
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
        providerOptions: { injected: { marker } },
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
        providerOptions: invalidProviderOptions({ provider: cyclic }),
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
    expect(seen?.countableProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
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

  test('a delayed hook mutating nested prompt cannot change the returned/counted request', async () => {
    const params = userPrompt('ORIGINAL-TEXT');
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        firstTextPart(params).text = 'MUTATED-DURING-AWAIT';
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(JSON.stringify(returned)).not.toContain('MUTATED-DURING-AWAIT');
    expect(JSON.stringify(returned.prompt)).toContain('ORIGINAL-TEXT');
    expect(ceiling.reservedTokens).toBe(
      Buffer.byteLength(serializeRequestForCounting(returned), 'utf8') + 64,
    );
  });

  test('a delayed hook mutating the output cap cannot change the returned snapshot', async () => {
    const params = userPrompt('hi');
    const mutable = params as { maxOutputTokens?: number };
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        mutable.maxOutputTokens = 1;
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(returned.maxOutputTokens).toBe(64);
  });

  test('a delayed hook mutating nested tools cannot change the returned/counted request', async () => {
    const params = {
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      tools: [
        {
          type: 'function' as const,
          name: 'read',
          description: 'ORIGINAL-TOOL-DESC',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    };
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        const tool = params.tools[0];
        if (tool !== undefined) tool.description = 'MUTATED-TOOL-DESC';
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(JSON.stringify(returned.tools)).toContain('ORIGINAL-TOOL-DESC');
    expect(JSON.stringify(returned.tools)).not.toContain('MUTATED-TOOL-DESC');
    expect(ceiling.reservedTokens).toBe(
      Buffer.byteLength(serializeRequestForCounting(returned), 'utf8') + 64,
    );
  });

  test('a delayed hook mutating nested providerOptions cannot change the returned/counted request', async () => {
    const params = {
      prompt: [{ role: 'user' as const, content: [{ type: 'text' as const, text: 'hi' }] }],
      providerOptions: { provider: { marker: 'ORIGINAL-OPT' } },
    };
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: async () => {
        params.providerOptions.provider.marker = 'MUTATED-OPT';
        await Promise.resolve();
      },
    });
    const returned = await ceiling.reserve(params);
    expect(JSON.stringify(returned.providerOptions)).toContain('ORIGINAL-OPT');
    expect(JSON.stringify(returned.providerOptions)).not.toContain('MUTATED-OPT');
    expect(ceiling.reservedTokens).toBe(
      Buffer.byteLength(serializeRequestForCounting(returned), 'utf8') + 64,
    );
  });

  test('the returned snapshot is frozen: counted fields cannot be mutated', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const returned = await ceiling.reserve(userPrompt('hi'));
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.prompt)).toBe(true);
    expect(() => {
      (returned as { maxOutputTokens?: number }).maxOutputTokens = 1;
    }).toThrow();
  });

  test('refuses a request whose counted fields structuredClone cannot clone', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const err = await refusalFrom(() =>
      ceiling.reserve({
        prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
        providerOptions: invalidProviderOptions({ provider: { fn: () => 1 } }),
      }),
    );
    expect(reasonOfRefusal(err)).toBe('unrepresentable-request');
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
      ).toBe('output-ceiling-invalid');
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

  // -------------------------------------------------------------------------
  // Cancellation outranks the ceiling (V1GX) and the refusal discriminant (V1Gf)
  // -------------------------------------------------------------------------

  test('classifies ONLY the real caps as budget; every infra reason as error', () => {
    const kindOf = (reason: PreRequestCeilingRefusalReason): PreRequestCeilingRefusalKind =>
      new PreRequestCeilingRefusal(reason, 'probe', {
        countedInput: 0,
        reserved: 0,
        cumulativeReserved: 0,
      }).kind;
    for (const reason of ['input-ceiling', 'output-reserve', 'whole-job-allowance'] as const) {
      expect(kindOf(reason)).toBe('budget');
    }
    for (const reason of [
      'output-ceiling-invalid',
      'output-ceiling-not-applied',
      'unrepresentable-request',
      'uncountable-request',
      'reservation-overflow',
      'reservation-not-written',
      'request-mutated',
    ] as const) {
      expect(kindOf(reason)).toBe('error');
    }
  });

  test('a pre-aborted run signal refuses before counting or charging (no send)', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const controller = new AbortController();
    controller.abort();
    const err = await ceiling
      .reserve({ ...userPrompt('hi'), abortSignal: controller.signal })
      .catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(ceiling.requestCount).toBe(0);
    expect(ceiling.reservedTokens).toBe(0);
  });

  test('an abort during a NEVER-SETTLING durable hook settles cancellation and keeps the charge', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: () => new Promise<void>(() => {}),
    });
    const controller = new AbortController();
    const pending = ceiling.reserve({ ...userPrompt('hi'), abortSignal: controller.signal });
    // Let the reserve reach its hook await, then fire the governor's abort.
    await Promise.resolve();
    controller.abort();
    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    // No refund: the local charge committed before the hook still stands.
    expect(ceiling.requestCount).toBe(1);
    expect(ceiling.reservedTokens).toBeGreaterThan(0);
  });

  test('a hook that resolves AFTER abort cannot wire the request (late resolution ignored)', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
      onBeforeWireReserve: () => gate,
    });
    const controller = new AbortController();
    const pending = ceiling.reserve({ ...userPrompt('hi'), abortSignal: controller.signal });
    await Promise.resolve();
    controller.abort();
    // The orphaned hook settles only AFTER the abort: the race is already
    // rejected, so no params are ever returned for the wire.
    release();
    const err = await pending.catch((e: unknown) => e);
    expect((err as Error).name).toBe('AbortError');
    expect(ceiling.requestCount).toBe(1);
  });

  test('a non-AbortError abort reason is normalized to AbortError with the reason as cause (never mutated)', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const reason = new Error('governor stopped the step');
    const controller = new AbortController();
    controller.abort(reason);
    const err = (await ceiling
      .reserve({ ...userPrompt('hi'), abortSignal: controller.signal })
      .catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AbortError');
    expect(err.cause).toBe(reason);
    // The reason itself is untouched (name/identity preserved).
    expect(reason.name).toBe('Error');
    expect(ceiling.requestCount).toBe(0);
  });

  test('a FROZEN abort reason is never mutated; the AbortError carries it as cause', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const reason = Object.freeze(new Error('frozen governor reason'));
    const controller = new AbortController();
    controller.abort(reason);
    const err = (await ceiling
      .reserve({ ...userPrompt('hi'), abortSignal: controller.signal })
      .catch((e: unknown) => e)) as Error;
    expect(Object.isFrozen(reason)).toBe(true);
    expect(err.name).toBe('AbortError');
    expect(err.cause).toBe(reason);
  });

  test('a TimeoutError-named abort reason (a governed step abort) still settles as an abort', async () => {
    const ceiling = new PreRequestCeiling({
      budget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 },
      capability: fakeCapability(),
    });
    const reason = new Error('step timed out');
    reason.name = 'TimeoutError';
    const controller = new AbortController();
    controller.abort(reason);
    const err = (await ceiling
      .reserve({ ...userPrompt('hi'), abortSignal: controller.signal })
      .catch((e: unknown) => e)) as Error;
    expect(err.name).toBe('AbortError');
    expect(err.cause).toBe(reason);
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
      expect(seen?.countableProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
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
      expect(seen?.countableProjectionDigest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a governed abort during a hung durable reservation hook settles aborted, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-hung-hook-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        // A hook that NEVER settles: without abort-awareness the run hangs here.
        strictTokenReservationHook: () => new Promise<void>(() => {}),
      });
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 20);
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { signal: controller.signal },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a mid-run governed abort with a NON-abort Error reason settles aborted, not error', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-abort-reason-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        strictTokenReservationHook: () => new Promise<void>(() => {}),
      });
      const controller = new AbortController();
      // A generic Error reason (not an AbortError): the ceiling must still
      // normalize the cancellation and the run must settle 'aborted'.
      setTimeout(() => controller.abort(new Error('governor stopped the run')), 20);
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { signal: controller.signal },
      );
      expect(result.stopReason).toBe('aborted');
      expect(result.error).toBeUndefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a capability that cannot count the request settles a diagnostic error, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-infra-count-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () =>
          fakeCapability({
            count: () => {
              throw new Error('unbounded multimodal input');
            },
          }),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBeDefined();
      expect(result.error).toContain('infrastructure');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a durable hook failure settles a diagnostic error, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-infra-hook-'));
    try {
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('ok') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
        strictTokenReservationHook: () => {
          throw new Error('ledger unavailable');
        },
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBeDefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('an infrastructure refusal on the REPAIR request settles error, not budget', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-repair-infra-'));
    try {
      let countCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () =>
            // Both the main call and the repair reply with non-JSON text, so the
            // main call settles a structured miss and the repair is attempted.
            new MockLanguageModelV4({ modelId: 'claude-test', doGenerate: textResult('not json') }),
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () =>
          fakeCapability({
            count: (serialized) => {
              countCalls += 1;
              if (countCalls === 1) return Buffer.byteLength(serialized, 'utf8');
              throw new Error('repair count unavailable');
            },
          }),
      });
      const result = await driver.run(
        invocation({
          outputSchema: toOutputSchema(
            'conformance/repair-infra/v1',
            z.object({ answer: z.string() }).strict(),
          ),
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
      );
      expect(countCalls).toBeGreaterThanOrEqual(2);
      expect(result.stopReason).toBe('error');
      expect(result.errorClass).toBeDefined();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });

  test('a provider factory that SYNCHRONOUSLY aborts mid-setup settles aborted (late recheck), no dispatch', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'aidrv-strict-midsetup-abort-'));
    try {
      const controller = new AbortController();
      let factoryCalls = 0;
      let generateCalls = 0;
      const driver = new AiSdkDriver({
        providers: {
          anthropic: () => {
            factoryCalls += 1;
            // A SYNCHRONOUS provider-factory abort: the ENTRY check already
            // passed, so only the LATE live recheck can catch this before the
            // wire. The factory still resolves a model instance.
            controller.abort();
            return new MockLanguageModelV4({
              modelId: 'claude-test',
              doGenerate: async () => {
                generateCalls += 1;
                return textResult('ok');
              },
            });
          },
        },
        sessionsDir: join(scratch, 'sessions'),
        strictTokenCapability: () => fakeCapability(),
      });
      const result = await driver.run(
        invocation({
          budget: { strictTokenBudget: { maxInputTokens: 1_000_000, reserveOutputTokens: 64 } },
        }),
        { signal: controller.signal },
      );
      expect(factoryCalls).toBe(1);
      expect(generateCalls).toBe(0);
      expect(result.stopReason).toBe('aborted');
      expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      expect(result.error).toBeUndefined();
      expect(existsSync(join(scratch, 'sessions'))).toBe(false);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// The public manifest contract: a declaration the root barrel RE-EXPORTS
// (AiSdkDriverOptions -> StrictTokenCapability -> LanguageModelV4CallOptions)
// reaches '@ai-sdk/provider', so that package must be a RUNTIME dependency a
// consumer install links — a devDependency makes an isolated pnpm consumer's
// TS resolution of the shipped .d.ts fail (TS2307).
// ---------------------------------------------------------------------------

/** A JSON-ish field read with an explicit `unknown` boundary (JSON.parse returns any). */
function manifestField(value: unknown, key: string): unknown {
  if (typeof value !== 'object' || value === null) return undefined;
  return (value as Record<string, unknown>)[key];
}

describe('package manifest — the strict ceiling public dependency', () => {
  test('@ai-sdk/provider is a runtime dependency pin, not a devDependency', async () => {
    const raw: unknown = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    );
    const dependencies = manifestField(raw, 'dependencies');
    const devDependencies = manifestField(raw, 'devDependencies');
    // Pinned same version the runtime @ai-sdk/* tree already resolves.
    expect(manifestField(dependencies, '@ai-sdk/provider')).toBe('4.0.14');
    expect(manifestField(devDependencies, '@ai-sdk/provider')).toBeUndefined();
  });
});
