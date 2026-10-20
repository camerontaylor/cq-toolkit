// analyze — the shipped analyze plan (goal G3; ws-g scope item 6): the
// failure-analysis pipeline probe → collect → cluster → report.
//
// THE FLOOR RUNS `analyze.run` (Lane C, S2). The discovered entry below is
// ONE job: the `analyze.run` op over the current directory, which reads the
// project's `cq.json` (write one with `cq analyze.init --dir=.`) and does the
// whole pipeline with REAL dataflow in-process. So `cq analyze` is a working
// command on a configured project, and on an unconfigured one it fails
// honestly, naming `analyze.init` — writing nothing.
//
// REMEDIATION IS NOT IN THE PLAN (UC §1 row 9): every remediation surface
// the analyze family ships — `analyze.fix` (preview, or an ATTENDED apply
// when the human passes `apply: true`), `analyze.applyRemediation`,
// `analyze.astGrepCodemod`, `analyze.agenticRemediation` (a proposal
// producer, never an applier), and `analyze.playbookDispatch` — stays
// OUTSIDE the plan runner's autonomous path. The approval gate is a human
// decision, and a plan job is dispatched without one; so this plan ends at
// the REPORT. Consumers invoke remediation per cluster, explicitly, after
// reading the report (`cq analyze.fix --dir=. --clusterId=<id>`).
//
// THE FOUR-JOB BUILDER ({@link makeAnalyzePlan}) is kept for SDK callers who
// want each stage as a separate journaled job. Its DATAFLOW CONTRACT is the
// kernel's: the frozen Job carries `input` as STATIC JSON data — the runner
// wires ORDER (`dependsOn`), never dataflow (src/kernel/runner.ts dispatches
// each job's own input verbatim) — so its caller supplies each stage's input
// from values an earlier stage produced. `analyze.run` exists precisely
// because that wiring is the part adopters should not have to write.
import type { Plan, PlanRegistryEntry } from '../kernel/types.js';
import type { CheckRunnerInput } from '../ops/gates/checkRunner.js';
import type { CollectFailuresInput } from '../ops/analyze/collectFailures.js';
import type { ClusterErrorsInput } from '../ops/analyze/clusterErrors.js';
import type { RenderAnalysisReportInput } from '../ops/analyze/renderAnalysisReport.js';
import type { AnalyzeRunInput } from '../ops/analyze/run.js';

/** The shipped plan's stable id (the discovery name and the Plan.id). */
export const ANALYZE_PLAN_ID = 'analyze';

/** The four jobs' stable ids (row order = execution wave order). */
export const ANALYZE_JOB_IDS = {
  probe: 'analyze-probe',
  collect: 'analyze-collect',
  cluster: 'analyze-cluster',
  report: 'analyze-report',
} as const;

/**
 * The four jobs' inputs, each exactly the referenced op's input (the plan
 * runner never merges or transforms them — the dataflow contract above).
 */
export interface AnalyzePlanInputs {
  /** The probe job's `gates.checkRunner` input (adapter + consumer CheckCommand). */
  probe: CheckRunnerInput;
  /** The collect job's `analyze.collectFailures` input (the probe's FailureSet(s), wired by the caller). */
  collect: CollectFailuresInput;
  /** The cluster job's `analyze.clusterErrors` input (the aggregate, wired by the caller). */
  cluster: ClusterErrorsInput;
  /** The report job's `analyze.renderAnalysisReport` input (the clustering report + output dir). */
  render: RenderAnalysisReportInput;
}

/**
 * Author an analyze plan for `inputs` (each op's input as static job data —
 * see the dataflow contract in the module header). SNAPSHOT DISCIPLINE (no
 * mutation aliasing): the builder stores DEEP COPIES of the caller's
 * inputs, so the authored plan is frozen at authoring time — a consumer
 * edit of the caller's objects (or of one authored plan's job inputs)
 * cannot rewrite another plan built from the same objects. Job ids are
 * stable ({@link ANALYZE_JOB_IDS}); the chain is strictly linear:
 * probe → collect → cluster → report.
 */
export function makeAnalyzePlan(inputs: AnalyzePlanInputs): Plan {
  const snapshot = structuredClone(inputs);
  return {
    id: ANALYZE_PLAN_ID,
    label: 'analyze: probe → collect → cluster → report (remediation is NEVER in the plan)',
    jobs: [
      { id: ANALYZE_JOB_IDS.probe, op: 'gates.checkRunner', input: snapshot.probe },
      {
        id: ANALYZE_JOB_IDS.collect,
        op: 'analyze.collectFailures',
        input: snapshot.collect,
        dependsOn: [ANALYZE_JOB_IDS.probe],
      },
      {
        id: ANALYZE_JOB_IDS.cluster,
        op: 'analyze.clusterErrors',
        input: snapshot.cluster,
        dependsOn: [ANALYZE_JOB_IDS.collect],
      },
      {
        id: ANALYZE_JOB_IDS.report,
        op: 'analyze.renderAnalysisReport',
        input: snapshot.render,
        dependsOn: [ANALYZE_JOB_IDS.cluster],
      },
    ],
  };
}

/** The floor's single job id (the `analyze.run` composition). */
export const ANALYZE_RUN_JOB_ID = 'analyze-run';

/**
 * Author the one-job plan that runs `analyze.run` with `input` (a deep copy —
 * the same snapshot discipline as {@link makeAnalyzePlan}).
 */
export function makeAnalyzeRunPlan(input: AnalyzeRunInput): Plan {
  return {
    id: ANALYZE_PLAN_ID,
    label:
      'analyze: analyze.run — probe → collect → cluster → report (remediation is NEVER in the plan)',
    jobs: [{ id: ANALYZE_RUN_JOB_ID, op: 'analyze.run', input: structuredClone(input) }],
  };
}

/**
 * The discovered plan entry: `analyze.run` over the current directory (built
 * FRESH per resolution). Reads `./cq.json`; without one it fails naming
 * `analyze.init` and writes nothing.
 */
export const plan: PlanRegistryEntry = {
  name: ANALYZE_PLAN_ID,
  importer: async () => makeAnalyzeRunPlan({ dir: '.' }),
};
