import { expect, test, vi } from 'vitest';
import { FixRunInputSchema } from '../../../src/ops/fix/registry.js';
import { validateFix } from '../../../src/ops/fix/validate.js';
import { fixSourceChecks } from '../../../src/ops/fix/runFix.js';
import { fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/checkRunner.js';
import {
  staticRelatedCheckCommand,
  staticTasksFromFailures,
  taskHasFailures,
} from '../../../src/ops/sweep/tasks.js';

const failure = (file: string | null, ruleId = 'TS2322', line = 1): CheckFailure => ({
  file,
  ruleId,
  line,
  column: 1,
  message: 'invalid assignment',
  severity: 'error',
});
const set = (...failures: CheckFailure[]): FailureSet => ({
  tool: 'tsc',
  exitCode: failures.length ? 1 : 0,
  failures,
});

test('static clusters own file and rule, preserve full signatures, and have order-independent identities', () => {
  const baseline = set(
    failure('b.ts'),
    failure('a.ts', 'TS2339'),
    failure('a.ts'),
    failure('a.ts', 'TS2322', 2),
    failure(null),
  );
  const tasks = staticTasksFromFailures(baseline);
  expect(tasks).toEqual(
    staticTasksFromFailures({ ...baseline, failures: [...baseline.failures].reverse() }),
  );
  expect(tasks.map((task) => task.files)).toEqual([[], ['a.ts'], ['a.ts'], ['b.ts']]);
  expect(tasks.find((task) => task.signature === '["tsc","a.ts","TS2322"]')?.failures).toHaveLength(
    2,
  );
  for (const task of tasks) expect(task.id).toBe(fnv1a32Hex(task.signature ?? ''));
  const target = tasks.find((task) => task.signature === '["tsc","a.ts","TS2322"]')!;
  expect(taskHasFailures(target, set(failure('a.ts', 'TS2339')), 'static')).toBe(false);
  expect(taskHasFailures(target, set(failure('a.ts', 'TS2322')), 'static')).toBe(true);
});

test('static related argv uses full tsc and explicit ESLint replacement including wrappers', () => {
  const tsc = { command: process.execPath, args: ['tsc.js', '--project', 'tsconfig.json'] };
  expect(staticRelatedCheckCommand(tsc, 'tsc-lines', ['a.ts'], ['{files}'])).toEqual(tsc);
  const eslint = { command: 'eslint', args: ['.', '--format=json'] };
  expect(
    staticRelatedCheckCommand(eslint, 'eslint-json', ['src/a.ts'], ['{files}', '--format=json'])
      .args,
  ).toEqual(['src/a.ts', '--format=json']);
  expect(eslint.args).toEqual(['.', '--format=json']);
  expect(
    staticRelatedCheckCommand(
      { command: process.execPath, args: ['wrapper.cjs', '.'] },
      'eslint-json',
      ['src/a.ts'],
      ['wrapper.cjs', '{files}'],
    ).args,
  ).toEqual(['wrapper.cjs', 'src/a.ts']);
  for (const template of [
    undefined,
    ['.'],
    ['--files={files}'],
    ['.', '{files}'],
    ['wrapper.cjs', './', '{files}'],
  ])
    expect(() => staticRelatedCheckCommand(eslint, 'eslint-json', ['a.ts'], template)).toThrow(
      'standalone {files}',
    );
  expect(() => staticRelatedCheckCommand(eslint, 'eslint-json', [], ['{files}'])).toThrow(
    'attributed task files',
  );
});

test('static validation permits siblings, requires cluster disappearance and fingerprint progress, reuses trusted full probe', async () => {
  const target = staticTasksFromFailures(set(failure('a.ts')))[0]!;
  const sibling = failure('b.ts');
  const baseline = set(failure('a.ts'), sibling);
  const broader = vi.fn(async () => set(sibling));
  const validate = (final: FailureSet) =>
    validateFix({
      baseline,
      related: async () => final,
      broader,
      relatedAccepts: (result) => !taskHasFailures(target, result, 'static'),
      reuseRelatedForBroader: true,
      requireProgress: true,
      stagedPaths: ['a.ts'],
      diff: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const a: string = 123;\n+export const a: string = "fixed";\n',
      message: 'fix: correct type\n\nOutcome: code-bug\nConfidence: 0.8\nTested: tsc',
    });
  const passing = await validate(set(sibling));
  expect(passing.verdict).toBe('pass');
  expect(passing.gates.map((gate) => gate.gate)).toEqual([
    'related',
    'broader',
    'paths',
    'tamper',
    'commit',
  ]);
  expect(passing.gates[1]?.detail).toContain('base-owned staged tree');
  expect(broader).not.toHaveBeenCalled();
  expect((await validate(baseline)).gates.at(-1)?.gate).toBe('related');
  expect((await validate(set(failure('new.ts')))).verdict).toBe('fail');
  expect((await validate(set(sibling, sibling))).verdict).toBe('fail');
});

test('static CLI schema accepts adapter aliases and arrays, rejects unknown checks', () => {
  const input = { repoRoot: '/fixture', source: 'static', selector: { mode: 'workspace-all' } };
  for (const checks of ['tsc', ['tsc', 'eslint']])
    expect(FixRunInputSchema.safeParse({ ...input, checks }).success).toBe(true);
  expect(FixRunInputSchema.safeParse({ ...input, checks: 'unknown' }).success).toBe(false);
});

test('oxfmt-check: related runs scope to the task files through a {files} template; otherwise the full check', () => {
  const oxfmt = { command: 'node_modules/.bin/oxfmt', args: ['--check', '.'] };
  expect(
    staticRelatedCheckCommand(oxfmt, 'oxfmt-check', ['src/a.ts'], ['--check', '{files}']).args,
  ).toEqual(['--check', 'src/a.ts']);
  expect(staticRelatedCheckCommand(oxfmt, 'oxfmt-check', ['src/a.ts'])).toEqual(oxfmt);
  expect(staticRelatedCheckCommand(oxfmt, 'oxfmt-check', [], ['--check', '{files}'])).toEqual(
    oxfmt,
  );
});

test('fix sources never offer the gate-only format check', () => {
  const tsc = {
    adapter: 'tsc-lines' as const,
    kind: 'static' as const,
    command: { command: 'tsc', args: [] },
  };
  const fmt = {
    adapter: 'oxfmt-check' as const,
    kind: 'static' as const,
    command: { command: 'oxfmt', args: ['--check', '.'] },
  };
  expect(fixSourceChecks([tsc, fmt], 'static')).toEqual([tsc]);
});

test('verification-only lint and related tests are not fix sources', () => {
  expect(fixSourceChecks([{ kind: 'static', adapter: 'oxlint-json' }], 'static')).toEqual([]);
  expect(fixSourceChecks([{ kind: 'tests', adapter: 'test-narrow' }], 'tests')).toEqual([]);
});

test('typed lint scopes code with its full typed flags and falls back for non-code fixes', () => {
  const command = { command: 'oxlint', args: ['--type-aware', 'src', 'test'] };
  expect(
    staticRelatedCheckCommand(command, 'oxlint-json', ['src/a.ts'], ['--type-aware', '{files}'])
      .args,
  ).toEqual(['--type-aware', 'src/a.ts']);
  expect(
    staticRelatedCheckCommand(command, 'oxlint-json', ['README.md'], ['--type-aware', '{files}']),
  ).toEqual(command);
});
