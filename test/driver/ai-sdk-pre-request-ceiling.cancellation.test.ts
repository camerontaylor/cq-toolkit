// Split provenance: test/driver/ai-sdk-pre-request-ceiling.test.ts was split
// into ai-sdk-pre-request-ceiling.helpers.ts (shared fixtures) and seven
// subject files; this file carries the ceiling-unit cancellation subject and
// the refusal discriminant (§2).
import { describe, expect, test } from 'vitest';
import {
  PreRequestCeiling,
  PreRequestCeilingRefusal,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import type {
  PreRequestCeilingRefusalKind,
  PreRequestCeilingRefusalReason,
} from '../../src/driver/ai-sdk/pre-request-ceiling.js';
import { fakeCapability, userPrompt } from './ai-sdk-pre-request-ceiling.helpers.js';

// ---------------------------------------------------------------------------
// 2. The ceiling unit — cancellation outranks the ceiling (V1GX)
// ---------------------------------------------------------------------------

describe('PreRequestCeiling (unit)', () => {
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
