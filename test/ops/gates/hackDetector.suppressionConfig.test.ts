// Split provenance: test/ops/gates/hackDetector.test.ts was split by subject
// into sibling files; this file carries the suppression-pattern config cases.
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import {
  DEFAULT_SUPPRESSION_PATTERNS,
  DEFAULT_TEST_FILE_PATTERNS,
  hackDetector,
} from '../../../src/ops/gates/hackDetector.js';
import { findingsOf, fixture } from './hackDetector.helpers.js';

describe('hackDetector: suppression config', () => {
  const MIXED_DIFF = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 1111111..2222222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,2 +1,4 @@',
    ' const before = 1;',
    '+// @ts-ignore',
    '+// HACK_TOKEN: hidden behind the linter',
    ' const after = 2;',
  ].join('\n');

  test('a custom pattern list REPLACES the shipped defaults (no @ts-ignore finding)', async () => {
    const findings = await findingsOf(MIXED_DIFF, [
      { name: 'hack-token', pattern: '^// HACK_TOKEN' },
    ]);
    expect(findings).toEqual([
      {
        kind: 'suppression',
        file: 'src/a.ts',
        line: 3,
        pattern: 'hack-token',
        snippet: '// HACK_TOKEN: hidden behind the linter',
        message: 'added suppression "hack-token"',
      },
    ]);
  });

  test('requiresReason: a bare match flags, whitespace-only and reasoned matches do not', async () => {
    const diff = [
      'diff --git a/src/b.ts b/src/b.ts',
      'index 3333333..4444444 100644',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -10,2 +10,5 @@',
      '   const a = 1;',
      '+   // @ts-expect-error',
      '+   // @ts-expect-error   ',
      '+   // @ts-expect-error: TODO(JIRA-9) drop after the migration lands',
      '   const b = 2;',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.map((f) => f.line)).toEqual([11, 12]);
    expect(findings[0]?.pattern).toBe('@ts-expect-error');
    expect(findings[0]?.message).toBe(
      'added suppression "@ts-expect-error" without the required same-line reason',
    );
  });

  test('a quoted deleted test path (spaces in the filename) still detects the deletion', async () => {
    const diff = [
      'diff --git "a/src/with space/printer.test.ts" "b/src/with space/printer.test.ts"',
      'deleted file mode 100644',
      'index 8a4b1c2..0000000',
      '--- "a/src/with space/printer.test.ts"',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-const a = 1;',
      '-const b = 2;',
    ].join('\n');
    expect(await findingsOf(diff)).toEqual([
      {
        kind: 'deleted-test-file',
        file: 'src/with space/printer.test.ts',
        line: null,
        pattern: '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
        snippet: '--- "a/src/with space/printer.test.ts"',
        message:
          'removed from the test run (deleted or renamed out of test patterns): src/with space/printer.test.ts',
      },
    ]);
  });

  test('a custom skipOnlyPattern replaces the shipped skip/only marker', async () => {
    const diff = [
      'diff --git a/test/a.test.ts b/test/a.test.ts',
      'index 1111111..2222222 100644',
      '--- a/test/a.test.ts',
      '+++ b/test/a.test.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '+fixtureSlow("does the thing");',
      '+test.skip("untouched by the custom marker", () => {});',
    ].join('\n');
    const result = await hackDetector({
      diff,
      tamper: { skipOnlyPattern: '\\bfixtureSlow\\b' },
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('unreachable');
    }
    expect(result.value).toEqual([
      {
        kind: 'new-skip-only',
        file: 'test/a.test.ts',
        line: 2,
        pattern: '\\bfixtureSlow\\b',
        snippet: 'fixtureSlow("does the thing");',
        message: 'added line marks a test as skipped or focused',
      },
    ]);
  });

  test('a suppression on a "-" line is never flagged (removal is a fix)', async () => {
    const diff = [
      'diff --git a/src/c.ts b/src/c.ts',
      'index 5555555..6666666 100644',
      '--- a/src/c.ts',
      '+++ b/src/c.ts',
      '@@ -1,3 +1,2 @@',
      ' const a = 1;',
      '-// @ts-ignore — no longer needed',
      ' const b = 2;',
    ].join('\n');
    expect(await findingsOf(diff)).toEqual([]);
  });

  test.each(['oxlint-disable', 'oxlint-disable-next-line', 'oxlint-disable-line'])(
    'detects added %s directives',
    async (directive) => {
      const diff = [
        'diff --git a/src/a.ts b/src/a.ts',
        '--- a/src/a.ts',
        '+++ b/src/a.ts',
        '@@ -0,0 +1 @@',
        `+// ${directive} no-debugger -- fixture`,
      ].join('\n');
      expect(await findingsOf(diff)).toEqual([
        match.objectContaining({ pattern: 'oxlint-disable' }),
      ]);
    },
  );

  test('the shipped defaults are DEEP-frozen: mutation attempts throw in strict mode', () => {
    expect(Object.isFrozen(DEFAULT_SUPPRESSION_PATTERNS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_SUPPRESSION_PATTERNS[0])).toBe(true);
    expect(Object.isFrozen(DEFAULT_SUPPRESSION_PATTERNS[3])).toBe(true);
    expect(DEFAULT_SUPPRESSION_PATTERNS.map((p) => p.name)).toEqual([
      'eslint-disable',
      'oxlint-disable',
      '@ts-ignore',
      '@ts-expect-error',
      '@ts-nocheck',
      'biome-ignore',
      'istanbul ignore',
    ]);
    expect(() => {
      (DEFAULT_SUPPRESSION_PATTERNS[2] as { pattern: string }).pattern = '\\bnever\\b';
    }).toThrow(TypeError);
    expect(DEFAULT_SUPPRESSION_PATTERNS[2]?.pattern).toBe('@ts-ignore\\b');
  });

  test('the frozen defaults pass STRAIGHT into the readonly config fields, no casts', async () => {
    // A type-level pin: readonly string[] / readonly SuppressionPattern[]
    // config fields must accept the frozen shipped defaults verbatim.
    const direct = await hackDetector({
      diff: fixture('suppression-added.diff'),
      suppressionPatterns: DEFAULT_SUPPRESSION_PATTERNS,
      tamper: { testFilePatterns: DEFAULT_TEST_FILE_PATTERNS },
    });
    const implicit = await hackDetector({ diff: fixture('suppression-added.diff') });
    expect(direct).toEqual(implicit);
  });

  test('a custom pattern source that does not compile is a `failed` op, never a crash', async () => {
    const result = await hackDetector({
      diff: '+anything',
      suppressionPatterns: [{ name: 'bad', pattern: '(' }],
    });
    expect(result.status).toBe('failed');
  });

  test('g/y flags are stripped at compile: every match found across files, hunks, and lines', async () => {
    // With `g` preserved, the shared RegExp carries lastIndex across exec
    // calls and later lines/files would be silently skipped — the exact
    // regression this test pins.
    const diff = [
      'diff --git a/src/one.ts b/src/one.ts',
      'index 1111111..2222222 100644',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1,1 +1,3 @@',
      ' const a = 1;',
      '+const b = TODO_HACK;',
      '+const c = TODO_HACK;',
      '@@ -10,1 +12,2 @@',
      ' const d = 4;',
      '+const e = TODO_HACK;',
      'diff --git a/src/two.ts b/src/two.ts',
      'index 3333333..4444444 100644',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -5,1 +5,2 @@',
      ' const f = 6;',
      '+const g = TODO_HACK;',
    ].join('\n');
    const findings = await findingsOf(diff, [
      { name: 'todo-hack', pattern: '\\bTODO_HACK\\b', flags: 'g' },
    ]);
    expect(findings).toHaveLength(4);
    expect(findings.map((f) => [f.file, f.line])).toEqual([
      ['src/one.ts', 2],
      ['src/one.ts', 3],
      ['src/one.ts', 13],
      ['src/two.ts', 6],
    ]);
  });
});
