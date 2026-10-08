// Price-map data pin — the WB-1 eval-matrix entries.
//
// `deepseek-flash` and `glm-5.3-flash` are the ids the live eval wires
// actually serve (docs/eval-axes-demo.md), so a drifted rate here would
// silently misprice every eval-matrix run. This pin asserts the vendored
// numbers, the derived arithmetic over a fixed usage, the never-fabricate
// rule for unknown models, and the shape invariant that every vendored rate
// is a finite positive number.
//
// The rates were transcribed from models.dev on 2026-09-21 (the fetch date
// is recorded in src/driver/pricing/data.ts's `FETCHED:` line). Like
// routing-tables.test.ts this is a DATA pin: no network, no model calls.
import { describe, expect, test } from 'vitest';
import { PRICE_TABLE } from '../../src/driver/pricing/data.js';
import { computeCostUSD, priceOf } from '../../src/driver/pricing/index.js';

/** One fixed usage observation; the expected sums are computed from the rates. */
const FIXED_USAGE = { input: 1_000_000, output: 2_000_000, cacheRead: 500_000, cacheWrite: 0 };

describe('price map — WB-1 eval-matrix entries', () => {
  test('deepseek-flash rates are vendored exactly', () => {
    expect(priceOf({ provider: 'deepseek', model: 'deepseek-flash' })).toEqual({
      input: 0.15,
      output: 0.6,
      cacheRead: 0.003,
    });
  });

  test('glm-5.3-flash rates are vendored exactly', () => {
    expect(priceOf({ provider: 'zai', model: 'glm-5.3-flash' })).toEqual({
      input: 0.15,
      output: 0.5,
      cacheRead: 0.03,
    });
  });

  test('computeCostUSD yields the exact per-million arithmetic for deepseek-flash', () => {
    const rates = { input: 0.15, output: 0.6, cacheRead: 0.003 };
    const expected =
      (FIXED_USAGE.input / 1_000_000) * rates.input +
      (FIXED_USAGE.output / 1_000_000) * rates.output +
      (FIXED_USAGE.cacheRead / 1_000_000) * rates.cacheRead; // cacheWrite absent → zero term
    expect(
      computeCostUSD({ provider: 'deepseek', model: 'deepseek-flash' }, FIXED_USAGE),
    ).toBeCloseTo(expected, 12);
  });

  test('computeCostUSD yields the exact per-million arithmetic for glm-5.3-flash', () => {
    const rates = { input: 0.15, output: 0.5, cacheRead: 0.03 };
    const expected =
      (FIXED_USAGE.input / 1_000_000) * rates.input +
      (FIXED_USAGE.output / 1_000_000) * rates.output +
      (FIXED_USAGE.cacheRead / 1_000_000) * rates.cacheRead; // cacheWrite absent → zero term
    expect(computeCostUSD({ provider: 'zai', model: 'glm-5.3-flash' }, FIXED_USAGE)).toBeCloseTo(
      expected,
      12,
    );
  });

  test('an unknown model is undefined — the map never fabricates a price', () => {
    expect(priceOf({ provider: 'deepseek', model: 'no-such-model' })).toBeUndefined();
    expect(priceOf({ provider: 'no-such-provider', model: 'deepseek-flash' })).toBeUndefined();
    expect(
      computeCostUSD({ provider: 'deepseek', model: 'no-such-model' }, FIXED_USAGE),
    ).toBeUndefined();
  });

  test('every vendored rate is a finite positive number', () => {
    for (const [provider, models] of Object.entries(PRICE_TABLE)) {
      for (const [model, rates] of Object.entries(models)) {
        for (const [field, rate] of Object.entries(rates)) {
          const value: unknown = rate;
          expect(
            typeof value === 'number' && Number.isFinite(value) && value > 0,
            `${provider}/${model}.${field} must be a finite positive rate`,
          ).toBe(true);
        }
      }
    }
  });
});
