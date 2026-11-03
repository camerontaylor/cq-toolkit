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
import { FIXTURE_FILES, fakeRunner, makeOp, matchOf, memoryStore } from './astGrep.helpers.js';

describe('makeAstGrepCodemod (the op: approval gate first, then scan → collision → write)', () => {
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
