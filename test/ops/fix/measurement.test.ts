import { describe, expect, it } from 'vitest';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';
import type { ValidationVerdict } from '../../../src/ops/fix/validate.js';
import {
  baselineFailuresOf,
  isTodoCommitMessage,
  measureRun,
  verifiedClosuresOf,
} from '../../../src/ops/fix/measurement.js';

// Fake/local fixtures only: no repositories, providers or credentials.
const subjectOnlyMessage = 'fix: TODO marker in subject must not count\n\nCq-Note: todo';
const goodMessage = 'fix: repair the related cluster\n\nplain body, no trailers';
const todoUpperMessage = 'fix: staged repair\n\nCQ-TODO: TRUE\n';
const todoPaddedMessage = 'fix: staged repair\n\n  cq-todo :  True  \n';
const todoFalseMessage = 'fix: trailer says false\n\nCq-Todo: false\n';
const messages = new Map<string, string>([
  ['good', goodMessage],
  ['todoUpper', todoUpperMessage],
  ['todoPadded', todoPaddedMessage],
  ['todoFalse', todoFalseMessage],
]);
const messageOf = (sha: string): string | undefined => messages.get(sha);
const passing: ValidationVerdict = { verdict: 'pass', gates: [] };

function fixedTask(overrides: {
  task?: FixTaskReport['task'];
  outcome?: FixTaskReport['outcome'];
  commits?: string[];
  validation?: ValidationVerdict | undefined;
}): FixTaskReport {
  return {
    task: overrides.task ?? { id: 'unit-a/task-1', files: ['src/a.ts'], failures: [] },
    attempts: [],
    outcome: overrides.outcome ?? 'fixed',
    branch: 'cq/fix/a',
    commits: overrides.commits ?? ['good'],
    validation: overrides.validation ?? passing,
  };
}

describe('isTodoCommitMessage', () => {
  it('matches the Cq-Todo true trailer case-insensitively after trimming', () => {
    expect(isTodoCommitMessage(todoUpperMessage)).toBe(true);
    expect(isTodoCommitMessage(todoPaddedMessage)).toBe(true);
    expect(isTodoCommitMessage(goodMessage)).toBe(false);
    expect(isTodoCommitMessage(todoFalseMessage)).toBe(false);
  });

  it('never infers intent from the subject or another trailer', () => {
    expect(isTodoCommitMessage(subjectOnlyMessage)).toBe(false);
  });
});

describe('verifiedClosuresOf', () => {
  it('T34 round-trip', () => {
    const tasks: FixTaskReport[] = [
      fixedTask({}),
      // Same commit closes a second task: the SHA counts once.
      fixedTask({ task: { id: 'unit-a/task-2', files: ['src/b.ts'], failures: [] } }),
      // Todo trailer: closure is recorded with todo true, excluded from the numerator.
      fixedTask({ commits: ['todoUpper'] }),
      // Unfixed and failing-validation rows never contribute.
      fixedTask({ outcome: 'unfixed', validation: undefined }),
      fixedTask({ validation: { verdict: 'fail', gates: [] } }),
      fixedTask({ validation: { verdict: 'needs-human', gates: [] } }),
    ];
    const closures = verifiedClosuresOf(tasks, messageOf);
    const closureShas = closures.map((closure) => closure.commitSha);
    expect(closureShas).toEqual(['good', 'good', 'todoUpper']);
    const first = closures[0];
    expect(first && first.todo === false && first.taskIds[0] === 'unit-a/task-1').toBe(true);
    const todoClosure = closures[2];
    expect(todoClosure?.todo).toBe(true);

    const plannedUnits = ['unit-a'];
    const probes = new Map([['unit-a', { completed: true, count: 4 }]]);
    const metric = measureRun(tasks, plannedUnits, probes, messageOf);
    expect(metric.fixesPerRun).toEqual({ numerator: 1, denominator: 4 });
    expect(metric.verifiedCommits).toEqual(['good']);
    expect(metric.baselineFailures).toEqual([
      { unitId: 'unit-a', probeHead: null, completed: true, count: 4, unknownReason: null },
    ]);
    expect(metric.availability['metric.fixesPerRun.denominator']?.state).toBe('not-collected');
  });

  it('T34 unknown evidence', () => {
    // No message provider: every commit's trailer status is unknown, so the
    // numerator is null, never zero.
    const noMessage = () => undefined;
    expect(verifiedClosuresOf([fixedTask({})], noMessage)).toEqual([]);
    const unknownMessage = measureRun([fixedTask({})], ['unit-a'], new Map(), noMessage);
    expect(unknownMessage.fixesPerRun.numerator).toBeNull();
    expect(unknownMessage.verifiedCommits).toEqual([]);

    // A bailed unit has no completed probe: its count and the denominator
    // stay null, never zero, with an explicit unknown reason.
    const probes = new Map([
      ['unit-a', { completed: true, count: 3 }],
      ['unit-b', { completed: false, count: null }],
    ]);
    const baseline = baselineFailuresOf(['unit-a', 'unit-b', 'unit-c'], probes);
    expect(baseline.length).toBe(3);
    expect(baseline[0]).toEqual({
      unitId: 'unit-a',
      probeHead: null,
      completed: true,
      count: 3,
      unknownReason: null,
    });
    for (const row of [baseline[1], baseline[2]]) {
      expect(row && row.completed).toBe(false);
      expect(row && row.count).toBeNull();
      expect(row && row.unknownReason).toBe('baseline probe did not complete for this unit');
    }
    const bailedMetric = measureRun([fixedTask({})], ['unit-a', 'unit-b'], probes, messageOf);
    expect(bailedMetric.fixesPerRun.denominator).toBeNull();
    expect(bailedMetric.availability['metric.fixesPerRun.denominator']?.reason).toContain(
      'no completed baseline probe',
    );
  });

  it('T34 failure boundary', () => {
    // Missing validation, non-passing validation, unfixed outcomes and
    // unknown messages each independently block the numerator, and the
    // todo exclusion applies per commit, not per task.
    const tasks: FixTaskReport[] = [
      fixedTask({ outcome: 'escalated-to-human' }),
      fixedTask({ validation: undefined }),
      fixedTask({ validation: { verdict: 'fail', gates: [] } }),
      fixedTask({ commits: ['unknown-sha'] }),
      // Both commits on one fixed passing task: todo excluded, good counts.
      fixedTask({ commits: ['todoPadded', 'good'] }),
    ];
    const probes = new Map([['unit-a', { completed: true, count: 0 }]]);
    const metric = measureRun(tasks, ['unit-a'], probes, messageOf);
    expect(metric.fixesPerRun).toEqual({ numerator: 1, denominator: 0 });
    const todoShas = metric.closures
      .filter((closure) => closure.todo)
      .map((closure) => closure.commitSha);
    expect(todoShas).toEqual(['todoPadded']);
    expect(metric.verifiedCommits).toEqual(['good']);
  });
});
