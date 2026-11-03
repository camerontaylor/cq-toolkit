// Split provenance: test/ops/gates/adapters.test.ts was split by subject into
// sibling files; this file carries the ruff-json and knip-json adapter cases
// over their real captured fixtures.
import { describe, expect, test } from 'vitest';
import { adapterByName, parseCheckOutput } from '../../../src/ops/gates/index.js';
import { CheckRunnerInputSchema } from '../../../src/ops/gates/registry.js';
import { fixture } from './adapters.helpers.js';

describe('Ruff and Knip JSON adapters', () => {
  test.each([
    ['ruff-json', 'ruff-0.14.3-fail.json', 'ruff', 1],
    ['knip-json', 'knip-6.35.1-fail.json', 'knip', 5],
  ] as const)('%s parses its versioned fixture', (name, filename, tool, count) => {
    const parsed = parseCheckOutput(adapterByName(name), {
      stdout: fixture(filename),
      stderr: '',
      exitCode: 1,
    });
    expect(parsed.verdict).toBe('parsed');
    if (parsed.verdict !== 'parsed') return;
    expect(parsed.set.tool).toBe(tool);
    expect(parsed.set.failures).toHaveLength(count);
    if (tool === 'knip') {
      expect(parsed.set.failures).toContainEqual({
        file: 'src/unused.ts',
        ruleId: 'enumMembers',
        message: 'enumMembers: Status.Unused',
        severity: 'error',
        line: 10,
        column: 3,
      });
      expect(parsed.set.failures.some((failure) => failure.message === 'exports: unused')).toBe(
        true,
      );
    }
    expect(parsed.set.failures[0]?.file).toBe(
      tool === 'ruff' ? '/project/input.py' : 'src/unused.ts',
    );
    expect(parsed.set.failures.every((failure) => failure.severity === 'error')).toBe(true);
    expect(
      CheckRunnerInputSchema.safeParse({
        adapter: name,
        command: { command: tool, args: [] },
      }).success,
    ).toBe(true);
  });

  test.each(['ruff-json', 'knip-json'] as const)(
    '%s refuses malformed output and non-check exits',
    (name) => {
      for (const stdout of ['', 'not JSON', '{}', '{"issues":[{"file":"x","unknown":[]}]}']) {
        expect(
          parseCheckOutput(adapterByName(name), { stdout, stderr: '', exitCode: 0 }).verdict,
        ).toBe('indeterminate');
      }
      const clean = name === 'ruff-json' ? '[]' : '{"issues":[]}';
      for (const exitCode of [1, 2, null]) {
        expect(
          parseCheckOutput(adapterByName(name), { stdout: clean, stderr: '', exitCode }).verdict,
        ).toBe('indeterminate');
      }
      expect(
        parseCheckOutput(adapterByName(name), { stdout: clean, stderr: '', exitCode: 0 }),
      ).toMatchObject({ verdict: 'parsed', set: { failures: [], exitCode: 0 } });
    },
  );

  test('Ruff preserves syntax errors without a rule code', () => {
    const parsed = parseCheckOutput(adapterByName('ruff-json'), {
      stdout: JSON.stringify([
        { filename: 'bad.py', code: null, message: 'Syntax error', location: null },
      ]),
      stderr: '',
      exitCode: 1,
    });
    expect(parsed).toMatchObject({
      verdict: 'parsed',
      set: { failures: [{ ruleId: null, line: null, column: null }] },
    });
  });

  test.each([
    ['ruff-json', 'ruff-0.14.3-fail.json'],
    ['knip-json', 'knip-6.35.1-fail.json'],
  ] as const)('%s rejects failure output behind exit zero', (name, filename) => {
    expect(
      parseCheckOutput(adapterByName(name), {
        stdout: fixture(filename),
        stderr: '',
        exitCode: 0,
      }).verdict,
    ).toBe('indeterminate');
  });
});
