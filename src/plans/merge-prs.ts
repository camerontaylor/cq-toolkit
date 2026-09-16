// merge-prs — the shipped merge-prs plan (goal F4, ws-f scope item 6), a
// FILE-REGISTERED plan module: src/plans/registry.ts discovers every sibling
// of this directory that exports `plan` (PlanRegistryEntry) — plans land by
// adding such a file, never by editing the plan registry.
//
// WHY THE PIPELINE IS ONE JOB, NOT A JOB GRAPH: the pipeline's stages are a
// DATAFLOW (classify hands its classifications to the planner, the planner
// hands its plan to the executor, the executor's report feeds the conflict
// pass and the post-mortem), and a frozen Job carries `input` as STATIC
// data — the kernel runner wires ORDER (dependsOn), never dataflow. A
// multi-job graph would therefore need a persistence layer between jobs to
// carry each stage's output, which the kernel does not have and the frozen
// Plan shape cannot express. The composition (runMergePrs, the merge.runPrs
// op) owns the dataflow in memory; the plan expresses the run as ONE job
// naming that op.
//
// THE DEFAULT ENTRY'S INPUT IS THE SCHEMA-VALID EMPTY RUN: repoRoot '.',
// baseBranch 'merge-queue', prs [] — discovery lists the plan, and run-plan
// executes it as a harmless empty pass (no candidates → no effect call can
// reach git; the composition completes with empty totals). Real callers
// author the plan for their run via makeMergePrsPlan (the SDK seam) or a
// plan JSON file naming op 'merge.runPrs' (the CLI run-plan seam) — the
// shipped entry is a discoverable floor, not the workflow's configuration.
//
// THE 'merge-queue' DEFAULT is the queue-branch convention of THIS repo's
// own merge flow (the documented merge-queue policy) — a presentation
// default for the shipped entry only. The merge.runPrs op itself hardcodes
// no branch name: baseBranch is configuration arriving on the input, and
// every other caller passes its own trunk.
import type { Plan, PlanRegistryEntry } from '../kernel/types.js';
import type { RunMergePrsInput } from '../ops/merge/runPrs.js';

/** The shipped plan's stable id (the discovery name and the Plan.id). */
export const MERGE_PRS_PLAN_ID = 'merge-prs';

/**
 * Author a merge-prs plan for `input` (the merge.runPrs op's input,
 * verbatim): one job, `merge-prs-run`, naming op 'merge.runPrs' with the
 * input carried as static data. The composition — not the job graph —
 * owns the stage dataflow (see the module doc).
 */
export function makeMergePrsPlan(input: RunMergePrsInput): Plan {
  return {
    id: MERGE_PRS_PLAN_ID,
    label: 'merge-prs: classify → plan → execute (+ one conflict-agent pass)',
    jobs: [{ id: 'merge-prs-run', op: 'merge.runPrs', input }],
  };
}

/**
 * The discovered plan entry: its importer resolves the schema-valid EMPTY
 * run (see the module doc) — the discoverable floor for run-plan, not a
 * configured workflow.
 */
export const plan: PlanRegistryEntry = {
  name: MERGE_PRS_PLAN_ID,
  importer: async () => makeMergePrsPlan({ repoRoot: '.', baseBranch: 'merge-queue', prs: [] }),
};
