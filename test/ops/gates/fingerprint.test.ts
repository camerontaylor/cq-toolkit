// Gates lane C2 — test evidence: the fingerprint's bucket math (19 vs 20 is
// the documented boundary), offset-addressed failures, rootDir/separator
// normalization, ruleId divergence, and the drift-survival contract itself —
// two failures differing ONLY in message fingerprint identically. FNV-1a is
// pinned against the PUBLISHED 32-bit vectors, so a silent hash change (or
// platform nondeterminism) fails these tests, not a circular snapshot.
import { describe, expect, test } from 'vitest';
import {
  fingerprintFailure,
  fingerprintKey,
  fingerprintPairs,
  fingerprintSet,
  fnv1a32Hex,
  type FingerprintConfig,
} from '../../../src/ops/gates/fingerprint.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';

/** A failure with only the fields under test; message is filler by design. */
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

describe('fnv1a32Hex (published FNV-1a 32-bit vectors)', () => {
  test('matches the published vectors: empty string is the offset basis', () => {
    expect(fnv1a32Hex('')).toBe('811c9dc5');
  });

  test('matches the published vectors: single character and a known word', () => {
    // Both values are the standard published FNV-1a 32-bit test vectors,
    // not outputs of this implementation pinned circularly.
    expect(fnv1a32Hex('a')).toBe('e40c292c');
    expect(fnv1a32Hex('foobar')).toBe('bf9cf968');
  });

  test('deterministic: the same string hashes identically across calls', () => {
    expect(fnv1a32Hex('a.ts|rule|0:0')).toBe(fnv1a32Hex('a.ts|rule|0:0'));
    expect(fnv1a32Hex('a.ts|rule|0:0')).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('fingerprintFailure bucket math', () => {
  test('line 19 and line 3 share a bucket; line 20 leaves it (the 19|20 boundary)', () => {
    const line19 = fingerprintFailure(failureOf({ line: 19 }));
    expect(fingerprintFailure(failureOf({ line: 3 }))).toBe(line19);
    expect(fingerprintFailure(failureOf({ line: 20 }))).not.toBe(line19);
  });

  test('line 20 and line 39 share the next bucket', () => {
    const line20 = fingerprintFailure(failureOf({ line: 20 }));
    expect(fingerprintFailure(failureOf({ line: 39 }))).toBe(line20);
  });

  test('columns bucket independently: column 19 vs 20 differs, 1 vs 19 does not', () => {
    const col19 = fingerprintFailure(failureOf({ line: 5, column: 19 }));
    expect(fingerprintFailure(failureOf({ line: 5, column: 1 }))).toBe(col19);
    expect(fingerprintFailure(failureOf({ line: 5, column: 20 }))).not.toBe(col19);
  });

  test('custom lineBucketSize rescales the buckets', () => {
    const cfg: FingerprintConfig = { lineBucketSize: 10 };
    const line5 = fingerprintFailure(failureOf({ line: 5 }), cfg);
    expect(fingerprintFailure(failureOf({ line: 9 }), cfg)).toBe(line5);
    expect(fingerprintFailure(failureOf({ line: 10 }), cfg)).not.toBe(line5);
  });

  test('offset-addressed failures (line null): column 499 vs 500 differs, 500 vs 999 does not (offset bucket 500)', () => {
    const off0 = fingerprintFailure(failureOf({ line: null, column: 499 }));
    const off1 = fingerprintFailure(failureOf({ line: null, column: 500 }));
    expect(fingerprintFailure(failureOf({ line: null, column: 999 }))).toBe(off1);
    expect(off1).not.toBe(off0);
  });

  test('a line-null failure with no column lands in the zero offset bucket', () => {
    const noPosition = fingerprintFailure(failureOf({ line: null, column: null }));
    expect(fingerprintFailure(failureOf({ line: null, column: 499 }))).toBe(noPosition);
    expect(fingerprintFailure(failureOf({ line: null, column: 500 }))).not.toBe(noPosition);
  });

  test('a positioned failure with a null column folds to column bucket 0 (documented residual)', () => {
    const noColumn = fingerprintFailure(failureOf({ column: null }));
    expect(fingerprintFailure(failureOf({ column: 1 }))).toBe(noColumn);
    expect(fingerprintFailure(failureOf({ column: 20 }))).not.toBe(noColumn);
  });

  test('line-addressed and offset-addressed failures never collide on the same column', () => {
    expect(fingerprintFailure(failureOf({ line: 1, column: 5 }))).not.toBe(
      fingerprintFailure(failureOf({ line: null, column: 5 })),
    );
  });
});

describe('fingerprintFailure path normalization', () => {
  test('rootDir is stripped before hashing', () => {
    const cfg: FingerprintConfig = { rootDir: '/work/repo' };
    expect(fingerprintFailure(failureOf({ file: '/work/repo/src/a.ts' }), cfg)).toBe(
      fingerprintFailure(failureOf({ file: 'src/a.ts' })),
    );
  });

  test('windows-style separators normalize to posix, with a windows rootDir too', () => {
    const cfg: FingerprintConfig = { rootDir: 'C:\\work\\repo' };
    expect(fingerprintFailure(failureOf({ file: 'C:\\work\\repo\\src\\a.ts' }), cfg)).toBe(
      fingerprintFailure(failureOf({ file: 'src/a.ts' })),
    );
  });

  test('a trailing slash on rootDir does not change the stripping', () => {
    const cfg: FingerprintConfig = { rootDir: '/work/repo/' };
    expect(fingerprintFailure(failureOf({ file: '/work/repo/src/a.ts' }), cfg)).toBe(
      fingerprintFailure(failureOf({ file: 'src/a.ts' })),
    );
  });

  test('a path outside rootDir is hashed as-is', () => {
    const cfg: FingerprintConfig = { rootDir: '/work/repo' };
    expect(fingerprintFailure(failureOf({ file: '/elsewhere/src/a.ts' }), cfg)).toBe(
      fingerprintFailure(failureOf({ file: '/elsewhere/src/a.ts' })),
    );
  });
});

describe('fingerprintFailure divergence (what counts as a different failure)', () => {
  test('ruleId divergence produces a different fingerprint', () => {
    expect(fingerprintFailure(failureOf({ ruleId: 'prefer-const' }))).not.toBe(
      fingerprintFailure(failureOf({ ruleId: 'no-unused-vars' })),
    );
  });

  test('file divergence produces a different fingerprint', () => {
    expect(fingerprintFailure(failureOf({ file: 'src/a.ts' }))).not.toBe(
      fingerprintFailure(failureOf({ file: 'src/b.ts' })),
    );
  });

  test('severity divergence produces a different fingerprint (warning baseline ≠ error escalation)', () => {
    expect(fingerprintFailure(failureOf({ severity: 'warning' }))).not.toBe(
      fingerprintFailure(failureOf({ severity: 'error' })),
    );
  });

  test('tool divergence produces a different fingerprint (fingerprintSet folds the FailureSet tool in)', () => {
    const failure = failureOf({});
    const vitestPrints = [...fingerprintSet({ tool: 'vitest', failures: [failure], exitCode: 1 })];
    const eslintPrints = [...fingerprintSet({ tool: 'eslint', failures: [failure], exitCode: 1 })];
    expect(vitestPrints[0]).not.toBe(eslintPrints[0]);
  });

  test('message-independence for POSITIONED failures: different messages, same fingerprint (the drift-survival contract)', () => {
    expect(
      fingerprintFailure(failureOf({ message: "'x' is assigned a value but never used." })),
    ).toBe(
      fingerprintFailure(failureOf({ message: "'x' is read here but the rule text changed." })),
    );
  });

  test('a null file and a null ruleId are stable components, not errors', () => {
    const nullFields = fingerprintFailure(failureOf({ file: null, ruleId: null }));
    expect(nullFields).toBe(fingerprintFailure(failureOf({ file: null, ruleId: null })));
    expect(nullFields).not.toBe(fingerprintFailure(failureOf({ file: null, ruleId: 'rule' })));
  });
});

describe('fingerprintFailure location-less content matching (line null keys by message)', () => {
  const locationLess = { line: null, column: null } as const;

  test('two location-less failures in the same file differing only in message are DIFFERENT failures', () => {
    const existing = fingerprintFailure(
      failureOf({ ...locationLess, message: 'suite > handles iso dates' }),
    );
    expect(
      fingerprintFailure(failureOf({ ...locationLess, message: 'suite > handles leap years' })),
    ).not.toBe(existing);
  });

  test('the same full test name keys identically after whitespace normalization', () => {
    const canonical = fingerprintFailure(
      failureOf({ ...locationLess, message: 'suite > handles iso dates' }),
    );
    expect(
      fingerprintFailure(failureOf({ ...locationLess, message: 'suite >  handles\tiso  dates' })),
    ).toBe(canonical);
  });

  test('the vitest full test name includes nested names split across lines', () => {
    // The vitest regime keys on the WHOLE message, so a name the reporter
    // split across lines keeps its whole identity: renaming the innermost
    // segment changes the fingerprint.
    const vitest = { ...locationLess } as const;
    const vitestKey = (message: string): string =>
      fingerprintFailure(failureOf({ ...vitest, message }), { tool: 'vitest' });
    const suiteAndTest = vitestKey('outer suite\ninner suite\ntest name');
    expect(vitestKey('outer suite\ninner suite\nrenamed test')).not.toBe(suiteAndTest);
    expect(vitestKey('outer suite\ninner suite\ntest name')).toBe(suiteAndTest);
  });

  test('long messages keep full-length distinctness: NO prefix-collision cap', () => {
    const sharesPrefix = `suite > ${'a'.repeat(200)}`;
    const first = fingerprintFailure(failureOf({ ...locationLess, message: `${sharesPrefix}one` }));
    expect(
      fingerprintFailure(failureOf({ ...locationLess, message: `${sharesPrefix}two` })),
    ).not.toBe(first);
    expect(fingerprintFailure(failureOf({ ...locationLess, message: `${sharesPrefix}one` }))).toBe(
      first,
    );
  });

  test('case is preserved: distinct test names that differ only in case stay distinct', () => {
    expect(
      fingerprintFailure(failureOf({ ...locationLess, message: 'suite > handles Edge Case' })),
    ).not.toBe(
      fingerprintFailure(failureOf({ ...locationLess, message: 'suite > handles edge case' })),
    );
  });

  test('a positioned failure never collides with a location-less one sharing the message text', () => {
    expect(fingerprintFailure(failureOf({ line: 3, message: 'same text' }))).not.toBe(
      fingerprintFailure(failureOf({ ...locationLess, message: 'same text' })),
    );
  });
});

describe('canonical keys vs compact hash (exact matching)', () => {
  test('components containing | cannot collide across different component splits (JSON tuple encoding)', () => {
    // Under naive pipe composition these two tuples would pre-hash
    // identically ('src/a.ts|r|s|error|...'): array encoding keeps every
    // split distinct.
    const pipeInFile = fingerprintKey(failureOf({ file: 'src/a.ts|r', ruleId: 's' }));
    const pipeInRule = fingerprintKey(failureOf({ ruleId: 'r|s' }));
    expect(pipeInFile).not.toBe(pipeInRule);
    expect(pipeInFile).toContain('"src/a.ts|r"');
    expect(pipeInRule).toContain('"r|s"');
  });

  test('the canonical key feeds the gate occurrence identity; fingerprintFailure is compact FNV', () => {
    const failure = failureOf({});
    const key = fingerprintKey(failure);
    expect(fingerprintFailure(failure)).not.toBe(key);
    expect(fingerprintFailure(failure)).toMatch(/^[0-9a-f]{8}$/);
    expect(
      fingerprintSet({ tool: 'vitest', failures: [failure], exitCode: 1 }).has(
        `${fingerprintKey(failure, { tool: 'vitest' })}#0`,
      ),
    ).toBe(true);
  });
});

describe('fingerprintSet', () => {
  test('retains duplicate identities as distinct occurrence keys', () => {
    const set = fingerprintSet({
      tool: 'eslint',
      exitCode: 1,
      failures: [
        failureOf({ line: 3 }),
        failureOf({ line: 7, message: 'same bucket as line 3' }),
        failureOf({ line: 300 }),
      ],
    });
    expect(set.size).toBe(3);
    const pairs = fingerprintPairs({
      tool: 'eslint',
      exitCode: 1,
      failures: [failureOf({ line: 3 }), failureOf({ line: 7 }), failureOf({ line: 300 })],
    });
    expect(pairs[0]?.key).not.toBe(pairs[1]?.key);
    expect(pairs[0]?.key).toBe(`${fingerprintKey(failureOf({ line: 3 }), { tool: 'eslint' })}#0`);
    expect(pairs[1]?.key).toBe(`${fingerprintKey(failureOf({ line: 7 }), { tool: 'eslint' })}#1`);
    expect(set.has(pairs[2]?.key ?? '')).toBe(true);
  });

  test('duplicate identities are order-invariant: shuffling occurrences cannot change the key set', () => {
    // Occurrences of ONE identity are interchangeable, so input order must
    // not move a key in or out of the set (the ordinal disambiguates
    // duplicates, it does not make the comparison order-sensitive).
    const at3 = failureOf({ line: 3, message: 'same identity' });
    const at7 = failureOf({ line: 7, message: 'same identity' });
    const ordered = fingerprintSet({ tool: 'vitest', failures: [at3, at7], exitCode: 1 });
    const shuffled = fingerprintSet({ tool: 'vitest', failures: [at7, at3], exitCode: 1 });
    const single = fingerprintSet({ tool: 'vitest', failures: [at3], exitCode: 1 });

    expect(ordered.size).toBe(2);
    expect([...shuffled].sort()).toEqual([...ordered].sort());
    expect([...ordered].filter((key) => !single.has(key))).toHaveLength(1);
  });

  test('a non-vitest location-less failure keys by the FIRST message line (drift tolerance)', () => {
    const noisy = (headline: string, detail: string): CheckFailure =>
      failureOf({ line: null, column: 1200, message: `${headline}\n${detail}` });
    const keyOf = (failure: CheckFailure): string =>
      fingerprintPairs({ tool: 'eslint', failures: [failure], exitCode: 1 })[0]?.key ?? '';

    // Same first line, different trailing detail → same identity (drift).
    expect(keyOf(noisy('parse error at token', 'expected `;` but found `}`'))).toBe(
      keyOf(noisy('parse error at token', 'line 4, column 9')),
    );
    // Different first line → different identity.
    expect(keyOf(noisy('parse error at token', 'expected `;`'))).not.toBe(
      keyOf(noisy('unterminated string literal', 'line 9')),
    );
  });

  test('multiset keys expose added and removed duplicate occurrences', () => {
    const repeated = failureOf({ line: 5, message: 'first wording' });
    const equivalent = failureOf({ line: 6, message: 'first wording' });
    const base = fingerprintSet({ tool: 'vitest', failures: [repeated], exitCode: 1 });
    const final = fingerprintSet({
      tool: 'vitest',
      failures: [equivalent, repeated],
      exitCode: 1,
    });
    const reduced = fingerprintSet({ tool: 'vitest', failures: [repeated], exitCode: 1 });

    expect([...final].filter((key) => !base.has(key))).toHaveLength(1);
    expect([...final].filter((key) => !reduced.has(key))).toHaveLength(1);
    expect([...reduced].filter((key) => !final.has(key))).toHaveLength(0);
  });

  test('Vitest identities use the full test name and ignore source-location drift', () => {
    const original = failureOf({ line: 5, column: 1, message: 'suite > nested > test A' });
    const moved = failureOf({ line: 300, column: 19, message: 'suite > nested > test A' });
    const renamed = failureOf({ line: 5, column: 1, message: 'suite > nested > test B' });
    const keyOf = (failure: CheckFailure): string =>
      fingerprintPairs({ tool: 'vitest', failures: [failure], exitCode: 1 })[0]?.key ?? '';

    expect(keyOf(moved)).toBe(keyOf(original));
    expect(keyOf(renamed)).not.toBe(keyOf(original));
  });

  test('which duplicate occurrence receives the ordinal is independent of input order', () => {
    const at205 = failureOf({ line: 205, message: 'suite > test' });
    const at306 = failureOf({ line: 306, message: 'suite > test' });
    const keyFor = (failures: CheckFailure[], target: CheckFailure): string | undefined =>
      fingerprintPairs({ tool: 'vitest', failures, exitCode: 1 }).find(
        (pair) => pair.failure === target,
      )?.key;
    expect(keyFor([at205, at306], at306)).toBe(keyFor([at306, at205], at306));
    expect(keyFor([at205, at306], at205)).toBe(keyFor([at306, at205], at205));
  });

  test('null and empty-string files never alias in duplicate ordering', () => {
    const nullFile = failureOf({ file: null, line: null, message: 'same' });
    const emptyFile = failureOf({ file: '', line: null, message: 'same' });
    const keyFor = (failures: CheckFailure[], target: CheckFailure): string | undefined =>
      fingerprintPairs({ tool: 'vitest', failures, exitCode: 1 }).find(
        (pair) => pair.failure === target,
      )?.key;
    expect(keyFor([nullFile, emptyFile], nullFile)).toBe(keyFor([emptyFile, nullFile], nullFile));
  });

  test('null and negative locations never alias in duplicate ordering', () => {
    const nullLine = failureOf({ line: null, column: null, message: 'same' });
    const negativeLine = failureOf({ line: -1, column: -1, message: 'same' });
    const keyFor = (failures: CheckFailure[], target: CheckFailure): string | undefined =>
      fingerprintPairs({ tool: 'vitest', failures, exitCode: 1 }).find(
        (pair) => pair.failure === target,
      )?.key;
    expect(keyFor([nullLine, negativeLine], nullLine)).toBe(
      keyFor([negativeLine, nullLine], nullLine),
    );
  });

  test('NaN locations order deterministically in duplicate ordering', () => {
    const finite = failureOf({ line: 5, column: 1, message: 'same' });
    const nanLine = failureOf({ line: Number.NaN, column: 1, message: 'same' });
    const nanColumn = failureOf({ line: 5, column: Number.NaN, message: 'same' });
    const keyFor = (failures: CheckFailure[], target: CheckFailure): string | undefined =>
      fingerprintPairs({ tool: 'vitest', failures, exitCode: 1 }).find(
        (pair) => pair.failure === target,
      )?.key;
    for (const target of [finite, nanLine, nanColumn]) {
      expect(keyFor([finite, nanLine, nanColumn], target)).toBe(
        keyFor([nanColumn, nanLine, finite], target),
      );
    }
  });

  test('null and empty-string rule ids never alias in duplicate ordering', () => {
    const nullRule = failureOf({ ruleId: null, line: null, message: 'same' });
    const emptyRule = failureOf({ ruleId: '', line: null, message: 'same' });
    const keyFor = (failures: CheckFailure[], target: CheckFailure): string | undefined =>
      fingerprintPairs({ tool: 'eslint', failures, exitCode: 1 }).find(
        (pair) => pair.failure === target,
      )?.key;
    expect(keyFor([nullRule, emptyRule], nullRule)).toBe(keyFor([emptyRule, nullRule], nullRule));
  });

  test('a suite-level vitest failure keys by the first message line, not the full error text', () => {
    const suite = (message: string): string =>
      fingerprintFailure(failureOf({ line: null, message, ruleId: 'vitest-suite' }), {
        tool: 'vitest',
      });
    expect(suite('Error: cannot load\n  at /tmp/a.ts:10:5')).toBe(
      suite('Error: cannot load\n  at /tmp/a.ts:99:1'),
    );
  });

  test('empty failure set yields an empty fingerprint set', () => {
    expect(fingerprintSet({ tool: 'eslint', failures: [], exitCode: 0 }).size).toBe(0);
  });
});
