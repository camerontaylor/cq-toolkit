import { describe, expect, it } from 'vitest';
import type { DriverFactory } from '../../../src/driver/factory.js';
import type { OpInvocation, Usage, WorkerResult } from '../../../src/driver/types.js';
import type { DevEffects } from '../../../src/ops/dev/effects.js';
import { makeDevCycle, meterDrivers } from '../../../src/ops/dev/cycle.js';
import { createKnownUsageLedger } from '../../../src/shared/knownUsage.js';

const usage: Usage = { input: 3, output: 2, cacheRead: 1, cacheWrite: 0 };
const invocation = {} as OpInvocation;

describe('dev.cycle known usage', () => {
  it('keeps one observation per driver dispatch, including retry, partial throw and unknown throw', async () => {
    const ledger = createKnownUsageLedger();
    const seen: string[] = [];
    let spent = 0;
    let attempt = 0;
    const driver = {
      marker: 'receiver',
      async run(): Promise<WorkerResult> {
        if (this.marker !== 'receiver') throw new Error('receiver lost');
        attempt++;
        if (attempt === 3) throw Object.assign(new Error('partial'), { usage });
        if (attempt === 4) throw new Error('unmeasured');
        return {
          stopReason: attempt === 1 ? 'error' : 'complete',
          usage,
          usageProvenance: 'measured',
          costUSD: 0.01,
          denials: [],
        };
      },
    };
    const factory: DriverFactory = {
      resolve: (request) => ({ driver, lane: 'ai-sdk', modelSpec: request.modelSpec }),
    };
    const metered = meterDrivers(
      factory,
      (tokens) => {
        spent += tokens;
      },
      {
        start: (id) => {
          seen.push(id);
        },
        settle: (id, observation) => {
          ledger.record(id, observation);
        },
      },
    );
    const resolved = metered.resolve({
      role: 'reviewer',
      modelSpec: { provider: 'mock', model: 'm' },
    });
    expect((await resolved.driver.run(invocation)).stopReason).toBe('error');
    expect((await resolved.driver.run(invocation)).stopReason).toBe('complete');
    await expect(resolved.driver.run(invocation)).rejects.toThrow('partial');
    await expect(resolved.driver.run(invocation)).rejects.toThrow('unmeasured');
    expect(seen).toEqual(['cycle:0', 'cycle:1', 'cycle:2', 'cycle:3']);
    expect(spent).toBe(18);
    expect(ledger.snapshot()).toMatchObject({
      usage: { input: 9, output: 6, cacheRead: 3, cacheWrite: 0 },
      knownCount: 3,
      unknownCount: 1,
      unpricedCount: 2,
    });
    expect(ledger.snapshot().costUSD).toBeCloseTo(0.02);
  });

  it('preserves a thrown driver error when its partial usage is invalid', async () => {
    const ledger = createKnownUsageLedger();
    const original = Object.assign(new Error('driver failed'), {
      usage: { ...usage, input: Number.NaN },
    });
    const driver = { run: async (): Promise<WorkerResult> => Promise.reject(original) };
    const factory: DriverFactory = {
      resolve: (request) => ({ driver, lane: 'ai-sdk', modelSpec: request.modelSpec }),
    };
    let spent = 0;
    const resolved = meterDrivers(factory, (tokens) => (spent += tokens), {
      start: () => {},
      settle: (id, observation) => ledger.record(id, observation),
    }).resolve({ role: 'reviewer', modelSpec: { provider: 'mock', model: 'm' } });

    await expect(resolved.driver.run(invocation)).rejects.toBe(original);
    expect(spent).toBe(0);
    expect(ledger.snapshot()).toEqual({ knownCount: 0, unknownCount: 1, unpricedCount: 1 });
  });

  it('returns the original driver result when its cost is invalid, keeping valid usage', async () => {
    const ledger = createKnownUsageLedger();
    const original: WorkerResult = {
      stopReason: 'complete',
      usage,
      usageProvenance: 'measured',
      costUSD: Number.POSITIVE_INFINITY,
      denials: [],
    };
    const driver = { run: async (): Promise<WorkerResult> => original };
    const factory: DriverFactory = {
      resolve: (request) => ({ driver, lane: 'ai-sdk', modelSpec: request.modelSpec }),
    };
    let spent = 0;
    const resolved = meterDrivers(factory, (tokens) => (spent += tokens), {
      start: () => {},
      settle: (id, observation) => ledger.record(id, observation),
    }).resolve({ role: 'reviewer', modelSpec: { provider: 'mock', model: 'm' } });

    expect(await resolved.driver.run(invocation)).toBe(original);
    expect(spent).toBe(6);
    expect(ledger.snapshot()).toEqual({
      usage,
      knownCount: 1,
      unknownCount: 0,
      unpricedCount: 1,
    });
  });

  it('returns the original driver result when usage is invalid, keeping valid cost', async () => {
    const ledger = createKnownUsageLedger();
    const original: WorkerResult = {
      stopReason: 'error',
      error: 'original partial result',
      usage: { ...usage, input: -1 },
      usageProvenance: 'measured',
      costUSD: 0.02,
      denials: [],
    };
    const driver = { run: async (): Promise<WorkerResult> => original };
    const factory: DriverFactory = {
      resolve: (request) => ({ driver, lane: 'ai-sdk', modelSpec: request.modelSpec }),
    };
    const resolved = meterDrivers(factory, () => {}, {
      start: () => {},
      settle: (id, observation) => ledger.record(id, observation),
    }).resolve({ role: 'reviewer', modelSpec: { provider: 'mock', model: 'm' } });

    expect(await resolved.driver.run(invocation)).toBe(original);
    expect(ledger.snapshot()).toEqual({
      costUSD: 0.02,
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 0,
    });
  });

  it('returns a partial driver result with null usage and retains its valid cost', async () => {
    const ledger = createKnownUsageLedger();
    const original: WorkerResult = {
      stopReason: 'error',
      error: 'original partial result',
      usage: null as unknown as Usage,
      costUSD: 0.02,
      denials: [],
    };
    const driver = { run: async (): Promise<WorkerResult> => original };
    const factory: DriverFactory = {
      resolve: (request) => ({ driver, lane: 'ai-sdk', modelSpec: request.modelSpec }),
    };
    let spent = 0;
    const resolved = meterDrivers(factory, (tokens) => (spent += tokens), {
      start: () => {},
      settle: (id, observation) => ledger.record(id, observation),
    }).resolve({ role: 'reviewer', modelSpec: { provider: 'mock', model: 'm' } });

    const actual = await resolved.driver.run(invocation);
    expect(actual).toBe(original);
    expect(actual.stopReason).toBe('error');
    expect(actual.error).toBe('original partial result');
    expect(spent).toBe(0);
    expect(ledger.snapshot()).toEqual({
      costUSD: 0.02,
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 0,
    });
  });

  it('returns the original result when its usage accessor throws and keeps valid cost', async () => {
    const ledger = createKnownUsageLedger();
    const original: WorkerResult = {
      stopReason: 'error',
      error: 'original accessor result',
      usage,
      usageProvenance: 'measured',
      costUSD: 0.03,
      denials: [],
    };
    Object.defineProperty(original, 'usage', {
      get: () => {
        throw new Error('bad usage accessor');
      },
    });
    const driver = { run: async (): Promise<WorkerResult> => original };
    const factory: DriverFactory = {
      resolve: (request) => ({ driver, lane: 'ai-sdk', modelSpec: request.modelSpec }),
    };
    let spent = 0;
    const resolved = meterDrivers(factory, (tokens) => (spent += tokens), {
      start: () => {},
      settle: (id, observation) => ledger.record(id, observation),
    }).resolve({ role: 'reviewer', modelSpec: { provider: 'mock', model: 'm' } });

    const actual = await resolved.driver.run(invocation);
    expect(actual).toBe(original);
    expect(actual.stopReason).toBe('error');
    expect(actual.error).toBe('original accessor result');
    expect(spent).toBe(0);
    expect(ledger.snapshot()).toEqual({
      costUSD: 0.03,
      knownCount: 0,
      unknownCount: 1,
      unpricedCount: 0,
    });
  });

  it('attaches a typed empty summary to a pre-dispatch validation failure', async () => {
    const cycle = makeDevCycle({ effects: {} as DevEffects });
    const result = await cycle({ repoRoot: '' });
    expect(result).toMatchObject({
      status: 'failed',
      report: { usageSummary: { knownCount: 0, unknownCount: 0, unpricedCount: 0 } },
    });
  });
  it('counts only explicitly measured usage (seam v3): unmeasured and absent are unknown, cost stays independent', async () => {
    const ledger = createKnownUsageLedger();
    let spent = 0;
    let attempt = 0;
    const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    const results: WorkerResult[] = [
      // A provider-reported all-zero measurement: KNOWN, aggregate stays zero.
      { stopReason: 'complete', usage: zero, usageProvenance: 'measured', denials: [] },
      // A placeholder zero: the driver declares it UNMEASURED.
      { stopReason: 'aborted', usage: zero, usageProvenance: 'unmeasured', denials: [] },
      // A legacy/custom result with no declaration at all: UNKNOWN, never assumed.
      { stopReason: 'error', error: 'legacy result', usage: zero, denials: [] },
      // A measured partial fold on failure, with an independently valid cost.
      { stopReason: 'error', usage, usageProvenance: 'measured', costUSD: 0.02, denials: [] },
    ];
    const driver = {
      run: async (): Promise<WorkerResult> => results[attempt++]!,
    };
    const factory: DriverFactory = {
      resolve: (request) => ({ driver, lane: 'ai-sdk', modelSpec: request.modelSpec }),
    };
    const resolved = meterDrivers(
      factory,
      (tokens) => {
        spent += tokens;
      },
      {
        start: () => {},
        settle: (id, observation) => ledger.record(id, observation),
      },
    ).resolve({ role: 'reviewer', modelSpec: { provider: 'mock', model: 'm' } });
    const returned: WorkerResult[] = [];
    for (let index = 0; index < results.length; index += 1)
      returned.push(await resolved.driver.run(invocation));
    // Original result identity is preserved for every dispatch.
    returned.forEach((value, index) => expect(value).toBe(results[index]));
    // The numeric debit is unchanged: the measured partial fold still spends.
    expect(spent).toBe(6);
    expect(ledger.snapshot()).toEqual({
      usage: { ...usage },
      costUSD: 0.02,
      knownCount: 2,
      unknownCount: 2,
      unpricedCount: 3,
    });
  });
});
