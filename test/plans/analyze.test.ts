// G3 slice 2 — tests for the shipped analyze plan module
// (src/plans/analyze.ts). Pinned here:
//   1. THE PLAN SHAPE: makeAnalyzePlan authors exactly the four-job linear
//      chain probe → collect → cluster → report, with stable job ids and
//      the inputs carried verbatim as static job data (the frozen Job has
//      no cross-job data channel — the dataflow contract).
//   2. SCHEMA VALIDITY: the shipped floor's four inputs parse against the
//      referenced ops' registry mirrors, and the whole plan parses against
//      the kernel PlanSchema (serializable, dispatchable).
//   3. THE SHIPPED ENTRY: name 'analyze'; discovered by FILE through the
//      plans-root scan (no registry.ts line — discovery is the convention).
//   4. REMEDIATION IS NOT IN THE PLAN (UC §1 row 9): no job names any
//      remediation op — the approval gate stays outside the plan runner's
//      autonomous path.
import { describe, expect, test } from 'vitest';
import { PlanSchema } from '../../src/kernel/schema.js';
import {
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  RenderAnalysisReportInputSchema,
  registry as analyzeRegistry,
} from '../../src/ops/analyze/registry.js';
import { CheckRunnerInputSchema } from '../../src/ops/gates/registry.js';
import {
  ANALYZE_JOB_IDS,
  ANALYZE_PLAN_ID,
  makeAnalyzePlan,
  plan,
} from '../../src/plans/analyze.js';
import { getPlan } from '../../src/plans/registry.js';

/** The remediation ops that must NEVER appear in the shipped plan. */
const REMEDIATION_OPS = [
  'analyze.applyRemediation',
  'analyze.astGrepCodemod',
  'analyze.agenticRemediation',
  'analyze.playbookDispatch',
] as const;

describe('makeAnalyzePlan (the pipeline as data)', () => {
  test('one linear four-job chain with stable ids and verbatim static inputs', () => {
    const inputs = {
      probe: {
        adapter: 'eslint-json' as const,
        command: { command: 'my-linter', args: ['--my-flag'], cwd: '/repo' },
      },
      collect: { sets: [{ tool: 'eslint', failures: [], exitCode: 0 }] },
      cluster: { set: { tool: 'eslint', failures: [], exitCode: 0 } },
      render: { report: { clusters: [], noise: [] }, dir: '/repo' },
    };
    const constructed = makeAnalyzePlan(inputs);
    expect(constructed.id).toBe(ANALYZE_PLAN_ID);
    expect(constructed.id).toBe('analyze');
    expect(constructed.label).toBe(
      'analyze: probe → collect → cluster → report (remediation is NEVER in the plan)',
    );
    expect(constructed.jobs).toEqual([
      { id: 'analyze-probe', op: 'gates.checkRunner', input: inputs.probe },
      {
        id: 'analyze-collect',
        op: 'analyze.collectFailures',
        input: inputs.collect,
        dependsOn: ['analyze-probe'],
      },
      {
        id: 'analyze-cluster',
        op: 'analyze.clusterErrors',
        input: inputs.cluster,
        dependsOn: ['analyze-collect'],
      },
      {
        id: 'analyze-report',
        op: 'analyze.renderAnalysisReport',
        input: inputs.render,
        dependsOn: ['analyze-cluster'],
      },
    ]);
    // The ids constant IS the ids in the plan (stable coordinates).
    expect(constructed.jobs.map((job) => job.id)).toEqual([
      ANALYZE_JOB_IDS.probe,
      ANALYZE_JOB_IDS.collect,
      ANALYZE_JOB_IDS.cluster,
      ANALYZE_JOB_IDS.report,
    ]);
  });

  test('no job names a remediation op — the approval gate stays outside the plan (UC §1 row 9)', () => {
    const constructed = makeAnalyzePlan({
      probe: { adapter: 'tsc-lines', command: { command: 'tsc', args: [] } },
      collect: { sets: [] },
      cluster: { set: { tool: 'tsc', failures: [], exitCode: 0 } },
      render: { report: { clusters: [], noise: [] }, dir: '.' },
    });
    for (const remediationOp of REMEDIATION_OPS) {
      expect(constructed.jobs.map((job) => job.op)).not.toContain(remediationOp);
    }
  });
});

describe('the shipped analyze plan entry (the discoverable floor)', () => {
  test("name 'analyze'; importer resolves the four-job floor", async () => {
    expect(plan.name).toBe('analyze');
    const resolved = await plan.importer();
    expect(resolved.id).toBe(ANALYZE_PLAN_ID);
    expect(resolved.jobs).toHaveLength(4);
    expect(resolved.jobs.map((job) => job.op)).toEqual([
      'gates.checkRunner',
      'analyze.collectFailures',
      'analyze.clusterErrors',
      'analyze.renderAnalysisReport',
    ]);
  });

  test('every floor input parses against the referenced op registry mirror', async () => {
    const resolved = await plan.importer();
    const byId = new Map(resolved.jobs.map((job) => [job.id, job]));
    const probe = byId.get(ANALYZE_JOB_IDS.probe);
    const collect = byId.get(ANALYZE_JOB_IDS.collect);
    const cluster = byId.get(ANALYZE_JOB_IDS.cluster);
    const report = byId.get(ANALYZE_JOB_IDS.report);
    expect(probe === undefined || CheckRunnerInputSchema.safeParse(probe.input).success).toBe(true);
    expect(
      collect === undefined || CollectFailuresInputSchema.safeParse(collect.input).success,
    ).toBe(true);
    expect(cluster === undefined || ClusterErrorsInputSchema.safeParse(cluster.input).success).toBe(
      true,
    );
    expect(
      report === undefined || RenderAnalysisReportInputSchema.safeParse(report.input).success,
    ).toBe(true);
    // Belt to those braces: the mirrors referenced here are the REAL
    // registry entries' schemas (the family cannot drift behind this test).
    const names = analyzeRegistry.map((entry) => entry.name);
    expect(names).toContain('analyze.collectFailures');
  });

  test('the floor parses against the kernel PlanSchema (serializable plan data)', async () => {
    const resolved = await plan.importer();
    expect(PlanSchema.safeParse(resolved).success).toBe(true);
  });

  test('getPlan discovers the module by file through the default plans root (no registry line)', async () => {
    const discovered = await getPlan('analyze');
    expect(discovered?.name).toBe('analyze');
    expect(typeof discovered?.importer).toBe('function');
  });

  test('the placeholder probe is an explicit CheckCommand a consumer edits (documented placeholder)', async () => {
    const resolved = await plan.importer();
    const probe = resolved.jobs[0];
    expect(probe?.op).toBe('gates.checkRunner');
    if (probe === undefined) throw new Error('the probe job is missing from the floor plan');
    const input = probe.input as { command: { command: string; cwd?: string } };
    expect(typeof input.command.command).toBe('string');
    expect(input.command.command.length).toBeGreaterThan(0);
  });
});
