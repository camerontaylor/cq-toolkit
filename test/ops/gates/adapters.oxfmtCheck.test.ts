// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the oxfmt-check adapter cases over captured
// oxfmt 0.x `--check` output.
import { describe, expect, test } from 'vitest';
import {
  adapterByName,
  parseCheckOutput,
  type CheckParseResult,
} from '../../../src/ops/gates/index.js';
import { CheckRunnerInputSchema } from '../../../src/ops/gates/registry.js';

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
