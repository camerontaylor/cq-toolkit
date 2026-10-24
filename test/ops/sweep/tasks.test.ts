import { expect, test } from 'vitest';
import { relatedCheckCommand, tasksFromFailures } from '../../../src/ops/sweep/tasks.js';
import type { CheckFailure } from '../../../src/ops/gates/checkRunner.js';

const failure = (file: string | null): CheckFailure => ({
  file,
  line: 1,
  column: null,
  ruleId: null,
  message: 'fails',
  severity: 'error',
});
test('groups duplicate failures by file and keeps unattributed evidence', () => {
  const tasks = tasksFromFailures({
    tool: 'tests',
    exitCode: 1,
    failures: [failure('b.test.ts'), failure('a.test.ts'), failure('a.test.ts'), failure(null)],
  });
  expect(tasks.map((task) => task.files)).toEqual([[], ['a.test.ts'], ['b.test.ts']]);
  expect(tasks[1]?.failures).toHaveLength(2);
});
test('argv template replaces full args and expands files without shell interpretation', () => {
  const check = { command: 'runner', args: ['full'], cwd: '/repo' };
  expect(
    relatedCheckCommand(check, ['a space.ts', '$(literal).ts'], ['related', '{files}', '--json'])
      .args,
  ).toEqual(['related', 'a space.ts', '$(literal).ts', '--json']);
  expect(relatedCheckCommand(check, ['-x.ts']).args).toEqual(['full', '--', '-x.ts']);
  expect(() => relatedCheckCommand(check, ['a.ts'], ['embedded-{files}'])).toThrow('standalone');
});

test('clean runs derive no tasks; an empty related argv cannot hide the required marker', () => {
  expect(tasksFromFailures({ tool: 'tests', exitCode: 0, failures: [] })).toEqual([]);
  expect(() => relatedCheckCommand({ command: 'runner', args: [] }, [], [])).toThrow('standalone');
  expect(
    relatedCheckCommand({ command: 'runner', args: [] }, [], ['{files}', '--json']).args,
  ).toEqual(['--json']);
});
