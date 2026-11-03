// Analyze lane G2 — test evidence for the ast-grep codemod path: the JSON
// wire parse (planned edits vs honestly-counted unfixed matches), the
// scan's verdict policy (a non-zero exit behind parsable JSON is the
// error-severity contract, not a failure; a lost exit is a fault naming the
// missing binary), the collision block, the exact splice semantics of the
// apply, the synthesized unified diffs (hunks, no-newline markers), and the
// op's approval gate — an apply without `approved: true` refuses before any
// I/O. All through INJECTED runners and stores: no ast-grep binary, no real
// fs.
//
// Split provenance: test/ops/analyze/codemod/astGrep.test.ts was split into
// astGrep.parse.test.ts, astGrep.scan.test.ts, astGrep.collision.test.ts,
// astGrep.diff.test.ts, astGrep.codemod-approval.test.ts,
// astGrep.codemod-plan.test.ts, astGrep.codemod-write-safety.test.ts and
// astGrep.codemod-target-policy.test.ts; shared fixtures live in
// astGrep.helpers.ts.
import { describe, expect, test } from 'vitest';
import {
  applyEditsToBytes,
  renderUnifiedDiff,
} from '../../../../src/ops/analyze/codemod/astGrep.js';

describe('renderUnifiedDiff (synthesized hunks, exact at the edit sites)', () => {
  const A = 'const foo_bar = 1;\nconst other = foo_bar;\n';

  test('adjacent edits share one hunk with the conventional header', () => {
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from(A, 'utf8'), [
      { file: 'src/a.ts', startByte: 6, endByte: 13, replacement: 'fooBar' },
      { file: 'src/a.ts', startByte: 33, endByte: 40, replacement: 'fooBar' },
    ]);
    expect(diff).toBe(
      [
        '--- src/a.ts\n',
        '+++ src/a.ts\n',
        '@@ -1,2 +1,2 @@\n',
        '-const foo_bar = 1;\n',
        '-const other = foo_bar;\n',
        '+const fooBar = 1;\n',
        '+const other = fooBar;\n',
      ].join(''),
    );
  });

  test('post-extension re-merge: two newline-joins whose extended blocks touch share one hunk (r1 review)', () => {
    // Deleting the newline after 'a' and after 'c' extends block [0,1) to
    // [0,2) and block [2,3) to [2,4) — now touching, so the re-merge pass
    // fuses them into ONE block [0,4) rendering one hunk.
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from('a\nb\nc\nd\ne\n', 'utf8'), [
      { file: 'src/a.ts', startByte: 1, endByte: 2, replacement: '' },
      { file: 'src/a.ts', startByte: 5, endByte: 6, replacement: '' },
    ]);
    expect(diff).toBe(
      [
        '--- src/a.ts\n',
        '+++ src/a.ts\n',
        '@@ -1,5 +1,3 @@\n',
        '-a\n',
        '-b\n',
        '-c\n',
        '-d\n',
        '+ab\n',
        '+cd\n',
        ' e\n',
      ].join(''),
    );
  });

  test('EOF join without a trailing newline renders both no-newline markers (r1 review)', () => {
    // 'beta' has no trailing newline (EOF): joining alpha+beta consumes the
    // file's last newline, so BOTH the del and add sides carry the
    // '\ No newline at end of file' marker.
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from('alpha\nbeta', 'utf8'), [
      { file: 'src/a.ts', startByte: 5, endByte: 6, replacement: '' },
    ]);
    expect(diff).toBe(
      [
        '--- src/a.ts\n',
        '+++ src/a.ts\n',
        '@@ -1,2 +1,1 @@\n',
        '-alpha\n',
        '-beta\n',
        '\\ No newline at end of file\n',
        '+alphabeta\n',
        '\\ No newline at end of file\n',
      ].join(''),
    );
  });

  test('a between-lines boundary insertion renders the following line rewritten (r3 review)', () => {
    // A zero-width insertion AT a line boundary probes an empty window and
    // extends over the FOLLOWING line: the diff shows `-beta` / `+Xbeta`
    // (the insertion becomes visible instead of the old invisible-prepend).
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from('alpha\nbeta\n', 'utf8'), [
      { file: 'src/a.ts', startByte: 6, endByte: 6, replacement: 'X' },
    ]);
    expect(diff).toBe(
      [
        '--- src/a.ts\n',
        '+++ src/a.ts\n',
        '@@ -1,2 +1,2 @@\n',
        ' alpha\n',
        '-beta\n',
        '+Xbeta\n',
      ].join(''),
    );
  });

  test('a CRLF newline-only deletion joins the lines, CR preserved in the text (r2 review)', () => {
    // CRLF files: the extension predicate fires on the \n half; the CR is
    // ordinary text and survives inside the joined line.
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from('alpha\r\nbeta\r\n', 'utf8'), [
      { file: 'src/a.ts', startByte: 6, endByte: 7, replacement: '' },
    ]);
    expect(diff).toBe(
      [
        '--- src/a.ts\n',
        '+++ src/a.ts\n',
        '@@ -1,2 +1,1 @@\n',
        '-alpha\r\n',
        '-beta\r\n',
        '+alpha\rbeta\r\n',
      ].join(''),
    );
  });

  test('a replacement that KEEPS the newline does not extend the block (r1 review)', () => {
    // Rewriting 'alpha' in place leaves the block's trailing newline intact:
    // no join, beta stays context — the no-extension control.
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from('alpha\nbeta\n', 'utf8'), [
      { file: 'src/a.ts', startByte: 0, endByte: 5, replacement: 'gamma' },
    ]);
    expect(diff).toBe(
      [
        '--- src/a.ts\n',
        '+++ src/a.ts\n',
        '@@ -1,2 +1,2 @@\n',
        '-alpha\n',
        '+gamma\n',
        ' beta\n',
      ].join(''),
    );
  });

  test('a FULL-line deletion does not extend the block: the next line stays context (coderabbit r1)', () => {
    // Deleting `alpha\n` outright joins nothing — beta merely moves up. The
    // extension must require surviving spliced content, or beta would be
    // rendered as removed-and-readded.
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from('alpha\nbeta\n', 'utf8'), [
      { file: 'src/a.ts', startByte: 0, endByte: 6, replacement: '' },
    ]);
    expect(diff).toBe(
      ['--- src/a.ts\n', '+++ src/a.ts\n', '@@ -1,2 +1,1 @@\n', '-alpha\n', ' beta\n'].join(''),
    );
  });

  test('a newline-only deletion shows the JOINED line, not an invisible join (review-debt #159)', () => {
    // The plan deletes ONLY the newline after 'alpha' (byte 5): alpha joins
    // beta. A one-line block would render `-alpha` / `+alpha` with beta as
    // unchanged context — the join invisible. The block extends over the
    // joined line so the diff shows the full resulting line.
    const diff = renderUnifiedDiff('src/a.ts', Buffer.from('alpha\nbeta\ngamma\n', 'utf8'), [
      { file: 'src/a.ts', startByte: 5, endByte: 6, replacement: '' },
    ]);
    expect(diff).toBe(
      [
        '--- src/a.ts\n',
        '+++ src/a.ts\n',
        '@@ -1,3 +1,2 @@\n',
        '-alpha\n',
        '-beta\n',
        '+alphabeta\n',
        ' gamma\n',
      ].join(''),
    );
  });

  test('far-apart edits produce separate hunks with three context lines', () => {
    const lines: string[] = [];
    for (let i = 1; i <= 20; i++) lines.push(`const v${i} = ${i};`);
    const content = `${lines.join('\n')}\n`;
    const needle = 'const v2 = 2;';
    const second = 'const v19 = 19;';
    const firstStart = content.indexOf(needle);
    const secondStart = content.indexOf(second);
    const diff = renderUnifiedDiff('src/big.ts', Buffer.from(content, 'utf8'), [
      {
        file: 'src/big.ts',
        startByte: firstStart,
        endByte: firstStart + needle.length,
        replacement: 'const v2_changed = 2;',
      },
      {
        file: 'src/big.ts',
        startByte: secondStart,
        endByte: secondStart + second.length,
        replacement: 'const v19_changed = 19;',
      },
    ]);
    const hunkHeaders = diff.split('\n').filter((line) => line.startsWith('@@'));
    expect(hunkHeaders).toEqual(['@@ -1,5 +1,5 @@', '@@ -16,5 +16,5 @@']);
    expect(diff).toContain('-const v2 = 2;');
    expect(diff).toContain('+const v2_changed = 2;');
    expect(diff).toContain(' const v4 = 4;'); // trailing context of hunk 1
    expect(diff).toContain(' const v17 = 17;'); // leading context of hunk 2
  });

  test('a file without a trailing newline carries the no-newline marker', () => {
    const content = 'export const baz_qux = 2;';
    const diff = renderUnifiedDiff('src/b.ts', Buffer.from(content, 'utf8'), [
      { file: 'src/b.ts', startByte: 13, endByte: 20, replacement: 'bazQux' },
    ]);
    expect(diff).toContain('-export const baz_qux = 2;\n\\ No newline at end of file\n');
    expect(diff).toContain('+export const bazQux = 2;\n\\ No newline at end of file\n');
  });

  test('a pure insertion at offset == file length (EOF) renders a diff and applies (L1)', async () => {
    for (const content of ['const a = 1;\n', 'const a = 1;']) {
      const bytes = Buffer.from(content, 'utf8');
      const insertion = {
        file: 'src/eof.ts',
        startByte: bytes.length,
        endByte: bytes.length,
        replacement: 'const b = 2;',
      };
      // The pre-L1 renderer threw out-of-bounds on the zero-width EOF block.
      const diff = renderUnifiedDiff('src/eof.ts', bytes, [insertion]);
      expect(diff).toContain('@@');
      // After a trailing newline the insertion is its own added line; in a
      // file WITHOUT one it appends to the last line — either way the added
      // content is in the diff with a '+' marker.
      expect(diff).toMatch(/\+.*const b = 2;/);
      // And the plan applies cleanly.
      const applied = applyEditsToBytes(bytes, [insertion]);
      expect(Buffer.from(applied).toString('utf8').startsWith(content)).toBe(true);
      expect(Buffer.from(applied).toString('utf8')).toContain('const b = 2;');
    }
  });

  test('an empty plan renders an empty diff', () => {
    expect(renderUnifiedDiff('src/a.ts', Buffer.from(A, 'utf8'), [])).toBe('');
  });
});
