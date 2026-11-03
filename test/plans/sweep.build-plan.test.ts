// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the buildSweepPlan expansion contract (planner job, verbatim unit
// jobs, tracker branch, assemble). Shared fixtures live in ./sweep.helpers.ts
// and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import { PlanSchema } from '../../src/kernel/schema.js';
import {
  AssemblePrsInputSchema,
  EnsureTrackerBranchInputSchema,
} from '../../src/ops/pr/registry.js';
import {
  PlanSweepInputSchema,
  SweepUnitDispatchInputSchema,
} from '../../src/ops/sweep/registry.js';
import { SWEEP_UNIT_OP } from '../../src/ops/sweep/planSweep.js';
import { sweepUnitSegments } from '../../src/ops/sweep/unit.js';
import { buildSweepPlan, SWEEP_PLAN_ID } from '../../src/plans/sweep.js';
import { CONFIG, twoUnitReport } from './sweep.helpers.js';

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
  test('buildSweepPlan: planner job first, unit jobs verbatim, tracker branch then assemble', () => {
    const plan = buildSweepPlan(CONFIG, twoUnitReport());
    expect(plan.id).toBe(SWEEP_PLAN_ID);
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    expect(plan.jobs.map((job) => job.id)).toEqual([
      'sweep-plan',
      'sweep-alpha-fix',
      'sweep-beta-fix',
      'sweep-tracker-branch',
      'sweep-assemble',
    ]);
    expect(plan.jobs[0]?.op).toBe('sweep.planSweep');
    // The planner job's input parses the registry mirror.
    expect(() => PlanSweepInputSchema.parse(plan.jobs[0]?.input)).not.toThrow();
    // Unit jobs: verbatim planner output, re-rooted on the planner job, and
    // their inputs parse the unit schema.
    for (const job of plan.jobs.slice(1, 3)) {
      expect(job.op).toBe(SWEEP_UNIT_OP);
      expect(job.dependsOn).toEqual(['sweep-plan']);
      expect(() => SweepUnitDispatchInputSchema.parse(job.input)).not.toThrow();
    }
    // The tracker-branch leg (review-debt #173): every unit a dependency, and
    // the assembler depends on it (so the head exists before the PR opens).
    const trackerBranch = plan.jobs[3] as {
      id: string;
      op: string;
      input: unknown;
      dependsOn: string[];
    };
    expect(trackerBranch.op).toBe('pr.ensureTrackerBranch');
    expect(trackerBranch.dependsOn).toEqual(['sweep-alpha-fix', 'sweep-beta-fix']);
    expect(EnsureTrackerBranchInputSchema.parse(trackerBranch.input)).toMatchObject({
      repoRoot: '/repo',
      runPrefix: 'cq/09-16a',
      base: 'main',
      branch: 'cq/09-16a/tracker',
    });
    // The assembler: static data, derived branches, the tracker-branch leg a dependency.
    const assemble = plan.jobs[4] as {
      id: string;
      op: string;
      input: unknown;
      dependsOn: string[];
    };
    expect(assemble.op).toBe('pr.assemblePrs');
    expect(assemble.dependsOn).toEqual(['sweep-tracker-branch']);
    const input = AssemblePrsInputSchema.parse(assemble.input);
    expect(input.tracker.branch).toBe('cq/09-16a/tracker');
    expect(input.packages.map((pkg) => pkg.branch)).toEqual([
      sweepUnitSegments('cq/09-16a', { package: 'alpha', fixer: 'fix' }).branch,
      sweepUnitSegments('cq/09-16a', { package: 'beta', fixer: 'fix' }).branch,
    ]);
    expect(input.packages.every((pkg) => pkg.branch.startsWith('cq/09-16a/'))).toBe(true);
  });
});
