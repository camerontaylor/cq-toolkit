// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the test-narrow gate cases, including the
// bounded-wrapper evidence that must never be guessed from incomplete output.
import { describe, expect, test } from 'vitest';
import { adapterByName, parseCheckOutput } from '../../../src/ops/gates/index.js';
import { FailureSetSchema } from '../../../src/ops/gates/registry.js';

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
