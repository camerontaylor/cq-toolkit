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
import type { RawCheckOutput, RunCheck } from '../../../../src/ops/gates/checkRunner.js';
import type { AnalyzeFileStore } from '../../../../src/ops/analyze/analysisStore.js';
import { AnalysisStoreError } from '../../../../src/ops/analyze/analysisStore.js';
import { FIXTURE_FILES, fakeRunner, makeOp, matchOf, memoryStore } from './astGrep.helpers.js';

describe('makeAstGrepCodemod (the op: approval gate first, then scan → collision → write)', () => {
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
});
