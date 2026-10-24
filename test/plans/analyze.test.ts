// G3 slice 2 — tests for the shipped analyze plan module
// (src/plans/analyze.ts). Pinned here:
//   1. THE PLAN SHAPE: makeAnalyzePlan authors exactly the four-job linear
//      chain probe → collect → cluster → report, with stable job ids and
//      the inputs carried verbatim as static job data (the frozen Job has
//      no cross-job data channel — the dataflow contract).
//   2. SCHEMA VALIDITY: the shipped floor's one `analyze.run` input parses
//      against the op's registry mirror, and the whole plan parses against
//      the kernel PlanSchema (serializable, dispatchable).
//   3. THE SHIPPED ENTRY: name 'analyze'; discovered by FILE through the
//      plans-root scan (no registry.ts line — discovery is the convention).
//   4. REMEDIATION IS NOT IN THE PLAN (UC §1 row 9): no job names any
//      remediation op — the approval gate stays outside the plan runner's
//      autonomous path.
//   5. THE FLOOR'S HONESTY, THROUGH THE REAL RUNNER: the shipped floor
//      (`analyze.run` over '.') run verbatim in a directory without cq.json
//      fails naming `analyze.init`, and NOTHING is written into the working
//      directory.
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import { PlanSchema } from '../../src/kernel/schema.js';
import type { OpRegistryEntry } from '../../src/kernel/types.js';
import {
  AnalyzeRunInputSchema,
  registry as analyzeRegistry,
} from '../../src/ops/analyze/registry.js';
import { registry as gatesRegistry } from '../../src/ops/gates/registry.js';
import {
  ANALYZE_JOB_IDS,
  ANALYZE_PLAN_ID,
  ANALYZE_RUN_JOB_ID,
  makeAnalyzePlan,
  makeAnalyzeRunPlan,
  plan,
} from '../../src/plans/analyze.js';
// The input type resolves through the BARREL (review-debt #167): if the
// barrel's `export type { AnalyzePlanInputs }` line is dropped, this file
// fails to compile — the re-export stays pinned by the suite.
import type { AnalyzePlanInputs } from '../../src/plans/index.js';
import { getPlan } from '../../src/plans/registry.js';

/** The remediation ops that must NEVER appear in the shipped plan. */
const REMEDIATION_OPS = [
  'analyze.fix',
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

  test('the shipped floor names no remediation op either', async () => {
    const floor = await plan.importer();
    for (const remediationOp of REMEDIATION_OPS) {
      expect(floor.jobs.map((job) => job.op)).not.toContain(remediationOp);
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
  test("name 'analyze'; importer resolves the one-job analyze.run floor over '.'", async () => {
    expect(plan.name).toBe('analyze');
    const resolved = await plan.importer();
    expect(resolved.id).toBe(ANALYZE_PLAN_ID);
    expect(resolved.jobs).toEqual([
      { id: ANALYZE_RUN_JOB_ID, op: 'analyze.run', input: { dir: '.' } },
    ]);
  });

  test('the floor input parses against the analyze.run registry mirror', async () => {
    const resolved = await plan.importer();
    expect(AnalyzeRunInputSchema.safeParse(resolved.jobs[0]?.input).success).toBe(true);
    expect(analyzeRegistry.map((entry) => entry.name)).toContain('analyze.run');
  });

  test('makeAnalyzeRunPlan snapshots its input', () => {
    const input = { dir: '/repo', out: 'reports' };
    const authored = makeAnalyzeRunPlan(input);
    input.dir = '/mutated';
    expect(authored.jobs[0]?.input).toEqual({ dir: '/repo', out: 'reports' });
  });

  test('the floor parses against the kernel PlanSchema (serializable plan data)', async () => {
    const resolved = await plan.importer();
    expect(PlanSchema.safeParse(resolved).success).toBe(true);
  });

  test('the floor builds FRESH inputs per importer resolution (no shared mutable module state to poison)', async () => {
    const floorA = await plan.importer();
    const floorB = await plan.importer();
    const runA = floorA.jobs[0];
    const runB = floorB.jobs[0];
    if (runA === undefined || runB === undefined) throw new Error('missing run jobs');
    (runA.input as { dir: string }).dir = '/mutated';
    expect((runB.input as { dir: string }).dir).toBe('.');
  });

  test('getPlan discovers the module by file through the default plans root (no registry line)', async () => {
    const discovered = await getPlan('analyze');
    expect(discovered?.name).toBe('analyze');
    expect(typeof discovered?.importer).toBe('function');
  });

  // The floor's honesty claim, pinned through the REAL runner and the REAL
  // op: run verbatim in a scratch directory WITHOUT cq.json, the
  // analyze.run job fails naming analyze.init, and NOTHING is written (no
  // report directory is created before the checks resolve).
  test('the floor run verbatim without cq.json fails naming analyze.init and writes NOTHING', async () => {
    const view: OpRegistryView = {
      get: (name) => {
        const entry = [...gatesRegistry, ...analyzeRegistry].find(
          (candidate) => candidate.name === name,
        );
        return entry as OpRegistryEntry<never, never> | undefined;
      },
    };
    const dir = await mkdtemp(join(tmpdir(), 'cq-analyze-unconfigured-'));
    try {
      const floor = await plan.importer();
      const job = floor.jobs[0];
      if (job === undefined) throw new Error('missing run job');
      // Bind the shipped floor's relative project directory without changing process.cwd().
      job.input = { dir };
      const report = await runPlan(floor, { concurrency: 1, stopOnError: true }, view);
      const row = report.jobs.find((job) => job.jobId === ANALYZE_RUN_JOB_ID);
      expect(row?.result.status).toBe('failed');
      if (row?.result.status === 'failed') expect(row.result.error).toContain('analyze.init');
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
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
