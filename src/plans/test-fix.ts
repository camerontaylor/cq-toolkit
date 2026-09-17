// test-fix — the shipped test-fixing plan (goal D4; UC §1 row 4): the sweep
// pipeline with the fixer set RESTRICTED to the test-only fixer label — the
// fleet run that touches ONLY tests, never production code.
//
// It is the sweep plan's two-phase contract under a different id: phase A
// runs the planner (`sweep.planSweep`) with `fixers: ['test-fix']`, phase B
// is the expanded per-unit graph (see src/plans/sweep.ts — the expansion
// contract, the unit composition, and the resume story live there). The
// restriction is the plan's WHOLE identity: the planner's unit fan-out is
// packages × fixers, so a single test-only fixer label is what makes every
// work unit a test-only unit, and the unit pipeline's regression gate +
// tamper scan are what keep the restricted fixer honest (a "fix" that
// breaks a passing suite or games the checks fails its unit uncommitted).
import type { PlanRegistryEntry } from '../kernel/types.js';
import { DEFAULT_TEST_FILE_PATTERNS } from '../ops/gates/hackDetector.js';
import { buildSweepPlan, type SweepPlanConfig } from './sweep.js';

/** The shipped plan's stable id (the discovery name and the Plan.id). */
export const TEST_FIX_PLAN_ID = 'test-fix';

/** THE test-only fixer label (UC row 4) — the plan's entire fixer set. */
export const TEST_FIX_FIXER = 'test-fix';

/**
 * A test-fix config: the sweep config with the fixer set pinned. A caller
 * passing `fixers` has it REPLACED, never merged — the plan's identity is
 * the test-only restriction.
 */
export type TestFixPlanConfig = Omit<SweepPlanConfig, 'fixers'> & { fixers?: string[] };

/**
 * The shipped stage-path allowlist of the test-only worker: the gates lane's
 * OWN test-file shapes (one definition — the hackDetector default). Every
 * staged path must match one of these patterns, or the unit fails naming the
 * offender: a test-fix worker can never commit production code, however its
 * agent phrases the edit.
 */
export const TEST_FIX_STAGE_PATH_ALLOWLIST: { patterns: string[] } = {
  patterns: [...DEFAULT_TEST_FILE_PATTERNS],
};

/**
 * Author the EXPANDED test-fix plan (phase B) — buildSweepPlan under the
 * test-fix id with `fixers` pinned to the one test-only label AND the
 * test-file stage allowlist layered onto every unit job (the restriction is
 * ENFORCED at the staged set, not just declared by the label). A caller
 * passing `fixers` here gets it REPLACED, never merged: the plan's identity
 * is the test-only restriction. The phase-A report must agree EVERYWHERE: a
 * report whose units OR whose embedded unit-job inputs carry a fixer outside
 * the test-only set is a caller/planner mismatch — plan corruption, thrown
 * here before foreign units can be embedded.
 */
export function buildTestFixPlan(
  config: TestFixPlanConfig,
  report: Parameters<typeof buildSweepPlan>[1],
): ReturnType<typeof buildSweepPlan> {
  const foreignUnits = [...new Set(report.units.map((unit) => unit.fixer))].filter(
    (fixer) => fixer !== TEST_FIX_FIXER,
  );
  if (foreignUnits.length > 0) {
    throw new Error(
      `buildTestFixPlan: the phase-A report carries fixer(s) ${JSON.stringify(foreignUnits)} outside the test-only set ['${TEST_FIX_FIXER}'] — the report must come from a planner run of THIS plan's config`,
    );
  }
  const foreignJobs = report.jobs
    .filter((job) => (job.input as { fixer?: unknown }).fixer !== TEST_FIX_FIXER)
    .map((job) => job.id);
  if (foreignJobs.length > 0) {
    throw new Error(
      `buildTestFixPlan: the phase-A report's unit job(s) ${JSON.stringify(foreignJobs)} embed inputs outside the test-only set ['${TEST_FIX_FIXER}'] — the report must come from a planner run of THIS plan's config`,
    );
  }
  return buildSweepPlan({ ...config, fixers: [TEST_FIX_FIXER] }, report, TEST_FIX_PLAN_ID, {
    stagePathAllowlist: TEST_FIX_STAGE_PATH_ALLOWLIST,
  });
}

/**
 * The discovered plan entry (src/plans/registry.ts convention): the EMPTY
 * fleet form — an empty manifest, `fixers: ['test-fix']`, the same harmless
 * empty pass the sweep floor runs. Real runs author the plan per-run via
 * buildTestFixPlan over a phase-A planner report.
 */
export const plan: PlanRegistryEntry = {
  name: TEST_FIX_PLAN_ID,
  importer: async () =>
    buildTestFixPlan(
      {
        repoRoot: '.',
        worktreesDir: 'worktrees/cq',
        runPrefix: 'cq/test-fix',
        base: 'main',
        packages: [],
        selector: { mode: 'workspace-all' },
      },
      { jobs: [], units: [], suppressed: [], needsHuman: [] },
    ),
};
