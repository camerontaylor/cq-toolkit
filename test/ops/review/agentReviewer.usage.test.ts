// Split provenance: test/ops/review/agentReviewer.test.ts was split into the
// agentReviewer.*.test.ts siblings in this directory; this file keeps the
// usage, cost and retry-accounting tests.
import { describe, expect, it } from 'vitest';
import type { WorkerResult } from '../../../src/driver/types.js';
import { runLadder } from '../../../src/kernel/governor.js';
import { runAgentReviewer } from '../../../src/ops/review/agentReviewer.js';
import { fakeDrivers, reviewerInput, usage, workerResult } from './agentReviewer.helpers.js';

describe('runAgentReviewer v3 session engine', () => {
  it('reports actual driver usage and cost to the active governor', async () => {
    const fake = fakeDrivers({ result: workerResult({ costUSD: 0.012 }) });
    const reports: { usage?: unknown; costUSD?: number }[] = [];
    await runLadder(
      () => runAgentReviewer(fake.drivers, reviewerInput()),
      { wallClockMs: 1_000 },
      { op: 'review.run', jobKey: 'review-spend', attempt: 1 },
      { onResult: (value) => reports.push(value) },
    );
    expect(reports).toEqual([{ usage, costUSD: 0.012 }]);
  });

  it('keeps a returned review result when its cost is invalid and retains valid usage', async () => {
    const fake = fakeDrivers({ result: workerResult({ costUSD: Number.POSITIVE_INFINITY }) });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error(JSON.stringify(result));
    expect(result.value.usageSummary).toEqual({
      usage,
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
  });

  it('counts an unmeasured placeholder as unknown, and a measured zero as known (seam v3)', async () => {
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const unmeasured = fakeDrivers({
      result: workerResult({ usage: zero, usageProvenance: 'unmeasured' }),
    });
    const unmeasuredResult = await runAgentReviewer(unmeasured.drivers, reviewerInput());
    expect(unmeasuredResult.status).toBe('ok');
    if (unmeasuredResult.status !== 'ok') throw new Error(JSON.stringify(unmeasuredResult));
    expect(unmeasuredResult.value.usageSummary).toEqual({
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 1,
    });

    const measuredZero = fakeDrivers({
      result: workerResult({ usage: zero, usageProvenance: 'measured' }),
    });
    const measuredResult = await runAgentReviewer(measuredZero.drivers, reviewerInput());
    expect(measuredResult.status).toBe('ok');
    if (measuredResult.status !== 'ok') throw new Error(JSON.stringify(measuredResult));
    // A genuine all-zero measurement is KNOWN and aggregates as a present zero.
    expect(measuredResult.value.usageSummary).toEqual({
      usage: zero,
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
  });

  it('keeps valid cost when returned usage is invalid and leaves session validation in charge', async () => {
    const fake = fakeDrivers({
      result: workerResult({
        stopReason: 'error',
        error: 'original partial driver failure',
        usage: { ...usage, input: -1 },
        costUSD: 0.012,
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') throw new Error(JSON.stringify(result));
    expect(result.reason).toContain('Too small: expected number to be >=0');
    expect(result.reason).not.toContain('invalid usage for dispatch');
    expect(result.report?.usageSummary).toEqual({
      costUSD: 0.012,
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 0,
    });
  });

  it('keeps a returned partial-error reason when only cost is invalid', async () => {
    const fake = fakeDrivers({
      result: workerResult({
        stopReason: 'error',
        error: 'original partial driver failure',
        costUSD: Number.NaN,
      }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') throw new Error(JSON.stringify(result));
    expect(result.reason).toContain('original partial driver failure');
    expect(result.report?.usageSummary).toEqual({
      usage,
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
  });

  it('keeps a thrown driver error distinct from unknown telemetry', async () => {
    const original = Object.assign(new Error('original rejected driver failure'), {
      usage: { ...usage, input: -1 },
    });
    const fake = fakeDrivers({ run: async () => Promise.reject(original) });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('needs-human');
    if (result.status !== 'needs-human') throw new Error(JSON.stringify(result));
    expect(result.reason).toContain('original rejected driver failure');
    expect(result.report?.usageSummary).toEqual({
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 1,
    });
  });

  it('keeps returned usage when cancellation lands before session settlement', async () => {
    const controller = new AbortController();
    const fake = fakeDrivers({
      run: async () => {
        const result = workerResult({ costUSD: 0.012 });
        Object.defineProperty(result, 'usage', {
          get: () => {
            controller.abort(new Error('cancelled after driver result'));
            return usage;
          },
        });
        return result;
      },
    });
    const result = await runAgentReviewer(
      fake.drivers,
      reviewerInput({ signal: controller.signal }),
    );
    expect(result).toMatchObject({
      status: 'needs-human',
      report: {
        usage: 0,
        usageSummary: { usage, costUSD: 0.012, knownCount: 1, unknownCount: 0 },
        coverage: { sessions: [{ status: 'aborted' }] },
      },
    });
  });

  it('freezes an unknown in-flight dispatch at the returned snapshot', async () => {
    const controller = new AbortController();
    let release!: (result: WorkerResult) => void;
    const pending = new Promise<WorkerResult>((resolve) => {
      release = resolve;
    });
    const fake = fakeDrivers({
      skipHook: true,
      run: async () => {
        controller.abort(new Error('cancelled while running'));
        return pending;
      },
    });
    const result = await runAgentReviewer(
      fake.drivers,
      reviewerInput({ signal: controller.signal }),
    );
    expect(result).toMatchObject({
      status: 'needs-human',
      report: { usageSummary: { knownCount: 0, unknownCount: 1 } },
    });
    release(workerResult({ costUSD: 0.012 }));
    await Promise.resolve();
    expect(result).toMatchObject({
      report: {
        usageSummary: { knownCount: 0, unknownCount: 1 },
        coverage: { sessions: [{ status: 'aborted' }] },
      },
    });
  });

  it('counts each transient retry result once without changing the numeric debit', async () => {
    let attempt = 0;
    const fake = fakeDrivers({
      run: async () =>
        attempt++ === 0
          ? workerResult({ stopReason: 'error', errorClass: 'transient', costUSD: 0.01 })
          : workerResult({ costUSD: 0.02 }),
    });
    const result = await runAgentReviewer(fake.drivers, reviewerInput());
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(fake.run).toHaveBeenCalledTimes(2);
    expect(result.value.usage).toBe(12);
    expect(result.value.usageSummary).toMatchObject({
      usage: { input: 4, output: 6, cacheRead: 2, cacheWrite: 0 },
      knownCount: 2,
      unknownCount: 0,
    });
    expect(result.value.usageSummary?.costUSD).toBeCloseTo(0.03);
  });
});
