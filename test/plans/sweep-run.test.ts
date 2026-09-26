// In-process coverage of the sweep's caller-side composition
// (src/plans/sweep-run.ts): every decision the composition makes AROUND the
// kernel runner — the rescue lane, the fleet gate, the committed-marker
// filter, the tracker-branch + assemble recomposition, prep mode, the #174
// run-state vouch, the stale-planner guard, the failures-only output, and
// the salvage journal tail. The kernel runner and its NDJSON journal are
// REAL (in a tmpdir); every op dispatch goes through a scripted registry
// view, so no git, driver, or forge process is ever launched. The real-effect
// contracts stay in test/e2e/sweep/sweep.e2e.test.ts.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import { openRunLog } from '../../src/kernel/journal.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type {
  JournalEvent,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunReport,
} from '../../src/kernel/types.js';
import type { AssemblePrsInput } from '../../src/ops/pr/assemblePrs.js';
import type { PlanSweepReport, WorkUnit } from '../../src/ops/sweep/planSweep.js';
import type { SalvageEffects } from '../../src/ops/sweep/salvage.js';
import type { CommittedMarker, SweepUnitDispatchInput } from '../../src/ops/sweep/unit.js';
import { SWEEP_PLAN_ID, type SweepPlanConfig } from '../../src/plans/sweep.js';
import {
  renderSweepOutput,
  runEventsAt,
  runSweep,
  salvageEntriesFor,
  salvageInterruptedRun,
  type SweepRunDeps,
  type SweepRunOpts,
} from '../../src/plans/sweep-run.js';

// ---------------------------------------------------------------------------
// The scripted world
// ---------------------------------------------------------------------------

const DIRS: string[] = [];
afterEach(async () => {
  for (const dir of DIRS.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function journalDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sweep-run-'));
  DIRS.push(dir);
  return dir;
}

const ALPHA: WorkUnit = { package: 'alpha', fixer: 'fix', files: ['packages/alpha/a.js'] };
const BETA: WorkUnit = { package: 'beta', fixer: 'fix', files: ['packages/beta/b.js'] };

function configFor(units: WorkUnit[], extra: Partial<SweepPlanConfig> = {}): SweepPlanConfig {
  return {
    repoRoot: '/repo',
    worktreesDir: 'worktrees',
    runPrefix: 'cq/run',
    base: 'main',
    packages: units.map((unit) => ({
      name: unit.package,
      path: `packages/${unit.package.replace(/^@/, '')}`,
    })),
    selector: { mode: 'workspace-all' },
    fixers: ['fix'],
    ...extra,
  };
}

/** The planner report shape sweep.planSweep emits: one `sweep-<pkg>-<fixer>` job per unit. */
function reportFor(units: WorkUnit[]): PlanSweepReport {
  return {
    jobs: units.map((unit) => ({
      id: `sweep-${unit.package.replace(/[^A-Za-z0-9._-]+/g, '-')}-${unit.fixer}`,
      op: 'sweep.unit',
      input: unit,
      dependsOn: [],
    })),
    units,
    suppressed: [],
    needsHuman: [],
  };
}

/** A unit script: the result of the Nth dispatch (1-based) of one package's unit. */
type UnitScript = (attempt: number, input: SweepUnitDispatchInput) => OpResult<unknown>;

const OK: OpResult<unknown> = { status: 'ok', value: { committed: false } };
const fail = (error: string): OpResult<unknown> => ({ status: 'failed', error });

interface World {
  opts: SweepRunOpts;
  deps: SweepRunDeps;
  /** Every sweep.unit dispatch input, in dispatch order. */
  unitInputs: SweepUnitDispatchInput[];
  trackerInputs: unknown[];
  assembleInputs: AssemblePrsInput[];
  markerReads: Array<{
    repoRoot: string;
    worktreesDir: string;
    runPrefix: string;
    runStateDir: string | undefined;
  }>;
  /** Every plan dispatched through the (real) kernel runner, in order. */
  dispatched: Plan[];
}

async function worldFor(
  units: WorkUnit[],
  scripts: Record<string, UnitScript>,
  options: {
    config?: Partial<SweepPlanConfig>;
    markers?: CommittedMarker[];
    runStateDir?: string | null;
    /** The in-plan planner job's report (default: the phase-A report). */
    inPlanReport?: PlanSweepReport;
    /** The tracker-branch leg's result (default ok). */
    trackerResult?: OpResult<unknown>;
    opts?: Partial<SweepRunOpts>;
  } = {},
): Promise<World> {
  const config = configFor(units, options.config);
  const report = reportFor(units);
  const unitInputs: SweepUnitDispatchInput[] = [];
  const trackerInputs: unknown[] = [];
  const assembleInputs: AssemblePrsInput[] = [];
  const markerReads: World['markerReads'] = [];
  const attempts = new Map<string, number>();
  const dispatched: Plan[] = [];

  const entry = (name: string, op: (input: unknown) => OpResult<unknown>): OpRegistryEntry => ({
    name,
    inputSchema: z.unknown(),
    importer: async () => async (input: unknown) => op(input),
  });
  const entries = new Map<string, OpRegistryEntry>([
    [
      'sweep.planSweep',
      entry('sweep.planSweep', () => ({ status: 'ok', value: options.inPlanReport ?? report })),
    ],
    [
      'sweep.unit',
      entry('sweep.unit', (input) => {
        const dispatched = input as SweepUnitDispatchInput;
        unitInputs.push(dispatched);
        const attempt = (attempts.get(dispatched.package) ?? 0) + 1;
        attempts.set(dispatched.package, attempt);
        const script = scripts[dispatched.package];
        if (script === undefined) throw new Error(`no script for ${dispatched.package}`);
        return script(attempt, dispatched);
      }),
    ],
    [
      'pr.ensureTrackerBranch',
      entry('pr.ensureTrackerBranch', (input) => {
        trackerInputs.push(input);
        return options.trackerResult ?? { status: 'ok', value: { created: true } };
      }),
    ],
    [
      'pr.assemblePrs',
      entry('pr.assemblePrs', (input) => {
        assembleInputs.push(input as AssemblePrsInput);
        return { status: 'ok', value: { packages: [] } };
      }),
    ],
  ]);
  const registry: OpRegistryView = {
    get: (name) => entries.get(name) as OpRegistryEntry<never, never> | undefined,
  };
  return {
    opts: {
      config,
      journalDir: await journalDir(),
      driver: { binary: ['fake-agent'], provider: 'fake', model: 'fake', sessionsDir: '/sessions' },
      check: { adapter: 'tsc-lines', command: 'node', args: ['check.js', '{package}'] },
      runStateDir: options.runStateDir === undefined ? '/run-state' : options.runStateDir,
      ...options.opts,
    },
    deps: {
      planner: async () => ({ status: 'ok', value: report }),
      registry,
      runPlan: async (plan, runOpts, view) => {
        dispatched.push(plan);
        return runPlan(plan, runOpts, view);
      },
      readMarkers: async (repoRoot, worktreesDir, runPrefix, runStateDir) => {
        markerReads.push({ repoRoot, worktreesDir, runPrefix, runStateDir });
        return options.markers ?? [];
      },
    },
    unitInputs,
    trackerInputs,
    assembleInputs,
    markerReads,
    dispatched,
  };
}

const markerOf = (unit: WorkUnit, slug = unit.package): CommittedMarker => ({
  package: unit.package,
  fixer: unit.fixer,
  branch: `cq/run/${unit.fixer}/${slug}`,
});

/** Every job id started in one journaled run of the sweep plan id (-1 = latest). */
async function startedJobs(dir: string, runIndex: number): Promise<string[]> {
  const events = await runEventsAt(dir, SWEEP_PLAN_ID, runIndex);
  return events.flatMap((event) => (event.type === 'job-started' ? [event.jobId] : []));
}

const rowOf = (run: RunReport, jobId: string) => run.jobs.find((row) => row.jobId === jobId);

// ---------------------------------------------------------------------------
// The fleet gate, the marker filter, and the assemble recomposition
// ---------------------------------------------------------------------------

describe('runSweep: fleet gate and marker-filtered assembly', () => {
  test('a clean fleet assembles ONLY the committed units: tracker leg first, then the filtered assembler', async () => {
    const world = await worldFor(
      [ALPHA, BETA],
      { alpha: () => OK, beta: () => OK },
      {
        markers: [markerOf(ALPHA)],
      },
    );
    const outcome = await runSweep(world.opts, world.deps);

    expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0, queued: 0 });
    // The declared tracker/assemble legs are REMOVED from the units plan.
    expect(outcome.plan.jobs.map((job) => job.id)).toEqual([
      'sweep-plan',
      'sweep-alpha-fix',
      'sweep-beta-fix',
    ]);
    expect(outcome.rescueRuns).toBeUndefined();
    expect(outcome.assembleRun).toBeDefined();
    // Beta no-oped (no marker): the assembler covers alpha only — a no-change
    // unit never yields an empty-diff PR.
    expect(world.assembleInputs).toHaveLength(1);
    expect(world.assembleInputs[0]?.packages.map((pkg) => pkg.name)).toEqual(['alpha']);
    // The tracker leg carries the declared template's input verbatim.
    expect(world.trackerInputs).toEqual([
      { repoRoot: '/repo', runPrefix: 'cq/run', base: 'main', branch: 'cq/run/tracker' },
    ]);
    // Journal: run 0 = units, run 1 = tracker branch THEN the assembler
    // (dependsOn: the tracker head exists before the assembler opens a PR).
    expect(await openRunLog(world.opts.journalDir).runs()).toHaveLength(2);
    expect(await startedJobs(world.opts.journalDir, 1)).toEqual([
      'sweep-tracker-branch',
      'sweep-assemble',
    ]);
    const assembleRow = rowOf(outcome.assembleRun as RunReport, 'sweep-assemble');
    expect(assembleRow?.result.status).toBe('ok');
    // The failures-only default output names no package on a clean run.
    expect(outcome.output).not.toMatch(/alpha|beta/);
    expect(outcome.output).toContain('0 failing unit(s) of 2');
  });

  test('an all-no-op fleet (no markers) dispatches NO tracker branch and NO assembler', async () => {
    const world = await worldFor([ALPHA, BETA], { alpha: () => OK, beta: () => OK });
    const outcome = await runSweep(world.opts, world.deps);
    expect(world.markerReads).toHaveLength(1);
    expect(outcome.assembleRun).toBeUndefined();
    expect(world.trackerInputs).toHaveLength(0);
    expect(world.assembleInputs).toHaveLength(0);
    expect(await openRunLog(world.opts.journalDir).runs()).toHaveLength(1);
    expect(outcome.output).toContain('0 failing unit(s) of 2');
  });

  test('a still-failed unit withholds the WHOLE fleet even when a sibling committed', async () => {
    const world = await worldFor(
      [ALPHA, BETA],
      {
        alpha: () => OK,
        beta: () => fail("[INFRA] sweep.unit beta: the fixer worker stopped with reason 'error'"),
      },
      { markers: [markerOf(ALPHA)] },
    );
    const outcome = await runSweep(world.opts, world.deps);
    // The default budget (1) re-dispatched beta once; it failed again.
    expect(outcome.rescueRuns?.map((run) => run.jobs[0]?.jobId)).toEqual(['sweep-beta-fix-r2']);
    expect(outcome.assembleRun).toBeUndefined();
    expect(world.markerReads).toHaveLength(0); // the gate precedes the marker read
    expect(world.trackerInputs).toHaveLength(0);
    expect(world.assembleInputs).toHaveLength(0);
    // The failures-only output names the failed unit and its reason.
    expect(outcome.output).toContain(
      "FAIL beta/fix: [INFRA] sweep.unit beta: the fixer worker stopped with reason 'error'",
    );
    expect(outcome.output).toContain('1 failing unit(s) of 2');
    expect(outcome.output).not.toContain('alpha');
  });

  test('the marker filter matches branch AND package name; scoped packages match their normalized branch', async () => {
    const GAMMA: WorkUnit = { package: '@scope/gamma', fixer: 'fix', files: [] };
    const world = await worldFor(
      [ALPHA, BETA, GAMMA],
      { alpha: () => OK, beta: () => OK, '@scope/gamma': () => OK },
      {
        markers: [
          // Right branch, WRONG package: never assembles alpha.
          { package: 'not-alpha', fixer: 'fix', branch: 'cq/run/fix/alpha' },
          // Right package, WRONG branch: never assembles beta.
          { package: 'beta', fixer: 'fix', branch: 'cq/run/fix/beta-elsewhere' },
          // The scoped unit's marker rides the normalized slug (jTPa1).
          markerOf(GAMMA, 'scope-gamma'),
        ],
      },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.assembleRun).toBeDefined();
    expect(world.assembleInputs[0]?.packages).toEqual([
      expect.objectContaining({ name: '@scope/gamma', branch: 'cq/run/fix/scope-gamma' }),
    ]);
  });

  test('a failed tracker-branch leg blocks the assembler: no PR without the tracker head', async () => {
    const world = await worldFor(
      [ALPHA],
      { alpha: () => OK },
      {
        markers: [markerOf(ALPHA)],
        trackerResult: fail('the tracker branch push was rejected'),
      },
    );
    const outcome = await runSweep(world.opts, world.deps);
    const assembleRun = outcome.assembleRun as RunReport;
    expect(rowOf(assembleRun, 'sweep-tracker-branch')?.result.status).toBe('failed');
    const assembleRow = rowOf(assembleRun, 'sweep-assemble');
    expect(assembleRow?.result.status).toBe('failed');
    if (assembleRow?.result.status === 'failed') {
      expect(assembleRow.result.error).toMatch(/^blocked: /);
    }
    expect(assembleRun.counts).toMatchObject({ failed: 1, blocked: 1 });
    expect(world.assembleInputs).toHaveLength(0);
  });

  test('an empty planner report runs no units and dispatches no assemble', async () => {
    const world = await worldFor([], {});
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.planner.units).toEqual([]);
    expect(world.unitInputs).toHaveLength(0);
    expect(world.markerReads).toHaveLength(0);
    expect(outcome.assembleRun).toBeUndefined();
    expect(outcome.output).toContain('0 failing unit(s) of 0');
  });
});

// ---------------------------------------------------------------------------
// The rescue lane (arm-a §4.2 step 5; I8)
// ---------------------------------------------------------------------------

describe('runSweep: the rescue lane', () => {
  test('a retryable fault is rescued: the -r2 attempt lands ok, the unit counts as succeeded, the fleet assembles', async () => {
    const world = await worldFor(
      [ALPHA, BETA],
      {
        alpha: (attempt) =>
          attempt === 1
            ? fail("[INFRA] sweep.unit alpha: the fixer worker stopped with reason 'error'")
            : { status: 'ok', value: { committed: true } },
        beta: () => OK,
      },
      { config: { rescue: { maxRedispatch: 1 } }, markers: [markerOf(ALPHA)] },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(rowOf(outcome.run, 'sweep-alpha-fix')?.result.status).toBe('failed');
    expect(outcome.rescueRuns).toHaveLength(1);
    const rescue = outcome.rescueRuns?.[0];
    expect(rescue?.jobs.map((row) => [row.jobId, row.result.status])).toEqual([
      ['sweep-alpha-fix-r2', 'ok'],
    ]);
    // The re-dispatch is the SAME unit job input (no re-planning), rooted
    // alone (its planner dependency dropped).
    expect(world.unitInputs.filter((input) => input.package === 'alpha')).toHaveLength(2);
    expect(world.unitInputs[2]).toEqual(world.unitInputs[0]);
    // Journal: units (0), the rescue (1), the assemble (2) — each its own run.
    expect(await startedJobs(world.opts.journalDir, 1)).toEqual(['sweep-alpha-fix-r2']);
    expect(await startedJobs(world.opts.journalDir, 2)).toEqual([
      'sweep-tracker-branch',
      'sweep-assemble',
    ]);
    expect(world.assembleInputs[0]?.packages.map((pkg) => pkg.name)).toEqual(['alpha']);
    // The failures-only output reports the FIRST run's rows: the rescued
    // unit's original failure stays visible (renderSweepOutput reads `run`).
    expect(outcome.output).toContain('FAIL alpha/fix');
  });

  test('the budget bounds the attempts: maxRedispatch 3 → -r2, -r3, -r4 labelled "attempt N of 4", then withheld', async () => {
    const world = await worldFor(
      [ALPHA],
      { alpha: () => fail('[PROBE] sweep.unit alpha: the probe could not run') },
      { config: { rescue: { maxRedispatch: 3 } }, markers: [markerOf(ALPHA)] },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.rescueRuns?.map((run) => run.jobs[0]?.jobId)).toEqual([
      'sweep-alpha-fix-r2',
      'sweep-alpha-fix-r3',
      'sweep-alpha-fix-r4',
    ]);
    expect(world.unitInputs).toHaveLength(4);
    expect(await openRunLog(world.opts.journalDir).runs()).toHaveLength(4); // units + three rescue runs
    const labels = world.dispatched.slice(1).map((plan) => plan.label);
    expect(labels).toEqual([
      'sweep: rescue re-dispatch (attempt 2 of 4)',
      'sweep: rescue re-dispatch (attempt 3 of 4)',
      'sweep: rescue re-dispatch (attempt 4 of 4)',
    ]);
    expect(outcome.assembleRun).toBeUndefined();
    expect(world.markerReads).toHaveLength(0);
  });

  test('a rescue attempt that fails NON-retryably stops the loop at once (no budget burn on verdicts)', async () => {
    const world = await worldFor(
      [ALPHA],
      {
        alpha: (attempt) =>
          attempt === 1
            ? fail('[REGRESSION] sweep.unit alpha: REGRESSION — novel failure')
            : fail('[TAMPER] sweep.unit alpha: tamper findings'),
      },
      { config: { rescue: { maxRedispatch: 3 } } },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.rescueRuns?.map((run) => run.jobs[0]?.jobId)).toEqual(['sweep-alpha-fix-r2']);
    expect(world.unitInputs).toHaveLength(2);
    expect(outcome.assembleRun).toBeUndefined();
  });

  test.each([
    ['[TAMPER] sweep.unit beta: tamper findings (new-skip-only)'],
    ['[SCOPE] sweep.unit beta: staged path outside the allowlist'],
    ['an untagged failure is class unknown'],
  ])('a non-retryable first failure is never re-dispatched: %s', async (error) => {
    const world = await worldFor(
      [ALPHA, BETA],
      { alpha: () => OK, beta: () => fail(error) },
      { config: { rescue: { maxRedispatch: 1 } }, markers: [markerOf(ALPHA)] },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.rescueRuns).toBeUndefined();
    expect(world.unitInputs).toHaveLength(2);
    // Alpha succeeded and committed, but beta's verdict blocks the fleet gate.
    expect(outcome.assembleRun).toBeUndefined();
    expect(world.trackerInputs).toHaveLength(0);
    expect(world.assembleInputs).toHaveLength(0);
    expect(await openRunLog(world.opts.journalDir).runs()).toHaveLength(1);
  });

  test('maxRedispatch 0 disables the lane: a retryable fault is not re-dispatched and withholds the fleet', async () => {
    const world = await worldFor(
      [ALPHA],
      { alpha: () => fail('[INFRA] sweep.unit alpha: transient') },
      { config: { rescue: { maxRedispatch: 0 } }, markers: [markerOf(ALPHA)] },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.rescueRuns).toBeUndefined();
    expect(world.unitInputs).toHaveLength(1);
    expect(outcome.assembleRun).toBeUndefined();
  });

  test('a non-failed, non-ok unit (needs-human) is not rescued and withholds the fleet', async () => {
    const world = await worldFor(
      [ALPHA],
      { alpha: () => ({ status: 'needs-human', reason: 'a human must look' }) },
      { markers: [markerOf(ALPHA)] },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.rescueRuns).toBeUndefined();
    expect(outcome.assembleRun).toBeUndefined();
    expect(outcome.output).toContain('FAIL alpha/fix: a human must look');
  });
});

// ---------------------------------------------------------------------------
// Dispatch enrichment, prep mode, and the phase-A guards
// ---------------------------------------------------------------------------

describe('runSweep: dispatch enrichment, prep mode, and guards', () => {
  test('every unit job carries the vouched runStateDir, its rendered prompt, and the dispatch knobs', async () => {
    const world = await worldFor(
      [ALPHA, BETA],
      { alpha: () => OK, beta: () => OK },
      {
        runStateDir: '/vouched/run-state',
        opts: {
          promptTemplate: (unit) => `fix ${unit.package}`,
          push: false,
          stagePathAllowlist: { patterns: ['^packages/'] },
        },
        markers: [markerOf(ALPHA)],
      },
    );
    await runSweep(world.opts, world.deps);
    expect(world.unitInputs.map((input) => input.package)).toEqual(['alpha', 'beta']);
    for (const input of world.unitInputs) {
      expect(input.runStateDir).toBe('/vouched/run-state');
      expect(input.promptTemplate).toBe(`fix ${input.package}`);
      expect(input.push).toBe(false);
      expect(input.stagePathAllowlist).toEqual({ patterns: ['^packages/'] });
      expect(input.driver).toEqual(world.opts.driver);
      expect(input.check).toEqual(world.opts.check);
    }
    // The marker read uses the SAME repo, worktrees, prefix and vouched dir
    // the units wrote under.
    expect(world.markerReads).toEqual([
      {
        repoRoot: '/repo',
        worktreesDir: 'worktrees',
        runPrefix: 'cq/run',
        runStateDir: '/vouched/run-state',
      },
    ]);
    // push:false reaches the tracker leg too (a local-only run).
    expect(world.trackerInputs).toEqual([expect.objectContaining({ push: false })]);
  });

  test('runStateDir null OMITS the field (the #174 no-vouch branch) and reads markers from the derived dir', async () => {
    const world = await worldFor([ALPHA], { alpha: () => OK }, { runStateDir: null });
    await runSweep(world.opts, world.deps);
    expect(world.unitInputs).toHaveLength(1);
    expect(Object.hasOwn(world.unitInputs[0] as object, 'runStateDir')).toBe(false);
    // push defaults to true when the caller does not say otherwise.
    expect(world.unitInputs[0]?.push).toBe(true);
    expect(world.markerReads).toEqual([expect.objectContaining({ runStateDir: undefined })]);
  });

  test('with no allowlist overlay, each unit job carries its DEFAULT per-package scope (jZ59w)', async () => {
    const world = await worldFor([ALPHA, BETA], { alpha: () => OK, beta: () => OK });
    const outcome = await runSweep(world.opts, world.deps);
    const scopes = world.unitInputs.map((input) => input.stagePathAllowlist?.patterns);
    expect(scopes[0]).toContain('^packages/alpha/');
    expect(scopes[0]).not.toContain('^packages/beta/');
    expect(scopes[1]).toContain('^packages/beta/');
    // The returned expanded plan is the one dispatched (the salvage-tail source).
    const alphaJob = outcome.plan.jobs.find((job) => job.id === 'sweep-alpha-fix');
    expect(alphaJob?.input).toEqual(world.unitInputs[0]);
  });

  test('prep mode: the units carry mode prep and NOTHING assembles, even with markers present', async () => {
    const world = await worldFor(
      [ALPHA, BETA],
      { alpha: () => OK, beta: () => OK },
      {
        config: { mode: 'prep' },
        markers: [markerOf(ALPHA), markerOf(BETA)],
      },
    );
    const outcome = await runSweep(world.opts, world.deps);
    expect(world.unitInputs.map((input) => input.mode)).toEqual(['prep', 'prep']);
    expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0 });
    expect(world.markerReads).toHaveLength(0);
    expect(outcome.assembleRun).toBeUndefined();
    expect(world.trackerInputs).toHaveLength(0);
  });

  test('a phase-A planner failure throws before anything is dispatched', async () => {
    const world = await worldFor([ALPHA], { alpha: () => OK });
    await expect(
      runSweep(world.opts, {
        ...world.deps,
        planner: async () => ({ status: 'failed', error: 'no manifest' }),
      }),
    ).rejects.toThrow(/the planner failed.*no manifest/);
    expect(world.unitInputs).toHaveLength(0);
    expect(await openRunLog(world.opts.journalDir).runs()).toHaveLength(0);
  });

  test('an in-plan planner that re-derives DIFFERENT units is a stale expansion: loud throw, no rescue, no assemble', async () => {
    const world = await worldFor(
      [ALPHA],
      { alpha: () => fail('[INFRA] transient') },
      {
        inPlanReport: reportFor([ALPHA, BETA]),
        markers: [markerOf(ALPHA)],
      },
    );
    await expect(runSweep(world.opts, world.deps)).rejects.toThrow(
      /re-derived DIFFERENT units than the caller expanded from/,
    );
    expect(world.unitInputs).toHaveLength(1); // the units ran; nothing after the guard did
    expect(world.assembleInputs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The failures-only default output
// ---------------------------------------------------------------------------

describe('renderSweepOutput', () => {
  test('one FAIL line per non-ok unit with its status detail, then the bare count', () => {
    const units = [
      ALPHA,
      BETA,
      { package: 'gamma', fixer: 'fix', files: [] },
      { package: 'delta', fixer: 'fix', files: [] },
      { package: 'eps', fixer: 'fix', files: [] },
    ];
    const report = reportFor(units);
    const results: Array<OpResult<unknown>> = [
      OK,
      fail('boom'),
      { status: 'needs-human', reason: 'look here' },
      { status: 'indeterminate', detail: 'unclear' },
      { status: 'budget-exhausted' },
    ];
    const run = {
      jobs: report.jobs.map((job, index) => ({ jobId: job.id, result: results[index] })),
    } as unknown as RunReport;
    expect(renderSweepOutput(configFor(units), report, run)).toBe(
      [
        'sweep cq/run: 5 unit(s)',
        'FAIL beta/fix: boom',
        'FAIL gamma/fix: look here',
        'FAIL delta/fix: unclear',
        'FAIL eps/fix: budget exhausted',
        'sweep finished: 4 failing unit(s) of 5',
        '',
      ].join('\n'),
    );
  });
});

// ---------------------------------------------------------------------------
// Salvage: the journal tail and the classification over a journaled run
// ---------------------------------------------------------------------------

describe('salvage: the journal tail (salvageEntriesFor) and salvageInterruptedRun', () => {
  const runId = 'sweep--tail--000000';
  const at = (tick: number): string => new Date(1_700_000_000_000 + tick).toISOString();
  const started = (jobId: string, tick: number): JournalEvent => ({
    type: 'job-started',
    runId,
    at: at(tick),
    jobId,
    op: 'sweep.unit',
    attempt: 1,
  });
  const finished = (jobId: string, tick: number, ok: boolean): JournalEvent => ({
    type: 'job-finished',
    runId,
    at: at(tick),
    jobId,
    opId: 'sweep.unit',
    inputsHash: 'h',
    result: ok ? { status: 'ok', value: {} } : { status: 'failed', error: 'boom' },
  });
  const runStarted: JournalEvent = { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID };

  test('lastStep is the LAST journal-order finish, never the plan-order last job', () => {
    const config = configFor([ALPHA, BETA]);
    const planner = reportFor([ALPHA, BETA]);
    // OUT OF PLAN ORDER: beta (failed) finishes BEFORE alpha; alpha then
    // re-finishes ok (a retry). The journal's last word per unit:
    const entries = salvageEntriesFor(config, planner, [
      runStarted,
      started('sweep-alpha-fix', 1),
      started('sweep-beta-fix', 2),
      finished('sweep-beta-fix', 3, false),
      finished('sweep-alpha-fix', 4, false),
      finished('sweep-alpha-fix', 5, true),
    ]);
    const alpha = entries.find((entry) => entry.branch?.endsWith('fix/alpha'));
    const beta = entries.find((entry) => entry.branch?.endsWith('fix/beta'));
    expect(alpha?.journal).toEqual({ lastStep: 'sweep-alpha-fix', allTerminal: true });
    // beta: failed terminal — pending work, never clean-done.
    expect(beta?.journal).toEqual({ lastStep: 'sweep-beta-fix', allTerminal: false });
    expect(alpha?.path).toBe('/repo/worktrees/fix/alpha');

    // NO terminal event at all (interrupted before any finish): NO lastStep —
    // salvage's absent-evidence branch (I9).
    const unfinished = salvageEntriesFor(config, planner, [
      runStarted,
      started('sweep-alpha-fix', 1),
      started('sweep-beta-fix', 2),
    ]);
    for (const entry of unfinished) {
      expect(entry.journal?.lastStep).toBeUndefined();
      expect(entry.journal?.allTerminal).toBe(false);
    }
  });

  test('a slug-collision fleet salvages BOTH resolved trees via the enriched jobs (jTPa1)', () => {
    const units: WorkUnit[] = [
      { package: '@a/b', fixer: 'fix', files: [] },
      { package: 'a.b', fixer: 'fix', files: [] },
    ];
    const planner: PlanSweepReport = {
      ...reportFor(units),
      jobs: units.map((unit, index) => ({
        id: `sweep-collide-${index}`,
        op: 'sweep.unit',
        input: unit,
        dependsOn: [],
      })),
    };
    // The ENRICHED expanded-plan jobs carry the builder's resolved kind/slug
    // (a-b, a-b-2). WITHOUT them the raw report derives 'a-b' for BOTH.
    const enriched = planner.jobs.map((job, index) => ({
      ...job,
      input: { ...(job.input as WorkUnit), kind: 'fix', slug: index === 0 ? 'a-b' : 'a-b-2' },
    }));
    const events = [
      runStarted,
      finished('sweep-collide-0', 1, true),
      finished('sweep-collide-1', 2, false),
    ];
    const entries = salvageEntriesFor(configFor(units), planner, events, enriched);
    expect(entries.map((entry) => entry.path)).toEqual([
      '/repo/worktrees/fix/a-b',
      '/repo/worktrees/fix/a-b-2',
    ]);
    expect(entries.map((entry) => entry.journal?.allTerminal)).toEqual([true, false]);
    // Without the enriched jobs the collision mis-derives one tree twice.
    const derived = salvageEntriesFor(configFor(units), planner, events);
    expect(new Set(derived.map((entry) => entry.path)).size).toBe(1);
  });

  test('a multi-fixer fleet yields ONE salvage entry per UNIT tree (per kind/slug)', () => {
    const units: WorkUnit[] = [
      { package: 'alpha', fixer: 'fix', files: [] },
      { package: 'alpha', fixer: 'test-fix', files: [] },
    ];
    const entries = salvageEntriesFor(configFor(units), reportFor(units), [
      runStarted,
      finished('sweep-alpha-fix', 1, false),
      finished('sweep-alpha-test-fix', 2, true),
    ]);
    expect(entries).toHaveLength(2);
    expect(entries.find((entry) => entry.branch === 'cq/run/fix/alpha')).toMatchObject({
      path: '/repo/worktrees/fix/alpha',
      journal: { lastStep: 'sweep-alpha-fix', allTerminal: false },
    });
    expect(entries.find((entry) => entry.branch === 'cq/run/test-fix/alpha')).toMatchObject({
      path: '/repo/worktrees/test-fix/alpha',
      journal: { lastStep: 'sweep-alpha-test-fix', allTerminal: true },
    });
  });

  test('salvageInterruptedRun classifies the UNITS run (index 0) past later rescue runs: reuse / resume / preserve', async () => {
    const GAMMA: WorkUnit = { package: 'gamma', fixer: 'fix', files: [] };
    const world = await worldFor([ALPHA, BETA, GAMMA], {
      alpha: () => OK,
      beta: () => fail('[INFRA] sweep.unit beta: interrupted'),
      gamma: () => fail('[TAMPER] sweep.unit gamma: tamper findings'),
    });
    const outcome = await runSweep(world.opts, world.deps);
    expect(outcome.rescueRuns).toHaveLength(1); // beta's rescue is the LATEST run
    const dirty = new Set(['/repo/worktrees/fix/gamma']);
    const effects: SalvageEffects = {
      pathExists: async () => true,
      isStrictClean: async (path) => !dirty.has(path),
      canonicalize: async (path) => path,
    };
    const salvaged = await salvageInterruptedRun(
      {
        journalDir: world.opts.journalDir,
        planId: SWEEP_PLAN_ID,
        config: world.opts.config,
        planner: outcome.planner,
        enrichedJobs: outcome.plan.jobs,
        runIndex: 0,
      },
      { salvageEffects: effects },
    );
    expect(salvaged.rows.map((row) => [row.branch, row.class])).toEqual([
      ['cq/run/fix/alpha', 'reuse'],
      ['cq/run/fix/beta', 'resume'],
      ['cq/run/fix/gamma', 'preserve'],
    ]);
    expect(salvaged.counts).toMatchObject({ reuse: 1, resume: 1, preserve: 1 });
    // The default index scans the LATEST run (the rescue): no unit job of
    // the units plan finished there, so no tree is proven done.
    const latest = await salvageInterruptedRun(
      {
        journalDir: world.opts.journalDir,
        planId: SWEEP_PLAN_ID,
        config: world.opts.config,
        planner: outcome.planner,
        enrichedJobs: outcome.plan.jobs,
      },
      { salvageEffects: effects },
    );
    expect(latest.rows.map((row) => row.class)).toEqual(['resume', 'resume', 'preserve']);
  });

  test('runEventsAt refuses a journal dir with no run of the plan id', async () => {
    await expect(runEventsAt(await journalDir(), SWEEP_PLAN_ID, -1)).rejects.toThrow(
      /no journaled run of plan 'sweep'/,
    );
  });
});
