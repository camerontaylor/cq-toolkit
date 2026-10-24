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
const input = (patch: Partial<ValidationInput> = {}): ValidationInput => ({
  baseline,
  related: async () => clean,
  broader: async () => clean,
  stagedPaths: ['a.test.ts'],
  diff: 'diff --git a/a.test.ts b/a.test.ts\n--- a/a.test.ts\n+++ b/a.test.ts\n@@ -1 +1 @@\n-expect(x).toBe(2);\n+expect(x).toBe(3);\n',
  message:
    'fix(test): correct expectation\n\nConfidence: 1\nTested: configured checks\nOutcome: broken-test',
  requireProgress: true,
  ...patch,
});
test('allows gated test edits and records ordered gates without committing', async () => {
  const report = await validateFix(input());
  expect(report.verdict).toBe('pass');
  expect(report.gates.map((gate) => gate.gate)).toEqual([
    'related',
    'broader',
    'paths',
    'tamper',
    'commit',
  ]);
});
test('protectTests and proposeOnly require human review; config always protected', async () => {
  for (const patch of [
    { protectTests: true },
    { proposeOnly: true },
    { stagedPaths: ['package.json'] },
  ]) {
    expect((await validateFix(input(patch))).verdict).toBe('needs-human');
  }
});
test('equal counts with novel fingerprints, increased counts, missing evidence and no progress fail', async () => {
  for (const final of [
    baseline,
    { ...baseline, exitCode: null },
    {
      ...baseline,
      failures: baseline.failures.map((failure) => ({ ...failure, message: 'novel' })),
    },
    { ...baseline, failures: [...baseline.failures, ...baseline.failures] },
  ]) {
    expect((await validateFix(input({ broader: async () => final }))).verdict).toBe('fail');
  }
});
test('related failure stops broader; tamper and invalid outcome stop commit', async () => {
  let broader = false;
  expect(
    (
      await validateFix(
        input({
          related: async () => baseline,
          broader: async () => {
            broader = true;
            return clean;
          },
        }),
      )
    ).verdict,
  ).toBe('fail');
  expect(broader).toBe(false);
  expect(
    (
      await validateFix(
        input({
          diff: 'diff --git a/a.test.ts b/a.test.ts\n+++ b/a.test.ts\n@@ -0,0 +1 @@\n+test.skip("bad", () => {});',
        }),
      )
    ).verdict,
  ).toBe('fail');
  expect((await validateFix(input({ message: 'fix(test): missing evidence' }))).verdict).toBe(
    'fail',
  );
});
