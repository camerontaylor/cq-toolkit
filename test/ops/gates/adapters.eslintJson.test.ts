// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the eslint-json adapter cases over the real
// captured fixture.
import { describe, expect, test } from 'vitest';
import type { FailureSet } from '../../../src/ops/gates/index.js';
import { fixture, parseWith } from './adapters.helpers.js';

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
