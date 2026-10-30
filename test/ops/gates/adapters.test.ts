// Gates lane C1 — test evidence: every committed fixture (REAL captured
// tool output, see test/fixtures/check-outputs) round-trips through its
// adapter to an exact FailureSet; every malformed fixture is indeterminate
// and never clean (I5); and the `gates.checkRunner` op is proven over a FAKE
// injected runner — ok, indeterminate, and runner-throws paths, with zero
// subprocesses spawned.
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, test, vi } from 'vitest';
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
import {
  FailureSetSchema,
  CheckRunnerInputSchema,
  registry,
} from '../../../src/ops/gates/registry.js';

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
            ruleId: 'vitest-suite',
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

describe('vitest-json adapter unnamed assertions', () => {
  test('a failing assertion with no name fields is marked vitest-unnamed and keeps its location', () => {
    const stdout = JSON.stringify({
      success: false,
      numTotalTests: 1,
      testResults: [
        {
          name: '/tmp/a.test.ts',
          status: 'failed',
          assertionResults: [
            {
              status: 'failed',
              location: { line: 10, column: 3 },
              failureMessages: ['AssertionError: expected 1 to be 2\n  at x'],
            },
          ],
        },
      ],
    });
    const result = parseWith('vitest-json', { stdout, stderr: '', exitCode: 1 });
    expect(result).toMatchObject({
      verdict: 'parsed',
      set: {
        failures: [
          {
            line: 10,
            column: 3,
            ruleId: 'vitest-unnamed',
            message: 'AssertionError: expected 1 to be 2',
          },
        ],
      },
    });
  });
});

describe('vitest fallback assertion identities', () => {
  test.each([undefined, '', '   '])(
    'ancestor titles without an assertion title (%s) remain unnamed',
    (title) => {
      const result = parseWith('vitest-json', {
        stdout: JSON.stringify({
          success: false,
          numTotalTests: 2,
          testResults: [
            {
              name: '/tmp/a.test.ts',
              status: 'failed',
              assertionResults: [10, 40].map((line) => ({
                status: 'failed',
                ancestorTitles: ['outer', 'inner'],
                title,
                location: { line, column: 3 },
                failureMessages: ['AssertionError: expected equality'],
              })),
            },
          ],
        }),
        stderr: '',
        exitCode: 1,
      });
      expect(result).toMatchObject({
        verdict: 'parsed',
        set: {
          failures: [
            { ruleId: 'vitest-unnamed', line: 10, message: 'AssertionError: expected equality' },
            { ruleId: 'vitest-unnamed', line: 40, message: 'AssertionError: expected equality' },
          ],
        },
      });
    },
  );

  test('distinct fallback chains containing the display separator retain distinct identities', () => {
    const result = parseWith('vitest-json', {
      stdout: JSON.stringify({
        success: false,
        numTotalTests: 2,
        testResults: [
          {
            name: '/tmp/a.test.ts',
            status: 'failed',
            assertionResults: [
              { ancestorTitles: ['a > b'], title: 'c' },
              { ancestorTitles: ['a'], title: 'b > c' },
            ].map((name) => ({ ...name, status: 'failed' })),
          },
        ],
      }),
      stderr: '',
      exitCode: 1,
    });
    expect(result.verdict).toBe('parsed');
    if (result.verdict !== 'parsed') return;
    const messages = result.set.failures.map((failure) => failure.message);
    expect(messages[0]).not.toBe(messages[1]);
    expect(messages.map((message) => JSON.parse(message) as string[])).toEqual([
      ['a > b', 'c'],
      ['a', 'b > c'],
    ]);
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

test('an already-aborted check never dispatches a child', async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await subprocessRunCheck(
    { command: process.execPath, args: ['-e', 'console.log("must not run")'] },
    { signal: controller.signal },
  );
  expect(result).toEqual({ stdout: '', stderr: 'check cancelled before dispatch', exitCode: null });
});
test('running check cancellation settles only after child exit', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cq-check-cancel-'));
  const marker = join(dir, 'ready');
  const controller = new AbortController();
  const running = subprocessRunCheck(
    {
      command: process.execPath,
      args: [
        '-e',
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid)); setInterval(() => {}, 1000)`,
      ],
      timeoutMs: 5000,
    },
    { signal: controller.signal },
  );
  let pid: number | undefined;
  try {
    await vi.waitFor(async () => {
      pid = Number(await readFile(marker, 'utf8'));
      expect(pid).toBeGreaterThan(0);
    });
    let settled = false;
    void running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    controller.abort();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 });
    expect((await running).exitCode).toBeNull();
    expect(() => process.kill(pid!, 0)).toThrow();
  } finally {
    controller.abort();
    await running;
    await rm(dir, { recursive: true, force: true });
  }
});

describe('oxfmt-check adapter (captured oxfmt 0.x `--check` output)', () => {
  const clean =
    'Checking formatting...\n\nAll matched files use the correct format.\nFinished in 1ms on 1 files using 6 threads.\n';
  const issues =
    'Checking formatting...\n\nsrc/a.ts (0ms)\nsrc/dir with space/b.ts (12ms)\n\nFormat issues found in above 2 files. Run without `--check` to fix.\nFinished in 2ms on 3 files using 6 threads.\n';
  const parse = (stdout: string, exitCode: number | null): CheckParseResult =>
    parseCheckOutput(adapterByName('oxfmt-check'), { stdout, stderr: '', exitCode });

  test('exit 0 with the all-formatted summary is clean', () => {
    expect(parse(clean, 0)).toEqual({
      verdict: 'parsed',
      set: { tool: 'oxfmt', failures: [], exitCode: 0 },
    });
  });

  test('exit 1 lists one failure per unformatted file', () => {
    const result = parse(issues, 1);
    expect(result.verdict).toBe('parsed');
    if (result.verdict !== 'parsed') return;
    expect(result.set.failures).toEqual([
      {
        file: 'src/a.ts',
        line: null,
        column: null,
        ruleId: 'oxfmt',
        message: 'not formatted',
        severity: 'error',
      },
      {
        file: 'src/dir with space/b.ts',
        line: null,
        column: null,
        ruleId: 'oxfmt',
        message: 'not formatted',
        severity: 'error',
      },
    ]);
  });

  test.each([
    ['a non-zero exit naming no file', 'Error: unknown flag --chek\n', 1],
    ['an unexpected exit code', issues, 2],
    ['an unobservable exit', clean, null],
    ['exit 0 that still names a file', issues, 0],
  ] as const)('%s is indeterminate, never clean', (_label, stdout, exitCode) => {
    expect(parse(stdout, exitCode).verdict).toBe('indeterminate');
  });

  const ansi = (text: string) => `\u001b[1m\u001b[31m${text}\u001b[0m`;

  test.each([
    ['empty output on exit 0', '', 0],
    ['help text on exit 0', 'Usage: oxfmt [OPTIONS] [PATH]...\n', 0],
    ['an unrecognized report on exit 0', 'some unrecognized report\n', 0],
    [
      'a summary count that disagrees with the listed files',
      'Checking formatting...\n\nsrc/a.ts (0ms)\n\nFormat issues found in above 2 files. Run without `--check` to fix.\n',
      1,
    ],
    [
      'a listed failure report without its summary',
      'Checking formatting...\n\nsrc/a.ts (0ms)\n',
      1,
    ],
  ] as const)('%s is indeterminate, never clean', (_label, stdout, exitCode) => {
    expect(parse(stdout, exitCode).verdict).toBe('indeterminate');
  });

  test('ANSI decoration is stripped before parsing, so no record is lost', () => {
    const coloured = issues
      .split('\n')
      .map((line) => (line.endsWith('ms)') ? ansi(line) : line))
      .join('\n');
    const result = parse(coloured, 1);
    expect(result.verdict).toBe('parsed');
    if (result.verdict === 'parsed')
      expect(result.set.failures.map((failure) => failure.file)).toEqual([
        'src/a.ts',
        'src/dir with space/b.ts',
      ]);
    expect(parse(ansi(clean), 0).verdict).toBe('parsed');
  });

  test('the registry schema accepts the adapter name', () => {
    expect(
      CheckRunnerInputSchema.parse({
        adapter: 'oxfmt-check',
        command: { command: 'oxfmt', args: ['--check', '.'] },
      }).adapter,
    ).toBe('oxfmt-check');
  });
});

describe('oxlint-json gate', () => {
  const parse = (stdout: string, exitCode: number | null = 0) =>
    parseCheckOutput(adapterByName('oxlint-json'), { stdout, stderr: '', exitCode });
  const diagnostic = {
    message: 'Unexpected await of a non-Promise',
    code: 'typescript(await-thenable)',
    severity: 'error',
    filename: 'test/a.test.ts',
    labels: [{ span: { line: 12, column: 3 } }],
  };
  test('clean and attributed typed lint failure', () => {
    expect(parse(JSON.stringify({ diagnostics: [], number_of_files: 1 }))).toMatchObject({
      verdict: 'parsed',
      set: { failures: [] },
    });
    expect(
      parse(JSON.stringify({ diagnostics: [diagnostic], number_of_files: 1 }), 1),
    ).toMatchObject({
      verdict: 'parsed',
      set: {
        failures: [{ file: 'test/a.test.ts', line: 12, ruleId: 'typescript(await-thenable)' }],
      },
    });
  });
  test.each(['', '{}', '{"diagnostics":[]}', '{"diagnostics":[{}],"number_of_files":1}'])(
    'ambiguous %s',
    (output) => expect(parse(output).verdict).toBe('indeterminate'),
  );
  test.each([1, 2, null])('unexpected exit %s never certifies clean', (exit) => {
    expect(parse('{"diagnostics":[],"number_of_files":1}', exit).verdict).toBe('indeterminate');
    if (exit !== 1)
      expect(
        parse(JSON.stringify({ diagnostics: [diagnostic], number_of_files: 1 }), exit).verdict,
      ).toBe('indeterminate');
  });
});

describe('test-narrow gate', () => {
  const report = {
    success: false,
    numTotalTests: 2,
    numPassedTests: 1,
    numFailedTests: 1,
    testResults: [
      {
        name: 'test/a.test.ts',
        status: 'failed',
        assertionResults: [
          { status: 'failed', fullName: 'stable test identity' },
          { status: 'passed', fullName: 'existing pass' },
        ],
      },
    ],
  };
  const parse = (stdout: string, exitCode = 1) =>
    parseCheckOutput(adapterByName('test-narrow'), { stdout, stderr: '', exitCode });
  test('retains failure identity for baseline comparison', () => {
    expect(
      parse(
        `test:narrow report=${JSON.stringify(report)}\ntest:narrow result="fail" exit=1 files=1 tests="1/2" failed=1`,
      ),
    ).toMatchObject({
      verdict: 'parsed',
      set: { tool: 'vitest', failures: [{ message: 'stable test identity' }] },
    });
  });
  test('clean requires completed report and matching summary', () => {
    const clean = {
      success: true,
      numTotalTests: 1,
      numPassedTests: 1,
      numFailedTests: 0,
      testResults: [
        {
          name: 'test/a.test.ts',
          status: 'passed',
          assertionResults: [{ status: 'passed', fullName: 'ok' }],
        },
      ],
    };
    expect(
      parse(
        `test:narrow report=${JSON.stringify(clean)}\ntest:narrow result="pass" exit=0 files=1 tests="1/1" failed=0`,
        0,
      ).verdict,
    ).toBe('parsed');
    expect(parse('test:narrow result="pass" exit=0 files=1 tests="1/1" failed=0', 0).verdict).toBe(
      'indeterminate',
    );
  });
  test.each(['refused', 'error', 'interrupted', 'timeout'])(
    '%s is indeterminate even with a report',
    (result) => {
      expect(
        parse(`test:narrow report=${JSON.stringify(report)}\ntest:narrow result="${result}" exit=1`)
          .verdict,
      ).toBe('indeterminate');
    },
  );
  test('none-map is an explicit advisory pass', () => {
    expect(
      parse(
        'test:narrow advisory="no related tests mapped"\ntest:narrow result="pass" exit=0 files=0 tests=- failed=-',
        0,
      ),
    ).toMatchObject({
      verdict: 'parsed',
      set: { failures: [], advisories: ['no related tests mapped'] },
    });
    expect(
      FailureSetSchema.safeParse({
        tool: 'vitest',
        failures: [],
        exitCode: 0,
        advisories: ['no related tests mapped'],
      }).success,
    ).toBe(true);
  });
});

test.each([
  '',
  '{}',
  'test:narrow result="pass" exit=0 files=0 tests=- failed=-',
  'test:narrow report={}\ntest:narrow result="fail" exit=1 files=1 tests="0/1" failed=1',
])('bounded test gate never guesses from incomplete output: %s', (stdout) => {
  expect(
    parseCheckOutput(adapterByName('test-narrow'), { stdout, stderr: '', exitCode: 0 }).verdict,
  ).toBe('indeterminate');
});

test.each([
  'test:narrow advisory="no related tests mapped"\ntest:narrow result="pass" exit=0 files=0 tests=- failed=9',
  'test:narrow result="refused" exit=2\ntest:narrow advisory="no related tests mapped"\ntest:narrow result="pass" exit=0 files=0 tests=- failed=-',
  ...[
    { total: 1, passed: 2, status: 'passed' },
    { total: 1, passed: 1, status: 'mystery' },
    { total: 2, passed: 2, status: 'passed' },
  ].map(
    ({ total, passed, status }) =>
      'test:narrow report=' +
      JSON.stringify({
        success: true,
        numTotalTests: total,
        numPassedTests: passed,
        numFailedTests: 0,
        testResults: [
          {
            name: 'test/a.test.ts',
            status: 'passed',
            assertionResults: [{ status, fullName: 'ok' }],
          },
        ],
      }) +
      '\ntest:narrow result="pass" exit=0 files=1 tests="' +
      passed +
      '/' +
      total +
      '" failed=0',
  ),
])('contradictory bounded wrapper evidence is indeterminate: %s', (stdout) => {
  expect(
    parseCheckOutput(adapterByName('test-narrow'), { stdout, stderr: '', exitCode: 0 }).verdict,
  ).toBe('indeterminate');
});

test('bounded reports preserve consistent skipped and todo totals', () => {
  const report = {
    success: true,
    numTotalTests: 3,
    numPassedTests: 1,
    numFailedTests: 0,
    numPendingTests: 1,
    numTodoTests: 1,
    testResults: [
      {
        name: 'test/a.test.ts',
        status: 'passed',
        assertionResults: [
          { status: 'passed', fullName: 'ok' },
          { status: 'pending', fullName: 'skip' },
          { status: 'todo', fullName: 'later' },
        ],
      },
    ],
  };
  const output =
    'test:narrow report=' +
    JSON.stringify(report) +
    '\ntest:narrow result="pass" exit=0 files=1 tests="1/3" failed=0 skipped=';
  expect(
    parseCheckOutput(adapterByName('test-narrow'), {
      stdout: output + '2',
      stderr: '',
      exitCode: 0,
    }).verdict,
  ).toBe('parsed');
  expect(
    parseCheckOutput(adapterByName('test-narrow'), {
      stdout: output + '9',
      stderr: '',
      exitCode: 0,
    }).verdict,
  ).toBe('indeterminate');
});
