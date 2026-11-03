// Split provenance: test/kernel/types.test.ts was split by subject; this file
// holds the WorkerResult wire contract (error, errorClass, providerSignals).
// Sibling subjects: types.roundtrip.test.ts, types.encoded-couplings.test.ts,
// types.mirror-tightenings.test.ts, types.seam.test.ts,
// types.dispatch-errors.test.ts; shared fixtures live in types.helpers.ts.
import { describe, expect, test } from 'vitest';
import * as kernelSchema from '../../src/kernel/schema.js';
import { failsParse, roundTripsThrough } from './types.helpers.js';

describe('WorkerResult.error — post-freeze seam migration wire contract', () => {
  test('a WorkerResult carrying error round-trips JSON and parses through the strict mirror', () => {
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      usage: { input: 7, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'error',
      error: 'ai-sdk driver: run failed — Error: scripted model failure',
    });
  });

  test('an error verdict with NO error parses — the field is present-only, not required', () => {
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'error',
    });
  });

  test.each(['complete', 'aborted', 'budget'] as const)(
    'error on a %s stopReason is rejected, naming the error path',
    (stopReason) => {
      const parsed = kernelSchema.WorkerResultSchema.safeParse({
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason,
        error: 'ai-sdk driver: run failed — Error: boom',
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return; // narrow for TS
      expect(parsed.error.issues.some((issue) => issue.path[0] === 'error')).toBe(true);
    },
  );

  test("an empty error on an 'error' verdict is rejected, naming the error path", () => {
    const parsed = kernelSchema.WorkerResultSchema.safeParse({
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'error',
      error: '',
    });
    expect(parsed.success).toBe(false);
    if (parsed.success) return; // narrow for TS
    expect(parsed.error.issues.some((issue) => issue.path[0] === 'error')).toBe(true);
  });

  test('the error message length bound matches the producer shape (513 incl. marker)', () => {
    const base = {
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'error' as const,
    };
    // 500 is the producer's raw cap; 513 is its truncated output (500 plus
    // the 13-char '… [truncated]' marker), which the old .max(500) rejected.
    roundTripsThrough(kernelSchema.WorkerResultSchema, { ...base, error: 'x'.repeat(500) });
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      ...base,
      error: 'x'.repeat(500) + '… [truncated]',
    });
    const tooLong = kernelSchema.WorkerResultSchema.safeParse({
      ...base,
      error: 'x'.repeat(514),
    });
    expect(tooLong.success).toBe(false);
    if (tooLong.success) return; // narrow for TS
    expect(tooLong.error.issues.some((issue) => issue.path[0] === 'error')).toBe(true);
  });
});

describe('WorkerResult.errorClass — seam v2 one-directional wire rule (ADR-0002 §2.2)', () => {
  const base = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    denials: [],
  };

  test('an error verdict WITH errorClass parses and round-trips', () => {
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      ...base,
      stopReason: 'error',
      error: 'ai-sdk driver: run failed — Error: 429 with retry-after',
      errorClass: 'rate-limit',
    });
  });

  test.each(['complete', 'aborted', 'budget'] as const)(
    'errorClass on a %s stopReason FAILS the mirror, naming the errorClass path',
    (stopReason) => {
      const parsed = kernelSchema.WorkerResultSchema.safeParse({
        ...base,
        stopReason,
        errorClass: 'transient',
      });
      expect(parsed.success).toBe(false);
      if (parsed.success) return; // narrow for TS
      expect(parsed.error.issues.some((issue) => issue.path[0] === 'errorClass')).toBe(true);
    },
  );

  test('a value outside the nine frozen classes is rejected by the enum', () => {
    failsParse(
      kernelSchema.WorkerResultSchema,
      { ...base, stopReason: 'error', errorClass: 'fatal' },
      "bogus errorClass 'fatal'",
    );
  });
});

describe('WorkerResult.providerSignals — seam v2, allowed on ANY verdict', () => {
  const base = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    denials: [],
  };

  test('providerSignals parse on a complete verdict and round-trip', () => {
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      ...base,
      stopReason: 'complete',
      providerSignals: {
        retryAfterMs: 1200,
        windows: [
          {
            id: '5h',
            utilization: 0.42,
            remaining: { requests: 3, tokens: 1200 },
            resetAt: '2026-09-28T00:00:00.000Z',
          },
          { id: '7d' },
        ],
      },
    });
  });

  test('window values carry the conformance bounds (PR #238 review round 2)', () => {
    // The mirror enforces the same rows the shipped conformance suite
    // asserts per result (src/driver/conformance.ts): nonempty ids,
    // utilization 0–1, parseable reset instants — plus integral nonnegative
    // remaining counts (the doc calls them counts). Malformed quota
    // evidence must not parse as validated data.
    const schema = kernelSchema.WorkerResultSchema;
    const window = (over: Record<string, unknown>): unknown => ({
      ...base,
      stopReason: 'complete',
      providerSignals: { windows: [{ id: '5h', utilization: 0.5, ...over }] },
    });
    failsParse(schema, window({ id: '' }), 'an empty window id');
    failsParse(schema, window({ utilization: 1.5 }), 'utilization over 1');
    failsParse(schema, window({ utilization: -0.1 }), 'negative utilization');
    failsParse(
      schema,
      {
        ...base,
        stopReason: 'complete',
        providerSignals: { windows: [{ id: 'requests', remaining: { requests: 2.5 } }] },
      },
      'a fractional remaining count',
    );
    failsParse(
      schema,
      {
        ...base,
        stopReason: 'complete',
        providerSignals: { windows: [{ id: 'tokens', remaining: { tokens: -1 } }] },
      },
      'a negative remaining count',
    );
    failsParse(schema, window({ resetAt: 'next tuesday' }), 'an unparseable resetAt');
    // The boundary values stay legal: the closed utilization range, a zero
    // count, and any parseable instant.
    schema.parse(window({ utilization: 0, resetAt: '2026-09-28T00:00:00.000Z' }));
    schema.parse({
      ...base,
      stopReason: 'complete',
      providerSignals: {
        windows: [{ id: 'requests', remaining: { requests: 0, tokens: 0 }, utilization: 1 }],
      },
    });
  });

  test('a negative retryAfterMs is rejected by the mirror bound (issue #242)', () => {
    failsParse(
      kernelSchema.WorkerResultSchema,
      { ...base, stopReason: 'complete', providerSignals: { retryAfterMs: -1 } },
      'a negative retryAfterMs',
    );
  });

  test('an empty providerSignals object parses — every field is optional', () => {
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      ...base,
      stopReason: 'aborted',
      providerSignals: {},
    });
  });

  test('an unknown key inside providerSignals is rejected (strict mirror)', () => {
    failsParse(
      kernelSchema.WorkerResultSchema,
      { ...base, stopReason: 'complete', providerSignals: { vendor: 'claude' } },
      'vendor key inside providerSignals',
    );
    failsParse(
      kernelSchema.WorkerResultSchema,
      {
        ...base,
        stopReason: 'complete',
        providerSignals: { windows: [{ id: '5h', share: 0.5 }] },
      },
      'unknown key inside a provider window',
    );
  });
});
