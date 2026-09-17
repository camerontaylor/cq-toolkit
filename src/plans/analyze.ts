// analyze — the shipped analyze plan (goal G3; ws-g scope item 6): the
// failure-analysis pipeline as DATA — probe → collect → cluster → report.
//
// REMEDIATION IS NOT IN THE PLAN (UC §1 row 9): every remediation surface
// the analyze family ships — `analyze.applyRemediation` (cluster-scoped,
// refuses without { clusterId, approved: true }), `analyze.astGrepCodemod`
// (rule-scoped, refuses without `approved: true`),
// `analyze.agenticRemediation` (a proposal producer, never an applier), and
// `analyze.playbookDispatch` (quarantine-consulted, verifier-gated) — stays
// OUTSIDE the plan runner's autonomous path. The approval gate is a human
// decision, and a plan job is dispatched without one; so this plan ends at
// the REPORT, which writes two files and decides nothing. Consumers invoke
// remediation per cluster, explicitly, after reading the report.
//
// THE DATAFLOW CONTRACT (why the inputs look the way they do): the frozen
// Job carries `input` as STATIC JSON data — the kernel runner wires ORDER
// (`dependsOn`), never dataflow (src/kernel/runner.ts dispatches each job's
// own input verbatim). So the four jobs below are independent data with
// fixed inputs, and the DATAFLOW — the probe's FailureSet becoming
// `collect.sets`, the aggregate becoming `cluster.set`, the clustering
// report becoming `render.report` — is implemented by the CALLER that
// authors the plan (the lane-i CLI run-plan consumers author a plan JSON
// from a prior stage's observed output; SDK callers use
// {@link makeAnalyzePlan} with the values their earlier stages produced).
// The shipped entry below is the discoverable FLOOR: schema-valid inputs
// that make the plan's SHAPE executable-but-unwired. Run verbatim, it is
// honest about exactly that — the collect job's empty `sets` is the
// boundary's valid "nothing wired" shape and the collect op fails with the
// no-input reason ('aggregating zero runs would fabricate a clean
// FailureSet'), which (with the runner's stop-on-error) keeps the floor
// from pretending an analysis happened. Nothing in the floor writes files
// unless a consumer edits the inputs to values a real upstream produced.
//
// THE PLACEHOLDER PROBE: the shipped `gates.checkRunner` job carries an
// explicit, consumer-editable CheckCommand — the shipped 'tsc-lines' tsc
// invocation is a PLACEHOLDER the consumer points at their own tool
// (their own compiler/linter/test runner binary, cwd, and args); the plan
// hardcodes no tool and no repository layout.
import type { Plan, PlanRegistryEntry } from '../kernel/types.js';
import type { CheckRunnerInput } from '../ops/gates/checkRunner.js';
import type { CollectFailuresInput } from '../ops/analyze/collectFailures.js';
import type { ClusterErrorsInput } from '../ops/analyze/clusterErrors.js';
import type { RenderAnalysisReportInput } from '../ops/analyze/renderAnalysisReport.js';

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
 * Author an analyze plan for `inputs` (each op's input verbatim, as static
 * job data — see the dataflow contract in the module header). Job ids are
 * stable ({@link ANALYZE_JOB_IDS}); the chain is strictly linear:
 * probe → collect → cluster → report.
 */
export function makeAnalyzePlan(inputs: AnalyzePlanInputs): Plan {
  return {
    id: ANALYZE_PLAN_ID,
    label: 'analyze: probe → collect → cluster → report (remediation is NEVER in the plan)',
    jobs: [
      { id: ANALYZE_JOB_IDS.probe, op: 'gates.checkRunner', input: inputs.probe },
      {
        id: ANALYZE_JOB_IDS.collect,
        op: 'analyze.collectFailures',
        input: inputs.collect,
        dependsOn: [ANALYZE_JOB_IDS.probe],
      },
      {
        id: ANALYZE_JOB_IDS.cluster,
        op: 'analyze.clusterErrors',
        input: inputs.cluster,
        dependsOn: [ANALYZE_JOB_IDS.collect],
      },
      {
        id: ANALYZE_JOB_IDS.report,
        op: 'analyze.renderAnalysisReport',
        input: inputs.render,
        dependsOn: [ANALYZE_JOB_IDS.cluster],
      },
    ],
  };
}

/**
 * The shipped floor's inputs: the placeholder tsc probe over the current
 * directory, and the schema-valid empty shapes downstream of it (`sets: []`
 * for collect; the empty tsc set for cluster; the empty report rendered into
 * the current directory for render). Run VERBATIM, the floor terminates at
 * the collect job with the honest no-input failure — see the module header.
 * These are template values for discovery, not a configured analysis.
 */
const FLOOR_INPUTS: AnalyzePlanInputs = {
  probe: {
    adapter: 'tsc-lines',
    command: { command: 'tsc', args: ['--noEmit', '--pretty', 'false'], cwd: '.' },
  },
  collect: { sets: [] },
  cluster: { set: { tool: 'tsc', failures: [], exitCode: 0 } },
  render: { report: { clusters: [], noise: [] }, dir: '.' },
};

/**
 * The discovered plan entry: its importer resolves the floor above — the
 * discoverable, schema-valid SHAPE of the pipeline (the src/plans/registry.ts
 * convention), not a configured workflow.
 */
export const plan: PlanRegistryEntry = {
  name: ANALYZE_PLAN_ID,
  importer: async () => makeAnalyzePlan(FLOOR_INPUTS),
};
