// Split provenance: test/plans/sweep.test.ts was split by subject; this file
// keeps the report-corruption guards (misaligned jobs, order mismatch,
// selection-evidence scope pins). Shared fixtures live in ./sweep.helpers.ts
// and the original suite header sits there.
import { describe, expect, test } from 'vitest';
import type { PlanSweepReport, WorkUnit } from '../../src/ops/sweep/planSweep.js';
import { SWEEP_UNIT_OP } from '../../src/ops/sweep/planSweep.js';
import { SweepUnitDispatchInputSchema } from '../../src/ops/sweep/registry.js';
import { buildSweepPlan } from '../../src/plans/sweep.js';
import { CONFIG } from './sweep.helpers.js';

describe('sweep + test-fix smoke: discovery and shape (ws-i item 2)', () => {
  test('a hand-built report with misaligned jobs/units is plan corruption (jTPa1-era guard)', () => {
    const units: Array<WorkUnit> = [
      { package: 'alpha', fixer: 'fix', files: [] },
      { package: 'beta', fixer: 'fix', files: [] },
    ];
    const misaligned: PlanSweepReport = {
      jobs: [
        {
          id: 'sweep-alpha-fix',
          op: SWEEP_UNIT_OP,
          input: units[0],
          dependsOn: [],
        },
      ],
      units,
      suppressed: [],
      needsHuman: [],
    };
    expect(() => buildSweepPlan(CONFIG, misaligned)).toThrow(/misaligned/);
  });

  test('an ORDER-mismatched report of equal length is plan corruption (#175 item 6)', () => {
    const units: Array<WorkUnit> = [
      { package: 'alpha', fixer: 'fix', files: [] },
      { package: 'beta', fixer: 'fix', files: [] },
    ];
    // Equal length, but job 0 embeds beta while unit 0 is alpha: the old
    // length-only guard would attach alpha's resolved kind/slug to beta's
    // job and mis-slug the unit.
    const swapped: PlanSweepReport = {
      jobs: [
        {
          id: 'sweep-beta-fix',
          op: SWEEP_UNIT_OP,
          input: units[1],
          dependsOn: [],
        },
        {
          id: 'sweep-alpha-fix',
          op: SWEEP_UNIT_OP,
          input: units[0],
          dependsOn: [],
        },
      ],
      units,
      suppressed: [],
      needsHuman: [],
    };
    expect(() => buildSweepPlan(CONFIG, swapped)).toThrow(/misaligned at index 0/);
  });

  test('a deletion-only root package keeps a scope pin from selection evidence (r1 major)', () => {
    const units: Array<WorkUnit> = [{ package: 'monorepo', fixer: 'fix', files: [] }];
    const report: PlanSweepReport = {
      jobs: [
        {
          id: 'sweep-monorepo-fix',
          op: SWEEP_UNIT_OP,
          input: units[0],
          dependsOn: [],
        },
      ],
      units,
      suppressed: [],
      needsHuman: [],
      selectionEvidence: { monorepo: ['old.ts'] },
    };
    const plan = buildSweepPlan({ ...CONFIG, packages: [{ name: 'monorepo', path: '.' }] }, report);
    const input = SweepUnitDispatchInputSchema.parse(plan.jobs[1]?.input);
    // Pre-fix this was `undefined` (no allowlist at all → fail open) because a
    // '.' package's only patterns come from `files`, which the #150 deletion
    // filter had emptied.
    expect(input.stagePathAllowlist?.patterns).toEqual(['^old\\.ts$']);
  });

  test("a 'toString'-named package never reads an inherited selection-evidence member (r2 major)", () => {
    const units: Array<WorkUnit> = [{ package: 'toString', fixer: 'fix', files: [] }];
    const report: PlanSweepReport = {
      jobs: [
        {
          id: 'sweep-toString-fix',
          op: SWEEP_UNIT_OP,
          input: units[0],
          dependsOn: [],
        },
      ],
      units,
      suppressed: [],
      needsHuman: [],
      // Evidence for ANOTHER package makes the map non-empty, so an
      // unguarded `map['toString']` would return Object.prototype.toString
      // and crash the allowlist loop.
      selectionEvidence: { other: ['gone.ts'] },
    };
    const plan = buildSweepPlan({ ...CONFIG, packages: [{ name: 'toString', path: '.' }] }, report);
    const input = SweepUnitDispatchInputSchema.parse(plan.jobs[1]?.input);
    expect(input.stagePathAllowlist).toBeUndefined();
  });
});
