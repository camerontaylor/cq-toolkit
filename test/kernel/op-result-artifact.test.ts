import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import {
  KnownUsageSummarySchema,
  OpResultArtifactSchema,
  OpResultSchema,
} from '../../src/kernel/schema.js';
import type { OpRegistryEntry, OpResult } from '../../src/kernel/types.js';

const usageSummary = {
  usage: { input: 3, output: 2, cacheRead: 0, cacheWrite: 0 },
  costUSD: 0.25,
  knownCount: 1,
  unknownCount: 1,
  unpricedCount: 1,
};

describe('typed result artifact usage summary', () => {
  it.each([
    { status: 'ok', value: { done: true } },
    { status: 'failed', error: 'failed' },
    { status: 'needs-human', reason: 'review' },
    { status: 'budget-exhausted' },
    { status: 'indeterminate', detail: 'lost' },
  ] as const)('keeps the frozen %j result and typed metadata separate', (base) => {
    const raw = { ...base, usageSummary, report: { note: 'retained' } };
    expect(OpResultSchema.safeParse(raw).success).toBe(false);
    expect(KnownUsageSummarySchema.parse(usageSummary)).toEqual(usageSummary);
    expect(OpResultArtifactSchema.parse(raw)).toBe(raw);
  });

  it.each([
    { knownCount: -1, unknownCount: 0, unpricedCount: 0 },
    { knownCount: Number.MAX_SAFE_INTEGER + 1, unknownCount: 0, unpricedCount: 0 },
    { knownCount: 0.5, unknownCount: 0, unpricedCount: 0 },
    { knownCount: 0, unknownCount: 0, unpricedCount: 0, costUSD: Number.POSITIVE_INFINITY },
    { knownCount: 0, unknownCount: 0, unpricedCount: 0, costUSD: -1 },
    { knownCount: 0, unknownCount: 0, unpricedCount: 0, usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { knownCount: 0, unknownCount: 0, unpricedCount: 0, extra: 1 },
    undefined,
  ])('rejects malformed or undefined summary %j before publication', (summary) => {
    expect(KnownUsageSummarySchema.safeParse(summary).success).toBe(false);
    expect(
      OpResultArtifactSchema.safeParse({ status: 'failed', error: 'failed', usageSummary: summary })
        .success,
    ).toBe(false);
  });

  it('rejects lossy summary metadata and unknown top-level keys', () => {
    const hidden = Object.defineProperty(
      { knownCount: 0, unknownCount: 0, unpricedCount: 0 },
      'hidden',
      { value: 1 },
    );
    expect(
      OpResultArtifactSchema.safeParse({ status: 'failed', error: 'failed', usageSummary: hidden })
        .success,
    ).toBe(false);
    expect(
      OpResultArtifactSchema.safeParse({
        status: 'failed',
        error: 'failed',
        usageSummary,
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('accepts a valid summary through the runner and refuses a lossy raw value', async () => {
    const execute = async (raw: unknown) => {
      const entry = {
        name: 'fixture',
        inputSchema: z.object({}).strict(),
        importer: async () => async () => raw as OpResult<unknown>,
      } as unknown as OpRegistryEntry<never, never>;
      const registry: OpRegistryView = { get: () => entry };
      return runPlan(
        { id: 'usage-artifact', jobs: [{ id: 'job', op: 'fixture', input: {} }] },
        { concurrency: 1, stopOnError: false },
        registry,
      );
    };
    const valid = { status: 'failed', error: 'failed', usageSummary };
    expect((await execute(valid)).jobs[0]?.result).toEqual(valid);

    const lossy = { status: 'ok', value: new Map(), usageSummary };
    expect((await execute(lossy)).jobs[0]?.result).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/non-serializable/),
    });
  });
});
