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
import { makeAstGrepScan } from '../../../../src/ops/analyze/codemod/astGrep.js';
import { fakeRunner, matchOf } from './astGrep.helpers.js';

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
