// D4 end-to-end — the shipped sweep composition on a scratch fixture repo
// (goal D4; ws-d item 5; arm-a §4.2 loop steps 1–7), narrowed to the five
// REAL-EFFECT contracts. Every composition decision (rescue budget and
// attempts, the fleet gate, the marker filter, all-no-op, prep, the #174
// vouch wiring, salvage tails) is pinned in-process in
// test/plans/sweep-run.test.ts, and every unit-op decision (regression,
// scope, self-commit, the strand-retry refusals, scoped branches, prep
// evidence) in test/ops/sweep/unit-scenarios.test.ts. What stays here is
// what only real git + the real subprocess driver can prove:
//
//   1. THE HAPPY FLEET at concurrency 2: probes → fix → gates → commit →
//      push → marker → tracker-first PRs, with dispatch OVERLAP observed in
//      journal order (not merely both completing).
//   2. INTERRUPT → SALVAGE → RE-INVOKE: a real driver fault, its real
//      rescue re-dispatch, salvage over the real trees (reuse/resume), and
//      the re-invoke's worktree reuse + fresh re-probe (I7).
//   3. STRANDED PUSH → LATER PUBLISH: a push fault strands a verified local
//      commit; the next run's strand-retry publishes it to the real origin.
//   4. TAMPER ON AN ADDED FILE: the unit stages before it scans, so a NEW
//      hacked file is flagged; the real salvage preserves the dirty tree.
//   5. RENAME SOURCE SCOPE: git's `diff --cached --name-status -z` rename
//      framing exposes the production SOURCE path to the allowlist.
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { Driver } from '../../../src/driver/types.js';
import { cloneTemplate, createGitTemplate, type GitTemplate } from '../../helpers/git-template.js';
import {
  ALPHA_FAILURE_MESSAGE,
  ALPHA_FIX,
  BETA_PACKAGE_JSON,
  generateScratchRepo,
  SCRATCH_PACKAGE_FILES,
  SCRATCH_PACKAGES,
} from '../../fixtures/scratch-repo/generate.js';
import { DEFAULT_TEST_FILE_PATTERNS } from '../../../src/ops/gates/hackDetector.js';
import { openRunLog } from '../../../src/kernel/journal.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import {
  SWEEP_RUN_STATE_BASELINE_DIR,
  makeSweepUnitOp,
  type SweepUnitReport,
} from '../../../src/ops/sweep/unit.js';
import type { SweepUnitDriverConfig } from '../../../src/ops/sweep/unit.js';
import { makeSubprocessWorktreeEffects } from '../../../src/ops/sweep/worktreeFor.js';
import { makeSalvage, makeSubprocessSalvageEffects } from '../../../src/ops/sweep/salvage.js';
import { subprocessRunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeGhRunner } from '../../../src/ops/review/gh.js';
import type {
  AssemblePrsPackageReport,
  AssemblePrsReport,
} from '../../../src/ops/pr/assemblePrs.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { JournalEvent, RunReport } from '../../../src/kernel/types.js';
import {
  makeFakeGh,
  runEventsAt,
  runSweepPlan,
  salvageInterruptedRun,
  type RunSweepOpts,
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
let gitTemplate: GitTemplate;
beforeAll(
  async () => {
    gitTemplate = await createGitTemplate(generateScratchRepo);
    CLEANUP.push(gitTemplate.root);
  },
  // Structural process-lifecycle setup: the template seeds one repository and
  // bare origin through bounded git calls before any test can start. The
  // 30s budget is headroom for host load, not a deadline for any assertion.
  30_000,
);
afterAll(() => {
  for (const dir of CLEANUP) rmSync(dir, { recursive: true, force: true });
});

interface Scenario {
  root: string;
  repo: string;
  /** The scratch repo's LOCAL BARE origin — the push leg's recorder (jSKJL). */
  origin: string;
  journalDir: string;
  sessionsDir: string;
  config: SweepPlanConfig;
  gh: ReturnType<typeof makeFakeGh>;
}

/** A fresh scratch repo (with a local bare origin) + dirs; the run prefix names the scenario. */
async function scenario(runPrefix: string): Promise<Scenario> {
  const cloned = await cloneTemplate(gitTemplate);
  const { root, repo, origin } = cloned;
  CLEANUP.push(root);
  return {
    root,
    repo,
    origin,
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
    // The forge-SIMULATING check (review-debt #173): the fake forge refuses
    // to record a PR whose head is not on the real (bare) remote.
    gh: makeFakeGh({
      headExists: async (head) => {
        const heads = await gitOut(['ls-remote', '--heads', 'origin', `refs/heads/${head}`], repo);
        return heads.trim() !== '';
      },
    }),
  };
}

/** Per-unit prompt steering — the scenario's faults ride the instruction line. */
function prompts(alpha: object, beta: object): RunSweepOpts['promptTemplate'] {
  return (unit) =>
    [
      `You are the ${unit.fixer} fixer for package ${unit.package}.`,
      'Apply exactly the edit in the instruction line, then report.',
      `@SWEEP-AGENT ${JSON.stringify(unit.package === 'alpha' ? alpha : beta)}`,
    ].join('\n');
}

/** The dispatch-grade unit-job knobs of every e2e run (JSON, central-registry dispatchable). */
function optsFor(
  scene: Scenario,
  promptTemplate?: RunSweepOpts['promptTemplate'],
  extra?: {
    push?: boolean;
    stagePathAllowlist?: { patterns: string[] };
    runStateDir?: string | null;
    concurrency?: number;
  },
): RunSweepOpts {
  return {
    config: scene.config,
    journalDir: scene.journalDir,
    gh: scene.gh.effects,
    driver: {
      binary: AGENT_CLI,
      provider: 'cq-d4-e2e',
      model: 'sweep-fake',
      sessionsDir: scene.sessionsDir,
      routingTable: {
        endpoints: {
          'cq-d4-e2e': {
            baseUrlEnv: 'CQ_D4_E2E_URL',
            baseUrlDefault: 'http://127.0.0.1:9',
            keyEnv: 'CQ_D4_E2E_KEY',
            models: ['sweep-fake'],
            notes: 'D4 e2e fake endpoint — the agent fixture is the model; nothing is contacted',
          },
        },
      },
    } satisfies SweepUnitDriverConfig,
    check: {
      adapter: 'tsc-lines',
      command: process.execPath,
      args: ['scripts/check.js', '{package}'],
      timeoutMs: 30_000,
    },
    ...(promptTemplate !== undefined ? { promptTemplate } : {}),
    ...extra,
  };
}

/** A focused real-git unit run: real worktree/probe/diff/commit effects, one injected driver. */
function focusedUnitBindings(scene: Scenario, driver: Driver) {
  return {
    repoRoot: scene.repo,
    worktreesDir: 'worktrees',
    runPrefix: 'cq/e2e-focused',
    base: 'main',
    adapter: 'tsc-lines' as const,
    runCheck: subprocessRunCheck,
    checkCommand: (unit: WorkUnit, cwd: string) => ({
      command: process.execPath,
      args: ['scripts/check.js', unit.package],
      cwd,
      timeoutMs: 30_000,
    }),
    driver,
    modelSpec: { model: 'sweep-fake', provider: 'cq-d4-e2e' },
    sessionsDir: scene.sessionsDir,
    prompt: () => 'focused real-git contract',
    git: makeGhRunner({ bin: 'git', timeoutMs: 30_000 }),
  };
}

/** The unit job's report row (by package + fixer), unwrapped as SweepUnitReport. */
function unitRow(
  run: RunReport,
  pkg: string,
  fixer: string = 'fix',
): { status: string; report?: SweepUnitReport; error?: string } {
  // The planner's own job-id fold (sanitizedIdPart): runs of characters
  // outside [A-Za-z0-9._-] become ONE '-' — '@scope/gamma' lands as
  // '-scope-gamma', so the id carries a double dash.
  const folded = pkg.replace(/[^A-Za-z0-9._-]+/g, '-');
  const id = `sweep-${folded}-${fixer}`;
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

/** Journal assertions for ONE journaled run (by index; -1 = latest). */
async function expectCompleteJournal(
  journalDir: string,
  expectedJobs: Array<[string, string]>,
  runIndex: number = -1,
) {
  const events = await runEventsAt(journalDir, SWEEP_PLAN_ID, runIndex);
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
    // Per-job order: this job's start precedes its own finish.
    expect(
      events.findIndex((e) => e.type === 'job-started' && e.jobId === jobId),
      `job-started precedes job-finished for ${jobId}`,
    ).toBeLessThan(events.findIndex((e) => e.type === 'job-finished' && e.jobId === jobId));
  }
}

/**
 * The unit jobs were in flight together (not merely both completed): every
 * start precedes the first finish in JOURNAL ORDER. The run log serializes
 * appends in call order, so line order is event order — no clock involved.
 * A serial dispatch (start, finish, start, ...) fails this.
 */
async function expectUnitOverlap(journalDir: string, runIndex: number, jobIds: string[]) {
  const events = await runEventsAt(journalDir, SWEEP_PLAN_ID, runIndex);
  const indexOf = (type: 'job-started' | 'job-finished', jobId: string): number =>
    events.findIndex((event) => event.type === type && event.jobId === jobId);
  const starts = jobIds.map((jobId) => indexOf('job-started', jobId));
  const finishes = jobIds.map((jobId) => indexOf('job-finished', jobId));
  expect(starts.every((index) => index >= 0)).toBe(true);
  expect(finishes.every((index) => index >= 0)).toBe(true);
  expect(Math.max(...starts)).toBeLessThan(Math.min(...finishes));
}

/** The fleet assertion: tracker-first order, tracker + the given packages' PRs, manifest updated in place. */
function expectTrackerFirstFleet(
  scene: Scenario,
  runPrefix: string,
  expectedBranches: string[],
  pkgRows: Array<AssemblePrsPackageReport>,
) {
  const calls = scene.gh.calls;
  const trackerBranch = `${runPrefix}/tracker`;
  expect(calls[0]).toBe(`searchPrByHead ${trackerBranch} -> main`);
  expect(calls[1]).toBe(`createPr ${trackerBranch} -> main`);
  for (const [index, branch] of expectedBranches.entries()) {
    expect(calls[2 + index * 2]).toBe(`searchPrByHead ${branch} -> main`);
    expect(calls[3 + index * 2]).toBe(`createPr ${branch} -> main`);
  }
  // The tracker (#1) before every package PR; numbers allocate in order.
  expect(scene.gh.created).toHaveLength(expectedBranches.length + 1);
  expect(scene.gh.created.map((pr) => pr.number)).toEqual(
    Array.from({ length: pkgRows.length + 1 }, (_, index) => index + 1),
  );
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
      const outcome = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, {}), { concurrency: 2 }),
      );

      // Phase A: both packages selected, one unit each.
      expect(outcome.planner.units).toEqual([
        { package: 'alpha', fixer: 'fix', files: SCRATCH_PACKAGE_FILES['alpha'] },
        { package: 'beta', fixer: 'fix', files: SCRATCH_PACKAGE_FILES['beta'] },
      ]);

      // Phase B: every unit job done — plan + two units (the assemble leg is
      // the marker-filtered second dispatch, jTPa8).
      expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0, queued: 0 });

      // Alpha: failing baseline → fixed → clean final → no-regression → committed.
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('ok');
      const alphaReport = alpha.report;
      expect(alphaReport?.baseline.verdict).toBe('failing');
      expect(alphaReport?.baseline.failureSet?.failures[0]?.message).toBe(ALPHA_FAILURE_MESSAGE);
      expect(alphaReport?.final?.verdict).toBe('clean');
      expect(alphaReport?.regression?.verdict).toBe('no-regression');
      expect(alphaReport?.regression?.fixedFailures).toHaveLength(1);
      expect(alphaReport?.worktree.reused).toBe(false);
      expect(alphaReport?.tamperFindings).toEqual([]);
      expect(alphaReport?.committed).toBe(true);
      expect(alphaReport?.committedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(alphaReport?.pushed).toBe(true);
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

      // The fleet: tracker-first, manifest updated in place — and composed
      // from the COMMITTED MARKERS (jTPa8): beta no-oped (nothing to fix →
      // uncommitted → no marker), so the assemble covers ALPHA ONLY; a
      // no-change unit never assembles an empty-diff PR.
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expectTrackerFirstFleet(
        scene,
        'cq/e2e-happy',
        ['cq/e2e-happy/fix/alpha'],
        assembled.packages,
      );

      // The journal shows every step: run 0 = units, run 1 = the marker-
      // filtered assemble dispatch.
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-plan', 'sweep.planSweep'],
          ['sweep-alpha-fix', 'sweep.unit'],
          ['sweep-beta-fix', 'sweep.unit'],
        ],
        0,
      );
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-tracker-branch', 'pr.ensureTrackerBranch'],
          ['sweep-assemble', 'pr.assemblePrs'],
        ],
        1,
      );
      await expectUnitOverlap(scene.journalDir, 0, ['sweep-alpha-fix', 'sweep-beta-fix']);

      // The failures-only DEFAULT output: a clean run names no package.
      expect(outcome.output).not.toMatch(/alpha|beta/);
      expect(outcome.output).toContain('0 failing unit(s) of 2');

      // The push leg (jSKJL): the committed unit's branch reached the origin
      // BEFORE the fleet assembled; the no-commit unit pushed nothing (a PR
      // head without a commit would be a fabricated deliverable).
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-happy/fix/alpha');
      expect(originHeads).not.toContain('cq/e2e-happy/fix/beta');
      // The tracker branch is pushed before assembly, and every recorded PR
      // head exists on the real bare origin.
      expect(originHeads).toContain('cq/e2e-happy/tracker');
      expect(scene.gh.created.map((pr) => pr.head)).toEqual([
        'cq/e2e-happy/tracker',
        'cq/e2e-happy/fix/alpha',
      ]);
      for (const pr of scene.gh.created) {
        expect(originHeads, `PR head '${pr.head}' must exist on the remote`).toContain(pr.head);
      }
      const assembleEvents = await runEventsAt(scene.journalDir, SWEEP_PLAN_ID, 1);
      const trackerFinished = assembleEvents.findIndex(
        (event) => event.type === 'job-finished' && event.jobId === 'sweep-tracker-branch',
      );
      const assembleStarted = assembleEvents.findIndex(
        (event) => event.type === 'job-started' && event.jobId === 'sweep-assemble',
      );
      expect(trackerFinished).toBeGreaterThan(-1);
      expect(assembleStarted).toBeGreaterThan(trackerFinished);
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
      // The I7 re-probe observable: the run-state baseline snapshot is
      // rewritten exactly once per unit run (right after the baseline probe),
      // so a re-run's fresh mtime is the re-probe's evidence.
      const alphaSnapshot = join(
        join(scene.repo, 'cq-run-state'),
        SWEEP_RUN_STATE_BASELINE_DIR,
        'fix',
        'alpha.json',
      );

      // Run 1: alpha completes (fix committed + pushed); the fake agent
      // faults on beta (exit 1, no edit) — the mid-run interrupt.
      const first = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, { fault: 'simulated crash on beta' })),
      );
      const beta = unitRow(first.run, 'beta');
      expect(beta.status).toBe('failed');
      // A real driver fault carries the RETRYABLE [INFRA] class, so the
      // rescue lane re-dispatched it through the central registry — and the
      // persisting fault failed the -r2 attempt too.
      expect(beta.error).toMatch(
        /^\[INFRA\] sweep\.unit beta: the fixer worker stopped with reason 'error'/,
      );
      expect(first.rescueRuns?.map((run) => run.jobs[0]?.jobId)).toEqual(['sweep-beta-fix-r2']);
      expect(first.rescueRuns?.[0]?.jobs[0]?.result.status).toBe('failed');
      // The fleet gate: one failed unit withholds the assemble dispatch.
      expect(first.assembleRun).toBeUndefined();
      expect(scene.gh.created).toHaveLength(0); // no PR without its full fleet
      // The push leg (jSKJL): alpha's committed branch is on the origin;
      // beta's is not (it never committed, so it never pushed).
      const originHeadsAfterRun1 = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeadsAfterRun1).toContain('cq/e2e-interrupt/fix/alpha');
      expect(originHeadsAfterRun1).not.toContain('cq/e2e-interrupt/fix/beta');

      // SALVAGE over run 1's journal tail: alpha clean+done → reuse;
      // beta clean but NOT done → resume. Both trees exist.
      const salvaged = await salvageInterruptedRun({
        journalDir: scene.journalDir,
        planId: SWEEP_PLAN_ID,
        config: scene.config,
        planner: first.planner,
        enrichedJobs: first.plan.jobs,
        runIndex: 0,
      });
      const alphaRow = salvaged.rows.find((row) => row.path.endsWith('fix/alpha'));
      const betaSalvageRow = salvaged.rows.find((row) => row.path.endsWith('fix/beta'));
      expect(alphaRow?.class).toBe('reuse');
      expect(betaSalvageRow?.class).toBe('resume');
      expect(salvaged.counts).toMatchObject({ reuse: 1, resume: 1, preserve: 0 });

      // RE-INVOKE (same plan id, same journalDir — a second run file; the
      // sweep-layer resume is salvage + reuse, not journal replay, so the
      // unit jobs re-execute and the reused trees must RE-PROBE, I7).
      const snapshotMtimeBefore = statSync(alphaSnapshot).mtimeMs;
      const second = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      // The reused tree RE-PROBED its baseline: the snapshot was rewritten.
      expect(statSync(alphaSnapshot).mtimeMs).toBeGreaterThan(snapshotMtimeBefore);

      // Alpha's unit: REUSED tree — and the reuse is clean WITHOUT any cache
      // eviction, because the tree carries NO baseline state (the snapshot
      // lives in the run-state dir outside the worktree, I7). No second
      // commit either: the fixer no-oped on the already-fixed tree.
      const alphaSecond = unitRow(second.run, 'alpha');
      expect(alphaSecond.status).toBe('ok');
      expect(alphaSecond.report?.worktree.reused).toBe(true);
      expect(alphaSecond.report?.worktree.clearedBaselineCaches).toEqual([]);
      expect(alphaSecond.report?.committed).toBe(false);
      expect(unitRow(second.run, 'beta').report?.worktree.reused).toBe(true);
      // The tree itself: no '.cq' (or any baseline state) inside; the
      // snapshot is in the RUN-PREFIX-NAMESPACED run-state dir (jTPbC),
      // keyed kind/slug.
      expect(existsSync(resolve(scene.repo, 'worktrees', 'fix', 'alpha', '.cq'))).toBe(false);
      expect(
        existsSync(
          join(join(scene.repo, 'cq-run-state'), SWEEP_RUN_STATE_BASELINE_DIR, 'fix', 'alpha.json'),
        ),
      ).toBe(true);

      // The fleet assembles now — from the COMMITTED MARKERS (jTPa8): alpha
      // committed+pushed in run 1 (its marker survives); beta no-oped in run
      // 2 (no commit, no marker) → the assemble covers ALPHA ONLY: a
      // no-change unit never assembles an empty-diff PR.
      expect(second.assembleRun).toBeDefined();
      const assembled = assembleReport(second.assembleRun as RunReport);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expectTrackerFirstFleet(
        scene,
        'cq/e2e-interrupt',
        ['cq/e2e-interrupt/fix/alpha'],
        assembled.packages,
      );

      // Journaled runs: units 1 (0), the beta rescue re-dispatch (1), units
      // 2 (2), the marker-filtered assemble (3) — each complete with a
      // run-finished frame.
      const runIds = await openRunLog(scene.journalDir).runs();
      expect(runIds).toHaveLength(4);
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-plan', 'sweep.planSweep'],
          ['sweep-alpha-fix', 'sweep.unit'],
          ['sweep-beta-fix', 'sweep.unit'],
        ],
        2,
      );
      await expectCompleteJournal(
        scene.journalDir,
        [
          ['sweep-tracker-branch', 'pr.ensureTrackerBranch'],
          ['sweep-assemble', 'pr.assemblePrs'],
        ],
        3,
      );

      // The re-invoke's output is failures-only clean as well.
      expect(second.output).toContain('0 failing unit(s) of 2');
    },
  );
});

// ---------------------------------------------------------------------------
// 3. The tamper guard, on NEW files: stage first, then scan the STAGED diff
// ---------------------------------------------------------------------------

describe('sweep e2e: tamper guard on new files', () => {
  test(
    'a fixer that ADDS a file with an it.skip hack: the staged scan flags it, the unit fails uncommitted',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-tamper');
      const HACKED = {
        file: 'packages/beta/test/added.test.js',
        text: "it.skip('gaming the run', () => {});\n",
      };
      const result = await makeSweepUnitOp(
        focusedUnitBindings(scene, {
          run: async () => {
            writeFileSync(
              resolve(scene.repo, 'worktrees', 'fix', 'beta', HACKED.file),
              HACKED.text,
            );
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            };
          },
        }),
      )({ package: 'beta', fixer: 'fix', files: ['packages/beta/test/suite.test.js'] });
      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        expect(result.error).toMatch(/^\[TAMPER\] sweep\.unit beta: tamper findings/);
        expect(result.error).toMatch(/new-skip-only/);
        expect(result.error).toMatch(/added\.test\.js/);
      }
      const betaPath = resolve(scene.repo, 'worktrees', 'fix', 'beta');
      expect(await makeSubprocessWorktreeEffects(scene.repo).isStrictClean(betaPath)).toBe(false);
      const betaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-focused/fix/beta'],
        scene.repo,
      );
      expect(betaCommits.trim()).toBe('0');
      const staged = await gitOut(['-C', betaPath, 'diff', '--cached', '--name-only'], scene.repo);
      expect(staged).toContain('packages/beta/test/added.test.js');
      const salvage = await makeSalvage(makeSubprocessSalvageEffects())({
        repoRoot: scene.repo,
        entries: [
          { path: betaPath, branch: 'cq/e2e-focused/fix/beta', journal: { allTerminal: false } },
        ],
      });
      expect(salvage.status).toBe('ok');
      if (salvage.status === 'ok') expect(salvage.value.rows[0]?.class).toBe('preserve');
      // The focused real-git run never publishes a branch; the prep/no-op
      // plan contract above separately proves the plan emits no push leg.
      expect((await gitOut(['ls-remote', '--heads', 'origin'], scene.repo)).trim()).toBe('');
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. Rename-side scope (jVgCj)
// ---------------------------------------------------------------------------

describe('sweep e2e: rename-side scope', () => {
  test(
    'a working-tree RENAME production → test shape: the allowlist flags the SOURCE path',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-rename');
      const result = await makeSweepUnitOp({
        ...focusedUnitBindings(scene, {
          run: async () => {
            const worktree = resolve(scene.repo, 'worktrees', 'test-fix', 'beta');
            writeFileSync(
              resolve(worktree, 'packages/beta/test/manifest.test.js'),
              BETA_PACKAGE_JSON,
            );
            rmSync(resolve(worktree, 'packages/beta/package.json'), { force: true });
            return {
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              denials: [],
              stopReason: 'complete',
            };
          },
        }),
        stagePathAllowlist: { patterns: [...DEFAULT_TEST_FILE_PATTERNS] },
      })({ package: 'beta', fixer: 'test-fix', files: ['packages/beta/package.json'] });

      const betaPath = resolve(scene.repo, 'worktrees', 'test-fix', 'beta');
      const nameStatus = (
        await gitOut(['-C', betaPath, 'diff', '--cached', '--name-status', '-z'], scene.repo)
      )
        .split('\0')
        .filter((token) => token !== '');
      const renameIndex = nameStatus.findIndex((token) => token.startsWith('R'));
      expect(renameIndex).toBeGreaterThanOrEqual(0);
      expect(nameStatus.slice(renameIndex, renameIndex + 3)).toEqual([
        expect.stringMatching(/^R/),
        'packages/beta/package.json',
        'packages/beta/test/manifest.test.js',
      ]);

      expect(result.status).toBe('failed');
      if (result.status === 'failed') {
        // The destination alone matches; the real git rename framing must
        // expose the production SOURCE to the allowlist.
        expect(result.error).toMatch(/outside the allowlist/);
        expect(result.error).toContain('packages/beta/package.json');
      }
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Stranded-commit retry
// ---------------------------------------------------------------------------

describe('sweep e2e: stranded commit retry', () => {
  test(
    'a run-1 push fault strands the commit; run 2 retries the push and the marker exists (resume completeness)',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-stranded');
      const oneUnit = {
        ...scene,
        config: {
          ...scene.config,
          packages: [SCRATCH_PACKAGES[0] as { name: string; path: string }],
          packageFiles: { alpha: SCRATCH_PACKAGE_FILES['alpha'] ?? [] },
        },
      };
      // Run 1 with NO origin configured: alpha commits, then the push fails —
      // the unit fails and its verified fix is stranded locally.
      await gitOut(['-C', scene.repo, 'remote', 'remove', 'origin'], scene.repo);
      const first = await runSweepPlan(optsFor(oneUnit, prompts({ edit: ALPHA_FIX }, {})));
      const alphaFirst = unitRow(first.run, 'alpha');
      expect(alphaFirst.status).toBe('failed');
      expect(alphaFirst.error).toMatch(/git push of 'cq\/e2e-stranded\/fix\/alpha' failed/);
      expect(first.assembleRun).toBeUndefined();
      // The commit exists locally with no remote copy: the STRANDED state.
      const stranded = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-stranded/fix/alpha'],
        scene.repo,
      );
      expect(stranded.trim()).toBe('1');

      // Run 2 (origin restored): the fixer no-ops (the fix is already in the
      // tree) — the no-commit leg detects the branch is ahead of base and
      // RE-ATTEMPTS the push; the marker exists and the fleet assembles it.
      await gitOut(['-C', scene.repo, 'remote', 'add', 'origin', scene.origin], scene.repo);
      const second = await runSweepPlan(optsFor(oneUnit, prompts({ edit: ALPHA_FIX }, {})));
      const alphaSecond = unitRow(second.run, 'alpha');
      expect(alphaSecond.status).toBe('ok');
      expect(alphaSecond.report?.committed).toBe(false); // nothing NEW to commit
      expect(alphaSecond.report?.pushed).toBe(true); // ...but the stranded fix shipped
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-stranded/fix/alpha');
      expect(second.assembleRun).toBeDefined();
      const assembled = assembleReport(second.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expect(second.output).toContain('0 failing unit(s) of 1');
    },
  );
});
