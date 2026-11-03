// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the tsc-lines adapter cases over the real
// captured fixture.
import { describe, expect, test } from 'vitest';
import type { FailureSet } from '../../../src/ops/gates/index.js';
import { fixture, parseWith } from './adapters.helpers.js';

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
