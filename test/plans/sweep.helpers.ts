// Split provenance: test/plans/sweep.test.ts was split by subject into the
// sweep.*.test.ts siblings in this directory; the shared fixtures live here
// and the original suite header is kept at the top of this module.
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
//      test-only label — the plan's identity is the restriction (UC §1 row 4)
//      — and validates EVERYWHERE: the report's units AND its embedded unit
//      jobs; a clean-units/foreign-job report is plan corruption, thrown.
//   5. THE FLOOR RUNS: the sweep floor through the real runner + the real
//      sweep registry entry is a harmless pass (empty manifest plans nothing,
//      zero effect calls).
//   6. THE BINDINGS RIDE THE SEAMS: the unit composition's sandboxPolicy
//      binding (default `workspace-write`, caller-overridable) lands
//      verbatim in the Driver's OpInvocation.
import type { PlanSweepReport } from '../../src/ops/sweep/planSweep.js';
import { SWEEP_UNIT_OP } from '../../src/ops/sweep/planSweep.js';
import type { SweepPlanConfig } from '../../src/plans/sweep.js';

/** A two-unit planner report as planSweep would have produced it. */
export function twoUnitReport(fixer: string = 'fix'): PlanSweepReport {
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

export const CONFIG: SweepPlanConfig = {
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
