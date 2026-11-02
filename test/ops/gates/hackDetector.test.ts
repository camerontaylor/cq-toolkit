import { match } from '../../helpers/matchers.js';
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
  DEFAULT_TEST_FILE_PATTERNS,
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
  suppressionPatterns?: readonly SuppressionPattern[],
): Promise<TamperFinding[]> {
  const result = await hackDetector({
    diff,
    ...(suppressionPatterns === undefined ? {} : { suppressionPatterns }),
  });
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
      'diff --git a/test/fresh.test.ts b/test/fresh.test.ts',
      'new file mode 100644',
      'index 0000000..9999999',
      '--- /dev/null',
      '+++ b/test/fresh.test.ts',
      '@@ -0,0 +1,1 @@',
      '+export const x = test.skip("later");',
    ].join('\n');
    const findings = await findingsOf(diff);
    expect(findings.map((f) => [f.kind, f.file, f.line])).toEqual([
      ['new-skip-only', 'test/fresh.test.ts', 1],
    ]);
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

  test('@@-bulleted prose is not diff structure: indeterminate', async () => {
    const result = await hackDetector({
      diff: 'meeting notes @@ everyone attends\naction items @@ follow up',
    });
    expect(result).toEqual({
      status: 'indeterminate',
      detail: 'input does not parse as a unified diff',
    });
  });

  test('a --- line with a NON-ADJACENT +++ is not diff structure: indeterminate', async () => {
    const result = await hackDetector({
      diff: '--- a/src/x.ts\nprose between the headers\n+++ b/src/x.ts\n+// @ts-ignore',
    });
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

describe('hackDetector: Python basename deletion and rename controls (RI4)', () => {
  test.each(['apps/crq-python/test_widget.py', 'pkg/widget_test.py'])(
    'deleting %s reports its exact removed path',
    async (path) => {
      const diff = [
        `diff --git a/${path} b/${path}`,
        'deleted file mode 100644',
        `--- a/${path}`,
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-def test_widget(): pass',
      ].join('\n');
      expect(await findingsOf(diff)).toEqual([
        {
          kind: 'deleted-test-file',
          file: path,
          line: null,
          pattern: '(?:^|/)(?:test_[^/]*|[^/]*_test)\\.py$',
          snippet: `--- a/${path}`,
          message: `removed from the test run (deleted or renamed out of test patterns): ${path}`,
        },
      ]);
      for (const tamper of [{ detectDeletedTests: false }, { testFilePatterns: [] }]) {
        expect(await hackDetector({ diff, tamper })).toEqual({ status: 'ok', value: [] });
      }
      const replaced = await hackDetector({ diff, tamper: { testFilePatterns: ['^custom/'] } });
      expect(replaced).toEqual({ status: 'ok', value: [] });
    },
  );

  test.each([
    ['pkg/test_widget.py', 'pkg/widget.py', true],
    ['pkg/widget_test.py', 'pkg/widget.py', true],
    ['pkg/widget.py', 'pkg/test_widget.py', false],
    ['pkg/widget.py', 'pkg/widget_test.py', false],
    ['pkg/test_widget.py', 'pkg/widget_test.py', false],
    ['pkg/widget_test.py', 'tests/widget.py', false],
    ['tests/widget.py', 'pkg/test_widget.py', false],
    ['pkg/widget.py', 'pkg/prepare-host.py', false],
  ] as const)('rename %s → %s: removed=%s', async (from, to, removed) => {
    const diff = [
      `diff --git a/${from} b/${to}`,
      'similarity index 100%',
      `rename from ${from}`,
      `rename to ${to}`,
    ].join('\n');
    const findings = await findingsOf(diff);
    if (removed) {
      expect(findings).toHaveLength(1);
      expect(findings[0]).toMatchObject({ kind: 'deleted-test-file', file: from, line: null });
    } else {
      expect(findings).toEqual([]);
    }
  });

  test.each(['pkg/test_widget.py', 'pkg/widget_test.py', 'pkg/prepare-host.py'])(
    'adding ordinary Python content at %s is not removal',
    async (path) => {
      const diff = [
        `diff --git a/${path} b/${path}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        '+value = 1',
      ].join('\n');
      expect(await findingsOf(diff)).toEqual([]);
    },
  );

  test.each(['pkg/prepare-host.py', 'pkg/contest_widget.py', 'pkg/test_widget.py.bak'])(
    'deleting ordinary source %s is not a deleted test',
    async (path) => {
      const diff = [
        `diff --git a/${path} b/${path}`,
        'deleted file mode 100644',
        `--- a/${path}`,
        '+++ /dev/null',
        '@@ -1 +0,0 @@',
        '-value = 1',
      ].join('\n');
      expect(await findingsOf(diff)).toEqual([]);
    },
  );
});

describe('hackDetector: tamper toggles', () => {
  test('detectDeletedTests: false suppresses the deleted-test-file finding', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { detectDeletedTests: false },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('invalid testFilePatterns remain an honest config failure (removed-test cannot be disabled)', async () => {
    const result = await hackDetector({
      diff: fixture('deleted-test.diff'),
      tamper: { testFilePatterns: ['('] },
    });
    expect(result.status).toBe('failed');
  });

  test('garbage skipOnlyPattern never compiles when the knob is off (lazy-compile symmetry)', async () => {
    const result = await hackDetector({
      diff: fixture('add-skip.diff'),
      tamper: { detectNewSkipOnly: false, skipOnlyPattern: '(' },
    });
    expect(result).toEqual({ status: 'ok', value: [] });
  });

  test('a "\\ No newline at end of file" marker is metadata, never content or a line slot', async () => {
    const diff = [
      'diff --git a/src/tail.ts b/src/tail.ts',
      'index 1111111..2222222 100644',
      '--- a/src/tail.ts',
      '+++ b/src/tail.ts',
      '@@ -1,2 +1,2 @@',
      ' const a = 1;',
      '-const b = 2;',
      '+// @ts-ignore',
      '\\ No newline at end of file',
    ].join('\n');
    expect(await findingsOf(diff)).toEqual([
      {
        kind: 'suppression',
        file: 'src/tail.ts',
        line: 2,
        pattern: '@ts-ignore',
        snippet: '// @ts-ignore',
        message: 'added suppression "@ts-ignore"',
      },
    ]);
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

describe('hackDetector: Python skip/xfail markers (#774)', () => {
  const PY = 'apps/crq-python/test_widget.py';

  /** A one-hunk modification of `path`: `context` lines, then `added` lines. */
  function pyDiff(
    added: readonly string[],
    context: readonly string[] = [],
    path = PY,
    header = '',
  ): string {
    return [
      `diff --git a/${path} b/${path}`,
      'index 1111111..2222222 100644',
      `--- a/${path}`,
      `+++ b/${path}`,
      `@@ -1,${context.length} +1,${context.length + added.length} @@${header}`,
      ...context.map((line) => ` ${line}`),
      ...added.map((line) => `+${line}`),
    ].join('\n');
  }

  async function markersOf(diff: string, tamper?: Record<string, unknown>): Promise<string[]> {
    const result = await hackDetector({ diff, ...(tamper === undefined ? {} : { tamper }) });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('unreachable');
    return result.value.filter((f) => f.kind === 'new-skip-only').map((f) => f.pattern ?? '');
  }

  test('an added pytest skip decorator reports the exact new-skip-only finding', async () => {
    const diff = pyDiff(['@pytest.mark.skip(reason="flaky")', 'def test_b():'], ['import pytest']);
    expect(await findingsOf(diff)).toEqual([
      {
        kind: 'new-skip-only',
        file: PY,
        line: 2,
        pattern: 'pytest.mark.skip',
        snippet: '@pytest.mark.skip(reason="flaky")',
        message: 'added line marks a Python test as skipped or expected to fail',
      },
    ]);
  });

  test.each([
    ['@pytest.mark.skip', 'pytest.mark.skip'],
    ['@pytest.mark.skipif(sys.platform == "win32", reason="x")', 'pytest.mark.skipif'],
    ['@pytest.mark.xfail(strict=True)', 'pytest.mark.xfail'],
    ['@ pytest . mark . xfail', 'pytest.mark.xfail'],
    ['pytestmark = pytest.mark.skip(reason="module")', 'pytest.mark.skip'],
    ['    pytest.param(1, marks=pytest.mark.xfail),', 'pytest.mark.xfail'],
    ['    pytest.skip("not today")', 'pytest.skip'],
    ['pytest.skip("module", allow_module_level=True)', 'pytest.skip'],
    ['    pytest.xfail("known bug")', 'pytest.xfail'],
    ['@unittest.skip("later")', 'unittest.skip'],
    ['@unittest.skipIf(True, "x")', 'unittest.skipIf'],
    ['@unittest.skipUnless(HAVE_X, "x")', 'unittest.skipUnless'],
    ['@unittest.expectedFailure', 'unittest.expectedFailure'],
    ['        self.skipTest("no network")', 'self.skipTest'],
    ['        raise unittest.SkipTest("no network")', 'unittest.SkipTest'],
    ['@mark.skip', 'pytest.mark.skip'],
  ])('added %s → %s', async (line, marker) => {
    expect(await markersOf(pyDiff([line]))).toEqual([marker]);
  });

  test.each([
    [['import pytest as pt'], '@pt.mark.skip', 'pytest.mark.skip'],
    [['from pytest import mark'], '@mark.xfail', 'pytest.mark.xfail'],
    [['from pytest import mark as m'], '@m.skipif(True, reason="x")', 'pytest.mark.skipif'],
    [['from pytest import skip'], '    skip("x")', 'pytest.skip'],
    [['from pytest import xfail as xf'], '    xf("x")', 'pytest.xfail'],
    [['import unittest as ut'], '@ut.skipIf(True, "x")', 'unittest.skipIf'],
    [['from unittest import skip'], '@skip("later")', 'unittest.skip'],
    [['from unittest import skipIf, skipUnless'], '@skipUnless(X, "x")', 'unittest.skipUnless'],
    [['from unittest import expectedFailure as ef'], '@ef', 'unittest.expectedFailure'],
    [['from unittest import SkipTest'], '    raise SkipTest("x")', 'unittest.SkipTest'],
    [['from unittest import (', '    TestCase,', '    skip,', ')'], '@skip("x")', 'unittest.skip'],
  ])('alias %j then %s → %s', async (imports, line, marker) => {
    expect(await markersOf(pyDiff([line], imports))).toEqual([marker]);
    // An added import resolves the alias just the same.
    expect(await markersOf(pyDiff([...imports, line]))).toEqual([marker]);
  });

  test('an alias imported in a later hunk of the same section still resolves', async () => {
    const diff = [
      `diff --git a/${PY} b/${PY}`,
      `--- a/${PY}`,
      `+++ b/${PY}`,
      '@@ -1,1 +1,2 @@',
      ' from unittest import skip',
      '+@skip("x")',
      '@@ -40,1 +41,2 @@',
      ' x = 1',
      '+from pytest import mark as m',
    ].join('\n');
    expect(await markersOf(diff)).toEqual(['unittest.skip']);
    const reversed = [
      `diff --git a/${PY} b/${PY}`,
      `--- a/${PY}`,
      `+++ b/${PY}`,
      '@@ -1,1 +1,2 @@',
      ' x = 1',
      '+@m.xfail',
      '@@ -40,1 +41,1 @@',
      ' from pytest import mark as m',
    ].join('\n');
    expect(await markersOf(reversed)).toEqual(['pytest.mark.xfail']);
  });

  test('pytest.importorskip flags only inside a visible test body (documented policy)', async () => {
    expect(await markersOf(pyDiff(['np = pytest.importorskip("numpy")']))).toEqual([]);
    expect(
      await markersOf(pyDiff(['    np = pytest.importorskip("numpy")'], ['def helper():'])),
    ).toEqual([]);
    expect(
      await markersOf(pyDiff(['    np = pytest.importorskip("numpy")'], ['def test_np():'])),
    ).toEqual(['pytest.importorskip']);
    expect(
      await markersOf(
        pyDiff(
          ['        np = pytest.importorskip("numpy")'],
          ['class TestNp:', '    def test_np(self):'],
        ),
      ),
    ).toEqual(['pytest.importorskip']);
    expect(
      await markersOf(pyDiff(['    np = pytest.importorskip("numpy")'], [], PY, ' def test_np():')),
    ).toEqual(['pytest.importorskip']);
    expect(
      await markersOf(
        pyDiff(
          ['    importorskip("numpy")'],
          ['from pytest import importorskip', 'def test_np():'],
        ),
      ),
    ).toEqual(['pytest.importorskip']);
    // Leaving the test body (dedent) ends it.
    expect(
      await markersOf(
        pyDiff(['np = pytest.importorskip("numpy")'], ['def test_np():', '    assert True']),
      ),
    ).toEqual([]);
  });

  test.each([
    ['# @pytest.mark.skip until fixed'],
    ['x = 1  # pytest.skip("later")'],
    ['msg = "@pytest.mark.skip"'],
    ['msg = \'unittest.skip("x")\''],
    ['msg = f"{x} self.skipTest(1)"'],
    ['"""@pytest.mark.xfail in a one-line docstring"""'],
    ['skip_cache = True'],
    ['pytest.skip_cache = True'],
    ['self.skip_cache()'],
    ['result = skipper(1)'],
    ['@pytest.mark.skipping_is_not_a_marker'],
    ['iterator.skip(3)'],
    ['rows.skip(count)'],
    ['self.mark_skip()'],
    ['remark.skip(1)'],
    ['except unittest.SkipTest:'],
    ['skip("not imported here")'],
  ])('false-positive control: %s does not flag', async (line) => {
    expect(await markersOf(pyDiff([line]))).toEqual([]);
  });

  /** A real-diff-shaped modification whose hunk starts at `start` (> 1). */
  function midFileDiff(start: number, header: string, body: readonly string[]): string {
    const old = body.filter((line) => !line.startsWith('+')).length;
    const added = body.filter((line) => !line.startsWith('-')).length;
    return [
      `diff --git a/${PY} b/${PY}`,
      'index 1111111..2222222 100644',
      `--- a/${PY}`,
      `+++ b/${PY}`,
      `@@ -${start},${old} +${start},${added} @@${header}`,
      ...body,
    ].join('\n');
  }

  test('P1 regression: a hunk starting mid-docstring never hides a following added skip', async () => {
    const diff = midFileDiff(22, ' def test_a():', [
      '     line four',
      '     line five',
      '     """',
      '+    pytest.skip("flaky")',
      '     assert 1',
    ]);
    expect(await findingsOf(diff)).toEqual([
      {
        kind: 'new-skip-only',
        file: PY,
        line: 25,
        pattern: 'pytest.skip',
        snippet: 'pytest.skip("flaky")',
        message: 'added line marks a Python test as skipped or expected to fail',
      },
    ]);
  });

  test.each([
    ['    self.skipTest("later")', 'self.skipTest'],
    ['@unittest.skip("later")', 'unittest.skip'],
    ["    pytest.xfail('known')", 'pytest.xfail'],
  ])("P1: a hunk starting inside a ''' string still flags %s", async (line, marker) => {
    const diff = midFileDiff(40, '', ['     tail of a string', "     '''", `+${line}`]);
    expect(await markersOf(diff)).toEqual([marker]);
  });

  test('P1: an added line in a hunk starting at line 1 is lexed from a known state', async () => {
    // Known start: the docstring prose is a string, so it never flags.
    const diff = midFileDiff(1, '', [
      ' def test_a():',
      '     """Docs.',
      '+    pytest.skip("prose") is mentioned here',
      '     """',
    ]);
    expect(await markersOf(diff)).toEqual([]);
  });

  test.each([
    ['pytestmark = mark.skip(reason="x")', 'pytest.mark.skip'],
    ['    pytest.param(1, marks=mark.xfail),', 'pytest.mark.xfail'],
    ['mark.skip = 1', 'pytest.mark.skip'],
    ['@pt.mark.skipif(True, reason="x")', 'pytest.mark.skipif'],
    ['pytestmark = [pt.mark.xfail]', 'pytest.mark.xfail'],
    ['@skip("x")', 'unittest.skip'],
    ['@skipIf(True, "x")', 'unittest.skipIf'],
    ['@skipUnless(X, "x")', 'unittest.skipUnless'],
    ['@expectedFailure', 'unittest.expectedFailure'],
    ['@ut.skipIf(True, "x")', 'unittest.skipIf'],
    ['    raise SkipTest("x")', 'unittest.SkipTest'],
    ['    raise ut.SkipTest("x")', 'unittest.SkipTest'],
    ['    raise pt.skip.Exception("x")', 'pytest.skip'],
    ['    pt.skip("x")', 'pytest.skip'],
    ['    pt.skip(reason="x")', 'pytest.skip'],
    ['pt.skip("module", allow_module_level=True)', 'pytest.skip'],
    ['    pt.xfail("x")', 'pytest.xfail'],
    ['    xfail("x")', 'pytest.xfail'],
    ['    cls.skipTest("x")', 'self.skipTest'],
  ])('P2 fallback without a visible import: %s → %s', async (line, marker) => {
    const diff = midFileDiff(120, ' def test_a():', ['     x = 1', `+${line}`]);
    expect(await markersOf(diff)).toEqual([marker]);
  });

  test('P2: importorskip under any alias flags only inside a test body', async () => {
    expect(
      await markersOf(
        midFileDiff(120, ' def test_a():', ['     x = 1', '+    pt.importorskip("np")']),
      ),
    ).toEqual(['pytest.importorskip']);
    expect(
      await markersOf(
        midFileDiff(120, ' def helper():', ['     x = 1', '+    pt.importorskip("np")']),
      ),
    ).toEqual([]);
  });

  test.each([
    [[], '@unittest.case.skip("x")', 'unittest.skip'],
    [[], '@unittest.case.skipIf(True, "x")', 'unittest.skipIf'],
    [['from unittest.case import skip as s'], '@s("x")', 'unittest.skip'],
    [['from unittest.case import SkipTest as ST'], '    raise ST("x")', 'unittest.SkipTest'],
    [['import unittest.case as uc'], '@uc.expectedFailure', 'unittest.expectedFailure'],
  ])('P3 unittest.case: %j then %s → %s', async (imports, line, marker) => {
    expect(await markersOf(pyDiff([line], imports))).toEqual([marker]);
  });

  test('a multi-line docstring hides markers on its inner lines', async () => {
    const diff = pyDiff([
      'def test_a():',
      '    """Docs.',
      '    @pytest.mark.skip is mentioned here',
      '    pytest.skip("still prose")',
      '    """',
      '    pytest.skip("real")',
    ]);
    expect(await markersOf(diff)).toEqual(['pytest.skip']);
    const findings = await findingsOf(diff);
    expect(findings.map((f) => f.line)).toEqual([6]);
  });

  test('a docstring opened on a context line hides an added marker inside it', async () => {
    expect(
      await markersOf(pyDiff(['@pytest.mark.skip prose'], ['def test_a():', '    """Docs'])),
    ).toEqual([]);
  });

  test('removed and context lines never flag', async () => {
    const diff = [
      `diff --git a/${PY} b/${PY}`,
      `--- a/${PY}`,
      `+++ b/${PY}`,
      '@@ -1,3 +1,2 @@',
      ' @pytest.mark.skip',
      '-@unittest.skip("removed")',
      ' def test_a():',
    ].join('\n');
    expect(await findingsOf(diff)).toEqual([]);
  });

  test('a removed docstring opener does not hide a following added marker', async () => {
    const diff = [
      `diff --git a/${PY} b/${PY}`,
      `--- a/${PY}`,
      `+++ b/${PY}`,
      '@@ -1,1 +1,1 @@',
      '-"""',
      '+@pytest.mark.skip',
    ].join('\n');
    expect(await markersOf(diff)).toEqual(['pytest.mark.skip']);
  });

  test.each([
    'apps/crq-python/status_summary.py',
    'tests/helpers.py',
    'tests/conftest.py',
    'pkg/contest_widget.py',
    'pkg/test_widget.py.bak',
    'src/widget.ts',
  ])('non-test file %s does not flag Python markers', async (path) => {
    expect(
      await markersOf(pyDiff(['@pytest.mark.skip', '    self.skipTest("x")'], [], path)),
    ).toEqual([]);
  });

  test.each(['pkg/test_widget.py', 'pkg/widget_test.py', 'tests/unit/test_widget.py'])(
    'Python test basename %s flags',
    async (path) => {
      expect(await markersOf(pyDiff(['@unittest.expectedFailure'], [], path))).toEqual([
        'unittest.expectedFailure',
      ]);
    },
  );

  test('a newly added Python test file is scanned', async () => {
    const diff = [
      `diff --git a/${PY} b/${PY}`,
      'new file mode 100644',
      '--- /dev/null',
      `+++ b/${PY}`,
      '@@ -0,0 +1,3 @@',
      '+import pytest as pt',
      '+@pt.mark.xfail',
      '+def test_a(): pass',
    ].join('\n');
    expect(await findingsOf(diff)).toMatchObject([{ kind: 'new-skip-only', line: 2 }]);
  });

  test('one finding per line, even with two markers or a regex marker on the same line', async () => {
    expect(await markersOf(pyDiff(['@pytest.mark.skip; pytest.xfail("x")']))).toEqual([
      'pytest.mark.skip',
    ]);
  });

  test('a line matched by both the JS/TS regex and a Python marker yields one finding', async () => {
    // `model.fit(` matches the shipped JS/TS `fit(` focus marker and
    // `pytest.skip(` the Python recognition: the regex finding stands alone.
    const line = '    pytest.skip("x"); model.fit(data)';
    expect(await findingsOf(pyDiff([line]))).toEqual([
      {
        kind: 'new-skip-only',
        file: PY,
        line: 1,
        pattern: DEFAULT_SKIP_ONLY_PATTERN,
        snippet: line.trim(),
        message: 'added line marks a test as skipped or focused',
      },
    ]);
  });

  test('detectNewSkipOnly: false mutes Python markers', async () => {
    expect(await markersOf(pyDiff(['@pytest.mark.skip']), { detectNewSkipOnly: false })).toEqual(
      [],
    );
  });

  test('a custom skipOnlyPattern replaces the shipped taxonomy, Python included', async () => {
    const diff = pyDiff(['@pytest.mark.skip', 'fixtureSlow()']);
    expect(await markersOf(diff, { skipOnlyPattern: '\\bfixtureSlow\\b' })).toEqual([
      '\\bfixtureSlow\\b',
    ]);
  });

  test('the shipped JS/TS marker still applies to JS/TS files only as before', async () => {
    expect(await markersOf(pyDiff(['test.skip("x", () => {});'], [], 'test/a.test.ts'))).toEqual([
      DEFAULT_SKIP_ONLY_PATTERN,
    ]);
  });
});
