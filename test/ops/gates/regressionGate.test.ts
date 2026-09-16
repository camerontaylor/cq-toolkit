// Gates lane C2 — test evidence: the regression gate's full decision table
// (regression, no-regression, subset-with-fixes, bucketed drift in and out,
// empty-vs-empty), plus a seeded PROPERTY test proving ordering-invariance:
// shuffled permutations of identical sets always yield no-regression, and
// injecting one novel failure into any permutation always yields regression
// with exactly that failure reported. All pure — zero I/O, zero subprocesses.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { regressionGate } from '../../../src/ops/gates/regressionGate.js';
import { adapterByName, parseCheckOutput } from '../../../src/ops/gates/index.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/index.js';

/** A FailureSet over the given failures, tool/exitCode filler. */
function setOf(failures: CheckFailure[]): FailureSet {
  return { tool: 'eslint', failures, exitCode: failures.length > 0 ? 1 : 0 };
}

/** A failure with only the fields under test. */
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

describe('regressionGate decision table', () => {
  test('empty base + non-empty final → regression, every final failure novel', async () => {
    const final = [
      failureOf({ file: 'src/new.ts', line: 10, ruleId: 'no-unused-vars' }),
      failureOf({ file: 'src/new.ts', line: 40, ruleId: 'prefer-const' }),
    ];
    const result = await regressionGate({ base: setOf([]), final: setOf(final) });
    expect(result).toEqual({
      status: 'ok',
      value: {
        verdict: 'regression',
        novelFailures: final,
        fixedFailures: [],
        preExistingCount: 0,
      },
    });
  });

  test('identical sets → no-regression, everything pre-existing, nothing novel or fixed', async () => {
    const failures = [failureOf({ line: 3 }), failureOf({ line: 55, ruleId: 'other' })];
    const result = await regressionGate({ base: setOf(failures), final: setOf(failures) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('no-regression');
    expect(result.value.novelFailures).toEqual([]);
    expect(result.value.fixedFailures).toEqual([]);
    expect(result.value.preExistingCount).toBe(2);
  });

  test('final ⊂ base → no-regression, with the vanished base failures reported as fixed', async () => {
    const stillThere = failureOf({ line: 3, ruleId: 'no-unused-vars' });
    const fixed = [
      failureOf({ line: 30, ruleId: 'prefer-const' }),
      failureOf({ line: 90, ruleId: 'no-unused-vars' }),
    ];
    const result = await regressionGate({
      base: setOf([stillThere, ...fixed]),
      final: setOf([stillThere]),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('no-regression');
    expect(result.value.fixedFailures).toEqual(fixed);
    expect(result.value.preExistingCount).toBe(1);
  });

  test('drift WITHIN one line bucket (5 → 19; bucket 0 spans lines 0-19) → still no-regression', async () => {
    const result = await regressionGate({
      base: setOf([failureOf({ line: 5 })]),
      final: setOf([failureOf({ line: 19, message: 'the text moved with the line' })]),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('no-regression');
    expect(result.value.preExistingCount).toBe(1);
  });

  test('drift ACROSS a bucket boundary (line 20 → 41: bucket 1 vs 2) → regression (documented coarseness)', async () => {
    const result = await regressionGate({
      base: setOf([failureOf({ line: 20 })]),
      final: setOf([failureOf({ line: 41 })]),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('regression');
    expect(result.value.novelFailures).toEqual([failureOf({ line: 41 })]);
    expect(result.value.fixedFailures).toEqual([failureOf({ line: 20 })]);
  });

  test('empty base AND empty final → no-regression with zero counts', async () => {
    const result = await regressionGate({ base: setOf([]), final: setOf([]) });
    expect(result).toEqual({
      status: 'ok',
      value: {
        verdict: 'no-regression',
        novelFailures: [],
        fixedFailures: [],
        preExistingCount: 0,
      },
    });
  });

  test('a NEW location-less vitest failure in an already-failing file IS novel (content matching)', async () => {
    const existing: CheckFailure = {
      file: '/repo/src/dates.test.ts',
      line: null,
      column: null,
      ruleId: null,
      message: 'parses dates > handles iso input',
      severity: 'error',
    };
    const novel: CheckFailure = {
      file: '/repo/src/dates.test.ts',
      line: null,
      column: null,
      ruleId: null,
      message: 'parses dates > handles leap years',
      severity: 'error',
    };
    const result = await regressionGate({
      base: { tool: 'vitest', failures: [existing], exitCode: 1 },
      final: { tool: 'vitest', failures: [existing, novel], exitCode: 1 },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('regression');
    expect(result.value.novelFailures).toEqual([novel]);
    expect(result.value.preExistingCount).toBe(1);
  });

  test('identical location-less failures (same normalized messages) → no-regression', async () => {
    const failures: CheckFailure[] = [
      {
        file: '/repo/src/a.test.ts',
        line: null,
        column: null,
        ruleId: null,
        message: 'suite > is  ok',
        severity: 'error',
      },
      {
        file: '/repo/src/a.test.ts',
        line: null,
        column: null,
        ruleId: null,
        message: 'suite > handles edge cases',
        severity: 'error',
      },
    ];
    const driftedMessages: CheckFailure[] = [
      {
        file: '/repo/src/a.test.ts',
        line: null,
        column: null,
        ruleId: null,
        message: 'suite >   is   ok',
        severity: 'error',
      },
      {
        file: '/repo/src/a.test.ts',
        line: null,
        column: null,
        ruleId: null,
        message: 'suite > handles edge cases',
        severity: 'error',
      },
    ];
    const result = await regressionGate({
      base: { tool: 'vitest', failures, exitCode: 1 },
      final: { tool: 'vitest', failures: driftedMessages, exitCode: 1 },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('no-regression');
    expect(result.value.preExistingCount).toBe(2);
  });

  test('a warning baseline escalating to error at the same spot is a regression', async () => {
    const result = await regressionGate({
      base: setOf([failureOf({ line: 30, severity: 'warning' })]),
      final: setOf([failureOf({ line: 30, severity: 'error' })]),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('regression');
    expect(result.value.novelFailures).toEqual([failureOf({ line: 30, severity: 'error' })]);
  });

  test('an error downgraded to warning at the same spot: symmetric severity identity → the base error is FIXED, the warning NOVEL', async () => {
    // Severity is identity in BOTH branches (finding 3's fix is symmetric):
    // a downgrade therefore appears as the old error in fixedFailures AND a
    // novel warning — the gate has no asymmetric "downgrade is free" rule.
    const result = await regressionGate({
      base: setOf([failureOf({ line: 30, severity: 'error' })]),
      final: setOf([failureOf({ line: 30, severity: 'warning' })]),
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.fixedFailures).toEqual([failureOf({ line: 30, severity: 'error' })]);
    expect(result.value.novelFailures).toEqual([failureOf({ line: 30, severity: 'warning' })]);
    expect(result.value.preExistingCount).toBe(0);
  });

  test('identical failures attributed to a DIFFERENT tool never match (tool is in the key)', async () => {
    const failure = failureOf({ line: 10 });
    const result = await regressionGate({
      base: { tool: 'vitest', failures: [failure], exitCode: 1 },
      final: { tool: 'eslint', failures: [failure], exitCode: 1 },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('regression');
    expect(result.value.novelFailures).toEqual([failure]);
    expect(result.value.fixedFailures).toEqual([failure]);
    expect(result.value.preExistingCount).toBe(0);
  });

  test('I5 guard: empty FINAL behind a non-zero exit is indeterminate, never no-regression', async () => {
    const result = await regressionGate({
      base: setOf([]),
      final: { tool: 'eslint', failures: [], exitCode: 1 },
    });
    expect(result.status).toBe('indeterminate');
    if (result.status !== 'indeterminate') {
      return;
    }
    expect(result.detail).toContain('final');
    expect(result.detail).toContain('exit code 1');
  });

  test('I5 guard: empty BASE behind an unobservable exit code (null) is indeterminate', async () => {
    const result = await regressionGate({
      base: { tool: 'eslint', failures: [], exitCode: null },
      final: setOf([]),
    });
    expect(result.status).toBe('indeterminate');
    if (result.status !== 'indeterminate') {
      return;
    }
    expect(result.detail).toContain('base');
    expect(result.detail).toContain('unobservable exit code');
  });

  test('I5 guard: null exit code discredits a NON-EMPTY final (partial evidence) → indeterminate', async () => {
    const result = await regressionGate({
      base: setOf([]),
      final: { tool: 'eslint', failures: [failureOf({ line: 10 })], exitCode: null },
    });
    expect(result.status).toBe('indeterminate');
    if (result.status !== 'indeterminate') {
      return;
    }
    expect(result.detail).toContain('final');
    expect(result.detail).toContain('partial evidence');
  });

  test('I5 guard: null exit code discredits a NON-EMPTY base → indeterminate', async () => {
    const result = await regressionGate({
      base: { tool: 'eslint', failures: [failureOf({ line: 10 })], exitCode: null },
      final: setOf([]),
    });
    expect(result.status).toBe('indeterminate');
    if (result.status !== 'indeterminate') {
      return;
    }
    expect(result.detail).toContain('base');
    expect(result.detail).toContain('partial evidence');
  });

  test('a custom config tightens buckets: lineBucketSize 1 makes line 5 → 6 a regression', async () => {
    const config = { lineBucketSize: 1 };
    const loose = await regressionGate({
      base: setOf([failureOf({ line: 5 })]),
      final: setOf([failureOf({ line: 6 })]),
    });
    expect(loose.status).toBe('ok');
    if (loose.status === 'ok') {
      expect(loose.value.verdict).toBe('no-regression');
    }
    const tight = await regressionGate({
      base: setOf([failureOf({ line: 5 })]),
      final: setOf([failureOf({ line: 6 })]),
      config,
    });
    expect(tight.status).toBe('ok');
    if (tight.status === 'ok') {
      expect(tight.value.verdict).toBe('regression');
    }
  });
});

describe('regressionGate ordering-invariance property (seeded, deterministic)', () => {
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

  /**
   * 12 failures with pairwise-distinct fingerprints: positioned entries
   * have distinct line buckets; every third is LOCATION-LESS (vitest's
   * shape) and matches by content, so those carry distinct messages.
   */
  const seedFailures: CheckFailure[] = Array.from({ length: 12 }, (_, i) => {
    const locationLess = i % 3 === 2;
    return {
      file: `src/mod${i % 4}.ts`,
      line: locationLess ? null : i * 20 + 3,
      column: locationLess ? null : i + 1,
      ruleId: `rule-${i % 3}`,
      message: locationLess ? `suite ${i} > handles case ${i}` : `failure ${i}`,
      severity: i % 2 === 0 ? ('error' as const) : ('warning' as const),
    };
  });

  const ITERATIONS = 40;
  const novelFailure: CheckFailure = {
    file: 'src/novel.ts',
    line: 801,
    column: 1,
    ruleId: 'brand-new-rule',
    message: 'introduced by the change',
    severity: 'error',
  };

  test('every permutation of identical base/final sets yields no-regression (40 iterations)', async () => {
    const rng = mulberry32(0x5eedc2);
    for (let i = 0; i < ITERATIONS; i++) {
      const result = await regressionGate({
        base: setOf(shuffled(seedFailures, rng)),
        final: setOf(shuffled(seedFailures, rng)),
      });
      expect(result).toEqual({
        status: 'ok',
        value: {
          verdict: 'no-regression',
          novelFailures: [],
          fixedFailures: [],
          preExistingCount: seedFailures.length,
        },
      });
    }
  });

  test('injecting one novel failure at a random position always yields regression with exactly 1 novel (40 iterations)', async () => {
    const rng = mulberry32(0x5eedc3);
    for (let i = 0; i < ITERATIONS; i++) {
      const base = shuffled(seedFailures, rng);
      const finalWithNovel = shuffled(seedFailures, rng);
      finalWithNovel.splice(Math.floor(rng() * (finalWithNovel.length + 1)), 0, novelFailure);
      const result = await regressionGate({ base: setOf(base), final: setOf(finalWithNovel) });
      expect(result.status).toBe('ok');
      if (result.status !== 'ok') {
        return;
      }
      expect(result.value.verdict).toBe('regression');
      expect(result.value.novelFailures).toHaveLength(1);
      expect(result.value.novelFailures[0]).toBe(novelFailure);
      expect(result.value.preExistingCount).toBe(seedFailures.length);
    }
  });
});

describe('regressionGate × real vitest fixture (adapter → gate integration)', () => {
  // The REAL committed capture, through the REAL adapter entry point — this
  // pins adapter→gate shape compatibility against drift. The fixture's
  // failure is location-less (line null), so the content-matching regime is
  // exercised end to end.
  const stdout = readFileSync(
    new URL('../../fixtures/check-outputs/vitest.json', import.meta.url),
    'utf8',
  );
  const parsed = parseCheckOutput(adapterByName('vitest-json'), {
    stdout,
    stderr: '',
    exitCode: 1,
  });
  if (parsed.verdict !== 'parsed') {
    throw new Error('the committed vitest fixture must parse');
  }
  const fixtureFailure = parsed.set.failures[0];
  if (fixtureFailure === undefined) throw new Error('fixture must contain a failure');

  test('a hand-built base with different content → regression with the REAL fixture failure as novel', async () => {
    const handBuilt: CheckFailure = { ...fixtureFailure, message: 'a different test failed' };
    const result = await regressionGate({
      base: { tool: 'vitest', failures: [handBuilt], exitCode: 1 },
      final: parsed.set,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('regression');
    expect(result.value.novelFailures).toEqual([fixtureFailure]);
    expect(result.value.fixedFailures).toEqual([handBuilt]);
  });

  test('the same fixture failure on both sides → no-regression (adapter shape is gate-compatible)', async () => {
    const result = await regressionGate({
      base: { tool: 'vitest', failures: [{ ...fixtureFailure }], exitCode: 1 },
      final: parsed.set,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      return;
    }
    expect(result.value.verdict).toBe('no-regression');
    expect(result.value.novelFailures).toEqual([]);
    expect(result.value.preExistingCount).toBe(1);
  });
});
