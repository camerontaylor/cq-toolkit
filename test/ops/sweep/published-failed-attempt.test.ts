// Publication evidence is per round, not per task: an earlier round can be
// pushed while the current failed attempt is refused publication. Consumers
// that render a ref must select the round belonging to the current attempt.
import { describe, expect, test } from 'vitest';
import { plannedTaskRowOf } from '../../../src/ops/fix/report.js';
import { publishedFailedAttemptBranch } from '../../../src/ops/sweep/taskLoop.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';

const report = (overrides: Partial<FixTaskReport> = {}): FixTaskReport => ({
  task: { id: 't1', files: ['a.ts'] },
  attempts: [{ tier: 'worker', attempt: 1, outcome: 'code-bug' }],
  outcome: 'unfixed',
  branch: 'fix/unit',
  commits: [],
  failedAttempt: { branch: 'fix/unit-failed-2', sha: 'b'.repeat(40) },
  ...overrides,
});

const round = (branch: string, published?: boolean) => ({
  tier: 'worker' as const,
  attempt: 1,
  reason: 'attempt failed',
  failedAttempt: { branch, sha: 'a'.repeat(40) },
  ...(published === undefined ? {} : { published }),
});

describe('publishedFailedAttemptBranch', () => {
  test('returns the branch of the current attempt when its own round published', () => {
    expect(
      publishedFailedAttemptBranch(
        report({
          rounds: [round('fix/unit-failed-1', true), round('fix/unit-failed-2', true)],
        }),
      ),
    ).toBe('fix/unit-failed-2');
  });

  test('withholds the branch when only an earlier round published', () => {
    expect(
      publishedFailedAttemptBranch(
        report({
          failedAttemptPublished: true,
          rounds: [round('fix/unit-failed-1', true), round('fix/unit-failed-2', false)],
        }),
      ),
    ).toBeUndefined();
  });

  test('withholds the branch when the current round has no publication flag', () => {
    expect(
      publishedFailedAttemptBranch(report({ failedAttemptPublished: true, rounds: [round('x')] })),
    ).toBeUndefined();
  });

  test('withholds the branch for a task with no recorded rounds or attempt', () => {
    expect(publishedFailedAttemptBranch(report({ failedAttemptPublished: true }))).toBeUndefined();
    expect(publishedFailedAttemptBranch(report({ failedAttempt: undefined }))).toBeUndefined();
  });
});

describe('plannedTaskRowOf publication evidence', () => {
  test('carries publishedBranch only for the round the current attempt belongs to', () => {
    const pushed = plannedTaskRowOf(
      report({ failedAttemptPublished: true, rounds: [round('fix/unit-failed-2', true)] }),
    );
    expect(pushed.publishedBranch).toBe('fix/unit-failed-2');

    const superseded = plannedTaskRowOf(
      report({
        failedAttemptPublished: true,
        rounds: [round('fix/unit-failed-1', true), round('fix/unit-failed-2', false)],
      }),
    );
    expect(superseded.publishedBranch).toBeUndefined();
  });
});
