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
//      journal order — jobs can finish out of plan order, and a multi-fixer
//      fleet yields ONE salvage entry per unit tree.
//   5. THE TAMPER GUARD, ON NEW FILES: the unit op stages BEFORE it scans,
//      so a fixer that ADDS a hacked file (a skip marker) is flagged by the
//      scan and its unit fails uncommitted.
import { execFile } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  ALPHA_FAILURE_MESSAGE,
  ALPHA_FIX,
  BETA_BREAK,
  BETA_BREAK_MESSAGE,
  BETA_PACKAGE_JSON,
  generateScratchRepo,
  SCRATCH_PACKAGE_FILES,
  SCRATCH_PACKAGES,
} from '../../fixtures/scratch-repo/generate.js';
import { DEFAULT_TEST_FILE_PATTERNS } from '../../../src/ops/gates/hackDetector.js';
import { openRunLog } from '../../../src/kernel/journal.js';
import { JournalEventSchema } from '../../../src/kernel/schema.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import { SWEEP_RUN_STATE_BASELINE_DIR, type SweepUnitReport } from '../../../src/ops/sweep/unit.js';
import type { SweepUnitDispatchInput, SweepUnitDriverConfig } from '../../../src/ops/sweep/unit.js';
import { makeSubprocessWorktreeEffects } from '../../../src/ops/sweep/worktreeFor.js';
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
  const root = mkdtempSync(join(tmpdir(), `d4-e2e-${runPrefix.replaceAll('/', '-')}-`));
  CLEANUP.push(root);
  const repo = join(root, 'repo');
  await generateScratchRepo(repo);
  // The push recorder: a LOCAL BARE origin — the real `git push -u origin`
  // binding works offline against it, and the tests read its refs back as
  // evidence of what was pushed (and what correctly was not).
  const origin = join(root, 'origin.git');
  await gitOut(['init', '-q', '--bare', origin], root);
  await gitOut(['-C', repo, 'remote', 'add', 'origin', origin], root);
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
    proposeOnly?: boolean;
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

/**
 * Strand alpha's verified fix: run 1 with NO origin (the commit lands, the
 * push fails), then restore the origin so a run-2 refusal branch can be
 * exercised (review-debt #174).
 */
async function strandAlpha(scene: Scenario, runPrefix: string): Promise<void> {
  await gitOut(['-C', scene.repo, 'remote', 'remove', 'origin'], scene.repo);
  const first = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
  const alpha = unitRow(first.run, 'alpha');
  expect(alpha.status).toBe('failed');
  expect(alpha.error).toContain(`git push of '${runPrefix}/fix/alpha' failed`);
  await gitOut(['-C', scene.repo, 'remote', 'add', 'origin', scene.origin], scene.repo);
}

/** The unit job's report row (by package + fixer), unwrapped as SweepUnitReport. */
function unitRow(
  run: RunReport,
  pkg: string,
  fixer: string = 'fix',
): { status: string; report?: SweepUnitReport; error?: string; reason?: string } {
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
    ...(row.result.status === 'needs-human' ? { reason: row.result.reason } : {}),
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
      const outcome = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));

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

      // The failures-only DEFAULT output: a clean run names no package.
      expect(outcome.output).not.toMatch(/alpha|beta/);
      expect(outcome.output).toContain('0 failing unit(s) of 2');

      // The push leg (jSKJL): the committed unit's branch reached the origin
      // BEFORE the fleet assembled; the no-commit unit pushed nothing (a PR
      // head without a commit would be a fabricated deliverable).
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-happy/fix/alpha');
      expect(originHeads).not.toContain('cq/e2e-happy/fix/beta');

      // FORGE-SIMULATING HEAD VERIFICATION (review-debt #173): the tracker
      // branch was created + pushed, and EVERY head the fake forge recorded
      // a PR for exists on the real (bare) remote — the fake gh alone cannot
      // see this, which is exactly what the issue deferred.
      expect(originHeads).toContain('cq/e2e-happy/tracker');
      expect(scene.gh.created.map((pr) => pr.head)).toEqual([
        'cq/e2e-happy/tracker',
        'cq/e2e-happy/fix/alpha',
      ]);
      for (const pr of scene.gh.created) {
        expect(originHeads, `PR head '${pr.head}' must exist on the remote`).toContain(pr.head);
      }
      // ORDERING PIN: the tracker-branch leg FINISHED before the assembler
      // STARTED — the head existed on the remote when the tracker-first PR
      // was opened, not merely by the end of the run.
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
// 1b. Tracker branch create/push + re-invoke reuse (review-debt #173)
// ---------------------------------------------------------------------------

describe('sweep e2e: tracker branch create/push + re-invoke reuse (#173)', () => {
  test(
    'a pre-existing remote tracker branch is reused: the fleet still assembles and the remote head is never rewound',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-tracker-reuse');
      // A previous run's tracker branch: an empty commit on base, already on
      // the remote. The re-invoke must tolerate it (and never move it).
      const trackerBranch = 'cq/e2e-tracker-reuse/tracker';
      const baseSha = (await gitOut(['rev-parse', 'main'], scene.repo)).trim();
      const tree = (await gitOut(['rev-parse', `${baseSha}^{tree}`], scene.repo)).trim();
      const prior = (
        await gitOut(
          ['commit-tree', tree, '-p', baseSha, '-m', 'pre-existing tracker branch'],
          scene.repo,
        )
      ).trim();
      await gitOut(['update-ref', `refs/heads/${trackerBranch}`, prior], scene.repo);
      await gitOut(
        ['push', 'origin', `refs/heads/${trackerBranch}:refs/heads/${trackerBranch}`],
        scene.repo,
      );
      const before = (
        await gitOut(['ls-remote', '--heads', 'origin', `refs/heads/${trackerBranch}`], scene.repo)
      ).trim();
      expect(before).toContain(prior);

      const outcome = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.tracker).toMatchObject({ number: 1, created: true });
      // The tracker-branch leg reported the remote reuse (no create, no push).
      const trackerRow = outcome.assembleRun?.jobs.find(
        (candidate) => candidate.jobId === 'sweep-tracker-branch',
      );
      expect(trackerRow?.result.status).toBe('ok');
      if (trackerRow?.result.status === 'ok') {
        expect(trackerRow.result.value).toMatchObject({
          reusedRemote: true,
          created: false,
          pushed: false,
          headSha: prior,
        });
      }
      // The remote head is byte-identical: a reuse never rewinds a live
      // tracker branch to a fresh empty commit.
      const after = (
        await gitOut(['ls-remote', '--heads', 'origin', `refs/heads/${trackerBranch}`], scene.repo)
      ).trim();
      expect(after).toBe(before);
      // And the PR head exists on the remote (forge-simulating verification).
      expect(after).toContain(prior);
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
      expect(beta.error).toMatch(/fixer worker stopped with reason 'error'/);
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
      // The failures-only output names the failing unit on the failure side.
      expect(outcome.output).toContain('FAIL beta/fix:');
      expect(outcome.output).toContain('1 failing unit(s) of 2');

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
        enrichedJobs: outcome.plan.jobs,
        runIndex: 0,
      });
      expect(salvaged.rows.find((row) => row.path.endsWith('fix/alpha'))?.class).toBe('reuse');
      expect(salvaged.rows.find((row) => row.path.endsWith('fix/beta'))?.class).toBe('preserve');
      expect(salvaged.counts).toMatchObject({ reuse: 1, preserve: 1, resume: 0 });
      // And no PR exists: the fleet never assembled.
      expect(scene.gh.created).toHaveLength(0);
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
      // Alpha fixes normally; beta "fixes" by ADDING a skip-marked file.
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, { write: HACKED })),
      );

      // Alpha committed; beta's unit FAILED on the tamper finding.
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('ok');
      expect(alpha.report?.committed).toBe(true);
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/tamper findings/);
      expect(beta.error).toMatch(/new-skip-only/);
      expect(beta.error).toMatch(/added\.test\.js/);

      // The fix was withheld AFTER staging: the hack file sits staged but
      // uncommitted — the branch carries no commit, the tree is dirty.
      expect(
        await makeSubprocessWorktreeEffects(scene.repo).isStrictClean(
          resolve(scene.repo, 'worktrees', 'fix', 'beta'),
        ),
      ).toBe(false);
      const betaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-tamper/fix/beta'],
        scene.repo,
      );
      expect(betaCommits.trim()).toBe('0');
      // The staged diff is exactly where the finding came from.
      const staged = await gitOut(
        ['-C', resolve(scene.repo, 'worktrees', 'fix', 'beta'), 'diff', '--cached', '--name-only'],
        scene.repo,
      );
      expect(staged).toContain('packages/beta/test/added.test.js');
      // No PR exists: the fleet never assembled.
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 4. The test-fix scope, enforced on the staged set (jSKJY)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 3b. The strand-retry trust pin: a driver SELF-COMMIT is never pushed (#174)
// ---------------------------------------------------------------------------

describe('sweep e2e: driver self-commit vs the strand-retry trust pin (#174)', () => {
  test(
    'a driver that COMMITS the fix itself: the stage gates see nothing, and the strand-retry refuses to push the unscanned commit',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-selfcommit');
      // Alpha fixes normally; beta "fixes" by committing the file DIRECTLY —
      // the op's later `git add -A` stages nothing, so the stage-path
      // allowlist, the tamper scan, and the commit step never see those
      // bytes and no scanned-sha record exists for the unit.
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          scene,
          prompts(
            { edit: ALPHA_FIX },
            {
              write: {
                file: 'packages/beta/src/self.ts',
                text: 'export const self = 1;\n',
              },
              selfCommit: { message: 'beta driver self-commit' },
            },
          ),
        ),
      );

      // Alpha: the normal record-and-push flow (control).
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('ok');
      expect(alpha.report?.committed).toBe(true);
      expect(alpha.report?.committedSha).toMatch(/^[0-9a-f]{40}$/);

      // Beta: the PRE-STAGE HEAD pin catches the self-commit FIRST — HEAD
      // moved during the fixer run, the staged-diff scan could never see
      // those bytes, so the unit fails TAMPER with nothing staged,
      // committed, recorded, or pushed (needs-human evidence). The
      // strand-retry's own no-record refusal (#174's 9b guard) sits behind
      // this for the resume shape: a self-commit from an EARLIER run whose
      // record never existed.
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/worktree HEAD moved during the fixer run/);
      expect(beta.error).toMatch(/driver self-commit is not a supported mode/);
      expect(beta.error).toMatch(/needs-human evidence/);

      // Beta's unscanned commit exists LOCALLY but never reached the origin;
      // alpha's branch did (push itself still works — the pin targets the
      // trust, not the transport).
      const localCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-selfcommit/fix/beta'],
        scene.repo,
      );
      expect(localCommits.trim()).toBe('1');
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-selfcommit/fix/alpha');
      expect(originHeads).not.toContain('cq/e2e-selfcommit/fix/beta');
    },
  );
});

describe('sweep e2e: test-fix stage-path allowlist', () => {
  test(
    'a test-fix worker is propose-only: staged test and production edits route to human review',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-scope');
      // The test-fix run: the planner's units carry the test-only fixer, and
      // the staged set is held to the test-file patterns (the plan overlay
      // buildTestFixPlan ships — wired here explicitly).
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          { ...scene, config: { ...scene.config, fixers: ['test-fix'] } },
          prompts(
            { edit: ALPHA_FIX }, // the legitimate test fix
            { write: { file: 'packages/beta/index.js', text: "export const beta = 'prod';\n" } }, // production code
          ),
          {
            stagePathAllowlist: { patterns: [...DEFAULT_TEST_FILE_PATTERNS] },
            proposeOnly: true,
          },
        ),
      );

      // Test-fix is propose-only: even the test edit is staged but never
      // committed, and the production edit is likewise human-routed.
      const alpha = unitRow(outcome.run, 'alpha', 'test-fix');
      expect(alpha.status).toBe('needs-human');
      expect(alpha.reason).toMatch(/propose-only|protected path/);

      const beta = unitRow(outcome.run, 'beta', 'test-fix');
      expect(beta.status).toBe('needs-human');
      expect(beta.reason).toMatch(/propose-only|protected path/);
      expect(beta.reason).toContain('packages/beta/index.js');
      expect(
        await makeSubprocessWorktreeEffects(scene.repo).isStrictClean(
          resolve(scene.repo, 'worktrees', 'test-fix', 'beta'),
        ),
      ).toBe(false);
      const betaCommits = await gitOut(
        ['rev-list', '--count', 'main..cq/e2e-scope/test-fix/beta'],
        scene.repo,
      );
      expect(betaCommits.trim()).toBe('0');
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-scope/test-fix/alpha');
      expect(originHeads).not.toContain('cq/e2e-scope/test-fix/beta');
      // No PR exists: the fleet never assembled.
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 5. Scoped-package slugs (jTPa1) and rename-side scope (jVgCj)
// ---------------------------------------------------------------------------

describe('sweep e2e: scoped packages and rename-side scope', () => {
  test(
    '@scope/gamma derives the slug scope-gamma: the unit runs, commits, and pushes on the normalized branch',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-scoped');
      // Seed ONE scoped package with alpha's failing-suite shape.
      const pkgDir = join(scene.repo, 'packages', '@scope', 'gamma');
      mkdirSync(join(pkgDir, 'test'), { recursive: true });
      writeFileSync(
        join(pkgDir, 'package.json'),
        `${JSON.stringify({ name: '@scope/gamma', version: '1.0.0', private: true }, null, 2)}\n`,
      );
      writeFileSync(
        join(pkgDir, 'test', 'suite.test.js'),
        [
          "'use strict';",
          'const sum = (a, b) => a + b;',
          'if (sum(1, 1) !== 3) {',
          "  throw new Error('expected 3, got ' + sum(1, 1));",
          '}',
          '',
        ].join('\n'),
      );
      await gitOut(['-C', scene.repo, 'add', '-A'], scene.repo);
      await gitOut(['-C', scene.repo, 'commit', '-q', '-m', 'seed: @scope/gamma'], scene.repo);

      const GAMMA_FIX = {
        file: 'packages/@scope/gamma/test/suite.test.js',
        oldText: 'if (sum(1, 1) !== 3) {',
        newText: 'if (sum(1, 1) !== 2) {',
      };
      const config: SweepPlanConfig = {
        ...scene.config,
        packages: [{ name: '@scope/gamma', path: 'packages/@scope/gamma' }],
        packageFiles: { '@scope/gamma': ['packages/@scope/gamma/test/suite.test.js'] },
      };
      const outcome = await runSweepPlan(
        optsFor({ ...scene, config }, (unit) =>
          [
            `You are the ${unit.fixer} fixer for package ${unit.package}.`,
            'Apply exactly the edit in the instruction line, then report.',
            `@SWEEP-AGENT ${JSON.stringify({ edit: GAMMA_FIX })}`,
          ].join('\n'),
        ),
      );

      // The scoped unit RAN (the old fold derived the undeliverable
      // `-scope-gamma`, which SEGMENT_RE refuses): fixed, committed, pushed
      // on the normalized branch.
      const gamma = unitRow(outcome.run, '@scope/gamma');
      expect(gamma.status).toBe('ok');
      expect(gamma.report?.baseline.verdict).toBe('failing');
      expect(gamma.report?.committed).toBe(true);
      expect(gamma.report?.pushed).toBe(true);
      expect(gamma.report?.prBranch).toBe('cq/e2e-scoped/fix/scope-gamma');
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-scoped/fix/scope-gamma');
      // The marker-filtered assemble covers the scoped unit under its
      // normalized branch.
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['@scope/gamma']);
      expectTrackerFirstFleet(
        scene,
        'cq/e2e-scoped',
        ['cq/e2e-scoped/fix/scope-gamma'],
        assembled.packages,
      );
    },
  );

  test(
    'a working-tree RENAME production → test shape: the allowlist flags the SOURCE path',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-rename');
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          { ...scene, config: { ...scene.config, fixers: ['test-fix'] } },
          prompts(
            { edit: ALPHA_FIX },
            {
              // Same content at a test-shaped path + the original removed:
              // git stages this as a rename whose SOURCE is production code.
              write: { file: 'packages/beta/test/manifest.test.js', text: BETA_PACKAGE_JSON },
              delete: 'packages/beta/package.json',
            },
          ),
          { stagePathAllowlist: { patterns: [...DEFAULT_TEST_FILE_PATTERNS] } },
        ),
      );

      // The unit failed naming the rename's SOURCE — the destination alone
      // (test/manifest.test.js) matches the test-file patterns and would
      // have slipped a --name-only allowlist.
      const beta = unitRow(outcome.run, 'beta', 'test-fix');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/outside the allowlist/);
      expect(beta.error).toContain('packages/beta/package.json');
      expect(scene.gh.created).toHaveLength(0);
    },
  );
});

// ---------------------------------------------------------------------------
// 6. Assemble-empty guard, stranded-commit retry, concurrent dispatch
// ---------------------------------------------------------------------------

describe('sweep e2e: assemble guard, stranded commits, concurrency', () => {
  test(
    'an all-no-op fleet (nothing commits) dispatches NO assemble: zero gh calls',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-clean');
      // Beta-only fleet: the suite passes, the fixer no-ops, nothing commits
      // -> no markers -> the marker-filtered package list is EMPTY -> no
      // assemble dispatch (no empty tracker PR).
      const config: SweepPlanConfig = {
        ...scene.config,
        packages: [SCRATCH_PACKAGES[1] as { name: string; path: string }],
        packageFiles: { beta: SCRATCH_PACKAGE_FILES['beta'] ?? [] },
      };
      const outcome = await runSweepPlan(optsFor({ ...scene, config }, prompts({}, {})));
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('ok');
      expect(beta.report?.committed).toBe(false);
      expect(outcome.assembleRun).toBeUndefined();
      expect(scene.gh.calls).toHaveLength(0); // the fake forge was never touched
      expect(outcome.output).toContain('0 failing unit(s) of 1');
    },
  );

  test(
    'a run-1 push fault strands the commit; run 2 retries the push and the marker exists (resume completeness)',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-stranded');
      // Run 1 with NO origin configured: alpha commits, then the push fails —
      // the unit fails and its verified fix is stranded locally.
      await gitOut(['-C', scene.repo, 'remote', 'remove', 'origin'], scene.repo);
      const first = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
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
      const second = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      const alphaSecond = unitRow(second.run, 'alpha');
      expect(alphaSecond.status).toBe('ok');
      expect(alphaSecond.report?.committed).toBe(false); // nothing NEW to commit
      expect(alphaSecond.report?.pushed).toBe(true); // ...but the stranded fix shipped
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).toContain('cq/e2e-stranded/fix/alpha');
      expect(second.assembleRun).toBeDefined();
      const assembled = assembleReport(second.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expect(second.output).toContain('0 failing unit(s) of 2');
    },
  );

  test(
    'strand-retry REFUSES with no caller-vouched runStateDir: an ahead-of-base branch is never pushed (no-vouch, #174)',
    { timeout: 600_000 },
    async () => {
      const scene = await scenario('cq/e2e-novouch');
      await strandAlpha(scene, 'cq/e2e-novouch');
      // Run 2 (origin restored, NO vouch): the fixer no-ops, the branch is
      // ahead of base, and the strand-retry refuses because the record could
      // not be trusted from the derived (driver-reachable) location.
      const second = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, {}), { runStateDir: null }),
      );
      const alpha = unitRow(second.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(
        /stranded pushes require an explicit caller-supplied runStateDir/,
      );
      expect(alpha.error).toMatch(/needs-human evidence/);
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-novouch/fix/alpha');
      expect(second.assembleRun).toBeUndefined();
    },
  );

  test(
    'strand-retry REFUSES a stripped scanned-commit record: a divergent tip is never pushed (#174)',
    { timeout: 600_000 },
    async () => {
      const scene = await scenario('cq/e2e-stripped');
      await strandAlpha(scene, 'cq/e2e-stripped');
      // The run-state `scanned/` record is the ONLY push authorization: strip
      // it and the retry fails TAMPER instead of trusting the ahead-of-base
      // tip.
      rmSync(join(scene.repo, 'cq-run-state', 'scanned', 'fix', 'alpha.json'));
      const second = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      const alpha = unitRow(second.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(/no scanned-commit record exists for this unit/);
      expect(alpha.error).toMatch(/unscanned commit must not be pushed/);
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-stripped/fix/alpha');
    },
  );

  test(
    'strand-retry REFUSES a divergent tip: the recorded sha must still be HEAD (#174)',
    { timeout: 600_000 },
    async () => {
      const scene = await scenario('cq/e2e-divergent');
      await strandAlpha(scene, 'cq/e2e-divergent');
      // Move the branch tip with a clean (empty) commit: the record still
      // exists, but it no longer names the tip — fail closed, never push.
      const worktree = resolve(scene.repo, 'worktrees', 'fix', 'alpha');
      await gitOut(
        ['-C', worktree, 'commit', '--allow-empty', '-m', 'unscanned tip move'],
        scene.repo,
      );
      const second = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
      const alpha = unitRow(second.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(/diverges from the recorded scanned sha/);
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads).not.toContain('cq/e2e-divergent/fix/alpha');
    },
  );

  test(
    'two units at concurrency 2 run under the default dispatch mutex and complete cleanly',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-parallel');
      const outcome = await runSweepPlan(
        optsFor(scene, prompts({ edit: ALPHA_FIX }, {}), { concurrency: 2 }),
      );
      // Both units dispatched IN PARALLEL (the default repo-level git mutex
      // serializes their worktree mutations) and both landed ok.
      expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0 });
      const alpha = unitRow(outcome.run, 'alpha');
      const beta = unitRow(outcome.run, 'beta');
      expect(alpha.status).toBe('ok');
      expect(alpha.report?.committed).toBe(true);
      expect(beta.status).toBe('ok');
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
      expect(scene.gh.created.length).toBeGreaterThanOrEqual(1);
      expect(scene.gh.created[0]?.head).toBe('cq/e2e-parallel/tracker');
    },
  );
});

test(
  'the default per-unit scope: an alpha worker editing beta fails naming the path (jZ59w)',
  { timeout: 120_000 },
  async () => {
    const scene = await scenario('cq/e2e-uniscope');
    // Alpha's worker crosses the package boundary: edits BETA's suite
    // inside ALPHA's worktree. The enriched job carries the per-unit
    // default (^packages/alpha/ + the declared file), so the staged
    // cross-package content fails the unit naming the path.
    const CROSS = {
      file: 'packages/beta/test/suite.test.js',
      oldText: 'const expected = 4;',
      newText: 'const expected = 4; // touched by the alpha worker',
    };
    const outcome = await runSweepPlan(optsFor(scene, prompts({ edit: CROSS }, {})));
    // The enriched job carried the per-unit default scope.
    const alphaInput = outcome.plan.jobs.find((job) => job.id === 'sweep-alpha-fix')
      ?.input as SweepUnitDispatchInput;
    expect(alphaInput.stagePathAllowlist?.patterns).toContain('^packages/alpha/');
    const alpha = unitRow(outcome.run, 'alpha');
    expect(alpha.status).toBe('failed');
    expect(alpha.error).toMatch(/outside the allowlist/);
    expect(alpha.error).toContain('packages/beta/test/suite.test.js');
    // The fleet gate: the failed unit withholds the assemble dispatch.
    expect(outcome.assembleRun).toBeUndefined();
    expect(scene.gh.created).toHaveLength(0);
  },
);

// ---------------------------------------------------------------------------
// 7. Rescue lane (arm-a §4.2 step 5) and prep mode (UC §1 row 3)
// ---------------------------------------------------------------------------

describe('sweep e2e: rescue lane and prep mode', () => {
  test(
    'a transient fault is rescued: the -r2 re-dispatch runs, the unit lands ok, and the fleet assembles',
    { timeout: 180_000 },
    async () => {
      const scene = await scenario('cq/e2e-rescue');
      // Attempt 1 faults (marker consumed); a re-dispatch proceeds to the fix.
      const faultMarker = join(scene.root, 'alpha-faulted');
      const outcome = await runSweepPlan(
        optsFor(
          { ...scene, config: { ...scene.config, rescue: { maxRedispatch: 1 } } },
          prompts(
            {
              edit: ALPHA_FIX,
              faultOnce: { marker: faultMarker, why: 'transient crash on alpha' },
            },
            {},
          ),
        ),
      );

      // Run 1: alpha FAILED (the transient fault); the RESCUE run re-dispatched
      // sweep-alpha-fix-r2 and it landed OK.
      const alpha = unitRow(outcome.run, 'alpha');
      expect(alpha.status).toBe('failed');
      expect(alpha.error).toMatch(
        /\[INFRA\] sweep.unit alpha: the fixer worker stopped with reason 'error'/,
      );
      expect(outcome.rescueRuns).toHaveLength(1);
      const rescueRow = outcome.rescueRuns?.[0]?.jobs[0];
      expect(rescueRow?.jobId).toBe('sweep-alpha-fix-r2');
      expect(rescueRow?.result.status).toBe('ok');
      // The fleet assembles the rescued unit.
      expect(outcome.assembleRun).toBeDefined();
      const assembled = assembleReport(outcome.assembleRun as RunReport);
      expect(assembled.packages.map((row) => row.name)).toEqual(['alpha']);
    },
  );

  test(
    'a TAMPER fault is never re-dispatched: no rescue run, straight to preserve',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-tamper-rescue');
      const config: SweepPlanConfig = { ...scene.config, rescue: { maxRedispatch: 1 } };
      const outcome: SweepRunOutcome = await runSweepPlan(
        optsFor(
          { ...scene, config },
          prompts(
            { edit: ALPHA_FIX },
            {
              write: {
                file: 'packages/beta/test/added.test.js',
                text: "it.skip('gaming the run', () => {});\n",
              },
            },
          ),
        ),
      );
      // Beta's unit failed with a TAMPER verdict: NOT retryable — no rescue
      // run exists for it.
      const beta = unitRow(outcome.run, 'beta');
      expect(beta.status).toBe('failed');
      expect(beta.error).toMatch(/\[TAMPER\]/);
      expect(outcome.rescueRuns).toBeUndefined();
      // And the tree state routes it to preserve.
      const salvaged = await salvageInterruptedRun({
        journalDir: scene.journalDir,
        planId: SWEEP_PLAN_ID,
        config: scene.config,
        planner: outcome.planner,
        enrichedJobs: outcome.plan.jobs,
        runIndex: 0,
      });
      expect(salvaged.rows.find((row) => row.path.endsWith('fix/beta'))?.class).toBe('preserve');
    },
  );

  test(
    'prep mode runs probes only: baseline evidence for both packages, zero agents, zero commits, zero PRs',
    { timeout: 120_000 },
    async () => {
      const scene = await scenario('cq/e2e-prep');
      const config: SweepPlanConfig = { ...scene.config, mode: 'prep' };
      const outcome = await runSweepPlan(
        optsFor({ ...scene, config }, prompts({ edit: ALPHA_FIX }, {})),
      );

      // Both prep units landed ok with probe evidence only.
      expect(outcome.run.counts).toMatchObject({ done: 3, failed: 0, blocked: 0 });
      for (const pkg of ['alpha', 'beta']) {
        const row = unitRow(outcome.run, pkg);
        expect(row.status).toBe('ok');
        expect(row.report?.mode).toBe('prep');
        expect(row.report?.baseline.failureSet).toBeDefined();
        expect(row.report?.final).toBeUndefined();
        expect(row.report?.regression).toBeUndefined();
        expect(row.report?.committed).toBeUndefined();
        expect(row.report?.pushed).toBeUndefined();
      }
      // Zero agent invocations: the sessions dir was never created.
      expect(existsSync(scene.sessionsDir)).toBe(false);
      // Zero commits pushed and zero PRs: prep's product is the evidence.
      const originHeads = await gitOut(['ls-remote', '--heads', 'origin'], scene.repo);
      expect(originHeads.trim()).toBe('');
      expect(scene.gh.calls).toHaveLength(0);
      expect(outcome.assembleRun).toBeUndefined();
      // The baseline snapshots exist for BOTH packages (run-state, namespaced).
      for (const pkg of ['alpha', 'beta']) {
        expect(
          existsSync(
            join(
              join(scene.repo, 'cq-run-state'),
              SWEEP_RUN_STATE_BASELINE_DIR,
              'fix',
              `${pkg}.json`,
            ),
          ),
        ).toBe(true);
      }
    },
  );
});

// The journal-file shape sanity: one NDJSON file per dispatch (units + the
// marker-filtered assemble), every line parseable.
describe('sweep e2e: journal evidence shape', () => {
  test('every journaled line parses as the frozen event union', { timeout: 120_000 }, async () => {
    const scene = await scenario('cq/e2e-journal');
    await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
    const files = readdirSync(scene.journalDir).filter((name) => name.endsWith('.ndjson'));
    expect(files).toHaveLength(2); // the units dispatch + the assemble dispatch
    for (const file of files) {
      const lines = readFileSync(join(scene.journalDir, file), 'utf8')
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

  test('a slug-collision fleet salvages BOTH resolved trees via the enriched jobs (jTPa1/jVgCc-era pin)', () => {
    const config = sceneLessConfig();
    const units: Array<WorkUnit> = [
      { package: '@a/b', fixer: 'fix', files: [] },
      { package: 'a.b', fixer: 'fix', files: [] },
    ];
    const planner: SweepRunOutcome['planner'] = {
      jobs: units.map((unit, index) => ({
        id: `sweep-collide-${index}`,
        op: 'sweep.unit',
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    // The ENRICHED expanded-plan jobs: the builder's resolved kind/slug
    // (a-b, a-b-2). WITHOUT them the raw report derives 'a-b' for BOTH —
    // the `-2` tree would be salvaged as the first tree, twice.
    const enriched = planner.jobs.map((job, index) => ({
      ...job,
      input: {
        ...(job.input as WorkUnit),
        repoRoot: '/repo',
        worktreesDir: 'worktrees',
        runPrefix: 'cq/tail',
        base: 'main',
        kind: 'fix',
        slug: index === 0 ? 'a-b' : 'a-b-2',
      },
    }));
    const runId = 'sweep--collide--00000';
    const at = (tick: number): string => new Date(1_700_000_000_000 + tick).toISOString();
    const entries = salvageEntriesFor(
      config,
      planner,
      [
        { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
        {
          type: 'job-finished',
          runId,
          at: at(1),
          jobId: 'sweep-collide-0',
          opId: 'sweep.unit',
          inputsHash: 'h',
          result: { status: 'ok', value: {} },
        },
        {
          type: 'job-finished',
          runId,
          at: at(2),
          jobId: 'sweep-collide-1',
          opId: 'sweep.unit',
          inputsHash: 'h',
          result: { status: 'failed', error: 'boom' },
        },
      ],
      enriched,
    );
    expect(entries.map((entry) => entry.path)).toEqual([
      '/repo/worktrees/fix/a-b',
      '/repo/worktrees/fix/a-b-2',
    ]);
    expect(entries.find((entry) => entry.branch?.endsWith('a-b'))?.journal?.allTerminal).toBe(true);
    expect(entries.find((entry) => entry.branch?.endsWith('a-b-2'))?.journal?.allTerminal).toBe(
      false,
    );
  });

  test('a multi-fixer fleet yields ONE salvage entry per UNIT tree (per kind/slug)', () => {
    const config = sceneLessConfig();
    // ONE package, TWO fixers — two trees (worktrees/fix/alpha and
    // worktrees/test-fix/alpha), two jobs, two independent tails.
    const units: Array<WorkUnit> = [
      { package: 'alpha', fixer: 'fix', files: [] },
      { package: 'alpha', fixer: 'test-fix', files: [] },
    ];
    const planner: SweepRunOutcome['planner'] = {
      jobs: units.map((unit) => ({
        id: `sweep-${unit.package}-${unit.fixer}`,
        op: 'sweep.unit',
        input: unit,
        dependsOn: [],
      })),
      units,
      suppressed: [],
      needsHuman: [],
    };
    const runId = 'sweep--fan--000000';
    const at = (tick: number): string => new Date(1_700_000_000_000 + tick).toISOString();
    const entries = salvageEntriesFor(config, planner, [
      { type: 'run-started', runId, at: at(0), planId: SWEEP_PLAN_ID },
      {
        type: 'job-finished',
        runId,
        at: at(1),
        jobId: 'sweep-alpha-fix',
        opId: 'sweep.unit',
        inputsHash: 'h',
        result: { status: 'failed', error: 'boom' },
      },
      {
        type: 'job-finished',
        runId,
        at: at(2),
        jobId: 'sweep-alpha-test-fix',
        opId: 'sweep.unit',
        inputsHash: 'h',
        result: { status: 'ok', value: {} },
      },
    ]);
    // Two entries, one per unit tree — the package-grouped derivation would
    // have collapsed both fixers into one tree and dropped the other.
    expect(entries).toHaveLength(2);
    const fixEntry = entries.find((entry) => entry.branch?.endsWith('fix/alpha'));
    const testFixEntry = entries.find((entry) => entry.branch?.endsWith('test-fix/alpha'));
    expect(fixEntry?.path).toContain('worktrees/fix/alpha');
    expect(testFixEntry?.path).toContain('worktrees/test-fix/alpha');
    expect(fixEntry?.journal).toMatchObject({
      lastStep: 'sweep-alpha-fix',
      allTerminal: false,
    });
    expect(testFixEntry?.journal).toMatchObject({
      lastStep: 'sweep-alpha-test-fix',
      allTerminal: true,
    });
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
