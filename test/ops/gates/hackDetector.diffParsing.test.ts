// Split provenance: test/ops/gates/hackDetector.test.ts was split by subject
// into sibling files; this file carries the diff-parsing and line-number cases.
import { describe, expect, test } from 'vitest';
import { hackDetector } from '../../../src/ops/gates/hackDetector.js';
import { findingsOf } from './hackDetector.helpers.js';

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
