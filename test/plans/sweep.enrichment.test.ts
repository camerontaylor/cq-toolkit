// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the unit-job enrichment pins (the builder-owned segments and the
// optional dispatch wiring). Shared fixtures live in ./sweep.helpers.ts and
// the original suite header sits there.
import { describe, expect, test } from 'vitest';
import { EnsureTrackerBranchInputSchema } from '../../src/ops/pr/registry.js';
import { SweepUnitDispatchInputSchema } from '../../src/ops/sweep/registry.js';
import { buildSweepPlan, SWEEP_PLAN_ID, type SweepUnitJobOverlay } from '../../src/plans/sweep.js';
import { CONFIG, twoUnitReport } from './sweep.helpers.js';

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
  test('the overlay cannot override the builder-owned kind/slug (jcqEl)', () => {
    // TYPE pin: kind/slug (and package/fixer/files) are the collision
    // resolution's and the planner's to set — an overlay carrying them is a
    // compile error (excess property against the Omit type).
    const clean: SweepUnitJobOverlay = { push: false };
    expect(clean.push).toBe(false);
    const overridden: SweepUnitJobOverlay = {
      push: false,
      // @ts-expect-error — kind is builder-owned (jcqEl)
      kind: 'overridden',
    };
    void overridden;
    // RUNTIME pin: the enrichment ships the RESOLVED segments regardless.
    const plan = buildSweepPlan(CONFIG, twoUnitReport(), SWEEP_PLAN_ID, {
      push: false,
    });
    const inputs = plan.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    expect(inputs.map((input) => input.kind)).toEqual(['fix', 'fix']);
    expect(inputs.map((input) => input.slug)).toEqual(['alpha', 'beta']);
    // The local-only knob reaches the tracker-branch leg too (review-debt
    // #173): a `push:false` fleet must not push the tracker branch.
    const trackerBranchJob = plan.jobs.find((job) => job.id === 'sweep-tracker-branch');
    expect(
      EnsureTrackerBranchInputSchema.parse((trackerBranchJob as { input: unknown }).input).push,
    ).toBe(false);
  });

  test('config.unitDispatch makes the enriched jobs dispatch-ready; absent leaves them unwired (jeDch)', () => {
    const driver = {
      provider: 'cq-e2e',
      model: 'sweep-fake',
      budget: { wallClockMs: 600_000, maxUsd: 1 },
    };
    const check = {
      adapter: 'tsc-lines' as const,
      command: 'node',
      args: ['scripts/check.js', '{package}'],
      timeoutMs: 30_000,
    };
    const wired = buildSweepPlan(
      {
        ...CONFIG,
        unitDispatch: {
          driver,
          check,
          promptTemplate: 'fix {package} at {worktree}',
        },
      },
      twoUnitReport(),
    );
    const wiredInputs = wired.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    // Dispatch-ready: driver/check/promptTemplate on EVERY unit job, and the
    // whole input parses the registry mirror.
    for (const input of wiredInputs) {
      expect(input.driver).toEqual(driver);
      expect(input.check).toEqual(check);
      expect(input.promptTemplate).toBe('fix {package} at {worktree}');
    }
    // ABSENT: unchanged — no driver/check keys (the exactOptional shape).
    const unwired = buildSweepPlan(CONFIG, twoUnitReport());
    const unwiredInputs = unwired.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    for (const input of unwiredInputs) {
      expect(input.driver).toBeUndefined();
      expect(input.check).toBeUndefined();
      expect(input.promptTemplate).toBeUndefined();
    }
  });
});
