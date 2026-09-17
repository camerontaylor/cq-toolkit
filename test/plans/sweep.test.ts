// D4 smoke tests — the shipped sweep and test-fix plans (goal D4; ws-i item
// 2: "each shipped plan has a smoke test"). Pinned here:
//   1. DISCOVERY + the smoke claim: both plans are discovered by FILE through
//      the plans-root scan (no registry line) and their importers resolve.
//   2. PLAN SHAPE: both floors parse against the kernel PlanSchema; the
//      floor's planner job input parses the sweep registry's mirror.
//   3. THE EXPANSION CONTRACT: buildSweepPlan embeds the planner report's
//      unit jobs verbatim, re-rooted on the planner job, with ONE
//      pr.assemblePrs job that depends on every unit — and an EMPTY fleet
//      carries NO assemble job (assemblePrs is tracker-first; a zero-package
//      run must never touch a forge).
//   4. THE TEST-FIX PIN: buildTestFixPlan REPLACES the fixer set with the one
//      test-only label — the plan's identity is the restriction (UC §1 row 4).
//   5. THE FLOOR RUNS: the sweep floor through the real runner + the real
//      sweep registry entry is a harmless pass (empty manifest plans nothing,
//      zero effect calls).
import { describe, expect, test } from 'vitest';
import { PlanSchema } from '../../src/kernel/schema.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type { OpRegistryEntry, Plan } from '../../src/kernel/types.js';
import { registry as prRegistry } from '../../src/ops/pr/registry.js';
import { AssemblePrsInputSchema } from '../../src/ops/pr/registry.js';
import { PlanSweepInputSchema } from '../../src/ops/sweep/registry.js';
import type { PlanSweepReport } from '../../src/ops/sweep/planSweep.js';
import { SWEEP_UNIT_OP } from '../../src/ops/sweep/planSweep.js';
import { registry as sweepRegistry } from '../../src/ops/sweep/registry.js';
import {
  buildSweepPlan,
  SWEEP_PLAN_ID,
  SweepUnitInputSchema,
  sweepUnitSegments,
  type SweepPlanConfig,
} from '../../src/plans/sweep.js';
import { buildTestFixPlan, TEST_FIX_FIXER, TEST_FIX_PLAN_ID } from '../../src/plans/test-fix.js';
import { getPlan } from '../../src/plans/registry.js';

/** A two-unit planner report as planSweep would have produced it. */
function twoUnitReport(fixer: string = 'fix'): PlanSweepReport {
  const units = [
    { package: 'alpha', fixer, files: ['packages/alpha/test/suite.test.js'] },
    { package: 'beta', fixer, files: ['packages/beta/test/suite.test.js'] },
  ];
  return {
    jobs: units.map((unit) => ({
      id: `sweep-${unit.package}-fix`,
      op: SWEEP_UNIT_OP,
      input: unit,
      dependsOn: [],
    })),
    units,
    suppressed: [],
    needsHuman: [],
  };
}

const CONFIG: SweepPlanConfig = {
  repoRoot: '/repo',
  worktreesDir: 'worktrees',
  runPrefix: 'cq/09-16a',
  base: 'main',
  packages: [
    { name: 'alpha', path: 'packages/alpha' },
    { name: 'beta', path: 'packages/beta' },
  ],
  selector: { mode: 'workspace-all' },
  fixers: ['fix'],
  packageFiles: { alpha: ['packages/alpha/test/suite.test.js'] },
};

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
  test('both plans are discovered by file and their importers resolve', async () => {
    for (const name of [SWEEP_PLAN_ID, TEST_FIX_PLAN_ID]) {
      const entry = await getPlan(name);
      expect(entry, `plan '${name}' discovered`).toBeDefined();
      const resolved = await entry?.importer();
      expect(resolved?.id).toBe(name);
      expect(resolved?.label).toContain('two-phase contract');
    }
  });

  test('both floors parse against the kernel PlanSchema and the registry mirrors', async () => {
    for (const name of [SWEEP_PLAN_ID, TEST_FIX_PLAN_ID]) {
      const plan = await (await getPlan(name))?.importer();
      expect(() => PlanSchema.parse(plan)).not.toThrow();
      const plannerJob = plan?.jobs[0];
      expect(plannerJob?.op).toBe('sweep.planSweep');
      expect(() => PlanSweepInputSchema.parse(plannerJob?.input)).not.toThrow();
      // An empty fleet carries NO assemble job (tracker-first would touch a
      // real forge even for zero packages).
      expect(plan?.jobs).toHaveLength(1);
    }
    // The test-fix floor pins the one test-only fixer label.
    const testFix = (await (await getPlan(TEST_FIX_PLAN_ID))?.importer()) as Plan;
    const testFixPlannerJob = PlanSchema.parse(testFix).jobs[0] as { input: unknown };
    expect(PlanSweepInputSchema.parse(testFixPlannerJob.input).fixers).toEqual([TEST_FIX_FIXER]);
  });

  test('buildSweepPlan: planner job first, unit jobs verbatim, assemble depends on every unit', () => {
    const plan = buildSweepPlan(CONFIG, twoUnitReport());
    expect(plan.id).toBe(SWEEP_PLAN_ID);
    expect(() => PlanSchema.parse(plan)).not.toThrow();
    expect(plan.jobs.map((job) => job.id)).toEqual([
      'sweep-plan',
      'sweep-alpha-fix',
      'sweep-beta-fix',
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
      expect(() => SweepUnitInputSchema.parse(job.input)).not.toThrow();
    }
    // The assembler: static data, derived branches, every unit a dependency.
    const assemble = plan.jobs[3] as {
      id: string;
      op: string;
      input: unknown;
      dependsOn: string[];
    };
    expect(assemble.op).toBe('pr.assemblePrs');
    expect(assemble.dependsOn).toEqual(['sweep-alpha-fix', 'sweep-beta-fix']);
    const input = AssemblePrsInputSchema.parse(assemble.input);
    expect(input.tracker.branch).toBe('cq/09-16a/tracker');
    expect(input.packages.map((pkg) => pkg.branch)).toEqual([
      sweepUnitSegments('cq/09-16a', { package: 'alpha', fixer: 'fix' }).branch,
      sweepUnitSegments('cq/09-16a', { package: 'beta', fixer: 'fix' }).branch,
    ]);
    expect(input.packages.every((pkg) => pkg.branch.startsWith('cq/09-16a/'))).toBe(true);
  });

  test('buildTestFixPlan REPLACES the fixer set with the test-only label (UC §1 row 4)', () => {
    const plan = buildTestFixPlan(
      { ...CONFIG, fixers: ['evil-fix'] },
      twoUnitReport(TEST_FIX_FIXER),
    );
    expect(plan.id).toBe(TEST_FIX_PLAN_ID);
    const plannerInput = PlanSweepInputSchema.parse((plan.jobs[0] as { input: unknown }).input);
    expect(plannerInput.fixers).toEqual([TEST_FIX_FIXER]);
    // Every unit job carries the test-only fixer (the plan's identity).
    for (const job of plan.jobs.slice(1, 3)) {
      expect(SweepUnitInputSchema.parse((job as { input: unknown }).input).fixer).toBe(
        TEST_FIX_FIXER,
      );
    }
    // A report from a DIFFERENTLY-configured phase A is plan corruption.
    expect(() => buildTestFixPlan(CONFIG, twoUnitReport('fix'))).toThrow(
      /outside the test-only set/,
    );
  });

  test('the sweep floor runs through the real runner as a harmless pass', async () => {
    const plan: Plan = (await (await getPlan(SWEEP_PLAN_ID))?.importer()) as Plan;
    // The real sweep registry entry (real subprocess planner deps) — the
    // empty manifest selects nothing and consults nothing.
    const entryByName = new Map<string, OpRegistryEntry<never, never>>(
      // The bottom-instantiation cast (the review-loop precedent: unknown
      // does not widen down to never, so the view cast goes through here).
      [...sweepRegistry, ...prRegistry].map((entry) => [
        entry.name,
        entry as unknown as OpRegistryEntry<never, never>,
      ]),
    );
    const view: OpRegistryView = { get: (name) => entryByName.get(name) };
    const report = await runPlan(plan, { concurrency: 1, stopOnError: true }, view);
    expect(report.counts).toMatchObject({ done: 1, failed: 0, blocked: 0 });
    expect(report.jobs[0]?.result.status).toBe('ok');
  });
});
