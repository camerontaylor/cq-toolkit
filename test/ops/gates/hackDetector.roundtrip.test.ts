// Split provenance: test/ops/gates/hackDetector.test.ts was split by subject
// into sibling files; this file carries the shipped-fixture round-trip cases.
import { describe, expect, test } from 'vitest';
import { DEFAULT_SKIP_ONLY_PATTERN } from '../../../src/ops/gates/hackDetector.js';
import { findingsOf, fixture } from './hackDetector.helpers.js';

describe('hackDetector: fixture round-trips (exact findings)', () => {
  test('deleted-test.diff → one deleted-test-file finding, line null', async () => {
    expect(await findingsOf(fixture('deleted-test.diff'))).toEqual([
      {
        kind: 'deleted-test-file',
        file: 'src/legacy/printer.test.ts',
        line: null,
        pattern: '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
        snippet: '--- a/src/legacy/printer.test.ts',
        message:
          'removed from the test run (deleted or renamed out of test patterns): src/legacy/printer.test.ts',
      },
    ]);
  });

  test('rename-test-out.diff → the renamed-away tests are removed from the run (flagged)', async () => {
    expect(await findingsOf(fixture('rename-test-out.diff'))).toEqual([
      {
        kind: 'deleted-test-file',
        file: 'src/legacy/printer.test.ts',
        line: null,
        pattern: '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
        snippet: 'rename from src/legacy/printer.test.ts',
        message:
          'removed from the test run (deleted or renamed out of test patterns): src/legacy/printer.test.ts',
      },
    ]);
  });

  test('rename-test-pure.diff → a pure git mv out of test-land is flagged (no ---/+++ headers)', async () => {
    expect(await findingsOf(fixture('rename-test-pure.diff'))).toEqual([
      {
        kind: 'deleted-test-file',
        file: 'src/legacy/printer.test.ts',
        line: null,
        pattern: '\\.(?:test|spec)\\.[cm]?[jt]sx?$',
        snippet: 'rename from src/legacy/printer.test.ts',
        message:
          'removed from the test run (deleted or renamed out of test patterns): src/legacy/printer.test.ts',
      },
    ]);
  });

  test('a PURE rename WITHIN test patterns stays unflagged', async () => {
    const diff = [
      'diff --git a/src/legacy/printer.test.ts b/src/legacy/printer.e2e.test.ts',
      'similarity index 100%',
      'rename from src/legacy/printer.test.ts',
      'rename to src/legacy/printer.e2e.test.ts',
    ].join('\n');
    expect(await findingsOf(diff)).toEqual([]);
  });

  test('a modified rename is evaluated ONCE (rename headers route; no +++ duplicate)', async () => {
    const diff = [
      'diff --git a/src/solo.test.ts b/src/solo.util.ts',
      'similarity index 74%',
      'rename from src/solo.test.ts',
      'rename to src/solo.util.ts',
      '--- a/src/solo.test.ts',
      '+++ b/src/solo.util.ts',
      '@@ -1,3 +1,3 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+const b = 3;',
      ' export { a, b };',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.file).toBe('src/solo.test.ts');
  });

  test('a rename WITHIN test patterns stays unflagged', async () => {
    const diff = [
      'diff --git a/src/legacy/printer.test.ts b/src/legacy/printer.e2e.test.ts',
      'similarity index 91%',
      'rename from src/legacy/printer.test.ts',
      'rename to src/legacy/printer.e2e.test.ts',
      '--- a/src/legacy/printer.test.ts',
      '+++ b/src/legacy/printer.e2e.test.ts',
      '@@ -1,3 +1,3 @@',
      " import { expect } from 'vitest';",
      "-const label = printLabel('ab');",
      "+const label = printLabel('abc');",
      ' export {};',
    ].join('\n');
    expect(await findingsOf(diff)).toEqual([]);
  });

  test('add-skip.diff → two new-skip-only findings at new-file lines 11 and 14', async () => {
    expect(await findingsOf(fixture('add-skip.diff'))).toEqual([
      {
        kind: 'new-skip-only',
        file: 'test/ops/cache.test.ts',
        line: 11,
        pattern: DEFAULT_SKIP_ONLY_PATTERN,
        snippet: "test.skip('evicts stale values', () => {",
        message: 'added line marks a test as skipped or focused',
      },
      {
        kind: 'new-skip-only',
        file: 'test/ops/cache.test.ts',
        line: 14,
        pattern: DEFAULT_SKIP_ONLY_PATTERN,
        snippet: "describe.skip('slow paths', () => {",
        message: 'added line marks a test as skipped or focused',
      },
    ]);
  });

  test('add-only.diff → one new-skip-only finding at new-file line 17', async () => {
    expect(await findingsOf(fixture('add-only.diff'))).toEqual([
      {
        kind: 'new-skip-only',
        file: 'test/kernel/plan.test.ts',
        line: 17,
        pattern: DEFAULT_SKIP_ONLY_PATTERN,
        snippet: "it.only('focuses the budget path', async () => {",
        message: 'added line marks a test as skipped or focused',
      },
    ]);
  });

  test('tautology.diff → two tautological-assertion findings at lines 10 and 11', async () => {
    expect(await findingsOf(fixture('tautology.diff'))).toEqual([
      {
        kind: 'tautological-assertion',
        file: 'src/math/abs.test.ts',
        line: 10,
        snippet: 'expect(makeValue()).toBe(makeValue());',
        message: 'added assertion compares an expression to itself',
      },
      {
        kind: 'tautological-assertion',
        file: 'src/math/abs.test.ts',
        line: 11,
        snippet: 'expect(1).toBe(1);',
        message: 'added assertion compares an expression to itself',
      },
    ]);
  });

  test('two tautologies on ONE added line yield two findings (matchAll, no cross-consumption)', async () => {
    const diff = [
      'diff --git a/test/pair.test.ts b/test/pair.test.ts',
      'index 1111111..2222222 100644',
      '--- a/test/pair.test.ts',
      '+++ b/test/pair.test.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+it("both fake", () => { expect(1).toBe(1); expect(2).toBe(2); });',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.filter((f) => f.kind === 'tautological-assertion')).toHaveLength(2);
  });

  test('a tautology and a suppression sharing one line yield BOTH findings independently', async () => {
    const diff = [
      'diff --git a/test/mix.test.ts b/test/mix.test.ts',
      'index 3333333..4444444 100644',
      '--- a/test/mix.test.ts',
      '+++ b/test/mix.test.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+expect(1).toBe(1); // @ts-ignore',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.map((f) => [f.kind, f.pattern])).toEqual([
      ['suppression', '@ts-ignore'],
      ['tautological-assertion', undefined],
    ]);
  });

  test('suppression-added.diff → eslint-disable + @ts-ignore findings on the + lines', async () => {
    expect(await findingsOf(fixture('suppression-added.diff'))).toEqual([
      {
        kind: 'suppression',
        file: 'src/parsers/config.ts',
        line: 24,
        pattern: 'eslint-disable',
        snippet: '// eslint-disable-next-line @typescript-eslint/no-explicit-any',
        message: 'added suppression "eslint-disable"',
      },
      {
        kind: 'suppression',
        file: 'src/parsers/config.ts',
        line: 26,
        pattern: '@ts-ignore',
        snippet: '// @ts-ignore',
        message: 'added suppression "@ts-ignore"',
      },
    ]);
  });

  test('ts-expect-error-reason.diff → only the BARE @ts-expect-error flagged (line 47)', async () => {
    expect(await findingsOf(fixture('ts-expect-error-reason.diff'))).toEqual([
      {
        kind: 'suppression',
        file: 'src/drivers/legacyBridge.ts',
        line: 47,
        pattern: '@ts-expect-error',
        snippet: '// @ts-expect-error',
        message: 'added suppression "@ts-expect-error" without the required same-line reason',
      },
    ]);
  });

  test('suppression-preexisting.diff → ZERO findings (context invisible, "-" removal is a fix)', async () => {
    // The same eslint-disable/@ts-ignore lines as suppression-added.diff
    // appear here as CONTEXT lines plus one @ts-ignore on a REMOVED line —
    // pre-existing suppressions are never blamed (UC row 28) and deleting
    // one is a fix, not a hack.
    expect(await findingsOf(fixture('suppression-preexisting.diff'))).toEqual([]);
  });

  test('clean.diff → ZERO findings', async () => {
    expect(await findingsOf(fixture('clean.diff'))).toEqual([]);
  });
});
