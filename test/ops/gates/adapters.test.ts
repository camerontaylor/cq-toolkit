// Gates lane C1 — test evidence: every committed fixture (REAL captured
// tool output, see test/fixtures/check-outputs) round-trips through its
// adapter to an exact FailureSet; every malformed fixture is indeterminate
// and never clean (I5); and the `gates.checkRunner` op is proven over a FAKE
// injected runner — ok, indeterminate, and runner-throws paths, with zero
// subprocesses spawned.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  adapterByName,
  makeCheckRunner,
  parseCheckOutput,
  subprocessRunCheck,
  type CheckParseResult,
  type FailureSet,
  type RawCheckOutput,
  type RunCheck,
} from '../../../src/ops/gates/index.js';
import { CheckRunnerInputSchema, registry } from '../../../src/ops/gates/registry.js';

/** Raw captured bytes of one committed fixture. */
function fixture(name: string): string {
  return readFileSync(new URL(`../../fixtures/check-outputs/${name}`, import.meta.url), 'utf8');
}

/** Parse through the real guarded entry point (parseCheckOutput, not the raw adapter). */
function parseWith(
  adapter: 'vitest-json' | 'eslint-json' | 'tsc-lines',
  raw: RawCheckOutput,
): CheckParseResult {
  return parseCheckOutput(adapterByName(adapter), raw);
}

describe('vitest-json adapter (real captured fixture)', () => {
  const VITEST_SUITE_FILE = '/private/tmp/cq-gates-fixtures.TA8IFi/sample.test.ts';

  test('parses to the exact captured failure set', () => {
    const result = parseWith('vitest-json', {
      stdout: fixture('vitest.json'),
      stderr: '',
      exitCode: 1,
    });
    const expected: FailureSet = {
      tool: 'vitest',
      failures: [
        {
          file: VITEST_SUITE_FILE,
          line: null,
          column: null,
          ruleId: null,
          message: 'fails on purpose',
          severity: 'error',
        },
      ],
      exitCode: 1,
      numTotalTests: 2,
      numPassedTests: 1,
      numPassed: 1,
      numSkippedTests: 0,
      numPendingTests: 0,
      numTodoTests: 0,
    };
    expect(result).toEqual({ verdict: 'parsed', set: expected });
  });

  test('truncated JSON mid-structure is indeterminate, never clean', () => {
    const result = parseWith('vitest-json', {
      stdout: fixture('vitest-truncated.json'),
      stderr: '',
      exitCode: 1,
    });
    expect(result.verdict).toBe('indeterminate');
  });

  test('empty output is indeterminate even behind exit 0 (summary-bearing tool, I5)', () => {
    const result = parseWith('vitest-json', { stdout: '', stderr: '', exitCode: 0 });
    expect(result).toMatchObject({ verdict: 'indeterminate' });
  });

  test('a parsed empty failure set behind a non-zero exit is indeterminate (central I5 guard)', () => {
    const stdout = JSON.stringify({ success: true, numTotalTests: 0, testResults: [] });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 1 });
    expect(result.verdict).toBe('indeterminate');
  });

  test('a parsed empty failure set with success:false is indeterminate even behind exit 0 (adapter-domain I5)', () => {
    const stdout = JSON.stringify({ success: false, numTotalTests: 0, testResults: [] });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 0 });
    expect(result).toEqual({
      verdict: 'indeterminate',
      reason: 'summary reports a failing run but no failure details were extracted',
    });
  });

  test('a summary counting tests over an empty testResults body is indeterminate (numTotalTests flavor)', () => {
    const stdout = JSON.stringify({
      success: true,
      numTotalTests: 2,
      numFailedTests: 0,
      testResults: [],
    });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 0 });
    expect(result).toEqual({
      verdict: 'indeterminate',
      reason: 'summary counts tests but testResults carries no suite entries',
    });
  });

  test('a summary counting failed tests over an empty testResults body is indeterminate (numFailedTests flavor)', () => {
    const stdout = JSON.stringify({
      success: true,
      numTotalTests: 0,
      numFailedTests: 1,
      testResults: [],
    });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 0 });
    expect(result).toEqual({
      verdict: 'indeterminate',
      reason: 'summary counts tests but testResults carries no suite entries',
    });
  });

  test('suites present but every one assertionless is indeterminate when the summary counts tests', () => {
    const stdout = JSON.stringify({
      success: true,
      numTotalTests: 1,
      numFailedTests: 0,
      testResults: [
        { name: '/tmp/a.test.ts', status: 'passed', assertionResults: [] },
        { name: '/tmp/b.test.ts', status: 'passed', assertionResults: [] },
      ],
    });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 0 });
    expect(result).toEqual({
      verdict: 'indeterminate',
      reason: 'summary counts tests but testResults carries no suite entries',
    });
  });

  test('success:true alongside a numFailedTests count is indeterminate (self-contradiction)', () => {
    const stdout = JSON.stringify({
      success: true,
      numTotalTests: 1,
      numFailedTests: 1,
      testResults: [
        {
          name: '/tmp/a.test.ts',
          status: 'passed',
          assertionResults: [
            { title: 'passes', fullName: 'passes', status: 'passed', failureMessages: [] },
          ],
        },
      ],
    });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 0 });
    expect(result).toEqual({
      verdict: 'indeterminate',
      reason: 'summary claims success but also counts failed tests',
    });
  });

  test('a testResult without an assertionResults array is indeterminate, not coerced empty', () => {
    const stdout = JSON.stringify({
      success: true,
      numTotalTests: 1,
      testResults: [{ name: '/tmp/a.test.ts', status: 'passed' }],
    });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 0 });
    expect(result.verdict).toBe('indeterminate');
  });

  test('a failed suite without failing assertions surfaces one suite-level failure', () => {
    const stdout = JSON.stringify({
      success: false,
      numTotalTests: 0,
      testResults: [
        {
          name: '/tmp/suite.test.ts',
          status: 'failed',
          message: 'RuntimeError: cannot load module',
          assertionResults: [],
        },
      ],
    });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 1 });
    expect(result).toEqual({
      verdict: 'parsed',
      set: {
        tool: 'vitest',
        failures: [
          {
            file: '/tmp/suite.test.ts',
            line: null,
            column: null,
            ruleId: null,
            message: 'RuntimeError: cannot load module',
            severity: 'error',
          },
        ],
        exitCode: 1,
        numTotalTests: 0,
      },
    });
  });
});

describe('eslint-json adapter (real captured fixture)', () => {
  const ESLINT_FILE = '/private/tmp/cq-gates-fixtures.TA8IFi/bad.ts';

  test('parses to the exact captured failure set (severity 2 → error, both rules)', () => {
    const result = parseWith('eslint-json', {
      stdout: fixture('eslint.json'),
      stderr: '',
      exitCode: 1,
    });
    const expected: FailureSet = {
      tool: 'eslint',
      failures: [
        {
          file: ESLINT_FILE,
          line: 1,
          column: 7,
          ruleId: '@typescript-eslint/no-unused-vars',
          message: "'unused' is assigned a value but never used.",
          severity: 'error',
        },
        {
          file: ESLINT_FILE,
          line: 4,
          column: 7,
          ruleId: 'prefer-const',
          message: "'greeting' is never reassigned. Use 'const' instead.",
          severity: 'error',
        },
      ],
      exitCode: 1,
    };
    expect(result).toEqual({ verdict: 'parsed', set: expected });
  });

  test('the diagnostics[] trap shape is indeterminate, never clean', () => {
    const result = parseWith('eslint-json', {
      stdout: fixture('eslint-wrong-shape.json'),
      stderr: '',
      exitCode: 0,
    });
    expect(result.verdict).toBe('indeterminate');
  });

  test('empty stdout is indeterminate (the clean shape is a parsed empty array)', () => {
    const result = parseWith('eslint-json', { stdout: '', stderr: '', exitCode: 0 });
    expect(result.verdict).toBe('indeterminate');
  });

  test('a valid empty array behind exit 0 parses clean', () => {
    const result = parseWith('eslint-json', { stdout: '[]\n', stderr: '', exitCode: 0 });
    expect(result).toEqual({
      verdict: 'parsed',
      set: { tool: 'eslint', failures: [], exitCode: 0 },
    });
  });

  test('the confirmed trap: an empty array behind exit 2 (unmatched glob) is indeterminate', () => {
    const result = parseWith('eslint-json', { stdout: '[]\n', stderr: '', exitCode: 2 });
    expect(result.verdict).toBe('indeterminate');
  });
});

describe('tsc-lines adapter (real captured fixture)', () => {
  test('parses to the exact captured failure set', () => {
    const result = parseWith('tsc-lines', {
      stdout: fixture('tsc.txt'),
      stderr: '',
      exitCode: 2,
    });
    const expected: FailureSet = {
      tool: 'tsc',
      failures: [
        {
          file: 'broken.ts',
          line: 1,
          column: 7,
          ruleId: 'TS2322',
          message: "Type 'string' is not assignable to type 'number'.",
          severity: 'error',
        },
      ],
      exitCode: 2,
    };
    expect(result).toEqual({ verdict: 'parsed', set: expected });
  });

  test('config-level crash output (non-empty, zero parsable lines) is indeterminate', () => {
    const result = parseWith('tsc-lines', {
      stdout: fixture('tsc-garbage.txt'),
      stderr: '',
      exitCode: 1,
    });
    expect(result.verdict).toBe('indeterminate');
  });

  test('empty stdout behind exit 0 is the clean shape; behind a non-zero exit it is not', () => {
    expect(parseWith('tsc-lines', { stdout: '', stderr: '', exitCode: 0 })).toEqual({
      verdict: 'parsed',
      set: { tool: 'tsc', failures: [], exitCode: 0 },
    });
    expect(parseWith('tsc-lines', { stdout: '', stderr: 'crash', exitCode: 1 }).verdict).toBe(
      'indeterminate',
    );
  });

  test('warning-severity lines map to warnings; related-info lines are skipped', () => {
    const stdout = [
      'a.ts(3,1): warning TS6133: declared but its value is never read.',
      'a.ts(3,1): this is the related info line without a TS code',
      '',
    ].join('\n');
    const result = parseWith('tsc-lines', { stdout, stderr: '', exitCode: 0 });
    expect(result).toEqual({
      verdict: 'parsed',
      set: {
        tool: 'tsc',
        failures: [
          {
            file: 'a.ts',
            line: 3,
            column: 1,
            ruleId: 'TS6133',
            message: 'declared but its value is never read.',
            severity: 'warning',
          },
        ],
        exitCode: 0,
      },
    });
  });
});

describe('makeCheckRunner over a fake injected runner (no subprocesses)', () => {
  const command = { command: 'eslint', args: ['--format', 'json', 'bad.ts'] };

  function runnerOf(stdout: string, exitCode: number | null): RunCheck {
    return async () => ({ stdout, stderr: '', exitCode });
  }

  test('parsed verdict → ok with the exact FailureSet', async () => {
    const run = makeCheckRunner(runnerOf(fixture('eslint.json'), 1));
    await expect(run({ adapter: 'eslint-json', command })).resolves.toEqual({
      status: 'ok',
      value: {
        tool: 'eslint',
        failures: [
          {
            file: '/private/tmp/cq-gates-fixtures.TA8IFi/bad.ts',
            line: 1,
            column: 7,
            ruleId: '@typescript-eslint/no-unused-vars',
            message: "'unused' is assigned a value but never used.",
            severity: 'error',
          },
          {
            file: '/private/tmp/cq-gates-fixtures.TA8IFi/bad.ts',
            line: 4,
            column: 7,
            ruleId: 'prefer-const',
            message: "'greeting' is never reassigned. Use 'const' instead.",
            severity: 'error',
          },
        ],
        exitCode: 1,
      },
    });
  });

  test('indeterminate verdict → indeterminate with the reason as detail', async () => {
    const run = makeCheckRunner(runnerOf(fixture('vitest-truncated.json'), 1));
    const result = await run({ adapter: 'vitest-json', command });
    expect(result.status).toBe('indeterminate');
    expect(result).toMatchObject({ detail: expect.any(String) });
  });

  test('a thrown runner → failed, never a crash or a fake verdict', async () => {
    const run = makeCheckRunner(async () => {
      throw new Error('spawn ENOENT');
    });
    await expect(run({ adapter: 'eslint-json', command })).resolves.toEqual({
      status: 'failed',
      error: 'spawn ENOENT',
    });
  });

  test('a rejected non-Error throw still yields failed evidence', async () => {
    const run = makeCheckRunner(async () => {
      throw 'boom';
    });
    await expect(run({ adapter: 'eslint-json', command })).resolves.toEqual({
      status: 'failed',
      error: 'boom',
    });
  });

  test('the same empty capture is clean for tsc-lines but indeterminate for vitest-json', async () => {
    const run = makeCheckRunner(async () => ({ stdout: '', stderr: '', exitCode: 0 }));
    await expect(run({ adapter: 'tsc-lines', command })).resolves.toEqual({
      status: 'ok',
      value: { tool: 'tsc', failures: [], exitCode: 0 },
    });
    const vitestResult = await run({ adapter: 'vitest-json', command });
    expect(vitestResult.status).toBe('indeterminate');
  });
});

describe('subprocessRunCheck (real runner over process.execPath, no external binaries)', () => {
  test('captures stdout and a zero exit', async () => {
    await expect(
      subprocessRunCheck({ command: process.execPath, args: ['-e', "console.log('hello')"] }),
    ).resolves.toEqual({ stdout: 'hello\n', stderr: '', exitCode: 0 });
  });

  test('maps a real exit code through', async () => {
    await expect(
      subprocessRunCheck({ command: process.execPath, args: ['-e', 'process.exit(3)'] }),
    ).resolves.toEqual({ stdout: '', stderr: '', exitCode: 3 });
  });

  test('a check past timeoutMs resolves quickly with exitCode null (SIGKILL, never clean)', async () => {
    const result = await subprocessRunCheck({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 10_000)'],
      timeoutMs: 300,
    });
    expect(result.exitCode).toBeNull();
  });

  test('a spawn failure yields exitCode null, not a rejection', async () => {
    await expect(
      subprocessRunCheck({ command: 'definitely-not-a-real-check-binary', args: [] }),
    ).resolves.toMatchObject({ exitCode: null });
  });
});

describe('gates registry entry', () => {
  test('registry entries in order (C3 appends the hack detector + commit gate); the checkRunner schema validates the full input and only it', () => {
    expect(registry.map((entry) => entry.name)).toEqual([
      'gates.checkRunner',
      'gates.baselineProbe',
      'gates.regressionGate',
      'gates.hackDetector',
      'gates.commitGate',
      'gates.policyDiff',
    ]);
    const valid = { adapter: 'tsc-lines', command: { command: 'tsc', args: ['--noEmit'] } };
    expect(CheckRunnerInputSchema.parse(valid)).toEqual({
      adapter: 'tsc-lines',
      command: { command: 'tsc', args: ['--noEmit'], timeoutMs: 600_000 },
    });
    expect(
      CheckRunnerInputSchema.safeParse({ adapter: 'grep-json', command: valid.command }).success,
    ).toBe(false);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: 'tsc-lines',
        command: { command: 'tsc', args: [7] },
      }).success,
    ).toBe(false);
    expect(
      CheckRunnerInputSchema.safeParse({ adapter: 'tsc-lines', command: { command: 9 } }).success,
    ).toBe(false);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: 'tsc-lines',
        command: { command: 'tsc', args: ['--noEmit'], timeoutMs: 30_000 },
      }).success,
    ).toBe(true);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: 'tsc-lines',
        command: { command: 'tsc', args: ['--noEmit'], timeoutMs: 0 },
      }).success,
    ).toBe(false);
  });

  test('an input without timeoutMs parses to the 600_000ms op-boundary floor', () => {
    const parsed = CheckRunnerInputSchema.parse({
      adapter: 'eslint-json',
      command: { command: 'eslint', args: ['--format', 'json', '.'] },
    });
    expect(parsed.command.timeoutMs).toBe(600_000);
  });

  test('the importer resolves to the subprocess-bound op', async () => {
    const entry = registry[0];
    if (entry === undefined) throw new Error('registry must contain the adapter op');
    expect(typeof entry.inputSchema).toBe('object');
    const op = await entry.importer();
    expect(typeof op).toBe('function');
  });
});
