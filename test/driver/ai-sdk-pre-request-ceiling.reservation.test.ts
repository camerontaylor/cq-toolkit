// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures) and seven
// subject files; this file carries the ceiling-unit reservation subject:
// accounting, refusals, the shared allowance and overflow (§2).
import { describe, expect, test } from 'vitest';
import {
  PreRequestCeiling,
  serializeRequestForCounting,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import type { WireReservation } from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import {
  fakeCapability,
  invalidProviderOptions,
  reasonOfRefusal,
  refusalFrom,
  userPrompt,
} from './ai-sdk-pre-request-ceiling.helpers.js';

// ---------------------------------------------------------------------------
// 2. The ceiling unit — accounting, refusals, allowance and overflow
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
});
