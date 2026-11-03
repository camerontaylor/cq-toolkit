// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the barrel-surface and worktree-default pins. Shared fixtures live in
// ./sweep.helpers.ts and the original suite header sits there.
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';
import { PlanSweepInputSchema } from '../../src/ops/sweep/registry.js';
import { sweepUnitSegments } from '../../src/ops/sweep/unit.js';
import { defaultSweepWorktreesDir, SWEEP_PLAN_ID } from '../../src/plans/sweep.js';
import { TEST_FIX_FIXER, TEST_FIX_PLAN_ID } from '../../src/plans/test-fix.js';
import { CONFIG, twoUnitReport } from './sweep.helpers.js';

describe('plans barrel surface (jZ59o)', () => {
  test('the builder surface resolves through src/plans/index.js and is callable', async () => {
    // Imported from the BARREL — the supported-API path SDK consumers take.
    const {
      buildSweepPlan: barrelBuild,
      buildTestFixPlan: barrelBuildTestFixPlan,
      sweepPlannerInput: barrelPlannerInput,
    } = (await import('../../src/plans/index.js')) as typeof import('../../src/plans/index.js');
    const plan = barrelBuild(CONFIG, twoUnitReport());
    expect(plan.id).toBe(SWEEP_PLAN_ID);
    expect(plan.jobs[0]?.op).toBe('sweep.planSweep');
    expect(() => PlanSweepInputSchema.parse(barrelPlannerInput(CONFIG))).not.toThrow();
    const testFixPlan = barrelBuildTestFixPlan(CONFIG, twoUnitReport(TEST_FIX_FIXER));
    expect(testFixPlan.id).toBe(TEST_FIX_PLAN_ID);
    // The naming contract rides the barrel too.
    expect(sweepUnitSegments('cq/x', { package: '@scope/pkg', fixer: 'fix' }).slug).toBe(
      'scope-pkg',
    );
    for (const job of testFixPlan.jobs.filter((candidate) => candidate.op === 'sweep.unit')) {
      expect((job as { input: { proposeOnly?: boolean } }).input.proposeOnly).toBe(true);
    }
  });
});

describe('sweep worktree default', () => {
  test('floor default resolves to a sibling worktrees directory', () => {
    expect(defaultSweepWorktreesDir('/repo')).toBe(resolve('/repo', '..', 'worktrees', 'cq'));
    expect(defaultSweepWorktreesDir('.')).toBe(resolve('.', '..', 'worktrees', 'cq'));
  });
});
