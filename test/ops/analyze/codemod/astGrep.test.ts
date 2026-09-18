// Analyze lane G2 — test evidence for the ast-grep codemod path: the JSON
// wire parse (planned edits vs honestly-counted unfixed matches), the
// scan's verdict policy (a non-zero exit behind parsable JSON is the
// error-severity contract, not a failure; a lost exit is a fault naming the
// missing binary), the collision block, the exact splice semantics of the
// apply, the synthesized unified diffs (hunks, no-newline markers), and the
// op's approval gate — an apply without `approved: true` refuses before any
// I/O. All through INJECTED runners and stores: no ast-grep binary, no real
// fs.
import { describe, expect, test } from 'vitest';
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFileStore } from '../../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../../src/ops/analyze/analysisStore.js';
import {
  applyEditsToBytes,
  findCollision,
  makeAstGrepCodemod,
  makeAstGrepScan,
  parseAstGrepJson,
  renderUnifiedDiff,
} from '../../../../src/ops/analyze/codemod/astGrep.js';
import { contentDigest } from '../../../../src/ops/analyze/renderAnalysisReport.js';

/**
 * An in-memory store recording writes; same idiom as the render tests. The
 * paths are used verbatim (the unit under test builds them).
 */
function memoryStore(files: Record<string, string>): AnalyzeFileStore & {
  written: Map<string, Uint8Array>;
} {
  const backing = new Map<string, Uint8Array>(
    Object.entries(files).map(([path, text]) => [path, Buffer.from(text, 'utf8')]),
  );
  const written = new Map<string, Uint8Array>();
  return {
    written,
    readBytes: async (path) => {
      const bytes = backing.get(path);
      if (bytes === undefined) {
        throw new AnalysisStoreError(`analysis store: '${path}' does not resolve`);
      }
      return Uint8Array.from(bytes);
    },
    readText: async (path) => Buffer.from(backing.get(path) as Uint8Array).toString('utf8'),
    writeBytes: async (path, bytes) => {
      const copy = Uint8Array.from(bytes);
      written.set(path, copy);
      backing.set(path, copy);
    },
    isDirectory: async () => true,
  };
}

/** A fake runner returning one canned raw output and recording the command. */
function fakeRunner(response: Omit<RawCheckOutput, never>): RunCheck & { commands: unknown[] } {
  const runner = async (cmd: Parameters<RunCheck>[0]) => {
    runner.commands.push(cmd);
    return response;
  };
  runner.commands = [] as unknown[];
  return runner as RunCheck & { commands: unknown[] };
}

/** One ast-grep scan match with a fix, over a byte range (the documented wire shape). */
function matchOf(file: string, start: number, end: number, replacement: string): object {
  return {
    text: 'matched bytes',
    range: {
      byteOffset: { start, end },
      start: { line: 0, column: 0 },
      end: { line: 0, column: end - start },
    },
    file,
    lines: 'matched bytes',
    charCount: { leading: 0, trailing: 0 },
    replacement,
    replacementOffsets: { start, end },
    language: 'TypeScript',
    ruleId: 'consumer-rule',
    severity: 'hint',
    note: null,
    message: 'consumer rule message',
  };
}

describe('parseAstGrepJson (the wire contract, strict where it matters)', () => {
  test('parses planned edits from replacement + replacementOffsets (byte ranges, documented)', () => {
    const result = parseAstGrepJson(
      JSON.stringify([matchOf('src/a.ts', 6, 13, 'fooBar'), matchOf('src/a.ts', 33, 40, 'fooBar')]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.plannedEdits).toEqual([
      { file: 'src/a.ts', startByte: 6, endByte: 13, replacement: 'fooBar' },
      { file: 'src/a.ts', startByte: 33, endByte: 40, replacement: 'fooBar' },
    ]);
    expect(result.outcome.unfixedMatches).toBe(0);
  });

  test('a match without a replacement is an honest unfixed match, never a fake edit', () => {
    const result = parseAstGrepJson(
      JSON.stringify([
        { file: 'src/a.ts', range: {}, ruleId: 'no-fix-rule', severity: 'warning' },
        matchOf('src/a.ts', 0, 1, 'x'),
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome.plannedEdits).toHaveLength(1);
    expect(result.outcome.unfixedMatches).toBe(1);
  });

  test('an empty array parses to the honest empty outcome', () => {
    const result = parseAstGrepJson('[]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.outcome).toEqual({ plannedEdits: [], unfixedMatches: 0 });
  });

  test('unparsable output, non-arrays, and edits without ranges are faults', () => {
    expect(parseAstGrepJson('not json').ok).toBe(false);
    expect(parseAstGrepJson('{"file":"a"}').ok).toBe(false);
    expect(parseAstGrepJson('[null]').ok).toBe(false);
    expect(parseAstGrepJson('[{"replacement":"x"}]').ok).toBe(false);
    const noOffsets = parseAstGrepJson(JSON.stringify([{ file: 'src/a.ts', replacement: 'x' }]));
    expect(noOffsets.ok).toBe(false);
    if (noOffsets.ok) return;
    expect(noOffsets.fault).toContain('replacementOffsets');
    const badOffsets = parseAstGrepJson(
      JSON.stringify([
        { file: 'src/a.ts', replacement: 'x', replacementOffsets: { start: 5, end: 2 } },
      ]),
    );
    expect(badOffsets.ok).toBe(false);
  });
});

describe('makeAstGrepScan (the injected-runner verdict policy)', () => {
  test('the command is the documented surface, scoped to the files, with cwd and timeout', async () => {
    const run = fakeRunner({ stdout: '[]', stderr: '', exitCode: 0 });
    const scan = makeAstGrepScan(run);
    const result = await scan({
      dir: '/ws',
      rule: 'id: r\nlanguage: ts\nrule:\n  pattern: x',
      files: ['src/a.ts', 'src/b.ts'],
      timeoutMs: 5_000,
    });
    expect(result.ok).toBe(true);
    expect(run.commands).toEqual([
      {
        command: 'ast-grep',
        args: [
          'scan',
          '--json=compact',
          '--inline-rules',
          'id: r\nlanguage: ts\nrule:\n  pattern: x',
          '--',
          'src/a.ts',
          'src/b.ts',
        ],
        cwd: '/ws',
        timeoutMs: 5_000,
      },
    ]);
  });

  test('a non-zero exit behind parsable JSON is a COMPLETED scan (the error-severity contract)', async () => {
    const run = fakeRunner({
      stdout: JSON.stringify([matchOf('src/a.ts', 0, 1, 'x')]),
      stderr: '',
      exitCode: 1,
    });
    const result = await makeAstGrepScan(run)({ dir: '/ws', rule: 'r', files: ['src/a.ts'] });
    expect(result.ok).toBe(true);
  });

  test('exit 0 with STDERR errors (a requested file the scan could not read) is a fault naming it — never a partial plan (R2-1)', async () => {
    // Verified against ast-grep 0.45.3: a missing requested file yields
    // matches for the others + `ERROR: <file>: ...` on stderr, exit 0.
    const run = fakeRunner({
      stdout: JSON.stringify([matchOf('src/a.ts', 6, 13, 'fooBar')]),
      stderr: 'ERROR: src/nope.ts: No such file or directory (os error 2)',
      exitCode: 0,
    });
    const result = await makeAstGrepScan(run)({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts', 'src/nope.ts'],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toContain('errors on stderr');
    expect(result.fault).toContain('src/nope.ts');
    expect(result.fault).toContain('silently absent');
  });

  test('an EMPTY result behind a NON-ZERO exit is non-passing evidence — never a clean no-op (P1)', async () => {
    // Mirrors the gates' checkRunner rule: [] behind exit 1 is a failed
    // ast-grep run, not a completed scan that matched nothing.
    const run = fakeRunner({ stdout: '[]', stderr: '', exitCode: 1 });
    const result = await makeAstGrepScan(run)({ dir: '/ws', rule: 'r', files: ['src/a.ts'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toContain('NO matches behind exit code 1');
    expect(result.fault).toContain('non-passing evidence');
  });

  test('crash text (stderr + non-zero exit) is a fault naming the exit and the stderr (the stderr rule fires first)', async () => {
    const run = fakeRunner({ stdout: '', stderr: 'error: unrecognized flag', exitCode: 2 });
    const result = await makeAstGrepScan(run)({ dir: '/ws', rule: 'r', files: ['src/a.ts'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toContain('errors on stderr');
    expect(result.fault).toContain('exit code 2');
    expect(result.fault).toContain('unrecognized flag');
  });

  test('unparsable output behind a non-zero exit with EMPTY stderr is a fault naming the exit', async () => {
    const run = fakeRunner({ stdout: 'binary \udcf0 garbage', stderr: '', exitCode: 3 });
    const result = await makeAstGrepScan(run)({ dir: '/ws', rule: 'r', files: ['src/a.ts'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toContain('not valid JSON');
    expect(result.fault).toContain('exit code 3');
  });

  test('an unobservable exit (the missing-binary shape) is a fault saying so — never an empty match set', async () => {
    const run = fakeRunner({ stdout: '', stderr: '', exitCode: null });
    const result = await makeAstGrepScan(run)({ dir: '/ws', rule: 'r', files: ['src/a.ts'] });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fault).toContain('unobservable');
    expect(result.fault).toContain('INCOMPLETE plan');
  });
});

describe('collision check + splice apply (the write-safety core)', () => {
  test('overlapping byte ranges in ONE file block the whole apply, naming both ranges', () => {
    const collision = findCollision([
      { file: 'src/a.ts', startByte: 0, endByte: 10, replacement: 'x' },
      { file: 'src/a.ts', startByte: 5, endByte: 20, replacement: 'y' },
    ]);
    expect(collision).toContain('collision');
    expect(collision).toContain("in 'src/a.ts'");
    expect(collision).toContain('[0, 10)');
    expect(collision).toContain('[5, 20)');
    expect(findCollision([])).toBeNull();
    // Disjoint edits and edits in DIFFERENT files never collide.
    expect(
      findCollision([
        { file: 'src/a.ts', startByte: 0, endByte: 10, replacement: 'x' },
        { file: 'src/a.ts', startByte: 10, endByte: 20, replacement: 'y' },
        { file: 'src/b.ts', startByte: 0, endByte: 5, replacement: 'z' },
      ]),
    ).toBeNull();
  });

  test('applyEditsToBytes splices disjoint edits in ascending order over the current bytes', () => {
    const content = Buffer.from('const foo_bar = 1;\nconst other = foo_bar;\n', 'utf8');
    const applied = applyEditsToBytes(content, [
      { file: 'a', startByte: 33, endByte: 40, replacement: 'fooBar' },
      { file: 'a', startByte: 6, endByte: 13, replacement: 'fooBar' },
    ]);
    expect(Buffer.from(applied).toString('utf8')).toBe(
      'const fooBar = 1;\nconst other = fooBar;\n',
    );
  });

  test('applyEditsToBytes refuses an out-of-bounds range (belt to the staleness braces)', () => {
    const content = Buffer.from('short', 'utf8');
    expect(() =>
      applyEditsToBytes(content, [{ file: 'a', startByte: 0, endByte: 99, replacement: 'x' }]),
    ).toThrow(/out of bounds/);
  });
});

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

describe('makeAstGrepCodemod (the op: approval gate first, then scan → collision → write)', () => {
  const FIXTURE_FILES = {
    'src/a.ts': 'const foo_bar = 1;\nconst other = foo_bar;\n',
    'src/b.ts': 'export const baz_qux = 2;\n',
  };
  const EDITS = [
    { file: 'src/a.ts', startByte: 6, endByte: 13, replacement: 'fooBar' },
    { file: 'src/a.ts', startByte: 33, endByte: 40, replacement: 'fooBar' },
    { file: 'src/b.ts', startByte: 13, endByte: 20, replacement: 'bazQux' },
  ];

  function scanRunner(): RunCheck & { commands: unknown[] } {
    return fakeRunner({
      stdout: JSON.stringify(
        EDITS.map((e) => matchOf(e.file, e.startByte, e.endByte, e.replacement)),
      ),
      stderr: '',
      exitCode: 0,
    });
  }

  function makeOp(store: AnalyzeFileStore, run: RunCheck = scanRunner()) {
    return makeAstGrepCodemod(run, () => store);
  }

  test('an apply without explicit approval is refused BEFORE any I/O', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const run = scanRunner();
    const op = makeOp(store, run);
    for (const approved of [undefined, false]) {
      const result = await op({
        dir: '/ws',
        rule: 'r',
        files: ['src/a.ts'],
        dryRun: false,
        ...(approved === undefined ? {} : { approved }),
      });
      expect(result.status).toBe('needs-human');
      if (result.status !== 'needs-human') continue;
      expect(result.reason).toContain('never auto-applied');
      expect(result.reason).toContain('approved: true');
    }
    expect(store.written.size).toBe(0);
    expect(run.commands).toHaveLength(0); // not even a scan ran
  });

  test('a dry-run renders the diffs and writes NOTHING, approval or not', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const op = makeOp(store);
    const result = await op({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts', 'src/b.ts'],
      dryRun: true,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.value.mode).toBe('dry-run');
    expect(result.value.plannedEdits).toBe(3);
    const byFile = new Map(result.value.files.map((file) => [file.file, file]));
    expect(byFile.get('src/a.ts')?.edits).toBe(2);
    expect(byFile.get('src/a.ts')?.diff).toContain('-const foo_bar = 1;');
    expect(byFile.get('src/b.ts')?.diff).toContain('+export const bazQux = 2;');
    expect(store.written.size).toBe(0);
  });

  test('an approved apply combines each file’s edits into ONE write, in deterministic order', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const op = makeOp(store);
    const result = await op({
      dir: '/ws',
      rule: 'r',
      files: ['src/b.ts', 'src/a.ts'], // deliberately unsorted input
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value.mode !== 'applied') return;
    expect(result.value.files.map((file) => file.file)).toEqual(['src/a.ts', 'src/b.ts']);
    const newA = Buffer.from(store.written.get('src/a.ts') as Uint8Array).toString('utf8');
    expect(newA).toBe('const fooBar = 1;\nconst other = fooBar;\n');
    const byFile = new Map(result.value.files.map((file) => [file.file, file]));
    expect(byFile.get('src/a.ts')?.digestAfter).toBe(contentDigest(newA));
    expect(byFile.get('src/b.ts')?.digestAfter).toBe(contentDigest('export const bazQux = 2;\n'));
  });

  test('a collision blocks the whole apply: `failed`, nothing written', async () => {
    const store = memoryStore({ 'src/a.ts': FIXTURE_FILES['src/a.ts'] as string });
    const run = fakeRunner({
      stdout: JSON.stringify([
        matchOf('src/a.ts', 0, 10, 'one'),
        matchOf('src/a.ts', 5, 15, 'two'),
      ]),
      stderr: '',
      exitCode: 0,
    });
    const result = await makeOp(
      store,
      run,
    )({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts'],
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('collision');
      expect(result.error).toContain('blocked');
    }
    expect(store.written.size).toBe(0);
  });

  test('an empty planned-edit set is the HONEST empty result in both modes', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const emptyRun = fakeRunner({ stdout: '[]', stderr: '', exitCode: 0 });
    const op = makeOp(store, emptyRun);
    const dry = await op({ dir: '/ws', rule: 'r', files: ['src/a.ts'], dryRun: true });
    expect(dry.status).toBe('ok');
    if (dry.status === 'ok') {
      expect(dry.value.plannedEdits).toBe(0);
      expect(dry.value.note).toContain('nothing matched');
    }
    const applied = await op({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts'],
      dryRun: false,
      approved: true,
    });
    expect(applied.status).toBe('ok');
    if (applied.status === 'ok' && applied.value.mode === 'applied') {
      expect(applied.value.plannedEdits).toBe(0);
      expect(applied.value.note).toContain('nothing was written');
    }
    expect(store.written.size).toBe(0);
  });

  test('an UNOBSERVABLE exit behind PARSEABLE stdout is rejected before acceptance — never applied (T1)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const killedMidScan = fakeRunner({
      // A killed scan (timeout/signal/overflow) can leave a parseable JSON
      // prefix — accepting it would apply edits from an incomplete plan.
      stdout: JSON.stringify([matchOf('src/a.ts', 6, 13, 'fooBar')]),
      stderr: '',
      exitCode: null,
    });
    const op = makeOp(store, killedMidScan);
    const applied = await op({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts'],
      dryRun: false,
      approved: true,
    });
    expect(applied.status).toBe('failed');
    if (applied.status === 'failed') {
      expect(applied.error).toContain('unobservable');
      expect(applied.error).toContain('INCOMPLETE plan');
    }
    expect(store.written.size).toBe(0);
  });

  test('a write fault mid-apply names the files ALREADY written (T2)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    // The store faults on the SECOND file, after the first is on disk
    // (a delegating wrapper — the underlying store keeps the real writes).
    const flaky: AnalyzeFileStore & { written: Map<string, Uint8Array> } = {
      get written() {
        return store.written;
      },
      readBytes: (path) => store.readBytes(path),
      readText: (path) => store.readText(path),
      writeBytes: async (path, bytes) => {
        if (path === 'src/b.ts') {
          throw new AnalysisStoreError('analysis store: disk full on second write');
        }
        return store.writeBytes(path, bytes);
      },
      isDirectory: (path) => store.isDirectory(path),
    };
    const result = await makeOp(flaky)({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts', 'src/b.ts'],
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not write 'src/b.ts'");
      // Z2: the first file was RESTORED (best-effort rollback), not stranded.
      expect(result.error).toContain('rolled back src/a.ts');
      expect(result.error).toContain('original bytes restored');
    }
    // The first file's ORIGINAL bytes are back on disk.
    expect(Buffer.from(store.written.get('src/a.ts') as Uint8Array).toString('utf8')).toBe(
      'const foo_bar = 1;\nconst other = foo_bar;\n',
    );
  });

  test('when the codemod ROLLBACK itself faults, the stranded naming survives (Z2)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    // Faults on the second file's write AND on every subsequent restore.
    let writeCount = 0;
    const flaky: AnalyzeFileStore & { written: Map<string, Uint8Array> } = {
      get written() {
        return store.written;
      },
      readBytes: (path) => store.readBytes(path),
      readText: (path) => store.readText(path),
      writeBytes: async (path, bytes) => {
        writeCount += 1;
        if (writeCount >= 2) {
          throw new AnalysisStoreError(`analysis store: disk full on write ${writeCount}`);
        }
        return store.writeBytes(path, bytes);
      },
      isDirectory: (path) => store.isDirectory(path),
    };
    const result = await makeOp(flaky)({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts', 'src/b.ts'],
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not write 'src/b.ts'");
      expect(result.error).toContain('rollback FAILED for src/a.ts');
      expect(result.error).toContain('restored: none');
      expect(result.error).toContain('already written (stranded): src/a.ts');
    }
    // The stranded remediated form is what is on disk — named, not hidden.
    expect(Buffer.from(store.written.get('src/a.ts') as Uint8Array).toString('utf8')).toBe(
      'const fooBar = 1;\nconst other = fooBar;\n',
    );
  });

  test('a SPLICE fault on a later target happens in preflight: NOTHING written, no rollback needed (Y2)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    // Valid offsets for the FIRST target, out-of-bounds offsets for the
    // SECOND — pre-Y2 the first file was written (and rolled back); with
    // the preflight the fault happens before any write.
    const mixedRunner = fakeRunner({
      stdout: JSON.stringify([
        matchOf('src/a.ts', 6, 13, 'fooBar'),
        matchOf('src/b.ts', 100, 200, 'bazQux'),
      ]),
      stderr: '',
      exitCode: 0,
    });
    const result = await makeOp(
      store,
      mixedRunner,
    )({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts', 'src/b.ts'],
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not apply the plan to 'src/b.ts'");
      // No rollback wording: nothing had been written to roll back.
      expect(result.error).not.toContain('rolled back');
      expect(result.error).not.toContain('already written');
    }
    expect(store.written.size).toBe(0);
  });

  test('a PARTIAL rollback states both lists, and stranded is the exact complement of restored (Y1)', async () => {
    // Three targets; the store faults on c's first write, allows c's own
    // restore, but faults b's restore — so a and c come back, b is stranded.
    const three = {
      'src/a.ts': 'foo_bar_a();\n',
      'src/b.ts': 'foo_bar_b();\n',
      'src/c.ts': 'foo_bar_c();\n',
    };
    const store = memoryStore(three);
    const scan = fakeRunner({
      stdout: JSON.stringify([
        matchOf('src/a.ts', 0, 7, 'fooBarA'),
        matchOf('src/b.ts', 0, 7, 'fooBarB'),
        matchOf('src/c.ts', 0, 7, 'fooBarC'),
      ]),
      stderr: '',
      exitCode: 0,
    });
    const writeCounts = new Map<string, number>();
    const flaky: AnalyzeFileStore & { written: Map<string, Uint8Array> } = {
      get written() {
        return store.written;
      },
      readBytes: (path) => store.readBytes(path),
      readText: (path) => store.readText(path),
      writeBytes: async (path, bytes) => {
        const count = (writeCounts.get(path) ?? 0) + 1;
        writeCounts.set(path, count);
        if (path === 'src/c.ts' && count === 1) {
          throw new AnalysisStoreError('analysis store: disk full on c');
        }
        if (path === 'src/b.ts' && count === 2) {
          throw new AnalysisStoreError('analysis store: disk full restoring b');
        }
        return store.writeBytes(path, bytes);
      },
      isDirectory: (path) => store.isDirectory(path),
    };
    const result = await makeOp(
      flaky,
      scan,
    )({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain("could not write 'src/c.ts'");
      // BOTH lists, verbatim: b's restore failed (stranded), a's restore
      // succeeded (c's own partial-write restore succeeded silently).
      expect(result.error).toContain('rollback FAILED for src/b.ts');
      expect(result.error).toContain('restored: src/a.ts');
      // Y1: a restored file is listed ONLY under restored — b (whose
      // restore failed) is the one stranded entry.
      expect(result.error).toContain('already written (stranded): src/b.ts');
      expect(result.error).not.toContain('stranded): src/a.ts');
    }
    // The verbatim on-disk state: a and c carry their ORIGINAL bytes; b
    // holds its remediated form (stranded, as stated).
    expect(Buffer.from(store.written.get('src/a.ts') as Uint8Array).toString('utf8')).toBe(
      'foo_bar_a();\n',
    );
    expect(Buffer.from(store.written.get('src/c.ts') as Uint8Array).toString('utf8')).toBe(
      'foo_bar_c();\n',
    );
    expect(Buffer.from(store.written.get('src/b.ts') as Uint8Array).toString('utf8')).toBe(
      'fooBarB_b();\n',
    );
  });

  test('a file mutated between read and scan fails the apply — the offsets are stale, nothing written (R2-5)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    // The fake runner performs the drift ITSELF at scan time (ast-grep
    // re-reads the file then): the pre-scan digest no longer matches.
    const driftOnScan: RunCheck = async () => {
      const raw: RawCheckOutput = {
        stdout: JSON.stringify([matchOf('src/a.ts', 6, 13, 'fooBar')]),
        stderr: '',
        exitCode: 0,
      };
      await store.writeBytes('src/a.ts', Buffer.from('mutated mid-flight;\n', 'utf8'));
      return raw;
    };
    const result = await makeOp(
      store,
      driftOnScan,
    )({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts'],
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('file changed during remediation planning');
      expect(result.error).toContain("'src/a.ts'");
      expect(result.error).toContain('nothing was written');
    }
    // The ONLY write to the file is the drift itself — the op never spliced
    // its (now stale) plan over the drifted bytes.
    expect(Buffer.from(store.written.get('src/a.ts') as Uint8Array).toString('utf8')).toBe(
      'mutated mid-flight;\n',
    );
  });

  test('an exit-1 empty-result scan fails the APPLY as non-passing evidence — nothing written (P1)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const failedEmptyRun = fakeRunner({ stdout: '[]', stderr: '', exitCode: 1 });
    const result = await makeOp(
      store,
      failedEmptyRun,
    )({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts'],
      dryRun: false,
      approved: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('NO matches behind exit code 1');
      expect(result.error).toContain('non-passing evidence');
    }
    expect(store.written.size).toBe(0);
  });

  test('files: [] at the LIBRARY level is a refused unscoped scan (L2)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const result = await makeOp(store)({
      dir: '/ws',
      rule: 'r',
      files: [],
      dryRun: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('an unscoped scan is refused');
      expect(result.error).toContain('at least one file');
    }
    expect(store.written.size).toBe(0);
  });

  test('a scan reporting DECORATED paths (./src/a.ts) still matches the requested targets and applies (L2)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const decoratedRunner = fakeRunner({
      stdout: JSON.stringify([
        matchOf('./src/a.ts', 6, 13, 'fooBar'),
        matchOf('./src/b.ts', 13, 20, 'bazQux'),
      ]),
      stderr: '',
      exitCode: 0,
    });
    const op = makeOp(store, decoratedRunner);
    const result = await op({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts', 'src/b.ts'],
      dryRun: false,
      approved: true,
    });
    // Pre-L2 the decorated spellings dropped every edit in the per-file
    // filters while plannedEdits still counted them.
    expect(result.status).toBe('ok');
    if (result.status !== 'ok' || result.value.mode !== 'applied') return;
    expect(result.value.plannedEdits).toBe(2);
    expect(result.value.files.map((file) => file.edits)).toEqual([1, 1]);
    expect(Buffer.from(store.written.get('src/a.ts') as Uint8Array).toString('utf8')).toBe(
      'const fooBar = 1;\nconst other = foo_bar;\n',
    );
  });

  test('a scan reporting a file OUTSIDE the requested set is a fault, never an edit (L2)', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const outsideRunner = fakeRunner({
      stdout: JSON.stringify([matchOf('src/elsewhere.ts', 0, 5, 'x')]),
      stderr: '',
      exitCode: 0,
    });
    const result = await makeOp(
      store,
      outsideRunner,
    )({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts'],
      dryRun: true,
    });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('outside the requested file set');
    }
    expect(store.written.size).toBe(0);
  });

  test('a scan fault and an unreadable target are honest failures', async () => {
    const store = memoryStore(FIXTURE_FILES);
    const deadRun = fakeRunner({ stdout: '', stderr: '', exitCode: null });
    const deadResult = await makeOp(
      store,
      deadRun,
    )({
      dir: '/ws',
      rule: 'r',
      files: ['src/a.ts'],
      dryRun: false,
      approved: true,
    });
    expect(deadResult.status).toBe('failed');
    if (deadResult.status === 'failed') {
      expect(deadResult.error).toContain('unobservable');
    }
    const missingResult = await makeOp(memoryStore({}))({
      dir: '/ws',
      rule: 'r',
      files: ['src/missing.ts'],
      dryRun: true,
    });
    expect(missingResult.status).toBe('failed');
    if (missingResult.status === 'failed') {
      expect(missingResult.error).toContain('src/missing.ts');
    }
  });
});
