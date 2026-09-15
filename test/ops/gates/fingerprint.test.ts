// Gates lane C2 — test evidence: the fingerprint's bucket math (19 vs 20 is
// the documented boundary), offset-addressed failures, rootDir/separator
// normalization, ruleId divergence, and the drift-survival contract itself —
// two failures differing ONLY in message fingerprint identically. FNV-1a is
// pinned against the PUBLISHED 32-bit vectors, so a silent hash change (or
// platform nondeterminism) fails these tests, not a circular snapshot.
import { describe, expect, test } from 'vitest';
import {
  fingerprintFailure,
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

  test('message-independence: different messages, same fingerprint (the drift-survival contract)', () => {
    expect(fingerprintFailure(failureOf({ message: "'x' is assigned a value but never used." }))).toBe(
      fingerprintFailure(failureOf({ message: "'x' is read here but the rule text changed." })),
    );
  });

  test('a null file and a null ruleId are stable components, not errors', () => {
    const nullFields = fingerprintFailure(failureOf({ file: null, ruleId: null }));
    expect(nullFields).toBe(fingerprintFailure(failureOf({ file: null, ruleId: null })));
    expect(nullFields).not.toBe(fingerprintFailure(failureOf({ file: null, ruleId: 'rule' })));
  });
});

describe('fingerprintSet', () => {
  test('collects one fingerprint per failure, deduplicated', () => {
    const set = fingerprintSet({
      tool: 'eslint',
      exitCode: 1,
      failures: [
        failureOf({ line: 3 }),
        failureOf({ line: 7, message: 'same bucket as line 3' }),
        failureOf({ line: 300 }),
      ],
    });
    expect(set.size).toBe(2);
    expect(set.has(fingerprintFailure(failureOf({ line: 300 })))).toBe(true);
  });

  test('empty failure set yields an empty fingerprint set', () => {
    expect(fingerprintSet({ tool: 'eslint', failures: [], exitCode: 0 }).size).toBe(0);
  });
});
