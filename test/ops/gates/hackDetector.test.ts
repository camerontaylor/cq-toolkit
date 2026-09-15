// Gates lane C3 — test evidence for the hack detector: every shipped
// tamper-diff fixture round-trips to its EXACT expected findings
// (kind/file/line/pattern/snippet/message), the must-NOT-flag fixtures
// (pre-existing suppressions as context lines, a '-'-line removal, a clean
// change) yield zero findings, and the config surface behaves as
// documented (replacement pattern lists, requiresReason, heuristic
// toggles, hunk line-number tracking). All pure — zero I/O beyond reading
// the shipped fixture text.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  DEFAULT_SKIP_ONLY_PATTERN,
  DEFAULT_SUPPRESSION_PATTERNS,
  hackDetector,
} from '../../../src/ops/gates/hackDetector.js';
import type { SuppressionPattern, TamperFinding } from '../../../src/ops/gates/hackDetector.js';

/** Fixture text from the shipped tamper-diff corpus. */
function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/tamper-diffs/${name}`, import.meta.url), 'utf8');
}

/** The findings of a clean scan — asserts the op status is ok first. */
async function findingsOf(
  diff: string,
  suppressionPatterns?: SuppressionPattern[],
): Promise<TamperFinding[]> {
  const result = await hackDetector({ diff, suppressionPatterns });
  expect(result.status).toBe('ok');
  return result.status === 'ok' ? result.value : [];
}

describe('hackDetector: fixture round-trips (exact findings)', () => {
  test('deleted-test.diff → one deleted-test-file finding, line null', async () => {
    expect(await findingsOf(fixture('deleted-test.diff'))).toEqual([
      {
        kind: 'deleted-test-file',
        file: 'src/legacy/printer.test.ts',
        line: null,
        pattern: '\\.test\\.[tj]sx?$',
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
        pattern: '\\.test\\.[tj]sx?$',
        snippet: '--- a/src/legacy/printer.test.ts',
        message:
          'removed from the test run (deleted or renamed out of test patterns): src/legacy/printer.test.ts',
      },
    ]);
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
      'diff --git a/src/pair.ts b/src/pair.ts',
      'index 1111111..2222222 100644',
      '--- a/src/pair.ts',
      '+++ b/src/pair.ts',
      '@@ -1,1 +1,2 @@',
      ' const a = 1;',
      '+it("both fake", () => { expect(1).toBe(1); expect(2).toBe(2); });',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.filter((f) => f.kind === 'tautological-assertion')).toHaveLength(2);
  });

  test('a tautology and a suppression sharing one line yield BOTH findings independently', async () => {
    const diff = [
      'diff --git a/src/mix.ts b/src/mix.ts',
      'index 3333333..4444444 100644',
      '--- a/src/mix.ts',
      '+++ b/src/mix.ts',
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
        pattern: '\\.test\\.[tj]sx?$',
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

  test('the shipped defaults are frozen (referencable, not mutable)', () => {
    expect(Object.isFrozen(DEFAULT_SUPPRESSION_PATTERNS)).toBe(true);
    expect(DEFAULT_SUPPRESSION_PATTERNS.map((p) => p.name)).toEqual([
      'eslint-disable',
      '@ts-ignore',
      '@ts-expect-error',
      'istanbul ignore',
    ]);
  });

  test('a custom pattern source that does not compile is a `failed` op, never a crash', async () => {
    const result = await hackDetector({ diff: '+anything', suppressionPatterns: [{ name: 'bad', pattern: '(' }] });
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

describe('hackDetector: diff parsing and line-number tracking', () => {
  test('multiple files in one diff carry their own paths', async () => {
    const diff = [
      'diff --git a/src/one.ts b/src/one.ts',
      'index 1111111..2222222 100644',
      '--- a/src/one.ts',
      '+++ b/src/one.ts',
      '@@ -1,2 +1,3 @@',
      ' const a = 1;',
      '+// eslint-disable-next-line no-console',
      ' const b = 2;',
      'diff --git a/src/two.ts b/src/two.ts',
      'index 3333333..4444444 100644',
      '--- a/src/two.ts',
      '+++ b/src/two.ts',
      '@@ -5,2 +5,3 @@',
      ' const c = 3;',
      '+// istanbul ignore next',
      ' const d = 4;',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.map((f) => [f.file, f.pattern])).toEqual([
      ['src/one.ts', 'eslint-disable'],
      ['src/two.ts', 'istanbul ignore'],
    ]);
  });

  test('hunk tracking: a finding line is its position in the NEW file, per hunk', async () => {
    const diff = [
      'diff --git a/src/many.ts b/src/many.ts',
      'index 7777777..8888888 100644',
      '--- a/src/many.ts',
      '+++ b/src/many.ts',
      '@@ -1,2 +1,3 @@',
      ' const first = 1;',
      '+// @ts-ignore',
      ' const second = 2;',
      '@@ -100,2 +101,3 @@',
      ' const third = 3;',
      '+// istanbul ignore next',
      ' const fourth = 4;',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.map((f) => f.line)).toEqual([2, 102]);
  });

  test('a NEW file (--- /dev/null) scans its added lines under the b/ path', async () => {
    const diff = [
      'diff --git a/src/fresh.ts b/src/fresh.ts',
      'new file mode 100644',
      'index 0000000..9999999',
      '--- /dev/null',
      '+++ b/src/fresh.ts',
      '@@ -0,0 +1,1 @@',
      '+export const x = test.skip("later");',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.map((f) => [f.kind, f.file, f.line])).toEqual([['new-skip-only', 'src/fresh.ts', 1]]);
  });

  test('non-blank input with NO diff structure is indeterminate, never a silent clean scan (I5)', async () => {
    const result = await hackDetector({ diff: 'this is not a diff at all' });
    expect(result).toEqual({
      status: 'indeterminate',
      detail: 'input does not parse as a unified diff',
    });
  });

  test('bare +/- lines are prose, not diff structure: indeterminate', async () => {
    const result = await hackDetector({ diff: '+ hello\n+ world\n- goodbye' });
    expect(result).toEqual({
      status: 'indeterminate',
      detail: 'input does not parse as a unified diff',
    });
  });

  test('a lone --- header without a +++ pair is not diff structure either', async () => {
    const result = await hackDetector({ diff: '--- a/src/x.ts\nsome prose under it' });
    expect(result).toEqual({
      status: 'indeterminate',
      detail: 'input does not parse as a unified diff',
    });
  });

  test('diff-shaped but broken text is best-effort scanned: ok with empty findings', async () => {
    expect(await findingsOf('diff --git a/x b/x\n@@ garbage @@\n+// @ts-ignore\n')).toEqual([]);
  });

  test('added lines before any +++ header attribute to file "unknown" (best effort)', async () => {
    const diff = '@@ -1,1 +1,2 @@\n+// @ts-ignore\n context\n';
    const findings = await findingsOf(diff);
    expect(findings.map((f) => [f.file, f.line])).toEqual([['unknown', 1]]);
  });

  test('an empty diff is a clean diff', async () => {
    expect(await findingsOf('')).toEqual([]);
  });
});

describe('hackDetector: tamper toggles', () => {
  test('detectDeletedTests: false suppresses the deleted-test-file finding', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { detectDeletedTests: false },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('invalid testFilePatterns never compile when the knob is off: no throw, no failed', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { detectDeletedTests: false, testFilePatterns: ['('] },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('an empty testFilePatterns list replaces the default shapes (no test-file match)', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { testFilePatterns: [] },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('detectNewSkipOnly: false and detectTautologies: false mute their heuristics', async () => {
    const skipResult = await hackDetector({
      diff: fixture('add-skip.diff'),
      tamper: { detectNewSkipOnly: false },
    });
    expect(skipResult).toEqual({ status: 'ok', value: [] });
    const tautologyResult = await hackDetector({
      diff: fixture('tautology.diff'),
      tamper: { detectTautologies: false },
    });
    expect(tautologyResult).toEqual({ status: 'ok', value: [] });
  });
});
