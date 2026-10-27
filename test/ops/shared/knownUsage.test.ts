import { describe, expect, it } from 'vitest';
import { createKnownUsageLedger } from '../../../src/ops/shared/knownUsage.js';

describe('known usage across driver exits', () => {
  it('keeps success, failure, cancellation, budget and repair measurements after a later throw', () => {
    const ledger = createKnownUsageLedger();
    const exits = ['success', 'failure', 'cancel', 'budget', 'repair', 'rereview'];
    for (const [index, exit] of exits.entries()) {
      ledger.record(exit, {
        usage: {
          input: index + 1,
          output: 2,
          cacheRead: 3,
          cacheWrite: 4,
          ...(exit === 'repair' ? { reasoning: 5 } : {}),
        },
        costUSD: 0.5,
      });
    }
    const failPublication = () => {
      throw new Error('publication failed');
    };
    expect(failPublication).toThrow('publication failed');
    expect(ledger.snapshot()).toEqual({
      usage: { input: 21, output: 12, cacheRead: 18, cacheWrite: 24, reasoning: 5 },
      costUSD: 3,
      knownCount: 6,
      unknownCount: 0,
      unpricedCount: 0,
    });
  });

  it('distinguishes absent provider usage from a measured zero and an unpriced model', () => {
    const ledger = createKnownUsageLedger();
    ledger.record('missing', {});
    ledger.record('zero', {
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
    });
    expect(ledger.snapshot()).toEqual({
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0,
      knownCount: 1,
      unknownCount: 1,
      unpricedCount: 1,
    });
  });

  it('counts retries once per invocation and ignores a replay of the same invocation', () => {
    const ledger = createKnownUsageLedger();
    const first = { usage: { input: 10, output: 1, cacheRead: 2, cacheWrite: 3 } };
    ledger.record('attempt-1', first);
    ledger.record('attempt-1', first);
    ledger.record('attempt-2', { usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0 } });
    expect(ledger.snapshot()).toMatchObject({
      usage: { input: 14, output: 2, cacheRead: 2, cacheWrite: 3 },
      knownCount: 2,
      unknownCount: 0,
    });
    expect(() => ledger.record('attempt-1', { usage: { ...first.usage, input: 9 } })).toThrow(
      'conflicting usage',
    );
    expect(ledger.snapshot().knownCount).toBe(2);
  });

  it('rejects invalid measurements without changing the prior aggregate', () => {
    const ledger = createKnownUsageLedger();
    expect(() =>
      ledger.record('bad', {
        usage: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 },
      }),
    ).toThrow('invalid usage');
    expect(() => ledger.record('bad-price', { costUSD: Number.NaN })).toThrow('invalid cost');
    expect(ledger.snapshot()).toEqual({ knownCount: 0, unknownCount: 0, unpricedCount: 0 });
  });
});
