// Split provenance: test/kernel/types.test.ts was split by subject; this file
// holds the mirror-only schema tightenings (domain cardinalities, RunOptions
// bounds, the DD-9 maxTokens/costBasis mirrors) and the exact optional
// boundary rules. Sibling subjects: types.roundtrip.test.ts,
// types.encoded-couplings.test.ts, types.worker-result-wire.test.ts,
// types.seam.test.ts, types.dispatch-errors.test.ts; shared fixtures live in
// types.helpers.ts.
import { describe, expect, test } from 'vitest';
import * as kernelSchema from '../../src/kernel/schema.js';
import { failsParse, roundTripsThrough } from './types.helpers.js';

describe('mirror-only domain tightenings (review-debt #17, PR #7 non-frozen items)', () => {
  test('UsageSchema rejects negative and fractional token counts (cardinalities)', () => {
    const base = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
    for (const bad of [
      { ...base, input: -1 },
      { ...base, output: -5 },
      { ...base, cacheRead: 0.5 },
      { ...base, cacheWrite: 1.5 },
      { ...base, reasoning: -1 },
    ]) {
      failsParse(kernelSchema.UsageSchema, bad, `usage ${JSON.stringify(bad)}`);
    }
    expect(kernelSchema.UsageSchema.safeParse({ ...base, reasoning: 3 }).success).toBe(true);
  });

  test('RunCountsSchema rejects negative and fractional counts', () => {
    const base = { queued: 0, running: 0, blocked: 0, done: 1, failed: 0, 'budget-exhausted': 0 };
    failsParse(kernelSchema.RunCountsSchema, { ...base, done: -1 }, 'negative count');
    failsParse(kernelSchema.RunCountsSchema, { ...base, failed: 1.5 }, 'fractional count');
    expect(kernelSchema.RunCountsSchema.safeParse(base).success).toBe(true);
  });

  test('RunOptionsSchema rejects a negative maxUsd; LimitsSchema rejects a sub-1 inFlightCeiling', () => {
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 2, stopOnError: false, maxUsd: -0.01 },
      'negative maxUsd',
    );
    expect(
      kernelSchema.RunOptionsSchema.safeParse({ concurrency: 2, stopOnError: false, maxUsd: 0 })
        .success,
    ).toBe(true);
    // inFlightCeiling is a LIMITS field (the issue's schema.ts:200 drifted
    // into the Limits block): the ceiling bound lives on LimitsSchema.
    failsParse(kernelSchema.LimitsSchema, { inFlightCeiling: 0 }, 'zero inFlightCeiling');
    failsParse(kernelSchema.LimitsSchema, { inFlightCeiling: 1.5 }, 'fractional inFlightCeiling');
    expect(kernelSchema.LimitsSchema.safeParse({ inFlightCeiling: 1 }).success).toBe(true);
    failsParse(kernelSchema.LimitsSchema, { maxUsd: -1 }, 'negative limits maxUsd');
    failsParse(kernelSchema.LimitsSchema, { perJobWallClockMs: -1 }, 'negative duration');
    failsParse(kernelSchema.LimitsSchema, { maxAttemptsPerJob: 0 }, 'zero attempts');
  });

  test('journal at timestamps must be ISO-8601 UTC', () => {
    const base = { runId: 'r', planId: 'p' } as const;
    failsParse(
      kernelSchema.RunStartedJournalEventSchema,
      { type: 'run-started', ...base, at: 't' },
      'bare-word timestamp',
    );
    failsParse(
      kernelSchema.RunStartedJournalEventSchema,
      { type: 'run-started', ...base, at: '2026-09-16T00:00:00+02:00' },
      'offset timestamp (UTC-only)',
    );
    expect(
      kernelSchema.RunStartedJournalEventSchema.safeParse({
        type: 'run-started',
        ...base,
        at: '2026-09-16T00:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 6. RunOptionsSchema concurrency bound — the promised T1.1 record item:
//    review round-4 medium finding, recorded in PR 7's 'Accepted at merge'
//    notes as "folded into the next kernel-schema-touching PR (T1.2)".
//    Mirror-only tightening (concurrency is a pool size; < 1 is
//    meaningless); the frozen RunOptions type is untouched.
// ---------------------------------------------------------------------------

describe('RunOptionsSchema concurrency bound (round-4 finding, folded from T1.1)', () => {
  test('concurrency 0 and negatives fail; 1 and 16 parse and round-trip', () => {
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 0, stopOnError: false },
      'concurrency 0',
    );
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: -3, stopOnError: false },
      'negative concurrency',
    );
    roundTripsThrough(kernelSchema.RunOptionsSchema, { concurrency: 1, stopOnError: true });
    roundTripsThrough(kernelSchema.RunOptionsSchema, { concurrency: 16, stopOnError: false });
  });
});

// ---------------------------------------------------------------------------
// 7. RD-B review debt: the maxTokens mirror (#14-3) and the DD-9
//    costUSD/costBasis wire pairing (#14-4)
// ---------------------------------------------------------------------------

describe('RunOptionsSchema maxTokens mirror (DD-9 cap, mirror-only tightening)', () => {
  test('maxTokens 0 and negatives fail; a positive value parses and round-trips', () => {
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 1, stopOnError: false, maxTokens: 0 },
      'maxTokens 0',
    );
    failsParse(
      kernelSchema.RunOptionsSchema,
      { concurrency: 1, stopOnError: false, maxTokens: -5 },
      'negative maxTokens',
    );
    roundTripsThrough(kernelSchema.RunOptionsSchema, {
      concurrency: 1,
      stopOnError: false,
      maxTokens: 100,
    });
  });
});

describe('WorkerResultSchema costUSD/costBasis pairing (DD-9 wire coupling)', () => {
  const base = {
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
    denials: [],
    stopReason: 'complete' as const,
  };

  test('both fields parse; either field ALONE fails; neither parses', () => {
    // Priced: costUSD and its basis together.
    roundTripsThrough(kernelSchema.WorkerResultSchema, {
      ...base,
      costUSD: 0.5,
      costBasis: 'modeled',
    });
    // Unpriced: neither field.
    roundTripsThrough(kernelSchema.WorkerResultSchema, { ...base });
    // Half a pairing is a fabrication either way.
    failsParse(
      kernelSchema.WorkerResultSchema,
      { ...base, costBasis: 'modeled' },
      'costBasis without costUSD',
    );
    failsParse(
      kernelSchema.WorkerResultSchema,
      { ...base, costUSD: 0.5 },
      'costUSD without costBasis',
    );
  });
});

describe('exact optional schema boundaries', () => {
  test('absence survives parsing while explicit undefined cannot satisfy a typed optional field', () => {
    expect(kernelSchema.BudgetSchema.parse({})).toEqual({});
    expect(kernelSchema.BudgetSchema.safeParse({ maxUsd: undefined }).success).toBe(false);
    expect(kernelSchema.BudgetSchema.parse({ maxUsd: 0 })).toEqual({ maxUsd: 0 });
    expect(kernelSchema.BudgetSchema.parse({ maxSteps: 1 })).toEqual({ maxSteps: 1 });
    expect(kernelSchema.BudgetSchema.safeParse({ maxSteps: 0 }).success).toBe(false);
    expect(kernelSchema.BudgetSchema.safeParse({ maxSteps: 1.5 }).success).toBe(false);
    const plan = { id: 'optional-boundary', jobs: [] };
    expect(kernelSchema.PlanSchema.parse(plan)).toEqual(plan);
    expect(kernelSchema.PlanSchema.safeParse({ ...plan, label: undefined }).success).toBe(false);
    expect(kernelSchema.PlanSchema.parse({ ...plan, label: '' }).label).toBe('');
    // The post-freeze seam-migration optional follows the same rule.
    const workerResult = {
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      denials: [],
      stopReason: 'error' as const,
    };
    expect(kernelSchema.WorkerResultSchema.parse(workerResult)).toEqual(workerResult);
    expect(kernelSchema.WorkerResultSchema.parse({ ...workerResult, steps: 0 }).steps).toBe(0);
    expect(kernelSchema.WorkerResultSchema.safeParse({ ...workerResult, steps: -1 }).success).toBe(
      false,
    );
    expect(
      kernelSchema.WorkerResultSchema.safeParse({ ...workerResult, error: undefined }).success,
    ).toBe(false);
  });
});
