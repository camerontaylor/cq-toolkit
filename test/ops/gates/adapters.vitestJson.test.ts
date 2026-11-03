// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the vitest-json adapter cases (real captured
// fixture, unnamed assertions, fallback assertion identities).
import { describe, expect, test } from 'vitest';
import type { FailureSet } from '../../../src/ops/gates/index.js';
import { fixture, parseWith } from './adapters.helpers.js';

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
