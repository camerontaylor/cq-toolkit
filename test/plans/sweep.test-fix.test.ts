// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the test-fix builder pins (the test-only fixer restriction and PREP
// mode). Shared fixtures live in ./sweep.helpers.ts and the original suite
// header sits there.
import { describe, expect, test } from 'vitest';
import type { PlanSweepReport } from '../../src/ops/sweep/planSweep.js';
import { SWEEP_UNIT_OP } from '../../src/ops/sweep/planSweep.js';
import {
  PlanSweepInputSchema,
  SweepUnitDispatchInputSchema,
} from '../../src/ops/sweep/registry.js';
import { buildTestFixPlan, TEST_FIX_FIXER, TEST_FIX_PLAN_ID } from '../../src/plans/test-fix.js';
import { CONFIG, twoUnitReport } from './sweep.helpers.js';

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
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
      const input = SweepUnitDispatchInputSchema.parse((job as { input: unknown }).input);
      expect(input.fixer).toBe(TEST_FIX_FIXER);
      expect(input.proposeOnly).toBe(true);
    }
    // A report from a DIFFERENTLY-configured phase A is plan corruption.
    expect(() => buildTestFixPlan(CONFIG, twoUnitReport('fix'))).toThrow(
      /outside the test-only set/,
    );
    // And so is a report whose UNITS are clean but whose EMBEDDED unit-job
    // inputs carry a foreign fixer — the jobs are what get dispatched.
    const corrupted: PlanSweepReport = {
      jobs: [
        {
          id: 'sweep-alpha-evil',
          op: SWEEP_UNIT_OP,
          input: { package: 'alpha', fixer: 'evil-fix', files: [] },
          dependsOn: [],
        },
      ],
      units: [{ package: 'alpha', fixer: TEST_FIX_FIXER, files: [] }],
      suppressed: [],
      needsHuman: [],
    };
    expect(() => buildTestFixPlan(CONFIG, corrupted)).toThrow(
      /embed inputs outside the test-only set/,
    );
  });

  test('test-fix carries PREP mode: probe-only plan, no assemble (ws-i)', () => {
    const prepReport = twoUnitReport(TEST_FIX_FIXER);
    const prepPlan = buildTestFixPlan({ ...CONFIG, mode: 'prep' }, prepReport);
    expect(prepPlan.id).toBe(TEST_FIX_PLAN_ID);
    // Planner job + two probe-only unit jobs; NO assemble job.
    expect(prepPlan.jobs.map((job) => job.id)).toEqual([
      'sweep-plan',
      'sweep-alpha-fix',
      'sweep-beta-fix',
    ]);
    const inputs = prepPlan.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    for (const input of inputs) {
      expect(input.mode).toBe('prep');
      expect(input.fixer).toBe(TEST_FIX_FIXER);
    }
  });
});
