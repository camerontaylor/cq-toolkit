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
import { contentDigest } from '../../../../src/ops/analyze/renderAnalysisReport.js';
import {
  FIXTURE_FILES,
  fakeRunner,
  makeOp,
  matchOf,
  memoryStore,
  scanRunner,
} from './astGrep.helpers.js';

describe('makeAstGrepCodemod (the op: approval gate first, then scan → collision → write)', () => {
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
});
