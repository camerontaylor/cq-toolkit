// In-process sweep.unit decision coverage. These scenarios exercise our
// orchestration over fresh injected effects; the real-git contracts remain in
// test/e2e/sweep/sweep.e2e.test.ts.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { z } from 'zod';
import type { Driver, OpInvocation, WorkerResult } from '../../../src/driver/types.js';
import { runPlan, type OpRegistryView } from '../../../src/kernel/runner.js';
import type { Op, OpRegistryEntry, Plan, RunReport } from '../../../src/kernel/types.js';
import { JournalEventSchema } from '../../../src/kernel/schema.js';
import { makeAssemblePrs } from '../../../src/ops/pr/assemblePrs.js';
import { makeSalvage } from '../../../src/ops/sweep/salvage.js';
import { makePlanSweep, type PlanSweepReport } from '../../../src/ops/sweep/planSweep.js';
import {
  buildSweepPlan,
  sweepPlannerInput,
  SWEEP_PLAN_ID,
  SWEEP_PLAN_JOB_IDS,
  type SweepPlanConfig,
} from '../../../src/plans/sweep.js';
import type { RunCheck } from '../../../src/ops/gates/checkRunner.js';
import {
  makeSweepUnitOp,
  readCommittedMarkers,
  RETRYABLE_FAULT_CLASSES,
  sweepUnitSegments,
  sweepUnitFaultClass,
} from '../../../src/ops/sweep/unit.js';
import type {
  SweepUnitBindings,
  SweepUnitDispatchInput,
  SweepUnitReport,
} from '../../../src/ops/sweep/unit.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { WorktreeEffects } from '../../../src/ops/sweep/worktreeFor.js';
import type { GhFn } from '../../../src/ops/review/gh.js';
import { makeFakeGh } from '../../e2e/sweep/run-sweep.js';

interface FakeWorld {
  root: string;
  effects: WorktreeEffects;
  git: GhFn;
  gitCalls: string[][];
  checks: string[];
  driverCalls: OpInvocation[];
  pushCalls: Array<{ repoRoot: string; branch: string }>;
  runCheck: RunCheck;
  driver: Driver;
  worktreePath: string;
  clean: boolean;
  state: {
    staged: boolean;
    stagedDiff: string;
    stagedNameStatus: string;
    commitFault: boolean;
    committed: boolean;
  };
  worktreeState: Array<{ path: string; branch: string }>;
  dirty: { value: boolean };
}

function vitestOutput(failing: boolean, message = 'failure'): string {
  return JSON.stringify({
    success: !failing,
    numTotalTests: 1,
    testResults: [
      {
        name: 'suite.test.js',
        status: failing ? 'failed' : 'passed',
        assertionResults: failing
          ? [
              {
                fullName: message,
                status: 'failed',
                failureMessages: [message],
              },
            ]
          : [{ fullName: 'passes', status: 'passed' }],
      },
    ],
  });
}

async function makeWorld(
  checkOutputs: Array<{ failing: boolean; message?: string }>,
): Promise<FakeWorld> {
  const root = await mkdtemp(join(tmpdir(), 'sweep-unit-scenarios-'));
  const worktreePath = join(root, 'worktrees', 'fix', 'alpha');
  const gitCalls: string[][] = [];
  const checks: string[] = [];
  const driverCalls: OpInvocation[] = [];
  const pushCalls: Array<{ repoRoot: string; branch: string }> = [];
  const state = { clean: true, worktreePath };
  const dirty = { value: false };
  const worktreeState: Array<{ path: string; branch: string }> = [];
  const effects: WorktreeEffects = {
    listWorktrees: async () => worktreeState.map((entry) => ({ ...entry })),
    listBranches: async () => [],
    listRemoteBranches: async () => [],
    remoteGetUrl: async () => null,
    pathExists: async () => false,
    trackedFilesUnder: async () => [],
    isStrictClean: async () => !dirty.value,
    worktreeAdd: async ({ path, branch }) => {
      state.worktreePath = path;
      state.clean = true;
      worktreeState.push({ path, branch });
    },
    worktreePrune: async () => undefined,
    rmDir: async () => undefined,
  };

  const gitState = {
    staged: true,
    stagedDiff: 'diff --git a/src/a.js b/src/a.js\n',
    stagedNameStatus: '',
    commitFault: false,
    committed: false,
  };
  const git: GhFn = async (args) => {
    gitCalls.push(args);
    if (args.includes('rev-list')) return { code: 0, stdout: '0\n', stderr: '' };
    if (args.includes('--quiet')) return { code: gitState.staged ? 1 : 0, stdout: '', stderr: '' };
    if (args.includes('--name-status')) {
      return { code: 0, stdout: gitState.stagedNameStatus, stderr: '' };
    }
    if (args.includes('diff') && args.includes('--cached')) {
      return { code: 0, stdout: gitState.stagedDiff, stderr: '' };
    }
    if (args.includes('commit') && gitState.commitFault) {
      return { code: 1, stdout: '', stderr: 'commit failed' };
    }
    if (args.includes('commit')) gitState.committed = true;
    return { code: 0, stdout: '', stderr: '' };
  };

  let checkIndex = 0;
  const runCheck: RunCheck = async (command) => {
    checks.push(command.cwd ?? '');
    const output = checkOutputs[Math.min(checkIndex, checkOutputs.length - 1)];
    checkIndex += 1;
    if (output === undefined) throw new Error('missing fake probe output');
    return {
      stdout: vitestOutput(output.failing, output.message),
      stderr: '',
      exitCode: output.failing ? 1 : 0,
    };
  };
  const driver: Driver = {
    run: async (invocation) => {
      driverCalls.push(invocation);
      return {
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      } satisfies WorkerResult;
    },
  };
  return {
    root,
    effects,
    git,
    gitCalls,
    checks,
    driverCalls,
    pushCalls,
    runCheck,
    driver,
    worktreePath,
    clean: state.clean,
    state: gitState,
    worktreeState,
    dirty,
  };
}

const UNIT: WorkUnit = { package: 'alpha', fixer: 'fix', files: ['src/a.js'] };

function bindingsOf(world: FakeWorld, extra: Partial<SweepUnitBindings> = {}): SweepUnitBindings {
  return {
    repoRoot: world.root,
    worktreesDir: 'worktrees',
    runPrefix: 'cq/unit',
    base: 'main',
    adapter: 'vitest-json',
    worktreeEffects: world.effects,
    runCheck: world.runCheck,
    checkCommand: (unit, cwd) => ({ command: 'vitest', args: [unit.package], cwd }),
    driver: world.driver,
    modelSpec: { model: 'fake', provider: 'test' },
    sessionsDir: join(world.root, 'sessions'),
    prompt: () => 'fix it',
    git: world.git,
    pushBranch: async (repoRoot, branch) => {
      world.pushCalls.push({ repoRoot, branch });
    },
    ...extra,
  };
}

async function runUnit(world: FakeWorld, extra: Partial<SweepUnitBindings> = {}, unit = UNIT) {
  return makeSweepUnitOp(bindingsOf(world, extra))(unit);
}

interface ComposedSweepOutcome {
  planner: PlanSweepReport;
  plan: Plan;
  run: RunReport;
  rescueRuns: RunReport[];
  assembleRun?: RunReport;
  gh: ReturnType<typeof makeFakeGh>;
  output: string;
}

function configFor(
  world: FakeWorld,
  packages: Array<{ name: string; path: string }>,
  extra: Partial<SweepPlanConfig> = {},
): SweepPlanConfig {
  return {
    repoRoot: world.root,
    worktreesDir: 'worktrees',
    runPrefix: 'cq/composed',
    base: 'main',
    packages,
    selector: { mode: 'workspace-all' },
    fixers: ['fix'],
    ...extra,
  };
}

function registryEntry(name: string, op: Op<never, never>): OpRegistryEntry<never, never> {
  return {
    name,
    inputSchema: z.any(),
    importer: async () => op,
  } as unknown as OpRegistryEntry<never, never>;
}

function unitRow(run: RunReport, pkg: string, fixer = 'fix') {
  const id = `sweep-${pkg.replace(/[^A-Za-z0-9._-]+/g, '-')}-${fixer}`;
  const row = run.jobs.find((job) => job.jobId === id);
  if (row === undefined) throw new Error(`missing composed unit row ${id}`);
  return row;
}

async function runComposedSweep(
  world: FakeWorld,
  config: SweepPlanConfig,
  unitExtra: (unit: WorkUnit) => Partial<SweepUnitBindings> = () => ({}),
): Promise<ComposedSweepOutcome> {
  const plannerOp = makePlanSweep({ changedFiles: async () => [] });
  const planned = await plannerOp(sweepPlannerInput(config));
  if (planned.status !== 'ok')
    throw new Error(`composed planner failed: ${JSON.stringify(planned)}`);
  const plan = buildSweepPlan(config, planned.value, SWEEP_PLAN_ID);
  const assembleTemplate = plan.jobs.find((job) => job.id === SWEEP_PLAN_JOB_IDS.assemble);
  const unitsPlan = {
    ...plan,
    jobs: plan.jobs.filter((job) => job.id !== SWEEP_PLAN_JOB_IDS.assemble),
  };
  const gh = makeFakeGh();
  const unitOp = (async (input: never) => {
    const dispatch = input as SweepUnitDispatchInput;
    const unit = dispatch as WorkUnit;
    const segments =
      dispatch.kind !== undefined && dispatch.slug !== undefined
        ? {
            kind: dispatch.kind,
            slug: dispatch.slug,
            branch: `${config.runPrefix}/${dispatch.kind}/${dispatch.slug}`,
          }
        : sweepUnitSegments(config.runPrefix, unit);
    return makeSweepUnitOp(
      bindingsOf(world, {
        runPrefix: config.runPrefix,
        base: config.base,
        segments,
        ...(dispatch.mode !== undefined ? { mode: dispatch.mode } : {}),
        prompt: () => unit.package,
        ...(dispatch.stagePathAllowlist !== undefined
          ? { stagePathAllowlist: dispatch.stagePathAllowlist }
          : {}),
        ...unitExtra(unit),
      }),
    )(unit);
  }) as unknown as Op<never, never>;
  const view: OpRegistryView = {
    get: (name) => {
      if (name === 'sweep.planSweep') {
        return registryEntry(name, plannerOp as unknown as Op<never, never>);
      }
      if (name === 'sweep.unit') return registryEntry(name, unitOp);
      if (name === 'pr.assemblePrs') {
        return registryEntry(name, makeAssemblePrs(gh.effects) as unknown as Op<never, never>);
      }
      return undefined;
    },
  };
  const journalDir = join(world.root, 'journal');
  const run = await runPlan(unitsPlan, { concurrency: 1, stopOnError: false, journalDir }, view);

  const rescueBudget = config.rescue?.maxRedispatch ?? 1;
  const rescueRuns: RunReport[] = [];
  const statusAfterRescue = new Map<string, 'ok' | 'not-ok'>();
  if (rescueBudget > 0) {
    for (const job of planned.value.jobs) {
      const row = run.jobs.find((candidate) => candidate.jobId === job.id);
      if (row === undefined || row.result.status === 'ok') continue;
      const error = row.result.status === 'failed' ? row.result.error : '';
      if (!RETRYABLE_FAULT_CLASSES.includes(sweepUnitFaultClass(error))) continue;
      const unitJob = unitsPlan.jobs.find((candidate) => candidate.id === job.id);
      if (unitJob === undefined) continue;
      let lastError = error;
      for (let attempt = 2; attempt <= rescueBudget + 1; attempt += 1) {
        const rescueReport = await runPlan(
          {
            id: SWEEP_PLAN_ID,
            label: `sweep rescue ${String(attempt)}`,
            jobs: [{ ...unitJob, id: `${unitJob.id}-r${String(attempt)}`, dependsOn: [] }],
          },
          { concurrency: 1, stopOnError: false, journalDir },
          view,
        );
        rescueRuns.push(rescueReport);
        const rescueRow = rescueReport.jobs[0];
        if (rescueRow?.result.status === 'ok') {
          lastError = '';
          break;
        }
        if (rescueRow?.result.status === 'failed') {
          lastError = rescueRow.result.error;
          if (!RETRYABLE_FAULT_CLASSES.includes(sweepUnitFaultClass(lastError))) break;
        }
      }
      statusAfterRescue.set(job.id, lastError === '' ? 'ok' : 'not-ok');
    }
  }

  const fleetOk = planned.value.jobs.every((job) => {
    const row = run.jobs.find((candidate) => candidate.jobId === job.id);
    return row?.result.status === 'ok' || statusAfterRescue.get(job.id) === 'ok';
  });
  let assembleRun: RunReport | undefined;
  if (
    config.mode !== 'prep' &&
    fleetOk &&
    planned.value.units.length > 0 &&
    assembleTemplate !== undefined
  ) {
    const markers = await readCommittedMarkers(
      config.repoRoot,
      config.worktreesDir,
      config.runPrefix,
    );
    const templateInput = assembleTemplate.input as {
      packages: Array<{ name: string; branch: string }>;
    };
    const input = {
      ...(assembleTemplate.input as object),
      packages: templateInput.packages.filter((pkg) =>
        markers.some((marker) => marker.package === pkg.name && marker.branch === pkg.branch),
      ),
    } as { packages: Array<{ name: string; branch: string }> };
    if (Array.isArray(input.packages) && input.packages.length > 0) {
      assembleRun = await runPlan(
        {
          id: SWEEP_PLAN_ID,
          label: 'sweep assemble',
          jobs: [{ ...assembleTemplate, input, dependsOn: [] }],
        },
        { concurrency: 1, stopOnError: false, journalDir },
        view,
      );
    }
  }
  const failed = planned.value.jobs.filter((job) => {
    const row = run.jobs.find((candidate) => candidate.jobId === job.id);
    return row?.result.status !== 'ok' && statusAfterRescue.get(job.id) !== 'ok';
  }).length;
  return {
    planner: planned.value,
    plan,
    run,
    rescueRuns,
    ...(assembleRun !== undefined ? { assembleRun } : {}),
    gh,
    output: `${String(failed)} failing unit(s) of ${String(planned.value.units.length)}`,
  };
}

describe('sweep unit in-process scenarios', () => {
  test('regression fails before commit and preserves a dirty worktree for salvage', async () => {
    const world = await makeWorld([
      { failing: true, message: 'baseline' },
      { failing: true, message: 'novel failure' },
    ]);
    try {
      const result = await runUnit(world, {
        driver: {
          run: async () => {
            world.dirty.value = true;
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            } satisfies WorkerResult;
          },
        },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/REGRESSION/);
        expect(result.error).toContain('novel failure');
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
      expect(world.dirty.value).toBe(true);
      const salvage = makeSalvage({
        pathExists: async () => true,
        isStrictClean: async () => false,
        canonicalize: async (path) => path,
      });
      const preserved = await salvage({
        repoRoot: world.root,
        entries: [{ path: world.worktreePath, journal: { allTerminal: false } }],
      });
      expect(preserved.status).toBe('ok');
      if (preserved.status === 'ok') expect(preserved.value.rows[0]?.class).toBe('preserve');
      const later = await makeSweepUnitOp(bindingsOf(world))(UNIT);
      expect(later.status).toBe('failed');
      if (later.status === 'failed') expect(later.error).toMatch(/dirty .*refusing reuse/);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('ordinary stage-path allowlist rejection leaves the fix staged but uncommitted', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.state.stagedNameStatus = 'M\0packages/beta/index.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: ['^src/'] },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/outside the allowlist/);
        expect(result.error).toContain('packages/beta/index.js');
      }
      expect(world.gitCalls.some((args) => args.includes('commit'))).toBe(false);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('scoped package names normalize, commit, push, and assemble at plan level', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      const outcome = await runComposedSweep(
        world,
        configFor(world, [{ name: '@scope/gamma', path: 'packages/@scope/gamma' }], {
          packageFiles: { '@scope/gamma': ['packages/@scope/gamma/test/suite.js'] },
        }),
      );
      const row = unitRow(outcome.run, '@scope/gamma');
      expect(row.result.status).toBe('ok');
      if (row.result.status === 'ok') {
        expect(row.result.value).toMatchObject({
          committed: true,
          pushed: true,
          prBranch: 'cq/composed/fix/scope-gamma',
        });
      }
      expect(outcome.assembleRun).toBeDefined();
      const assembled = outcome.assembleRun?.jobs.find(
        (job) => job.jobId === SWEEP_PLAN_JOB_IDS.assemble,
      );
      expect(assembled?.result.status).toBe('ok');
      if (assembled?.result.status === 'ok') {
        expect(assembled.result.value).toMatchObject({
          packages: [expect.objectContaining({ name: '@scope/gamma' })],
        });
      }
      expect(outcome.gh.created.map((pr) => pr.head)).toEqual([
        'cq/composed/tracker',
        'cq/composed/fix/scope-gamma',
      ]);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('all-no-op plan omits assembly and makes no forge calls', async () => {
    const world = await makeWorld([{ failing: false }, { failing: false }]);
    try {
      world.state.staged = false;
      const outcome = await runComposedSweep(
        world,
        configFor(world, [
          { name: 'alpha', path: 'packages/alpha' },
          { name: 'beta', path: 'packages/beta' },
        ]),
      );
      expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0 });
      const alpha = unitRow(outcome.run, 'alpha');
      const beta = unitRow(outcome.run, 'beta');
      expect(alpha.result.status).toBe('ok');
      expect(beta.result.status).toBe('ok');
      if (alpha.result.status === 'ok') {
        expect(alpha.result.value).toMatchObject({ committed: false, pushed: false });
      }
      expect(outcome.assembleRun).toBeUndefined();
      expect(outcome.gh.calls).toHaveLength(0);
      expect(outcome.output).toBe('0 failing unit(s) of 2');
      expect(world.pushCalls).toHaveLength(0);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('the default package scope rejects a cross-package staged path', async () => {
    const world = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      world.state.stagedNameStatus = 'M\0packages/beta/test/suite.test.js';
      const result = await runUnit(world, {
        stagePathAllowlist: { patterns: ['^packages/alpha/', 'packages/alpha/test/suite.js'] },
      });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/outside the allowlist/);
        expect(result.error).toContain('packages/beta/test/suite.test.js');
      }
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });

  test('the plan rescues infra faults and withholds rescue for tamper', async () => {
    const infraWorld = await makeWorld([{ failing: true }, { failing: true }]);
    try {
      let alphaAttempts = 0;
      const infraDriver: Driver = {
        run: async (invocation) => {
          if (invocation.prompt === 'alpha' && alphaAttempts++ === 0) {
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'error',
            } satisfies WorkerResult;
          }
          return {
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            denials: [],
            stopReason: 'complete',
          } satisfies WorkerResult;
        },
      };
      const infra = await runComposedSweep(
        infraWorld,
        configFor(infraWorld, [{ name: 'alpha', path: 'packages/alpha' }], {
          rescue: { maxRedispatch: 1 },
        }),
        () => ({ driver: infraDriver }),
      );
      const alpha = unitRow(infra.run, 'alpha');
      expect(alpha.result.status).toBe('failed');
      if (alpha.result.status === 'failed')
        expect(sweepUnitFaultClass(alpha.result.error)).toBe('infra');
      expect(infra.rescueRuns).toHaveLength(1);
      expect(infra.rescueRuns[0]?.jobs[0]?.jobId).toBe('sweep-alpha-fix-r2');
      expect(infra.rescueRuns[0]?.jobs[0]?.result.status).toBe('ok');
      expect(infra.assembleRun).toBeDefined();
      expect(infra.gh.created.map((pr) => pr.head)).toEqual([
        'cq/composed/tracker',
        'cq/composed/fix/alpha',
      ]);
      expect(infra.output).toBe('0 failing unit(s) of 1');
    } finally {
      await rm(infraWorld.root, { recursive: true, force: true });
    }

    const tamperWorld = await makeWorld([{ failing: true }, { failing: false }]);
    try {
      tamperWorld.state.stagedDiff =
        'diff --git a/added.test.js b/added.test.js\nnew file mode 100644\n--- /dev/null\n+++ b/added.test.js\n@@ -0,0 +1 @@\n+it.skip("gaming the run", () => {});\n';
      const tamper = await runComposedSweep(
        tamperWorld,
        configFor(tamperWorld, [{ name: 'beta', path: 'packages/beta' }], {
          rescue: { maxRedispatch: 1 },
        }),
      );
      const beta = unitRow(tamper.run, 'beta');
      expect(beta.result.status).toBe('failed');
      if (beta.result.status === 'failed')
        expect(sweepUnitFaultClass(beta.result.error)).toBe('tamper');
      expect(tamper.rescueRuns).toHaveLength(0);
      expect(tamper.assembleRun).toBeUndefined();
      expect(tamper.gh.calls).toHaveLength(0);
    } finally {
      await rm(tamperWorld.root, { recursive: true, force: true });
    }
  });

  test('journal lifecycle frames satisfy the frozen journal schema', () => {
    const at = new Date(1_700_000_000_000).toISOString();
    const events = [
      { type: 'run-started', runId: 'r', at, planId: 'sweep' },
      {
        type: 'job-started',
        runId: 'r',
        at,
        jobId: 'sweep-alpha-fix',
        op: 'sweep.unit',
        attempt: 1,
      },
      {
        type: 'job-finished',
        runId: 'r',
        at,
        jobId: 'sweep-alpha-fix',
        opId: 'sweep.unit',
        inputsHash: 'h',
        result: { status: 'ok', value: {} },
      },
      { type: 'run-finished', runId: 'r', at, stoppedEarly: false },
    ];
    expect(events.map((event) => JournalEventSchema.safeParse(event).success)).toEqual([
      true,
      true,
      true,
      true,
    ]);
  });

  test('two-package prep plan writes both snapshots and omits assembly', async () => {
    const world = await makeWorld([{ failing: true }, { failing: true }]);
    try {
      const outcome = await runComposedSweep(
        world,
        configFor(
          world,
          [
            { name: 'alpha', path: 'packages/alpha' },
            { name: 'beta', path: 'packages/beta' },
          ],
          { mode: 'prep' },
        ),
      );
      expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0 });
      for (const pkg of ['alpha', 'beta']) {
        const row = unitRow(outcome.run, pkg);
        expect(row.result.status).toBe('ok');
        if (row.result.status === 'ok') {
          const report = row.result.value as SweepUnitReport;
          expect(report).toMatchObject({ mode: 'prep', baseline: { verdict: 'failing' } });
          expect(report.final).toBeUndefined();
          expect(report.regression).toBeUndefined();
          expect(report.committed).toBeUndefined();
          expect(report.pushed).toBeUndefined();
        }
        const snapshot = join(
          world.root,
          'worktrees',
          '.cq-state',
          'cq/composed',
          'baseline',
          'fix',
          `${pkg}.json`,
        );
        expect(await readFile(snapshot, 'utf8')).toContain('"failures"');
      }
      expect(world.driverCalls).toHaveLength(0);
      expect(world.checks).toHaveLength(2);
      expect(world.pushCalls).toHaveLength(0);
      expect(outcome.assembleRun).toBeUndefined();
      expect(outcome.gh.calls).toHaveLength(0);
    } finally {
      await rm(world.root, { recursive: true, force: true });
    }
  });
});
