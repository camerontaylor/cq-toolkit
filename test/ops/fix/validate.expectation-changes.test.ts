// #1198 — validateFix carries the expectation-change observation on the
// verdict, outside every gate: the observation must be present when the diff
// rewrites a test expectation, absent (not an empty entry) otherwise, and it
// must never move a verdict — the tamper gate stays hackDetector-only.
import { expect, test } from 'vitest';
import { validateFix, type ValidationInput } from '../../../src/ops/fix/validate.js';
import type { FailureSet } from '../../../src/ops/gates/checkRunner.js';

const clean: FailureSet = { tool: 'tests', exitCode: 0, failures: [] };
const baseline: FailureSet = {
  tool: 'tests',
  exitCode: 1,
  failures: [
    { file: 'a.test.ts', line: 1, column: null, ruleId: null, message: 'fails', severity: 'error' },
  ],
};
const expectationDiff =
  'diff --git a/test/a.test.ts b/test/a.test.ts\n' +
  '--- a/test/a.test.ts\n' +
  '+++ b/test/a.test.ts\n' +
  '@@ -1,3 +1,3 @@\n' +
  ' const x = 1;\n' +
  '-expect(x).toBe(1);\n' +
  '+expect(x).toBe(2);\n';
const sourceDiff =
  'diff --git a/src/a.ts b/src/a.ts\n' +
  '--- a/src/a.ts\n' +
  '+++ b/src/a.ts\n' +
  '@@ -1,3 +1,3 @@\n' +
  ' const x = 1;\n' +
  '-export const y = 1;\n' +
  '+export const y = 2;\n';
const input = (patch: Partial<ValidationInput> = {}): ValidationInput => ({
  baseline,
  related: async () => clean,
  broader: async () => clean,
  stagedPaths: ['test/a.test.ts'],
  diff: expectationDiff,
  message:
    'fix(test): correct expectation\n\nConfidence: 1\nTested: configured checks\nOutcome: broken-test',
  requireProgress: true,
  ...patch,
});

test('an expectation rewrite is recorded on the verdict without failing any gate', async () => {
  const report = await validateFix(input());
  expect(report.verdict).toBe('pass');
  expect(report.expectationChanges).toEqual([
    { file: 'test/a.test.ts', line: 2, before: 'expect(x).toBe(1);', after: 'expect(x).toBe(2);' },
  ]);
  // The no-gate decision: the tamper gate stays a pass and the gate list
  // keeps its ordinary shape — the observation rides outside `gates`.
  expect(report.gates.find((gate) => gate.gate === 'tamper')?.verdict).toBe('pass');
  expect(report.gates.map((gate) => gate.gate)).toEqual([
    'related',
    'broader',
    'paths',
    'tamper',
    'commit',
  ]);
});

test('the observation survives an early gate refusal and a needs-human path', async () => {
  const failed = await validateFix(input({ related: async () => baseline }));
  expect(failed.verdict).toBe('fail');
  expect(failed.expectationChanges).toHaveLength(1);
  const human = await validateFix(input({ protectTests: true }));
  expect(human.verdict).toBe('needs-human');
  expect(human.expectationChanges).toHaveLength(1);
});

test('a source-only fix records no entry — absence, not an empty array', async () => {
  const report = await validateFix(input({ stagedPaths: ['src/a.ts'], diff: sourceDiff }));
  expect(report.verdict).toBe('pass');
  expect(report.expectationChanges).toBeUndefined();
  expect('expectationChanges' in report).toBe(false);
});

test('a non-assertion change inside a test file records no entry', async () => {
  const diff =
    'diff --git a/test/a.test.ts b/test/a.test.ts\n' +
    '--- a/test/a.test.ts\n' +
    '+++ b/test/a.test.ts\n' +
    '@@ -1,3 +1,3 @@\n' +
    ' const x = 1;\n' +
    '-const y = compute(1);\n' +
    '+const y = compute(2);\n';
  const report = await validateFix(input({ diff }));
  expect(report.verdict).toBe('pass');
  expect('expectationChanges' in report).toBe(false);
});
