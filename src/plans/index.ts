// Plans public-surface barrel — re-export only, no logic.
export * from './registry.js';
// The review-loop wiring + builder are PACKAGE SURFACE (Codex D2iX): the
// installed package must expose runReviewLoop/buildReviewLoopPlan and the
// loop's public types, not just the plan registry.
export * from './review-loop.js';
// The sweep + test-fix builders are PACKAGE SURFACE too (goal D4; jZ59o):
// SDK consumers author parameterized plans via these builders (the registry
// entries carry only the degenerate floor instances). NAMED exports, never
// star: sweep.ts, test-fix.ts AND review-loop.ts each export a `plan`
// PlanRegistryEntry, and colliding star exports are a TS2308 build error
// (ESM would silently drop two of the three at runtime).
export { SWEEP_PLAN_ID, SWEEP_PLAN_JOB_IDS, buildSweepPlan, sweepPlannerInput } from './sweep.js';
export type { SweepPlanConfig, SweepUnitJobOverlay } from './sweep.js';
export { TEST_FIX_FIXER, TEST_FIX_PLAN_ID, buildTestFixPlan } from './test-fix.js';
export type { TestFixPlanConfig } from './test-fix.js';
// The branch-segment derivation is part of the sweep plan's contract (the
// assembler input shares it with the unit op); it lives with the executor
// (src/ops/sweep — plans compose, ops execute) and is re-exported here so
// the plan surface is self-contained. SWEEP_UNIT_OP (the unit-job op NAME)
// is deliberately NOT re-exported: the ops barrel already exports it, and a
// second path to the same name is a root-barrel TS2308 collision.
export { sweepUnitSegments } from '../ops/sweep/unit.js';
// The merge-prs + analyze builders are PACKAGE SURFACE too (review-debt
// #147 #167): SDK consumers author these plans via the factories (the
// registry entries carry only the degenerate floor instances). NAMED
// exports, never star: merge-prs.ts and analyze.ts each export a `plan`
// PlanRegistryEntry, and colliding star exports are a TS2308 build error.
export { MERGE_PRS_PLAN_ID, makeMergePrsPlan } from './merge-prs.js';
export { ANALYZE_PLAN_ID, ANALYZE_JOB_IDS, makeAnalyzePlan } from './analyze.js';
export type { AnalyzePlanInputs } from './analyze.js';
// The factory's input type rides the barrel so the plans surface is
// self-contained; it is the SAME declaration ops/merge exports (one
// binding), so the root barrel's two `export *` paths do not collide.
export type { RunMergePrsInput } from '../ops/merge/runPrs.js';
