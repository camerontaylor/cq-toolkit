// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the slug naming pins (deterministic collision disambiguation and the
// reserved-suffix loop). Shared fixtures live in ./sweep.helpers.ts and the
// original suite header sits there.
import { describe, expect, test } from 'vitest';
import type { PlanSweepReport, WorkUnit } from '../../src/ops/sweep/planSweep.js';
import { SWEEP_UNIT_OP } from '../../src/ops/sweep/planSweep.js';
import { AssemblePrsInputSchema } from '../../src/ops/pr/registry.js';
import { SweepUnitDispatchInputSchema } from '../../src/ops/sweep/registry.js';
import { sweepUnitSegments } from '../../src/ops/sweep/unit.js';
import { buildSweepPlan } from '../../src/plans/sweep.js';
import { CONFIG } from './sweep.helpers.js';

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
  test('the suffix loop reserves FINAL slugs: natural scope-foo-2 cannot be collided (jcqEj)', () => {
    // The finder's exact fixture: '@scope/foo' normalizes to 'scope-foo',
    // and BOTH 'scope-foo' and 'scope-foo-2' are NATURAL packages. The old
    // seen-inputs ordinal gave the third unit 'scope-foo-2' — colliding with
    // the second. The reserved-set loop keeps suffixing until free.
    const units: Array<WorkUnit> = [
      { package: '@scope/foo', fixer: 'fix', files: [] },
      { package: 'scope-foo', fixer: 'fix', files: [] },
      { package: 'scope-foo-2', fixer: 'fix', files: [] },
    ];
    const report: PlanSweepReport = {
      jobs: units.map((unit, index) => ({
        id: `sweep-natural-${index}`,
        op: SWEEP_UNIT_OP,
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    const plan = buildSweepPlan(CONFIG, report);
    const inputs = plan.jobs
      .slice(1, 4)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    const slugs = inputs.map((input) => input.slug);
    // Each unit suffixes its OWN base when taken — deterministic, traceable,
    // and all three DISTINCT (the old seen-inputs ordinal handed 'scope-foo-2'
    // to BOTH the second and the third unit).
    expect(slugs).toEqual(['scope-foo', 'scope-foo-2', 'scope-foo-2-2']);
    expect(new Set(slugs).size).toBe(3);
    // The assembler accepts all three DISTINCT branches.
    const assemble = AssemblePrsInputSchema.parse((plan.jobs[5] as { input: unknown }).input);
    expect(assemble.packages.map((pkg) => pkg.branch)).toEqual([
      'cq/09-16a/fix/scope-foo',
      'cq/09-16a/fix/scope-foo-2',
      'cq/09-16a/fix/scope-foo-2-2',
    ]);
  });

  test('slug normalization and deterministic collision disambiguation (jTPa1)', () => {
    // '@scope/pkg' normalizes to the DISPATCHABLE slug 'scope-pkg' (the old
    // fold produced '-scope-pkg', which SEGMENT_RE refuses).
    expect(sweepUnitSegments('cq/x', { package: '@scope/pkg', fixer: 'fix' })).toEqual({
      kind: 'fix',
      slug: 'scope-pkg',
      branch: 'cq/x/fix/scope-pkg',
    });
    // Distinct packages normalizing to the SAME slug resolve deterministically:
    // a '-2' suffix in unit order (the planner's job-id idiom), shipped on the
    // enriched jobs and mirrored in the assembler input.
    const units: Array<WorkUnit> = [
      { package: '@a/b', fixer: 'fix', files: [] },
      { package: 'a.b', fixer: 'fix', files: [] },
    ];
    const colliding: PlanSweepReport = {
      jobs: units.map((unit, index) => ({
        id: `sweep-collide-${index}`,
        op: SWEEP_UNIT_OP,
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    const plan = buildSweepPlan(CONFIG, colliding);
    const inputs = plan.jobs
      .slice(1, 3)
      .map((job) => SweepUnitDispatchInputSchema.parse(job.input));
    expect(inputs.map((input) => input.slug)).toEqual(['a-b', 'a-b-2']);
    const assemble = AssemblePrsInputSchema.parse((plan.jobs[4] as { input: unknown }).input);
    expect(assemble.packages.map((pkg) => pkg.branch)).toEqual([
      'cq/09-16a/fix/a-b',
      'cq/09-16a/fix/a-b-2',
    ]);
  });
});
