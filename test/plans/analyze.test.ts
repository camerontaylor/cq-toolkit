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
//   5. THE FLOOR'S HONESTY, THROUGH THE REAL RUNNER: the shipped floor run
//      verbatim through the governed runPlan seam (the review-loop
//      precedent) terminates at the collect job with the honest no-input
//      failure, the cluster/report jobs end non-done (blocked), and
//      NOTHING is written into the working directory.
import { readdir } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import { PlanSchema } from '../../src/kernel/schema.js';
import type { OpRegistryEntry } from '../../src/kernel/types.js';
import {
  ClusterErrorsInputSchema,
  CollectFailuresInputSchema,
  RenderAnalysisReportInputSchema,
  registry as analyzeRegistry,
} from '../../src/ops/analyze/registry.js';
import { CheckRunnerInputSchema, registry as gatesRegistry } from '../../src/ops/gates/registry.js';
import {
  ANALYZE_JOB_IDS,
  ANALYZE_PLAN_ID,
  makeAnalyzePlan,
  plan,
  type AnalyzePlanInputs,
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

  test('SNAPSHOT discipline: two makeAnalyzePlan calls from one inputs object stay independent (no mutation aliasing)', () => {
    const inputs: AnalyzePlanInputs = {
      probe: { adapter: 'tsc-lines', command: { command: 'tsc', args: ['--noEmit'], cwd: '.' } },
      collect: { sets: [] },
      cluster: { set: { tool: 'tsc', failures: [], exitCode: 0 } },
      render: { report: { clusters: [], noise: [] }, dir: '.' },
    };
    const a = makeAnalyzePlan(inputs);
    const b = makeAnalyzePlan(inputs);
    const jobA = a.jobs[0];
    const jobB = b.jobs[0];
    if (jobA === undefined || jobB === undefined) throw new Error('missing probe jobs');
    // Mutate plan A's job input — plan B and the caller's object are
    // untouched: the builder stored deep copies.
    (jobA.input as { command: { command: string } }).command.command = 'mutated';
    expect((jobB.input as { command: { command: string } }).command.command).toBe('tsc');
    expect(inputs.probe.command.command).toBe('tsc');
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

  test('the floor builds FRESH inputs per importer resolution (no shared mutable module state to poison)', async () => {
    const floorA = await plan.importer();
    const floorB = await plan.importer();
    const renderA = floorA.jobs[3];
    const renderB = floorB.jobs[3];
    if (renderA === undefined || renderB === undefined) throw new Error('missing render jobs');
    (renderA.input as { dir: string }).dir = '/mutated';
    expect((renderB.input as { dir: string }).dir).toBe('.');
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

  // The floor's central honesty claim, pinned through the REAL runner and
  // the REAL ops (the governed runPlan seam, the review-loop precedent):
  // run VERBATIM, the floor's collect job fails with the honest no-input
  // policy ('aggregating zero runs would fabricate a clean FailureSet'),
  // the cluster/report jobs end non-done (blocked on the failed
  // dependency), and NOTHING is written into the working directory.
  test('the floor run verbatim through runPlan terminates at collect and writes NOTHING (the honesty pin)', async () => {
    const view: OpRegistryView = {
      get: (name) => {
        const entry = [...gatesRegistry, ...analyzeRegistry].find(
          (candidate) => candidate.name === name,
        );
        return entry as OpRegistryEntry<never, never> | undefined;
      },
    };
    // NO-WRITE ISOLATION: the working directory is shared, so the claim is
    // pinned as "the run adds no analysis-* artifact" — snapshot the cwd
    // listing before and compare against it after (never absolute zero,
    // which pre-existing artifacts would break).
    const before = new Set(await readdir(process.cwd()));
    const floor = await plan.importer();
    const report = await runPlan(floor, { concurrency: 1, stopOnError: true }, view);
    const byId = new Map(report.jobs.map((job) => [job.jobId, job]));
    // The probe (the placeholder tsc over this repo, which the static gate
    // keeps clean) completes ok; collect then fails on the empty-sets
    // policy — the runner's honest-stop keeps the rest from running.
    const collect = byId.get(ANALYZE_JOB_IDS.collect);
    expect(collect?.result.status).toBe('failed');
    if (collect?.result.status === 'failed') {
      expect(collect.result.error).toContain('no input sets');
    }
    for (const jobId of [ANALYZE_JOB_IDS.cluster, ANALYZE_JOB_IDS.report]) {
      const row = byId.get(jobId);
      expect(row?.result.status).not.toBe('ok');
      expect(row?.result.status).toBe('failed');
      if (row?.result.status === 'failed') {
        expect(row.result.error).toContain('blocked:');
      }
    }
    // And nothing was rendered: no NEW analysis-* entry in the directory.
    const after = await readdir(process.cwd());
    expect(after.filter((name) => name.startsWith('analysis-') && !before.has(name))).toEqual([]);
  }, 180_000);
});

describe('plans barrel surface (review-debt #167)', () => {
  test('the analyze surface — builder, id, job ids, input type — resolves through src/plans/index.js', async () => {
    // EVERYTHING resolved from the BARREL — the supported-API path SDK
    // consumers take — so deleting any barrel re-export fails this test.
    const barrel =
      (await import('../../src/plans/index.js')) as typeof import('../../src/plans/index.js');
    const inputs: AnalyzePlanInputs = {
      probe: {
        adapter: 'eslint-json' as const,
        command: { command: 'my-linter', args: ['--my-flag'], cwd: '/repo' },
      },
      collect: { sets: [{ tool: 'eslint', failures: [], exitCode: 0 }] },
      cluster: { set: { tool: 'eslint', failures: [], exitCode: 0 } },
      render: { report: { clusters: [], noise: [] }, dir: '/repo' },
    };
    const constructed = barrel.makeAnalyzePlan(inputs);
    expect(barrel.ANALYZE_PLAN_ID).toBe(ANALYZE_PLAN_ID);
    expect(constructed.id).toBe(barrel.ANALYZE_PLAN_ID);
    expect(constructed.jobs.map((j) => j.id)).toEqual([
      barrel.ANALYZE_JOB_IDS.probe,
      barrel.ANALYZE_JOB_IDS.collect,
      barrel.ANALYZE_JOB_IDS.cluster,
      barrel.ANALYZE_JOB_IDS.report,
    ]);
    expect(barrel.ANALYZE_JOB_IDS).toEqual(ANALYZE_JOB_IDS);
  });
});
