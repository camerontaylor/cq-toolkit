// Split provenance: test/ops/gates/hackDetector.test.ts was split by subject
// into sibling files; this file carries the Python skip/xfail marker cases.
import { describe, expect, test } from 'vitest';
import { DEFAULT_SKIP_ONLY_PATTERN, hackDetector } from '../../../src/ops/gates/hackDetector.js';
import { findingsOf } from './hackDetector.helpers.js';

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

  test('a multi-line def signature keeps the test body visible to importorskip', async () => {
    expect(
      await markersOf(
        pyDiff([
          'def test_x(',
          '    fixture_a,',
          '):',
          '    pytest.importorskip("numpy")',
        ]),
      ),
    ).toEqual(['pytest.importorskip']);
    // The same for a return-annotated signature and for a method in a class.
    expect(
      await markersOf(
        pyDiff([
          'def test_x(',
          '    fixture_a: int,',
          ') -> None:',
          '    pytest.importorskip("numpy")',
        ]),
      ),
    ).toEqual(['pytest.importorskip']);
    expect(
      await markersOf(
        pyDiff([
          'class TestX:',
          '    def test_x(',
          '        self,',
          '        fixture_a,',
          '    ):',
          '        pytest.importorskip("numpy")',
        ]),
      ),
    ).toEqual(['pytest.importorskip']);
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

  test('a line matched by both the JS/TS regex and a Python marker reports the Python marker', async () => {
    // `model.fit(` matches the shipped JS/TS `fit(` focus marker, but the
    // Python scanner owns the default taxonomy for Python test paths.
    const line = '    pytest.skip("x"); model.fit(data)';
    expect(await findingsOf(pyDiff([line]))).toEqual([
      {
        kind: 'new-skip-only',
        file: PY,
        line: 1,
        pattern: 'pytest.skip',
        snippet: line.trim(),
        message: 'added line marks a Python test as skipped or expected to fail',
      },
    ]);
  });

  test('an ordinary added model.fit( in a Python test is not a skip/only finding', async () => {
    expect(await markersOf(pyDiff(['    model.fit(X, y)', '    clf.fit(X, y)']))).toEqual([]);
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
