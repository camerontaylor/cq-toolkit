// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// in sweep.e2e.helpers.ts and the original suite header sits there. These
// tail-derivation tests need no scratch repo, so they import no fixtures.
import { describe, expect, test } from 'vitest';
import type { JournalEvent } from '../../../src/kernel/types.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import { salvageEntriesFor, type SweepRunOutcome } from './run-sweep.js';

// The journal-file shape sanity: one NDJSON file per dispatch (units + the
// marker-filtered assemble), every line parseable.
describe('sweep e2e: journal evidence shape', () => {
  test('salvage journal tail: lastStep is the LAST journal-order finish, never the plan-order last job', () => {
    const config = sceneLessConfig();
    const planner = twoUnitPlanner();
    const runId = 'sweep--tail--000000';
    const at = (tick: number): string => new Date(1_700_000_000_000 + tick).toISOString();
    const started = (jobId: string, tick: number): JournalEvent => ({
      type: 'job-started',
      runId,
      at: at(tick),
      jobId,
      op: 'sweep.unit',
      attempt: 1,
    });
    const finishedOk = (jobId: string, tick: number): JournalEvent => ({
      type: 'job-finished',
      runId,
      at: at(tick),
      jobId,
      opId: 'sweep.unit',
      inputsHash: 'h',
      result: { status: 'ok', value: {} },
    });
    const finishedFailed = (jobId: string, tick: number): JournalEvent => ({
      type: 'job-finished',
      runId,
      at: at(tick),
      jobId,
      opId: 'sweep.unit',
      inputsHash: 'h',
      result: { status: 'failed', error: 'boom' },
    });

    // OUT OF PLAN ORDER: beta (failed) finishes BEFORE alpha; alpha then
    // re-finishes ok (a retry). The journal's last word per package:
    const events: JournalEvent[] = [
      { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
      started('sweep-alpha-fix', 1),
      started('sweep-beta-fix', 2),
      finishedFailed('sweep-beta-fix', 3), // beta terminal FIRST ...
      finishedFailed('sweep-alpha-fix', 4), // ... alpha's first attempt fails ...
      finishedOk('sweep-alpha-fix', 5), // ... and its retry lands LAST
    ];
    const entries = salvageEntriesFor(config, planner, events);
    const alpha = entries.find((entry) => entry.branch?.endsWith('fix/alpha'));
    const beta = entries.find((entry) => entry.branch?.endsWith('fix/beta'));
    // alpha: lastStep is ITS OWN last finish — the old plan-order fallback
    // (`jobIds[jobIds.length - 1]`) would have named beta's job here.
    expect(alpha?.journal?.lastStep).toBe('sweep-alpha-fix');
    expect(alpha?.journal?.allTerminal).toBe(true); // the retry ended ok
    // beta: failed terminal — pending work, never clean-done.
    expect(beta?.journal?.lastStep).toBe('sweep-beta-fix');
    expect(beta?.journal?.allTerminal).toBe(false);

    // NO terminal event at all (interrupted before any finish): the entry
    // carries NO lastStep — salvage's absent-evidence branch (I9).
    const unfinished = salvageEntriesFor(config, planner, [
      { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
      started('sweep-alpha-fix', 1),
      started('sweep-beta-fix', 2),
    ]);
    for (const entry of unfinished) {
      expect(entry.journal?.lastStep).toBeUndefined();
      expect(entry.journal?.allTerminal).toBe(false);
    }
  });

  test('a slug-collision fleet salvages BOTH resolved trees via the enriched jobs (jTPa1/jVgCc-era pin)', () => {
    const config = sceneLessConfig();
    const units: Array<WorkUnit> = [
      { package: '@a/b', fixer: 'fix', files: [] },
      { package: 'a.b', fixer: 'fix', files: [] },
    ];
    const planner: SweepRunOutcome['planner'] = {
      jobs: units.map((unit, index) => ({
        id: `sweep-collide-${index}`,
        op: 'sweep.unit',
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    // The ENRICHED expanded-plan jobs: the builder's resolved kind/slug
    // (a-b, a-b-2). WITHOUT them the raw report derives 'a-b' for BOTH —
    // the `-2` tree would be salvaged as the first tree, twice.
    const enriched = planner.jobs.map((job, index) => ({
      ...job,
      input: {
        ...(job.input as WorkUnit),
        repoRoot: '/repo',
        worktreesDir: 'worktrees',
        runPrefix: 'cq/tail',
        base: 'main',
        kind: 'fix',
        slug: index === 0 ? 'a-b' : 'a-b-2',
      },
    }));
    const runId = 'sweep--collide--00000';
    const at = (tick: number): string => new Date(1_700_000_000_000 + tick).toISOString();
    const entries = salvageEntriesFor(
      config,
      planner,
      [
        { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
        {
          type: 'job-finished',
          runId,
          at: at(1),
          jobId: 'sweep-collide-0',
          opId: 'sweep.unit',
          inputsHash: 'h',
          result: { status: 'ok', value: {} },
        },
        {
          type: 'job-finished',
          runId,
          at: at(2),
          jobId: 'sweep-collide-1',
          opId: 'sweep.unit',
          inputsHash: 'h',
          result: { status: 'failed', error: 'boom' },
        },
      ],
      enriched,
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      '/repo/worktrees/fix/a-b',
      '/repo/worktrees/fix/a-b-2',
    ]);
    expect(entries.find((entry) => entry.branch?.endsWith('a-b'))?.journal?.allTerminal).toBe(true);
    expect(entries.find((entry) => entry.branch?.endsWith('a-b-2'))?.journal?.allTerminal).toBe(
      false,
    );
  });

  test('a multi-fixer fleet yields ONE salvage entry per UNIT tree (per kind/slug)', () => {
    const config = sceneLessConfig();
    // ONE package, TWO fixers — two trees (worktrees/fix/alpha and
    // worktrees/test-fix/alpha), two jobs, two independent tails.
    const units: Array<WorkUnit> = [
      { package: 'alpha', fixer: 'fix', files: [] },
      { package: 'alpha', fixer: 'test-fix', files: [] },
    ];
    const planner: SweepRunOutcome['planner'] = {
      jobs: units.map((unit) => ({
        id: `sweep-${unit.package}-${unit.fixer}`,
        op: 'sweep.unit',
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    const runId = 'sweep--fan--000000';
    const at = (tick: number): string => new Date(1_700_000_000_000 + tick).toISOString();
    const entries = salvageEntriesFor(config, planner, [
      { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
      {
        type: 'job-finished',
        runId,
        at: at(1),
        jobId: 'sweep-alpha-fix',
        opId: 'sweep.unit',
        inputsHash: 'h',
        result: { status: 'failed', error: 'boom' },
      },
      {
        type: 'job-finished',
        runId,
        at: at(2),
        jobId: 'sweep-alpha-test-fix',
        opId: 'sweep.unit',
        inputsHash: 'h',
        result: { status: 'ok', value: {} },
      },
    ]);
    // Two entries, one per unit tree — the package-grouped derivation would
    // have collapsed both fixers into one tree and dropped the other.
    expect(entries).toHaveLength(2);
    const fixEntry = entries.find((entry) => entry.branch?.endsWith('fix/alpha'));
    const testFixEntry = entries.find((entry) => entry.branch?.endsWith('test-fix/alpha'));
    expect(fixEntry?.path).toContain('worktrees/fix/alpha');
    expect(testFixEntry?.path).toContain('worktrees/test-fix/alpha');
    expect(fixEntry?.journal).toMatchObject({
      lastStep: 'sweep-alpha-fix',
      allTerminal: false,
    });
    expect(testFixEntry?.journal).toMatchObject({
      lastStep: 'sweep-alpha-test-fix',
      allTerminal: true,
    });
  });
});

/** Minimal config for the tail-derivation tests (only the naming fields are read). */
function sceneLessConfig(): SweepPlanConfig {
  return {
    repoRoot: '/repo',
    worktreesDir: 'worktrees',
    runPrefix: 'cq/tail',
    base: 'main',
    packages: [
      { name: 'alpha', path: 'packages/alpha' },
      { name: 'beta', path: 'packages/beta' },
    ],
    selector: { mode: 'workspace-all' },
    fixers: ['fix'],
  };
}

/** The two-unit planner shape the expanded plan embeds (plan order: alpha, beta). */
function twoUnitPlanner(): SweepRunOutcome['planner'] {
  const units: Array<WorkUnit> = [
    { package: 'alpha', fixer: 'fix', files: [] },
    { package: 'beta', fixer: 'fix', files: [] },
  ];
  return {
    jobs: units.map((unit) => ({
      id: `sweep-${unit.package}-fix`,
      op: 'sweep.unit',
      input: unit,
      dependsOn: [],
    })),
    units,
    suppressed: [],
    needsHuman: [],
  };
}
