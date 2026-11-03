// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the discovery and floor-shape pins. Shared fixtures live in
// ./sweep.helpers.ts and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import { PlanSchema } from '../../src/kernel/schema.js';
import type { Plan } from '../../src/kernel/types.js';
import { PlanSweepInputSchema } from '../../src/ops/sweep/registry.js';
import { SWEEP_PLAN_ID } from '../../src/plans/sweep.js';
import { getPlan } from '../../src/plans/registry.js';
import { TEST_FIX_FIXER, TEST_FIX_PLAN_ID } from '../../src/plans/test-fix.js';

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
    const testFixPlannerJob = PlanSchema.parse(testFix).jobs[0] as {
      input: unknown;
    };
    expect(PlanSweepInputSchema.parse(testFixPlannerJob.input).fixers).toEqual([TEST_FIX_FIXER]);
  });
});
