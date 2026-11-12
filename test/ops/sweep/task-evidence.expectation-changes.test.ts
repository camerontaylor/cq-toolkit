// #1198 acceptance — a scripted worker whose staged diff rewrites
// `expect(x).toBe(1)` to `toBe(2)` in a fixture test: the task loop's attempt
// report carries exactly one `expectation-changed` entry with the before/after
// lines, and the attempt is NOT failed by it (outcome `fixed`, tamper gate
// pass). The same worker fixing source only records no entry.
import { expect, test } from 'vitest';
import type { OpInvocation } from '../../../src/driver/types.js';
import { runTaskLoop } from '../../../src/ops/sweep/taskLoop.js';
import { EFFECTS, loopBindings, PROBE, UNIT } from './task-evidence.helpers.js';

const TREE = `${'b'.repeat(40)}\n`;
const TEST_DIFF = [
  'diff --git a/test/a.test.ts b/test/a.test.ts',
  '--- a/test/a.test.ts',
  '+++ b/test/a.test.ts',
  '@@ -1,3 +1,3 @@',
  ' const x = 1;',
  '-expect(x).toBe(1);',
  '+expect(x).toBe(2);',
].join('\n');
const SOURCE_DIFF = [
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,3 @@',
  ' const x = 1;',
  '-export const y = 1;',
  '+export const y = 2;',
].join('\n');

/** The default harness's scripted git, answering the staged-diff probes. The
 * loop's wrapper prepends `-C <worktree>`, so dispatch on membership, not
 * argv[0]. */
const gitWithDiff = (diff: string, staged: string) => async (args: string[]) => {
  if (args.includes('write-tree')) return { code: 0, stdout: TREE, stderr: '' };
  if (args.includes('--name-status')) return { code: 0, stdout: staged, stderr: '' };
  if (args.includes('diff')) return { code: 0, stdout: `${diff}\n`, stderr: '' };
  return { code: 0, stdout: '', stderr: '' };
};

const runWith = (diff: string, staged: string) => {
  const invocations: OpInvocation[] = [];
  const bindings = { ...loopBindings(invocations), git: gitWithDiff(diff, staged) };
  return runTaskLoop(
    bindings,
    UNIT,
    { path: '/tmp/unused', branch: 'run/x' } as never,
    PROBE,
    'run/x',
    EFFECTS,
  );
};

test('an expectation rewrite rides the attempt report without failing the attempt', async () => {
  const outcome = await runWith(TEST_DIFF, 'M\x00test/a.test.ts');
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') return; // narrow for the row reads below
  const task = outcome.value.tasks?.[0];
  expect(task?.outcome).toBe('fixed');
  expect(task?.validation?.verdict).toBe('pass');
  expect(task?.validation?.gates.find((gate) => gate.gate === 'tamper')?.verdict).toBe('pass');
  expect(task?.validation?.expectationChanges).toEqual([
    { file: 'test/a.test.ts', line: 2, before: 'expect(x).toBe(1);', after: 'expect(x).toBe(2);' },
  ]);
  // The attempt-level evidence: the round record carries the same verdict.
  expect(task?.rounds?.[0]?.validation?.expectationChanges).toEqual([
    { file: 'test/a.test.ts', line: 2, before: 'expect(x).toBe(1);', after: 'expect(x).toBe(2);' },
  ]);
});

test('a source-only fix records no entry — absence, not an empty array', async () => {
  const outcome = await runWith(SOURCE_DIFF, 'M\x00src/a.ts');
  expect(outcome.status).toBe('ok');
  if (outcome.status !== 'ok') return;
  const task = outcome.value.tasks?.[0];
  expect(task?.outcome).toBe('fixed');
  expect(task?.validation?.expectationChanges).toBeUndefined();
  expect('expectationChanges' in (task?.validation ?? {})).toBe(false);
});
