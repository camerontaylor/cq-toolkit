// Split provenance: test/ops/gates/hackDetector.test.ts was split by subject
// into sibling files; this file carries the Python basename deletion/rename cases.
import { describe, expect, test } from 'vitest';
import { hackDetector } from '../../../src/ops/gates/hackDetector.js';
import { findingsOf } from './hackDetector.helpers.js';

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
