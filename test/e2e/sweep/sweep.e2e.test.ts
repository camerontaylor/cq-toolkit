// D4 end-to-end — the shipped sweep plan on a scratch fixture repo (goal D4;
// ws-d item 5; arm-a §4.2 loop steps 1–7; UC §1 rows 3–4). Pinned here:
//
//   1. THE HAPPY PATH: probes → fix → gates → PRs with the REAL subprocess
//      driver (the fake agent CLI fixture is its CLI leg) and REAL git
//      (worktrees, check.js probes, diffs, commits) — the fake gh seam is
//      the only injected forge. Tracker-first PR order, 3 PRs total, the
//      journal shows every step, alpha's seeded failure is fixed and
//      committed, and the failures-only DEFAULT output carries no
//      per-package noise on a clean run.
//   2. INTERRUPT → SALVAGE → RE-INVOKE: the fake agent faults on beta after
//      alpha completed; salvage classifies alpha's clean-done tree `reuse`
//      and beta's half-done tree `resume`; the re-invoke REUSES both trees
//      and RE-PROBES their baselines (I7 — asserted by probe-call counting
//      and the reuse's baseline-cache eviction), then assembles 3 PRs.
//   3. DIRTY TREES ARE PRESERVED: the breaking-edit fault makes beta's fix a
//      REGRESSION — the unit fails uncommitted, the tree stays dirty, and
//      salvage classifies it `preserve` while alpha stays `reuse`.
//   4. EVIDENCE QUALITY: every journaled line parses through the frozen
//      JournalEventSchema (not just a type-field sniff), and the salvage
//      journal tail takes lastStep from the LAST job-finished event in
//      journal order — jobs can finish out of plan order.
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ALPHA_FAILURE_MESSAGE,
  ALPHA_FIX,
  BETA_BREAK,
  BETA_BREAK_MESSAGE,
  generateScratchRepo,
  SCRATCH_PACKAGE_FILES,
  SCRATCH_PACKAGES,
} from '../../fixtures/scratch-repo/generate.js';
import { openRunLog } from '../../../src/kernel/journal.js';
import { JournalEventSchema } from '../../../src/kernel/schema.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import type { SweepPlanConfig, SweepUnitReport } from '../../../src/plans/sweep.js';
import { makeSubprocessWorktreeEffects } from '../../../src/ops/sweep/worktreeFor.js';
import type {
  AssemblePrsPackageReport,
  AssemblePrsReport,
} from '../../../src/ops/pr/assemblePrs.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { JournalEvent, RunReport } from '../../../src/kernel/types.js';
import {
  latestRunEvents,
  makeFakeGh,
  runSweepPlan,
  salvageEntriesFor,
  salvageInterruptedRun,
  type RunSweepOpts,
  type SweepRunOutcome,
} from './run-sweep.js';

// The fake endpoint's key: read by the driver at dispatch time from this
// host env var (name-only routing; the value never leaves this process).
const KEY_ENV = 'CQ_D4_E2E_KEY';
const previousKey = process.env[KEY_ENV];
beforeAll(() => {
  process.env[KEY_ENV] = 'd4-e2e-fake-key';
});
afterAll(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

// ---------------------------------------------------------------------------
// Per-test fixture state
// ---------------------------------------------------------------------------

const AGENT_CLI = [
  process.execPath,
  fileURLToPath(new URL('../../fixtures/scratch-repo/sweep-agent.mjs', import.meta.url)),
];

const CLEANUP: string[] = [];
afterAll(() => {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  repo: string;
  journalDir: string;
  sessionsDir: string;
  config: SweepPlanConfig;
  gh: ReturnType<typeof makeFakeGh>;
}

/** A fresh scratch repo + dirs; the run prefix names the scenario. */
async function scenario(runPrefix: string): Promise<Scenario> {
  const root = mkdtempSync(join(tmpdir(), `d4-e2e-${runPrefix.replaceAll('/', '-')}-`));
  CLEANUP.push(root);
  const repo = join(root, 'repo');
  await generateScratchRepo(repo);
  return {
    repo,
    journalDir: join(root, 'journal'),
    sessionsDir: join(root, 'sessions'),
    config: {
      repoRoot: repo,
      worktreesDir: 'worktrees',
      runPrefix,
      base: 'main',
      packages: SCRATCH_PACKAGES,
      selector: { mode: 'workspace-all' },
      fixers: ['fix'],
      packageFiles: SCRATCH_PACKAGE_FILES,
    },
    gh: makeFakeGh(),
  };
}

/** The probe command: the scratch check script, scoped to the unit's package. */
function checkCommand(unit: WorkUnit, worktreePath: string) {
  return {
    command: process.execPath,
    args: ['scripts/check.js', unit.package],
    cwd: worktreePath,
    timeoutMs: 30_000,
  };
}

/** Per-unit prompt steering — the scenario's faults ride the instruction line. */
function prompts(alpha: object, beta: object): RunSweepOpts['prompt'] {
  return (unit) =>
    [
      `You are the ${unit.fixer} fixer for package ${unit.package}.`,
      'Apply exactly the edit in the instruction line, then report.',
      `@SWEEP-AGENT ${JSON.stringify(unit.package === 'alpha' ? alpha : beta)}`,
    ].join('\n');
}

function optsFor(
  scene: Scenario,
  prompt: RunSweepOpts['prompt'],
  onProbe?: RunSweepOpts['onProbe'],
): RunSweepOpts {
  return {
    config: scene.config,
    journalDir: scene.journalDir,
    sessionsDir: scene.sessionsDir,
    agentCli: AGENT_CLI,
    provider: 'cq-d4-e2e',
    model: 'sweep-fake',
    keyEnv: 'CQ_D4_E2E_KEY',
    baseUrlEnv: 'CQ_D4_E2E_URL',
    prompt,
    checkCommand,
    gh: scene.gh.effects,
    ...(onProbe !== undefined ? { onProbe } : {}),
  };
}

/** The unit job's report row (by package), unwrapped as SweepUnitReport. */
function unitRow(
  run: RunReport,
  pkg: string,
): { status: string; report?: SweepUnitReport; error?: string } {
  const id = `sweep-${pkg}-fix`;
  const row = run.jobs.find((candidate) => candidate.jobId === id);
  if (row === undefined) throw new Error(`no unit row '${id}' in the run report`);
  if (row.result.status === 'ok') {
    return { status: 'ok', report: row.result.value as SweepUnitReport };
  }
  return {
    status: row.result.status,
    ...(row.result.status === 'failed' ? { error: row.result.error } : {}),
  };
}

/** The assemble job's report value. */
function assembleReport(run: RunReport): AssemblePrsReport {
  const row = run.jobs.find((candidate) => candidate.jobId === 'sweep-assemble');
  if (row === undefined || row.result.status !== 'ok') {
    throw new Error('the assemble job did not end ok');
  }
  return row.result.value as AssemblePrsReport;
}

/** Read one file inside a package's worktree (the worktree mirrors the repo layout). */
function readInWorktree(repo: string, pkg: string, repoRelative: string): string {
  return readFileSync(resolve(repo, 'worktrees', 'fix', pkg, repoRelative), 'utf8');
}

/** Bounded real git read for the assertions (the worktreeFor.test.ts idiom). */
function gitOut(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve_, reject) => {
    execFile(
      'git',
      ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args],
      { cwd, timeout: 10_000, killSignal: 'SIGKILL' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve_(stdout);
      },
    );
  });
}

/** Journal assertions shared by the happy path and the re-invoke. */
async function expectCompleteJournal(journalDir: string, expectedJobs: Array<[string, string]>) {
  const events = await latestRunEvents(journalDir, SWEEP_PLAN_ID);
  expect(events.length).toBeGreaterThan(0);
  const first = events[0] as JournalEvent;
  const last = events[events.length - 1] as JournalEvent;
  expect(first.type).toBe('run-started');
  if (first.type !== 'run-started') return;
  expect(first.planId).toBe(SWEEP_PLAN_ID);
  expect(last.type).toBe('run-finished');
  if (last.type === 'run-finished') {
    expect(last.stoppedEarly).toBe(false);
  }
  for (const [jobId, op] of expectedJobs) {
    const started = events.filter((e) => e.type === 'job-started' && e.jobId === jobId);
    expect(started, `job-started for ${jobId}`).toHaveLength(1);
    if (started[0]?.type === 'job-started') {
      expect(started[0].op).toBe(op);
    }
    const finished = events.filter((e) => e.type === 'job-finished' && e.jobId === jobId);
    expect(finished, `job-finished for ${jobId}`).toHaveLength(1);
    if (finished[0]?.type === 'job-finished') {
      expect(finished[0].result.status).toBe('ok');
      expect(finished[0].opId).toBe(op);
    }
  }
  // Started and finished strictly interleave inside the run-started/finished frame.
  const frame = events
    .slice(1, -1)
    .map((e) => (e.type === 'run-started' || e.type === 'run-finished' ? 'run' : e.type));
  for (let index = 0; index < frame.length; index += 1) {
    const kind = frame[index];
    expect(kind === 'job-started' || kind === 'job-finished').toBe(true);
    if (kind === 'job-started') {
      expect(frame[index + 1]).toBe('job-finished');
    }
  }
}

/** The fleet assertion: tracker-first order, 3 PRs, the manifest updated in place. */
function expectTrackerFirstFleet(
  scene: Scenario,
  runPrefix: string,
  pkgRows: Array<AssemblePrsPackageReport>,
) {
  const calls = scene.gh.calls;
  const trackerBranch = `${runPrefix}/tracker`;
  expect(calls[0]).toBe(`searchPrByHead ${trackerBranch} -> main`);
  expect(calls[1]).toBe(`createPr ${trackerBranch} -> main`);
  for (const [index, pkg] of SCRATCH_PACKAGES.entries()) {
    expect(calls[2 + index * 2]).toBe(`searchPrByHead ${runPrefix}/fix/${pkg.name} -> main`);
    expect(calls[3 + index * 2]).toBe(`createPr ${runPrefix}/fix/${pkg.name} -> main`);
  }
  // 3 PRs total: the tracker (#1) before both package PRs (#2, #3).
  expect(scene.gh.created).toHaveLength(3);
  expect(scene.gh.created.map((pr) => pr.number)).toEqual([1, 2, 3]);
  expect(scene.gh.created[0]?.head).toBe(trackerBranch);
  // The tracker's body is the fleet manifest, updated in place with the numbers.
  const trackerBody = scene.gh.bodies.get(1) ?? '';
  for (const row of pkgRows) {
    expect(trackerBody).toContain(`#${String(row.number)}`);
    expect(trackerBody).toContain(row.name);
  }
}

// ---------------------------------------------------------------------------
// 1. The happy path
// ---------------------------------------------------------------------------

describe('sweep e2e: probes → fix → gates → PRs (arm-a §4.2 steps 1–7)', () => {
  test(
    'two seeded packages: alpha fixed + committed, beta untouched, tracker-first fleet, clean journal, failures-only output',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-happy');
      const outcome = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));

      // Phase A: both packages selected, one unit each.
      expect(outcome.planner.units).toEqual([
        { package: 'alpha', fixer: 'fix', files: SCRATCH_PACKAGE_FILES['alpha'] },
        { package: 'beta', fixer: 'fix', files: SCRATCH_PACKAGE_FILES['beta'] },
      ]);

      // Phase B: every job done — plan, two units, assemble.
      expect(outcome.run.counts).toMatchObject({ done: 4, failed: 0, blocked: 0, queued: 0 });

      // Alpha: failing baseline → fixed → clean final → no-regression → committed.
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('ok');
      const alphaReport = alpha.report;
      expect(alphaReport?.baseline.verdict).toBe('failing');
      expect(alphaReport?.baseline.failureSet?.failures[0]?.message).toBe(ALPHA_FAILURE_MESSAGE);
      expect(alphaReport?.final.verdict).toBe('clean');
      expect(alphaReport?.regression.verdict).toBe('no-regression');
      expect(alphaReport?.regression.fixedFailures).toHaveLength(1);
      expect(alphaReport?.worktree.reused).toBe(false);
      expect(alphaReport?.tamperFindings).toEqual([]);
      expect(alphaReport?.committed).toBe(true);
      expect(alphaReport?.prBranch).toBe('cq/e2e-happy/fix/alpha');

      // Alpha's fix landed in the worktree AND in a commit; beta's suite is
      // untouched and its branch carries no commit.
      expect(readInWorktree(scene.repo, 'alpha', 'packages/alpha/test/suite.test.js')).toContain(
        ALPHA_FIX.newText,
      );
      const alphaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-happy/fix/alpha'],
        scene.repo,
      );
      expect(alphaCommits.trim()).toBe('1');
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('ok');
      expect(beta.report?.baseline.verdict).toBe('clean');
      expect(beta.report?.committed).toBe(false);
      const betaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-happy/fix/beta'],
        scene.repo,
      );
      expect(betaCommits.trim()).toBe('0');

      // The fleet: tracker-first, 3 PRs, manifest updated in place.
      const assembled = assembleReport(outcome.run);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      expectTrackerFirstFleet(scene, 'cq/e2e-happy', assembled.packages);

      // The journal shows every step.
      await expectCompleteJournal(scene.journalDir, [
        ['sweep-plan', 'sweep.planSweep'],
        ['sweep-alpha-fix', 'sweep.unit'],
        ['sweep-beta-fix', 'sweep.unit'],
        ['sweep-assemble', 'pr.assemblePrs'],
      ]);

      // The failures-only DEFAULT output: a clean run names no package.
      expect(outcome.output).not.toMatch(/alpha|beta/);
      expect(outcome.output).toContain('0 failing unit(s) of 2');
    },
  );
});

// ---------------------------------------------------------------------------
// 2. Interrupt → salvage → re-invoke (reuse + the I7 re-probe)
// ---------------------------------------------------------------------------

describe('sweep e2e: interrupt mid-run → salvage → re-invoke', () => {
  test(
    'beta faults after alpha completed: salvage says alpha reuse / beta resume; the re-invoke reuses both trees and re-probes both baselines (I7)',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-interrupt');
      const probes = new Map<string, number>();
      const countProbe = (pkg: string): void => {
        probes.set(pkg, (probes.get(pkg) ?? 0) + 1);
      };

      // Run 1: alpha completes (fix committed); the fake agent faults on
      // beta (exit 1, no edit) — the mid-run interrupt.
      const first = await runSweepPlan(
        optsFor(
          scene,
          prompts({ edit: ALPHA_FIX }, { fault: 'simulated crash on beta' }),
          countProbe,
        ),
      );
      expect(probes.get('alpha')).toBe(2); // baseline + final
      const beta = unitRow(first.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/fixer worker stopped with reason 'error'/);
      // The fleet gate: one failed unit blocks the assemble job.
      const assembleRow = first.run.jobs.find((candidate) => candidate.jobId === 'sweep-assemble');
      expect(assembleRow?.result.status).toBe('failed');
      expect(assembleRow?.result.status === 'failed' && assembleRow.result.error).toContain(
        'blocked: dependency',
      );
      expect(scene.gh.created).toHaveLength(0); // no PR without its full fleet

      // SALVAGE over run 1's journal tail: alpha clean+done → reuse;
      // beta clean but NOT done → resume. Both trees exist.
      const salvaged = await salvageInterruptedRun({
        journalDir: scene.journalDir,
        planId: SWEEP_PLAN_ID,
        config: scene.config,
        planner: first.planner,
      });
      const alphaRow = salvaged.rows.find((row) => row.path.endsWith('fix/alpha'));
      const betaSalvageRow = salvaged.rows.find((row) => row.path.endsWith('fix/beta'));
      expect(alphaRow?.class).toBe('reuse');
      expect(betaSalvageRow?.class).toBe('resume');
      expect(salvaged.counts).toMatchObject({ reuse: 1, resume: 1, preserve: 0 });

      // RE-INVOKE (same plan id, same journalDir — a second run file; the
      // sweep-layer resume is salvage + reuse, not journal replay, so the
      // unit jobs re-execute and the reused trees must RE-PROBE, I7).
      probes.clear();
      const second = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, {}), countProbe),
      );
      expect(probes.get('alpha')).toBe(2); // the reused tree re-probed baseline + final
      expect(probes.get('beta')).toBe(2);

      // Alpha's unit: REUSED tree, its baseline cache EVICTED (I7, visible),
      // no second commit (the fixer no-oped on the already-fixed tree).
      const alphaSecond = unitRow(second.run, 'alpha');
      expect(alphaSecond.status).toBe('ok');
      expect(alphaSecond.report?.worktree.reused).toBe(true);
      expect(alphaSecond.report?.worktree.clearedBaselineCaches).toContain('.cq/baseline');
      expect(alphaSecond.report?.committed).toBe(false);
      expect(unitRow(second.run, 'beta').report?.worktree.reused).toBe(true);

      // The fleet assembles now: tracker-first, 3 PRs.
      const assembled = assembleReport(second.run);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      expectTrackerFirstFleet(scene, 'cq/e2e-interrupt', assembled.packages);

      // Two journaled runs, each complete with a run-finished frame.
      const runIds = await openRunLog(scene.journalDir).runs();
      expect(runIds).toHaveLength(2);
      await expectCompleteJournal(scene.journalDir, [
        ['sweep-plan', 'sweep.planSweep'],
        ['sweep-alpha-fix', 'sweep.unit'],
        ['sweep-beta-fix', 'sweep.unit'],
        ['sweep-assemble', 'pr.assemblePrs'],
      ]);

      // The re-invoke's output is failures-only clean as well.
      expect(second.output).toContain('0 failing unit(s) of 2');
    },
  );

  test(
    'a breaking edit makes beta a REGRESSION: the unit fails uncommitted, the tree stays dirty, salvage preserves it',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-dirty');
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, { edit: BETA_BREAK })),
      );

      // Alpha committed its fix; beta's "fix" is a regression — failed.
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('ok');
      expect(alpha.report?.committed).toBe(true);
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/REGRESSION/);
      expect(beta.error).toMatch(/novel failure/);
      // The novel failure is exactly the broken suite's own consistent text.
      expect(beta.error).toContain(BETA_BREAK_MESSAGE);

      // The fix was withheld: beta's tree is DIRTY (the breaking edit is
      // still sitting uncommitted in the worktree).
      const effects = makeSubprocessWorktreeEffects(scene.repo);
      const betaPath = resolve(scene.repo, 'worktrees', 'fix', 'beta');
      expect(await effects.isStrictClean(betaPath)).toBe(false);

      // Salvage: alpha clean-done → reuse; beta dirty → PRESERVE (never
      // auto-cleaned, never silently resumed over uncommitted work).
      const salvaged = await salvageInterruptedRun({
        journalDir: scene.journalDir,
        planId: SWEEP_PLAN_ID,
        config: scene.config,
        planner: outcome.planner,
      });
      expect(salvaged.rows.find((row) => row.path.endsWith('fix/alpha'))?.class).toBe('reuse');
      expect(salvaged.rows.find((row) => row.path.endsWith('fix/beta'))?.class).toBe('preserve');
      expect(salvaged.counts).toMatchObject({ reuse: 1, preserve: 1, resume: 0 });
      // And no PR exists: the fleet never assembled.
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});

// The journal-file shape sanity: one NDJSON file per run, parseable lines.
describe('sweep e2e: journal evidence shape', () => {
  test('every journaled line parses as the frozen event union', { timeout: 120_000 }, async () => {
    const scene = await scenario('cq/e2e-journal');
    await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
    const files = readdirSync(scene.journalDir).filter((name) => name.endsWith('.ndjson'));
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(scene.journalDir, files[0] as string), 'utf8')
      .split('\n')
      .filter((line) => line !== '');
    for (const line of lines) {
      // The SCHEMA validates, not a type-field sniff: a line missing required
      // fields (or carrying an unknown discriminator) is rejected here — the
      // same validation openRunLog.append performs before anything hits disk.
      const parsed = JournalEventSchema.safeParse(JSON.parse(line));
      expect(parsed.success, `line must parse as a journal event: ${line}`).toBe(true);
      if (parsed.success) {
        expect(['run-started', 'job-started', 'job-finished', 'run-finished']).toContain(
          parsed.data.type,
        );
      }
    }
  });

  test('salvage journal tail: lastStep is the LAST journal-order finish, never the plan-order last job', () => {
    const config = sceneLessConfig();
    const planner = twoUnitPlanner();
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
    const finishedOk = (jobId: string, tick: number): JournalEvent => ({
      type: 'job-finished',
      runId,
      at: at(tick),
      jobId,
      opId: 'sweep.unit',
      inputsHash: 'h',
      result: { status: 'ok', value: {} },
    });
    const finishedFailed = (jobId: string, tick: number): JournalEvent => ({
      type: 'job-finished',
      runId,
      at: at(tick),
      jobId,
      opId: 'sweep.unit',
      inputsHash: 'h',
      result: { status: 'failed', error: 'boom' },
    });

    // OUT OF PLAN ORDER: beta (failed) finishes BEFORE alpha; alpha then
    // re-finishes ok (a retry). The journal's last word per package:
    const events: JournalEvent[] = [
      { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
      started('sweep-alpha-fix', 1),
      started('sweep-beta-fix', 2),
      finishedFailed('sweep-beta-fix', 3), // beta terminal FIRST ...
      finishedFailed('sweep-alpha-fix', 4), // ... alpha's first attempt fails ...
      finishedOk('sweep-alpha-fix', 5), // ... and its retry lands LAST
    ];
    const entries = salvageEntriesFor(config, planner, events);
    const alpha = entries.find((entry) => entry.branch?.endsWith('fix/alpha'));
    const beta = entries.find((entry) => entry.branch?.endsWith('fix/beta'));
    // alpha: lastStep is ITS OWN last finish — the old plan-order fallback
    // (`jobIds[jobIds.length - 1]`) would have named beta's job here.
    expect(alpha?.journal?.lastStep).toBe('sweep-alpha-fix');
    expect(alpha?.journal?.allTerminal).toBe(true); // the retry ended ok
    // beta: failed terminal — pending work, never clean-done.
    expect(beta?.journal?.lastStep).toBe('sweep-beta-fix');
    expect(beta?.journal?.allTerminal).toBe(false);

    // NO terminal event at all (interrupted before any finish): the entry
    // carries NO lastStep — salvage's absent-evidence branch (I9).
    const unfinished = salvageEntriesFor(config, planner, [
      { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
      started('sweep-alpha-fix', 1),
      started('sweep-beta-fix', 2),
    ]);
    for (const entry of unfinished) {
      expect(entry.journal?.lastStep).toBeUndefined();
      expect(entry.journal?.allTerminal).toBe(false);
    }
  });
});

/** Minimal config for the tail-derivation tests (only the naming fields are read). */
function sceneLessConfig(): SweepPlanConfig {
  return {
    repoRoot: '/repo',
    worktreesDir: 'worktrees',
    runPrefix: 'cq/tail',
    base: 'main',
    packages: [
      { name: 'alpha', path: 'packages/alpha' },
      { name: 'beta', path: 'packages/beta' },
    ],
    selector: { mode: 'workspace-all' },
    fixers: ['fix'],
  };
}

/** The two-unit planner shape the expanded plan embeds (plan order: alpha, beta). */
function twoUnitPlanner(): SweepRunOutcome['planner'] {
  const units: Array<WorkUnit> = [
    { package: 'alpha', fixer: 'fix', files: [] },
    { package: 'beta', fixer: 'fix', files: [] },
  ];
  return {
    jobs: units.map((unit) => ({
      id: `sweep-${unit.package}-fix`,
      op: 'sweep.unit',
      input: unit,
      dependsOn: [],
    })),
    units,
    suppressed: [],
    needsHuman: [],
  };
}
