import { describe, expect, test } from 'vitest';
import { FixRunInputSchema } from '../../../src/ops/fix/registry.js';
import {
  failureRowsOf,
  fixRunCounters,
  neverStartedRow,
  plannedTaskRowOf,
  unitLabelOf,
  type PlannedTaskRow,
} from '../../../src/ops/fix/report.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';
import { SweepUnitDispatchInputSchema } from '../../../src/ops/sweep/registry.js';

test('fix.run defaults to local gated work and requires an explicit selector', () => {
  const input = { repoRoot: '/fixture', source: 'tests', selector: { mode: 'workspace-all' } };
  expect(FixRunInputSchema.parse(input)).toMatchObject({
    push: false,
    pushFailed: false,
    pr: false,
    proposeOnly: false,
    protectTests: false,
    concurrency: 1,
  });
  expect(FixRunInputSchema.safeParse({ ...input, selector: undefined }).success).toBe(false);
  expect(FixRunInputSchema.safeParse({ ...input, maxTokens: 0 }).success).toBe(false);
  expect(FixRunInputSchema.safeParse({ ...input, unexpected: true }).success).toBe(false);
  expect(FixRunInputSchema.parse({ ...input, pushFailed: true }).pushFailed).toBe(true);
});
test('sweep rejects invalid related argv before dispatch', () => {
  const input = {
    repoRoot: '/fixture',
    runPrefix: 'cq/run',
    base: 'HEAD',
    package: 'fixture',
    fixer: 'test',
    files: [],
    taskLoop: { relatedArgs: ['embedded-{files}'] },
  };
  expect(SweepUnitDispatchInputSchema.safeParse(input).success).toBe(false);
});

describe('fix-run report accounting', () => {
  const branch = 'cq/run/tests-1/scratch-repo';
  const task = (overrides: Partial<FixTaskReport> = {}): FixTaskReport => ({
    task: { id: 'cases/a.test.cjs', files: ['cases/a.test.cjs'] },
    attempts: [],
    outcome: 'unfixed',
    branch,
    commits: [],
    ...overrides,
  });

  test('unitLabelOf derives <kind>/<slug> from the sweep branch', () => {
    expect(unitLabelOf('cq/run/tests-1/scratch-repo')).toBe('tests-1/scratch-repo');
    expect(unitLabelOf('short')).toBe('short');
  });

  test('a fixed task with past failed rounds keeps the evidence and counts as fixed', () => {
    const report = task({
      outcome: 'fixed',
      commits: ['a'.repeat(40)],
      rounds: [
        {
          tier: 'worker',
          attempt: 1,
          reason: 'validation refused',
          failedAttempt: { branch: 'cq/run/failed/tests-1/scratch-repo/t/a1', sha: 'b'.repeat(40) },
        },
        { tier: 'rescue', attempt: 1, reason: 'rescue retry' },
      ],
      attempts: [
        { tier: 'worker', attempt: 1, invocation: 'edit', wallMs: 1, reason: 'initial task' },
        { tier: 'rescue', attempt: 1, invocation: 'edit', wallMs: 1, reason: 'rescue retry' },
      ],
    });
    const row = plannedTaskRowOf(report);
    expect(row.outcome).toBe('fixed');
    expect(row.failures).toHaveLength(1);
    expect(row.failures[0]).toMatchObject({
      unit: 'tests-1/scratch-repo',
      outcome: 'unfixed',
      gate: 'none',
      branch: 'cq/run/failed/tests-1/scratch-repo/t/a1',
    });
    expect(fixRunCounters([row])).toMatchObject({
      planned: 1,
      attempted: 1,
      fixed: 1,
      skipped: 0,
      unresolved: 0,
      rescueAttempts: 1,
      rescueFixes: 1,
    });
  });

  test('a retained failed artifact stays branch-bearing while no-artifact failures stay branchless', () => {
    const withBranch = plannedTaskRowOf(
      task({
        outcome: 'unfixed',
        reason: 'Error: validation refused task',
        failedAttempt: { branch: 'cq/run/failed/tests-1/scratch-repo/t/a1', sha: 'c'.repeat(40) },
      }),
    );
    expect(withBranch.failures[0]).toMatchObject({
      branch: 'cq/run/failed/tests-1/scratch-repo/t/a1',
      sha: 'c'.repeat(40),
      gate: 'none',
    });
    const withoutBranch = plannedTaskRowOf(
      task({ outcome: 'escalated-to-human', reason: 'failure has no attributed file' }),
    );
    expect(withoutBranch.outcome).toBe('escalated-to-human');
    expect(withoutBranch.failures[0]).toEqual({
      unit: 'tests-1/scratch-repo',
      task: 'cases/a.test.cjs',
      outcome: 'escalated-to-human',
      gate: 'none',
      reason: 'failure has no attributed file',
    });
    expect('branch' in withoutBranch.failures[0]).toBe(false);
  });

  test('never-dispatched, cancelled and budget-stopped siblings refine their outcomes', () => {
    const notStarted = plannedTaskRowOf(
      task({ outcome: 'escalated-to-human', reason: 'unit stopped for human review' }),
    );
    expect(notStarted.outcome).toBe('not-started');
    const cancelled = plannedTaskRowOf(
      task({ outcome: 'escalated-to-human', reason: 'enclosing job cancelled' }),
    );
    expect(cancelled.outcome).toBe('cancelled');
    const exhausted = plannedTaskRowOf(
      task({ outcome: 'escalated-to-human', reason: 'token or wall budget exhausted' }),
    );
    expect(exhausted.outcome).toBe('exhausted');
    // An attempted task keeps its terminal outcome even when the reason names
    // a budget: the loop concluded the attempt honestly.
    const attempted = plannedTaskRowOf(
      task({
        outcome: 'escalated-to-human',
        reason: 'token or wall budget exhausted',
        attempts: [
          { tier: 'worker', attempt: 1, invocation: 'edit', wallMs: 1, reason: 'initial task' },
        ],
      }),
    );
    expect(attempted.outcome).toBe('escalated-to-human');
  });

  test('a skipped task (fixed by an earlier verified sibling) counts skipped, not unresolved-free', () => {
    const skipped = plannedTaskRowOf(
      task({
        outcome: 'fixed',
        reason: 'earlier verified task resolved this file or cluster',
      }),
    );
    expect(skipped.outcome).toBe('fixed');
    const rows: PlannedTaskRow[] = [skipped];
    expect(fixRunCounters(rows)).toMatchObject({
      planned: 1,
      attempted: 0,
      fixed: 0,
      skipped: 1,
      unresolved: 1,
    });
  });

  test('a never-started unit row names the unit branchlessly and counts planned and unresolved', () => {
    const row = neverStartedRow(
      { kind: 'tests-1', slug: 'other-repo', branch: 'cq/run/tests-1/other-repo' },
      'other-repo',
      'unit halted on a budget bound',
    );
    expect(row.outcome).toBe('not-started');
    expect(row.branch).toBe('cq/run/tests-1/other-repo');
    expect(row.failures[0]).toEqual({
      unit: 'tests-1/other-repo',
      task: 'other-repo',
      outcome: 'not-started',
      gate: 'none',
      reason: 'unit halted on a budget bound',
    });
    expect(fixRunCounters([row])).toMatchObject({
      planned: 1,
      attempted: 0,
      fixed: 0,
      unresolved: 1,
      rescueAttempts: 0,
    });
  });

  test('counters sum across a mixed set with explicit denominators', () => {
    const fixed = plannedTaskRowOf(
      task({
        outcome: 'fixed',
        commits: ['d'.repeat(40)],
        attempts: [
          { tier: 'worker', attempt: 1, invocation: 'edit', wallMs: 1, reason: 'initial task' },
        ],
      }),
    );
    const humanNoArtifact = plannedTaskRowOf(
      task({
        task: { id: 'cases/x.test.cjs', files: ['cases/x.test.cjs'] },
        outcome: 'escalated-to-human',
        reason: 'failure has no attributed file',
      }),
    );
    const rows = [
      fixed,
      humanNoArtifact,
      neverStartedRow({ kind: 'k', slug: 's', branch: 'cq/run/k/s' }, 'p', 'cancelled'),
    ];
    expect(fixRunCounters(rows)).toEqual({
      planned: 3,
      attempted: 1,
      fixed: 1,
      skipped: 0,
      unresolved: 2,
      rescueAttempts: 0,
      rescueFixes: 0,
    });
  });

  test('failureRowsOf preserves one row per failed round including rescue history', () => {
    const report = task({
      outcome: 'unfixed',
      reason: 'cap exhausted',
      rounds: [
        {
          tier: 'worker',
          attempt: 1,
          reason: 'first refusal',
          failedAttempt: { branch: 'cq/run/failed/k/s/t/a1', sha: 'e'.repeat(40) },
          gate: 'related',
        },
        {
          tier: 'rescue',
          attempt: 1,
          reason: 'second refusal',
          failedAttempt: { branch: 'cq/run/failed/k/s/t/a2', sha: 'f'.repeat(40) },
          gate: 'broader',
        },
      ],
    });
    const rows = failureRowsOf(report, 'k/s');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ gate: 'related', outcome: 'unfixed' });
    expect(rows[1]).toMatchObject({ gate: 'broader', outcome: 'unfixed' });
  });
});
