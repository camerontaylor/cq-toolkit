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
const goodMessage = 'fix: repair the related cluster\n\nplain body, no trailers';
const todoUpperMessage = 'fix: staged repair\n\nCQ-TODO: TRUE';
const todoPaddedMessage = 'fix: staged repair\n\nCq-Run: p\n  cq-todo :  True  ';
const subjectOnlyMessage = 'fix: TODO marker in subject must not count\n\nCq-Note: todo';
const proseTodoMessage = 'fix: repairs a TODO marker\n\nCq-Todo: false\n\nFootnote: Cq-Todo: true';
const todoFalseMessage = 'fix: trailer says false\n\nCq-Todo: false';
const messages = new Map<string, string>([
  ['good', goodMessage],
  ['todoUpper', todoUpperMessage],
  ['todoPadded', todoPaddedMessage],
  ['proseTodo', proseTodoMessage],
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

  it('never infers intent from the subject, prose or another trailer', () => {
    expect(isTodoCommitMessage(subjectOnlyMessage)).toBe(false);
    expect(isTodoCommitMessage(proseTodoMessage)).toBe(false);
  });
});

describe('verifiedClosuresOf', () => {
  it('T34 round-trip', () => {
    const tasks: FixTaskReport[] = [
      fixedTask({}),
      // Same commit closes a second task: the SHA counts once.
      fixedTask({ task: { id: 'unit-a/task-2', files: ['src/b.ts'], failures: [] } }),
      // Todo trailer: closure recorded with todo true, excluded from the numerator.
      fixedTask({ commits: ['todoUpper'] }),
      // Unfixed, missing-validation and non-passing rows never contribute.
      fixedTask({ outcome: 'unfixed', validation: undefined }),
      fixedTask({ validation: { verdict: 'fail', gates: [] } }),
      fixedTask({ validation: { verdict: 'needs-human', gates: [] } }),
    ];
    const { closures, unknownTrailerShas } = verifiedClosuresOf(tasks, messageOf);
    expect(closures.map((closure) => closure.commitSha)).toEqual(['good', 'good', 'todoUpper']);
    expect(closures[0]?.todo).toBe(false);
    expect(closures[0]?.taskIds).toEqual(['unit-a/task-1']);
    expect(closures[0]?.verificationEvidence).toEqual(['validation:pass']);
    expect(closures[2]?.todo).toBe(true);
    expect(unknownTrailerShas).toEqual([]);

    const plannedUnits = ['unit-a'];
    const probes = new Map([['unit-a', { completed: true, count: 4 }]]);
    const metric = measureRun(tasks, plannedUnits, probes, messageOf);
    expect(metric.fixesPerRun).toEqual({ numerator: 1, denominator: 4 });
    expect(metric.verifiedCommits).toEqual(['good']);
    expect(metric.baselineFailures).toEqual([
      { unitId: 'unit-a', probeHead: null, completed: true, count: 4, unknownReason: null },
    ]);
    expect(metric.availability['/metric/fixesPerRun/numerator']?.state).toBe('known');
    expect(metric.availability['/metric/fixesPerRun/denominator']?.state).toBe('known');
  });

  it('T34 unknown evidence', () => {
    // A candidate closure with an unavailable message is genuinely unknown:
    // the numerator is null (never zero), with an unavailable availability
    // record that the T28 null rule requires.
    const noMessage = () => undefined;
    expect(verifiedClosuresOf([fixedTask({})], noMessage)).toEqual({
      closures: [],
      unknownTrailerShas: ['good'],
    });
    const unknownMessage = measureRun([fixedTask({})], ['unit-a'], new Map(), noMessage);
    expect(unknownMessage.fixesPerRun.numerator).toBeNull();
    expect(unknownMessage.verifiedCommits).toEqual([]);
    expect(unknownMessage.availability['/metric/fixesPerRun/numerator']?.state).toBe('unavailable');

    // A run with no closures at all is known zero, not unknown.
    const emptyMetric = measureRun([], ['unit-a'], new Map(), messageOf);
    expect(emptyMetric.fixesPerRun.numerator).toBe(0);
    expect(emptyMetric.availability['/metric/fixesPerRun/numerator']?.state).toBe('known-zero');

    // A bailed unit has no completed probe: its count and the denominator
    // stay null, never zero, with an explicit unknown reason and per-baseline
    // availability entry.
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
    expect(baseline[1]?.completed).toBe(false);
    expect(baseline[1]?.count).toBeNull();
    expect(baseline[1]?.unknownReason).toBe('baseline probe did not complete for this unit');
    expect(baseline[2]?.completed).toBe(false);
    expect(baseline[2]?.count).toBeNull();
    const bailedMetric = measureRun([fixedTask({})], ['unit-a', 'unit-b'], probes, messageOf);
    expect(bailedMetric.fixesPerRun.denominator).toBeNull();
    expect(bailedMetric.availability['/metric/fixesPerRun/denominator']?.state).toBe('unavailable');
    expect(bailedMetric.availability['/metric/baselineFailures/1/count']?.state).toBe(
      'unavailable',
    );
  });

  it('T34 failure boundary', () => {
    // Escalated outcome, missing validation, non-passing validation and an
    // unknown message each independently block the numerator, and the todo
    // exclusion applies per commit, not per task. Prose and subject TODO
    // markers stay non-todo.
    const tasks: FixTaskReport[] = [
      fixedTask({ outcome: 'escalated-to-human' }),
      fixedTask({ validation: undefined }),
      fixedTask({ validation: { verdict: 'fail', gates: [] } }),
      fixedTask({ commits: ['unknown-sha'] }),
      fixedTask({ commits: ['proseTodo', 'todoPadded', 'good'] }),
    ];
    const probes = new Map([['unit-a', { completed: true, count: 0 }]]);
    const metric = measureRun(tasks, ['unit-a'], probes, messageOf);
    // The unknown-sha candidate makes the numerator genuinely unknown even
    // though 'good' itself is verified; the denominator is a known zero.
    expect(metric.fixesPerRun).toEqual({ numerator: null, denominator: 0 });
    expect(metric.verifiedCommits).toEqual(['good', 'proseTodo']);
    expect(metric.closures.filter((c) => c.todo).map((c) => c.commitSha)).toEqual(['todoPadded']);
    expect(metric.availability['/metric/fixesPerRun/numerator']?.state).toBe('unavailable');

    // Without the unknown-message candidate the numerator is known: one
    // verified commit; todo-padded and prose-todo commits excluded.
    const boundaryTasks: FixTaskReport[] = [
      fixedTask({ outcome: 'escalated-to-human' }),
      fixedTask({ validation: undefined }),
      fixedTask({ validation: { verdict: 'fail', gates: [] } }),
      fixedTask({ commits: ['proseTodo', 'todoPadded', 'good'] }),
    ];
    const knownMetric = measureRun(boundaryTasks, ['unit-a'], probes, messageOf);
    expect(knownMetric.fixesPerRun).toEqual({ numerator: 2, denominator: 0 });
    expect(knownMetric.availability['/metric/fixesPerRun/numerator']?.state).toBe('known');
  });
});
