// Analyze lane G1 — test evidence for the FailureSet union: the exit-code
// decision table (all-zero, definitive non-zero, null contagion), exact
// duplicate collapse, the honest tool policy (single-tool, empty and mixed
// inputs rejected), and a seeded PROPERTY test proving order-invariance —
// shuffled presentations of the same sets always yield the identical
// aggregate. All pure — zero I/O, zero subprocesses.
import { describe, expect, test } from 'vitest';
import {
  collectFailures,
  collectFailuresOp,
  failureIdentity,
  sortByIdentity,
} from '../../../src/ops/analyze/collectFailures.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/index.js';

/** A failure with only the fields under test (the gates test idiom). */
function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    ruleId: 'rule',
    message: 'message text',
    severity: 'error',
    ...overrides,
  };
}

/** A FailureSet over the given failures (the gates test idiom). */
function setOf(failures: CheckFailure[], tool = 'eslint', exitCode: number | null = 1): FailureSet {
  return { tool, failures, exitCode };
}

describe('collectFailures decision table', () => {
  test('aggregates same-tool sets; output sorted by identity, not input order', () => {
    const late = failureOf({ file: 'src/z.ts', line: 9, ruleId: 'prefer-const' });
    const early = failureOf({ file: 'src/a.ts', line: 2, ruleId: 'no-unused-vars' });
    const result = collectFailures([setOf([late]), setOf([early])]);
    expect(result.tool).toBe('eslint');
    expect(result.failures).toEqual([early, late]); // identity of src/a.ts sorts first
  });

  test('duplicate collapse: the same failure reported by two package runs appears once', () => {
    const shared = failureOf({ file: 'src/shared.ts', line: 5, ruleId: 'no-unused-vars' });
    const onlyPkgA = failureOf({ file: 'src/only-a.ts', line: 7, ruleId: 'prefer-const' });
    const result = collectFailures([setOf([shared, onlyPkgA]), setOf([{ ...shared }])]);
    expect(result.failures).toHaveLength(2);
    expect(result.failures).toEqual([onlyPkgA, shared]);
  });

  test('exactness: failures differing in ANY single field both survive', () => {
    const base = failureOf({});
    const variants: Array<Partial<CheckFailure>> = [
      { file: 'src/b.ts' },
      { line: 2 },
      { column: 2 },
      { ruleId: 'other' },
      { message: 'message text!' },
      { severity: 'warning' },
    ];
    const result = collectFailures([setOf([base]), setOf(variants.map((v) => failureOf(v)))]);
    expect(result.failures).toHaveLength(1 + variants.length);
  });

  test.each([
    { label: 'all zero → 0', codes: [0, 0], expected: 0 },
    { label: 'a definitive non-zero → 1', codes: [0, 1], expected: 1 },
    { label: 'non-zero in any position → 1 (no null present)', codes: [1, 0], expected: 1 },
    { label: 'every non-zero → still 1', codes: [2, 1], expected: 1 },
    { label: 'a negative exit is non-zero → 1', codes: [0, -1], expected: 1 },
    { label: 'all null → null', codes: [null, null], expected: null },
    {
      label: 'null contagion: [0, null] → null, never a fabricated clean or failure',
      codes: [0, null],
      expected: null,
    },
    // FLIPPED from the earlier pin ([1, null] → 1): the lost run's failure
    // list is possibly incomplete, and the regression gate treats a numeric
    // non-zero as TRUSTED evidence — a 1 here would let the gate compare
    // partial data as a complete failing run. Null keeps it untrusted.
    {
      label: 'null is CONTAGIOUS: [1, null] → null, never a complete-looking failure',
      codes: [1, null],
      expected: null,
    },
    { label: 'single null → null', codes: [null], expected: null },
  ])('exitCode aggregation: $label', ({ codes, expected }) => {
    const result = collectFailures(codes.map((code) => setOf([], 'eslint', code)));
    expect(result.exitCode).toBe(expected);
  });

  test('empty input throws — aggregating zero runs would fabricate a clean set (I5)', () => {
    expect(() => collectFailures([])).toThrow(/no input sets/);
  });

  test('mixed tools throw — the aggregate would misattribute every failure', () => {
    expect(() => collectFailures([setOf([]), setOf([], 'tsc')])).toThrow(/mixed tools/);
  });

  test('failures are carried verbatim (no rewriting of tool-reported fields)', () => {
    const weird: CheckFailure = {
      file: null,
      line: null,
      column: null,
      ruleId: null,
      message: 'suite > handles 2 cases',
      severity: 'warning',
    };
    expect(collectFailures([setOf([weird])]).failures).toEqual([weird]);
  });
});

describe('collectFailures order-invariance property (seeded, deterministic)', () => {
  /** mulberry32 — tiny seeded PRNG; a fixed seed makes the property deterministic. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher-Yates over a copy; the input array is never mutated. */
  function shuffled<T>(items: readonly T[], rng: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const swap = copy[i];
      const other = copy[j];
      if (swap === undefined || other === undefined) throw new Error('shuffle index out of range');
      copy[i] = other;
      copy[j] = swap;
    }
    return copy;
  }

  // Three per-package runs of one tool with overlapping failure sets (the
  // shared ones must collapse), presented in arbitrary order.
  const sharedFailures: CheckFailure[] = [
    failureOf({ file: 'src/one.ts', line: 10, ruleId: 'prefer-const' }),
    failureOf({ file: 'src/two.ts', line: 20, ruleId: 'no-unused-vars' }),
  ];
  const packageRuns: FailureSet[] = [
    setOf([...sharedFailures, failureOf({ file: 'pkg-a/only.ts', line: 1 })], 'eslint', 1),
    setOf([...sharedFailures, failureOf({ file: 'pkg-b/only.ts', line: 2 })], 'eslint', 1),
    setOf(
      [sharedFailures[0] as CheckFailure, failureOf({ file: 'pkg-c/only.ts', line: 3 })],
      'eslint',
      1,
    ),
  ];

  test('every permutation of the same runs yields the deep-identical aggregate (40 iterations)', () => {
    const rng = mulberry32(0xc011ec7);
    const reference = collectFailures(packageRuns);
    expect(reference.failures).toHaveLength(5); // 2 shared + 3 per-package
    for (let i = 0; i < 40; i++) {
      expect(collectFailures(shuffled(packageRuns, rng))).toEqual(reference);
    }
  });

  test('duplicate presentation in any order collapses identically (40 iterations)', () => {
    const rng = mulberry32(0xd0d1e);
    const duplicated = [...packageRuns, ...shuffled(packageRuns, rng)];
    const reference = collectFailures(packageRuns);
    for (let i = 0; i < 40; i++) {
      expect(collectFailures(shuffled(duplicated, rng))).toEqual(reference);
    }
  });
});

describe('sortByIdentity / failureIdentity', () => {
  test('is a pure sorted copy (the input is never mutated)', () => {
    const a = failureOf({ file: 'src/a.ts' });
    const b = failureOf({ file: 'src/b.ts' });
    const input = [b, a];
    expect(sortByIdentity(input, 'eslint')).toEqual([a, b]);
    expect(input).toEqual([b, a]);
  });

  test('identity is the full seven-component JSON tuple (tool folded in)', () => {
    const failure = failureOf({ file: null, line: null, column: null, ruleId: null });
    expect(failureIdentity(failure, 'vitest')).toBe(
      JSON.stringify(['vitest', null, null, null, null, 'error', 'message text']),
    );
  });

  test('identity namespaces by tool: the same fields under different tools differ', () => {
    const failure = failureOf({});
    expect(failureIdentity(failure, 'eslint')).not.toBe(failureIdentity(failure, 'tsc'));
  });
});

describe('collectFailuresOp', () => {
  test('ok with the aggregate for valid same-tool input', async () => {
    const result = await collectFailuresOp({ sets: [setOf([failureOf({})])] });
    expect(result).toEqual({
      status: 'ok',
      value: { tool: 'eslint', failures: [failureOf({})], exitCode: 1 },
    });
  });

  test('empty input maps the policy throw to failed, naming the reason', async () => {
    const result = await collectFailuresOp({ sets: [] });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain('no input sets');
  });

  test('mixed tools map the policy throw to failed, naming both tools', async () => {
    const result = await collectFailuresOp({
      sets: [setOf([], 'eslint'), setOf([], 'vitest')],
    });
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') return;
    expect(result.error).toContain("'eslint'");
    expect(result.error).toContain("'vitest'");
  });
});
