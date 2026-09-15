// Lane H slice 1 — tests for the metric adapter registry
// (src/ops/ratchet/registry.ts) and the typecheck-count adapter
// (src/ops/ratchet/adapters/typecheckCount.ts).
//
// Pinned here:
//   1. Registry: register/get round-trip, unknown-id → undefined, loud
//      duplicate rejection, sorted listAdapters. The registry is
//      module-level, so every test uses fresh ids; vitest isolates module
//      state per test file, so these cannot leak.
//   2. typecheckCount extract: structured {count} objects (top-level or
//      nested) are read verbatim (a structured 0 is a real zero); negative
//      and non-finite counts are null; raw compiler text is counted by
//      /error TS\d+:/ lines; text with no error lines (empty or otherwise)
//      and non-text non-object garbage are null — non-passing evidence
//      (I5), never a fabricated pass.
import { describe, expect, test } from 'vitest';
import { typecheckCount } from '../../../src/ops/ratchet/adapters/typecheckCount.js';
import { getAdapter, listAdapters, registerAdapter } from '../../../src/ops/ratchet/registry.js';
import type { MetricAdapter } from '../../../src/ops/ratchet/registry.js';

function adapter(id: string): MetricAdapter {
  return { id, direction: 'lower-is-better', extract: () => null };
}

describe('registry', () => {
  test('register + get round-trips the adapter', () => {
    const a = adapter('reg-probe-a');
    registerAdapter(a);
    expect(getAdapter('reg-probe-a')).toBe(a);
  });

  test('getAdapter of an unknown id is undefined', () => {
    expect(getAdapter('reg-never-registered')).toBeUndefined();
  });

  test('registering a duplicate id throws', () => {
    registerAdapter(adapter('reg-probe-dup'));
    expect(() => registerAdapter(adapter('reg-probe-dup'))).toThrow(/already registered/);
  });

  test('listAdapters is sorted and includes everything registered', () => {
    registerAdapter(adapter('reg-zeta'));
    registerAdapter(adapter('reg-alpha'));
    registerAdapter(adapter('reg-mid'));
    const listed = listAdapters();
    expect(listed).toEqual([...listed].sort());
    expect(listed).toContain('reg-alpha');
    expect(listed).toContain('reg-mid');
    expect(listed).toContain('reg-zeta');
  });
});

describe('typecheckCount', () => {
  test('carries its adapter metadata', () => {
    expect(typecheckCount.id).toBe('typecheck-count');
    expect(typecheckCount.direction).toBe('lower-is-better');
  });

  test('slots into the registry under its id', () => {
    registerAdapter(typecheckCount);
    expect(getAdapter('typecheck-count')).toBe(typecheckCount);
  });

  const TSC_OUTPUT =
    'src/a.ts(1,7): error TS2322: Type \'string\' is not assignable to type \'number\'.\n' +
    'src/b.ts(4,1): error TS2304: Cannot find name \'missing\'.\n' +
    'src/c.ts(9,3): error TS2345: Argument of type \'x\' is not assignable.\n';

  const extractCases: Array<[string, unknown, number | null]> = [
    // [label, raw, expected value (null = extract returns null)]
    ['flat count object', { count: 3 }, 3],
    ['nested count object', { outer: { count: 7 } }, 7],
    ['structured zero is a real zero', { count: 0 }, 0],
    ['raw tsc output with several errors', TSC_OUTPUT, 3],
    ['negative count', { count: -1 }, null],
    ['non-finite count', { count: Number.POSITIVE_INFINITY }, null],
    ['NaN count', { count: Number.NaN }, null],
    ['count key present but not numeric', { count: 'many' }, null],
    ['empty text', '', null],
    ['clean-build-style text (no error lines)', 'Successfully ran, all good.', null],
    ['object without any count', { errors: 'many', summary: 'bad' }, null],
    ['non-object non-text garbage', 42, null],
    ['null raw', null, null],
    ['undefined raw', undefined, null],
  ];

  test.each(extractCases)('extract: %s', (_label, raw, expected) => {
    expect(typecheckCount.extract(raw)).toEqual(
      expected === null ? null : { value: expected, unit: 'errors' },
    );
  });
});
