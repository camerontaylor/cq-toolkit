// Lane H slice 2 (+ round-1 fix) — tests for the coverage and complexity
// metric adapters (src/ops/ratchet/adapters/).
//
// Pinned here:
//   1. coverage: total.lines.pct is the value (higher-is-better, unit pct);
//      branches/functions/statements pct ride along in detail ONLY when
//      numeric and inside the same [0,100] bound as the primary value
//      (out-of-range detail is dropped, not fatal); boundaries 0 and 100
//      are valid; out-of-range, missing, non-numeric and non-object raws
//      are null.
//   2. complexity: pre-averaged {averageComplexity} is rounded half-up to
//      2 decimals with a relative-epsilon guard (binary-unrepresentable
//      halves like 1.005 → 1.01 and 2.675 → 2.68); {Complexity} record
//      arrays become the arithmetic mean rounded half-up in the INTEGER
//      domain (sum*100 / count), so 201/200 → 1.01 exactly; any negative
//      record is rejected before aggregation; empty arrays and junk are
//      null.
import { describe, expect, test } from 'vitest';
import { complexity } from '../../../src/ops/ratchet/adapters/complexity.js';
import { coverage } from '../../../src/ops/ratchet/adapters/coverage.js';
import type { MetricReading } from '../../../src/ops/ratchet/registry.js';

describe('coverage', () => {
  test('carries its adapter metadata', () => {
    expect(coverage.id).toBe('coverage');
    expect(coverage.direction).toBe('higher-is-better');
  });

  const cases: Array<[string, unknown, MetricReading | null]> = [
    // [label, raw, expected reading (null = extract returns null)]
    ['full summary carries detail', { total: { lines: { pct: 85.5 }, branches: { pct: 70 }, functions: { pct: 90 }, statements: { pct: 84 } } }, { value: 85.5, unit: 'pct', detail: { branches: 70, functions: 90, statements: 84 } }],
    ['lines only → no detail key', { total: { lines: { pct: 42 } } }, { value: 42, unit: 'pct' }],
    ['boundary 0 is valid', { total: { lines: { pct: 0 } } }, { value: 0, unit: 'pct' }],
    ['boundary 100 is valid', { total: { lines: { pct: 100 } } }, { value: 100, unit: 'pct' }],
    ['non-numeric detail pct is dropped, not fatal', { total: { lines: { pct: 50 }, branches: { pct: 'many' } } }, { value: 50, unit: 'pct' }],
    ['detail pct above 100 is dropped, not fatal', { total: { lines: { pct: 50 }, branches: { pct: 150 } } }, { value: 50, unit: 'pct' }],
    ['negative detail pct is dropped, not fatal', { total: { lines: { pct: 50 }, functions: { pct: -5 } } }, { value: 50, unit: 'pct' }],
    ['partial detail: numeric siblings only', { total: { lines: { pct: 60 }, functions: { pct: 77.7 } } }, { value: 60, unit: 'pct', detail: { functions: 77.7 } }],
    ['above 100', { total: { lines: { pct: 100.5 } } }, null],
    ['negative', { total: { lines: { pct: -1 } } }, null],
    ['pct non-numeric', { total: { lines: { pct: '85' } } }, null],
    ['pct missing', { total: { lines: {} } }, null],
    ['lines missing', { total: {} }, null],
    ['total missing', { branches: { pct: 1 } }, null],
    ['null raw', null, null],
    ['array raw', [{ total: { lines: { pct: 1 } } }], null],
    ['string raw', 'coverage!', null],
    ['number raw', 42, null],
  ];

  test.each(cases)('extract: %s', (_label, raw, expected) => {
    expect(coverage.extract(raw)).toEqual(expected);
  });
});

describe('complexity', () => {
  test('carries its adapter metadata', () => {
    expect(complexity.id).toBe('complexity');
    expect(complexity.direction).toBe('lower-is-better');
  });

  // 200 records summing to 201 → mean 1.005, an exact decimal half whose
  // binary double rounds the wrong way under naive float scaling; only the
  // integer-domain ratio (201*100)/200 lands on 1.01.
  const records201of200: unknown[] = [
    ...Array.from({ length: 199 }, () => ({ Complexity: 1 })),
    { Complexity: 2 },
  ];

  const cases: Array<[string, unknown, MetricReading | null]> = [
    // [label, raw, expected reading (null = extract returns null)]
    ['pre-averaged summary rounds half-up to 2 decimals', { averageComplexity: 3.7 }, { value: 3.7, unit: 'avg-cx' }],
    ['direct: binary-unrepresentable half 1.005 rounds half-up', { averageComplexity: 1.005 }, { value: 1.01, unit: 'avg-cx' }],
    ['direct: classic 2.675 rounds half-up', { averageComplexity: 2.675 }, { value: 2.68, unit: 'avg-cx' }],
    ['pre-averaged zero', { averageComplexity: 0 }, { value: 0, unit: 'avg-cx' }],
    ['pre-averaged negative', { averageComplexity: -1 }, null],
    ['pre-averaged Infinity', { averageComplexity: Number.POSITIVE_INFINITY }, null],
    ['pre-averaged NaN', { averageComplexity: Number.NaN }, null],
    ['records: clean mean', [{ Complexity: 1 }, { Complexity: 2 }], { value: 1.5, unit: 'avg-cx' }],
    ['records: repeating decimal rounds down', [{ Complexity: 1 }, { Complexity: 1 }, { Complexity: 2 }], { value: 1.33, unit: 'avg-cx' }],
    ['records: repeating decimal rounds up', [{ Complexity: 1 }, { Complexity: 2 }, { Complexity: 2 }], { value: 1.67, unit: 'avg-cx' }],
    ['records: exact-binary half rounds half-up', [{ Complexity: 0.125 }], { value: 0.13, unit: 'avg-cx' }],
    ['records: 201/200 integer-domain half-up', records201of200, { value: 1.01, unit: 'avg-cx' }],
    ['records: single value', [{ Complexity: 4 }], { value: 4, unit: 'avg-cx' }],
    ['records: negative record rejected before aggregation', [{ Complexity: -1 }, { Complexity: 2 }], null],
    ['empty array', [], null],
    ['record missing Complexity', [{ Complexity: 1 }, {}], null],
    ['record with non-numeric Complexity', [{ Complexity: 'high' }], null],
    ['array of non-records', [1, 2], null],
    ['all-negative records', [{ Complexity: -2 }, { Complexity: -4 }], null],
    ['object without averageComplexity', { average: 3 }, null],
    ['null raw', null, null],
    ['string raw', 'complexity!', null],
    ['number raw', 7, null],
    ['boolean raw', true, null],
  ];

  test.each(cases)('extract: %s', (_label, raw, expected) => {
    expect(complexity.extract(raw)).toEqual(expected);
  });
});
