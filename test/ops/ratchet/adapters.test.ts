// Lane H slice 2 — tests for the coverage and complexity metric adapters
// (src/ops/ratchet/adapters/).
//
// Pinned here:
//   1. coverage: total.lines.pct is the value (higher-is-better, unit pct);
//      branches/functions/statements pct ride along in detail when numeric;
//      the boundaries 0 and 100 are valid; out-of-range, missing,
//      non-numeric and non-object raws are null.
//   2. complexity: pre-averaged {averageComplexity} passes through verbatim;
//      {Complexity} record arrays become the arithmetic mean rounded
//      half-up to 2 decimals — 0.125 → 0.13 is the exact-binary half case;
//      empty arrays, records without a numeric Complexity, negative values
//      and junk are null.
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

  const cases: Array<[string, unknown, MetricReading | null]> = [
    // [label, raw, expected reading (null = extract returns null)]
    ['pre-averaged summary passes through', { averageComplexity: 3.7 }, { value: 3.7, unit: 'avg-cx' }],
    ['pre-averaged zero', { averageComplexity: 0 }, { value: 0, unit: 'avg-cx' }],
    ['pre-averaged negative', { averageComplexity: -1 }, null],
    ['pre-averaged Infinity', { averageComplexity: Number.POSITIVE_INFINITY }, null],
    ['pre-averaged NaN', { averageComplexity: Number.NaN }, null],
    ['records: clean mean', [{ Complexity: 1 }, { Complexity: 2 }], { value: 1.5, unit: 'avg-cx' }],
    ['records: repeating decimal rounds down', [{ Complexity: 1 }, { Complexity: 1 }, { Complexity: 2 }], { value: 1.33, unit: 'avg-cx' }],
    ['records: repeating decimal rounds up', [{ Complexity: 1 }, { Complexity: 2 }, { Complexity: 2 }], { value: 1.67, unit: 'avg-cx' }],
    ['records: exact-binary half rounds half-up', [{ Complexity: 0.125 }], { value: 0.13, unit: 'avg-cx' }],
    ['records: single value', [{ Complexity: 4 }], { value: 4, unit: 'avg-cx' }],
    ['empty array', [], null],
    ['record missing Complexity', [{ Complexity: 1 }, {}], null],
    ['record with non-numeric Complexity', [{ Complexity: 'high' }], null],
    ['array of non-records', [1, 2], null],
    ['all-negative records → negative mean', [{ Complexity: -2 }, { Complexity: -4 }], null],
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
