// The fixture deployment's `sweep.planSweep` op: the REAL planner
// composition from the BUILT package, bound input-driven exactly like the
// registered src entry (the subprocess planner effects over the dispatched
// input's repoRoot). Path depth (verified against the layout):
//   this file = <repo>/test/fixtures/cli-smoke-ops/sweepfix/plan.js
//   DIST      = <repo>/dist/index.js → 4 hops up
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DIST = join(HERE, '..', '..', '..', '..', 'dist', 'index.js');
const { makePlanSweep, makeSubprocessSweepPlannerDeps } = await import(DIST);

export default async function sweepPlanSweep(input) {
  return await makePlanSweep(makeSubprocessSweepPlannerDeps(input.repoRoot))(input);
}
