// Split provenance: test/e2e/sweep/sweep.e2e.test.ts was split into the
// sweep.e2e.*.test.ts siblings in this directory; the shared fixtures live
// here. The original suite header is kept at the top of this module.
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
//   3. DIRTY TREES ARE PRESERVED: the focused tamper run leaves beta's tree
//      staged but uncommitted, and the REAL salvage (subprocess effects)
//      classifies it `preserve`. The regression decision that withholds the
//      commit is pinned in-process (test/ops/sweep/unit-scenarios.test.ts).
//   4. EVIDENCE QUALITY: every journaled line parses through the frozen
//      JournalEventSchema (openRunLog.read validates each line, not just a
//      type-field sniff), and the salvage
//      journal tail takes lastStep from the LAST job-finished event in
//      journal order — jobs can finish out of plan order, and a multi-fixer
//      fleet yields ONE salvage entry per unit tree.
//   5. THE TAMPER GUARD, ON NEW FILES: the unit op stages BEFORE it scans,
//      so a fixer that ADDS a hacked file (a skip marker) is flagged by the
//      scan and its unit fails uncommitted.
import { execFile } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect } from 'vitest';
import { createDriverFactory } from '../../../src/driver/factory.js';
import type { Driver } from '../../../src/driver/types.js';
import { cloneTemplate, createGitTemplate, type GitTemplate } from '../../helpers/git-template.js';
import {
  ALPHA_FIX,
  generateScratchRepo,
  SCRATCH_PACKAGE_FILES,
  SCRATCH_PACKAGES,
} from '../../fixtures/scratch-repo/generate.js';
import { SWEEP_PLAN_ID } from '../../../src/plans/sweep.js';
import type { SweepPlanConfig } from '../../../src/plans/sweep.js';
import type { SweepUnitReport } from '../../../src/ops/sweep/unit.js';
import type { SweepUnitDriverConfig } from '../../../src/ops/sweep/unit.js';
import { subprocessRunCheck } from '../../../src/ops/gates/checkRunner.js';
import { makeGhRunner } from '../../../src/adapters/forge-github/gh.js';
import type {
  AssemblePrsPackageReport,
  AssemblePrsReport,
} from '../../../src/ops/pr/assemblePrs.js';
import type { WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import type { JournalEvent, RunReport } from '../../../src/kernel/types.js';
import { makeFakeGh, runEventsAt, runSweepPlan, type RunSweepOpts } from './run-sweep.js';

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

export interface Scenario {
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
export async function scenario(runPrefix: string): Promise<Scenario> {
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
export function prompts(alpha: object, beta: object): RunSweepOpts['promptTemplate'] {
  return (unit) =>
    [
      `You are the ${unit.fixer} fixer for package ${unit.package}.`,
      'Apply exactly the edit in the instruction line, then report.',
      `@SWEEP-AGENT ${JSON.stringify(unit.package === 'alpha' ? alpha : beta)}`,
    ].join('\n');
}

/** The dispatch-grade unit-job knobs of every e2e run (JSON, central-registry dispatchable). */
export function optsFor(
  scene: Scenario,
  promptTemplate?: RunSweepOpts['promptTemplate'],
  extra?: {
    push?: boolean;
    stagePathAllowlist?: { patterns: string[] };
    proposeOnly?: boolean;
    testFixPlan?: boolean;
    runStateDir?: string | null;
    concurrency?: number;
  },
): RunSweepOpts {
  return {
    config: scene.config,
    journalDir: scene.journalDir,
    gh: scene.gh.effects,
    driver: {
      provider: 'cq-d4-e2e',
      model: 'sweep-fake',
      // The required in-flight bound, generous for loaded CI hosts, plus a
      // landing gate the fake agent (unpriced 'sweep-fake', 20 tokens per
      // run) stays well inside — a maxUsd gate would trip on unpriced usage.
      budget: { wallClockMs: 600_000, maxTokens: 1_000_000 },
    } satisfies SweepUnitDriverConfig,
    // The scenario's DEPLOYMENT factory config (ADR-0002 §2.5): role
    // 'fixer' + the fake provider → the subprocess lane over the fake agent
    // CLI; the lane knobs (binary/routing table/sessions dir) live HERE,
    // never in plan JSON. The factory owns the served-model assertion.
    drivers: createDriverFactory({
      bindings: { fixer: { 'cq-d4-e2e': 'claude-code' } },
      lanes: {
        claudeCode: {
          binary: AGENT_CLI,
          sessionsDir: scene.sessionsDir,
          routingTable: {
            endpoints: {
              'cq-d4-e2e': {
                baseUrlEnv: 'CQ_D4_E2E_URL',
                baseUrlDefault: 'http://127.0.0.1:9',
                keyEnv: KEY_ENV,
                models: ['sweep-fake'],
                notes:
                  'D4 e2e fake endpoint — the agent fixture is the model; nothing is contacted',
              },
            },
          },
        },
      },
    }),
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
export function focusedUnitBindings(scene: Scenario, driver: Driver) {
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
    budget: { wallClockMs: 600_000, maxTokens: 1_000_000 },
    prompt: () => 'focused real-git contract',
    git: makeGhRunner({ bin: 'git', timeoutMs: 30_000 }),
  };
}

/**
 * Strand alpha's verified fix: run 1 with NO origin (the commit lands, the
 * push fails), then restore the origin so a run-2 refusal branch can be
 * exercised (review-debt #174).
 */
export async function strandAlpha(scene: Scenario, runPrefix: string): Promise<void> {
  await gitOut(['-C', scene.repo, 'remote', 'remove', 'origin'], scene.repo);
  const first = await runSweepPlan(optsFor(scene, prompts({ edit: ALPHA_FIX }, {})));
  const alpha = unitRow(first.run, 'alpha');
  expect(alpha.status).toBe('failed');
  expect(alpha.error).toContain(`git push of '${runPrefix}/fix/alpha' failed`);
  await gitOut(['-C', scene.repo, 'remote', 'add', 'origin', scene.origin], scene.repo);
}

/** The unit job's report row (by package + fixer), unwrapped as SweepUnitReport. */
export function unitRow(
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
export function assembleReport(run: RunReport): AssemblePrsReport {
  const row = run.jobs.find((candidate) => candidate.jobId === 'sweep-assemble');
  if (row === undefined || row.result.status !== 'ok') {
    throw new Error('the assemble job did not end ok');
  }
  return row.result.value as AssemblePrsReport;
}

/** Read one file inside a package's worktree (the worktree mirrors the repo layout). */
export function readInWorktree(repo: string, pkg: string, repoRelative: string): string {
  return readFileSync(resolve(repo, 'worktrees', 'fix', pkg, repoRelative), 'utf8');
}

/** Bounded real git read for the assertions (the worktreeFor.real-git.test.ts idiom). */
export function gitOut(args: string[], cwd: string): Promise<string> {
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
export async function expectCompleteJournal(
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
export async function expectUnitOverlap(journalDir: string, runIndex: number, jobIds: string[]) {
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
export function expectTrackerFirstFleet(
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
