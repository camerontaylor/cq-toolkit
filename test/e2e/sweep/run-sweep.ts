// The D4 e2e composition — the caller side of the sweep plan's two-phase
// contract (arm-a §4.2 loop steps 1–7), wired the way the future CLI/runner
// layer is expected to wire it:
//
//   phase A  run the planner (sweep.planSweep, REAL subprocess deps) and
//            keep its report — the fan-out data;
//   phase B  buildSweepPlan(config, report) → runPlan through an
//            OpRegistryView that binds: the CENTRAL registry's real
//            `sweep.planSweep` entry (the plan's producer job), the D4
//            `sweep.unit` composition (makeSweepUnitOp — the op the central
//            registry does not carry yet; see the FLAG in src/plans/sweep.ts),
//            and `pr.assemblePrs` over the INJECTED fake gh (makeAssemblePrs
//            + this module's makeFakeGh — no forge is contacted).
//
// The fixer driver leg is the REAL SubprocessDriver spawning the fake agent
// CLI fixture (test/fixtures/scratch-repo/sweep-agent.mjs); every git leg
// (worktrees, probes' check.js, diffs, commits) is real, in tmpdirs. The
// journal is the runner's own NDJSON (one file per run invocation under
// journalDir) — the tests read it back as evidence.
//
// Sweep-layer resume is salvage + reuse, never kernel journal-replay (the
// rationale lives in src/plans/sweep.ts): salvageInterruptedRun scans the
// LATEST run of the plan id, derives each package's SalvageEntry journal
// tail (allTerminal = every unit job of the package finished ok), and runs
// the REAL salvage op over the inventory.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { SubprocessDriver } from '../../../src/driver/subprocess/index.js';
import type { RoutingTable } from '../../../src/driver/subprocess/routing.js';
import { openRunLog, candidateRunsForPlan } from '../../../src/kernel/journal.js';
import type { JournalEvent, Op, OpRegistryEntry, RunReport } from '../../../src/kernel/types.js';
import { runPlan, type OpRegistryView } from '../../../src/kernel/runner.js';
import { makeAssemblePrs } from '../../../src/ops/pr/assemblePrs.js';
import type {
  AssemblePrsInput,
  PrCreateRequest,
  PrCreateResult,
  PrEffects,
  PrReadinessSnapshot,
  PrSearchResult,
} from '../../../src/ops/pr/assemblePrs.js';
import { AssemblePrsInputSchema } from '../../../src/ops/pr/registry.js';
import type { CheckCommand, RunCheck } from '../../../src/ops/gates/checkRunner.js';
import { subprocessRunCheck } from '../../../src/ops/gates/checkRunner.js';
import type { GhFn } from '../../../src/ops/review/gh.js';
import { list } from '../../../src/registry/index.js';
import {
  buildSweepPlan,
  makeSweepUnitOp,
  sweepPlannerInput,
  sweepUnitSegments,
  SweepUnitInputSchema,
  type SweepPlanConfig,
} from '../../../src/plans/sweep.js';
import {
  makePlanSweep,
  makeSubprocessSweepPlannerDeps,
  SWEEP_UNIT_OP,
} from '../../../src/ops/sweep/planSweep.js';
import type { PlanSweepReport, WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import { makeSalvage, makeSubprocessSalvageEffects } from '../../../src/ops/sweep/salvage.js';
import type { SalvageEntry, SalvagePlan } from '../../../src/ops/sweep/salvage.js';

// ---------------------------------------------------------------------------
// The fake gh seam — an in-memory PrEffects that records its call order
// ---------------------------------------------------------------------------

export interface FakeGh {
  /** The injected seam for makeAssemblePrs. */
  effects: PrEffects;
  /** Every effect call, in order — the tracker-first assertion reads this. */
  calls: string[];
  /** The PRs created, in creation order (numbers allocate 1, 2, 3, …). */
  created: Array<{ number: number; head: string; base: string; title: string; draft: boolean }>;
  /** Body per PR number (the tracker's in-place manifest updates land here). */
  bodies: Map<number, string>;
}

/** An in-memory forge: search by head+base, create, body read/edit, record everything. */
export function makeFakeGh(): FakeGh {
  const calls: string[] = [];
  const created: FakeGh['created'] = [];
  const bodies = new Map<number, string>();
  const heads = new Map<string, number>(); // `${head} -> ${base}` → number

  const searchPrByHead = async (head: string, base: string): Promise<PrSearchResult | null> => {
    calls.push(`searchPrByHead ${head} -> ${base}`);
    const number = heads.get(`${head} -> ${base}`);
    return number === undefined ? null : { number, state: 'open', isCrossRepository: false };
  };
  const createPr = async (request: PrCreateRequest): Promise<PrCreateResult> => {
    calls.push(`createPr ${request.head} -> ${request.base}`);
    const number = created.length + 1;
    created.push({
      number,
      head: request.head,
      base: request.base,
      title: request.title,
      draft: request.draft,
    });
    heads.set(`${request.head} -> ${request.base}`, number);
    bodies.set(number, request.body ?? '');
    return { number };
  };

  const effects: PrEffects = {
    searchPrByHead,
    createPr,
    editPrBody: async (number, body) => {
      calls.push(`editPrBody #${String(number)}`);
      bodies.set(number, body);
    },
    getPrBody: async (number) => {
      calls.push(`getPrBody #${String(number)}`);
      return bodies.get(number) ?? '';
    },
    comment: async (number, body) => {
      calls.push(`comment #${String(number)} ${body}`);
    },
    getPrReadiness: async (number): Promise<PrReadinessSnapshot> => {
      calls.push(`getPrReadiness #${String(number)}`);
      const draft = created.find((pr) => pr.number === number)?.draft ?? true;
      return {
        checks: { state: 'none' },
        review: { state: 'none' },
        meta: { isDraft: draft, state: 'open', mergeable: 'mergeable', mergeStateStatus: 'clean' },
      };
    },
  };
  return { effects, calls, created, bodies };
}

// ---------------------------------------------------------------------------
// The sweep run — phase A (plan) + phase B (expanded graph through runPlan)
// ---------------------------------------------------------------------------

/** Everything one e2e sweep invocation needs; the test owns the scenario. */
export interface RunSweepOpts {
  /** Config-grade sweep inputs (repo, worktrees, naming, manifest, selector). */
  config: SweepPlanConfig;
  /** NDJSON journal dir — one run file per invocation, shared across re-invokes. */
  journalDir: string;
  /** Sessions dir for the fixer workers' session records. */
  sessionsDir: string;
  /** The fake agent CLI argv (e.g. [node, sweep-agent.mjs]) — the driver's binary. */
  agentCli: readonly string[];
  /** The fake endpoint's provider handle + model (both plain data). */
  provider: string;
  model: string;
  /** Host env var NAMES the fake routing table reads (values live in process.env). */
  keyEnv: string;
  baseUrlEnv: string;
  /** The per-unit fixer prompt — the scenario steering (faults ride here). */
  prompt: (unit: WorkUnit, worktreePath: string) => string;
  /** The per-package probe command, resolved against the unit's worktree. */
  checkCommand: (unit: WorkUnit, worktreePath: string) => CheckCommand;
  /** The injected forge (makeFakeGh) — no real gh is ever spawned. */
  gh: PrEffects;
  /** Probe observation hook — the I7 re-probe assertion counts through this. */
  onProbe?: (packageName: string) => void;
}

/** One sweep invocation's outcome: the phase-A report, the phase-B run, the default output. */
export interface SweepRunOutcome {
  planner: PlanSweepReport;
  run: RunReport;
  /** The failures-only DEFAULT output (see renderSweepOutput). */
  output: string;
}

/** Run the full sweep once: plan (phase A) → expand → journaled runPlan (phase B). */
export async function runSweepPlan(opts: RunSweepOpts): Promise<SweepRunOutcome> {
  // Phase A: the planner over its REAL subprocess deps (input-driven).
  const plannerOp = makePlanSweep(makeSubprocessSweepPlannerDeps(opts.config.repoRoot));
  const planned = await plannerOp(sweepPlannerInput(opts.config));
  if (planned.status !== 'ok') {
    throw new Error(`e2e setup: the planner failed — ${JSON.stringify(planned)}`);
  }
  const planner = planned.value;

  // The probe runner: the REAL subprocess check, observed per package.
  const runCheck: RunCheck = async (cmd) => {
    const pkg = cmd.args[cmd.args.length - 1];
    opts.onProbe?.(typeof pkg === 'string' ? pkg : '');
    return subprocessRunCheck(cmd);
  };

  // The unit composition, bound per run (every seam injected).
  const git: GhFn = makeGitRunner();
  const driver = new SubprocessDriver({
    binary: [...opts.agentCli],
    routingTable: fakeRoutingTable(opts),
    sessionsDir: opts.sessionsDir,
  });
  const unitOp = makeSweepUnitOp({
    repoRoot: opts.config.repoRoot,
    worktreesDir: opts.config.worktreesDir,
    runPrefix: opts.config.runPrefix,
    base: opts.config.base,
    baselineCacheDirs: ['.cq/baseline'],
    adapter: 'tsc-lines',
    runCheck,
    checkCommand: opts.checkCommand,
    driver,
    modelSpec: { model: opts.model, provider: opts.provider },
    sessionsDir: opts.sessionsDir,
    prompt: (unit, worktree) => opts.prompt(unit, worktree.path),
    git,
  });

  // The dispatch view: central registry for the real ops (planSweep), the D4
  // composition for sweep.unit, the fake forge for pr.assemblePrs.
  const central = new Map((await list()).map((entry) => [entry.name, entry] as const));
  if (!central.has('pr.assemblePrs'))
    throw new Error('e2e setup: pr.assemblePrs is not registered');
  const overridden = new Map<string, OpRegistryEntry>([
    [
      SWEEP_UNIT_OP,
      {
        name: SWEEP_UNIT_OP,
        inputSchema: SweepUnitInputSchema,
        // The dispatch seam re-validates input through inputSchema.parseAsync,
        // so the erased op typing is safe here (the registry precedent).
        importer: async () => (async (input: WorkUnit) => unitOp(input)) as Op<unknown, unknown>,
      },
    ],
    [
      'pr.assemblePrs',
      {
        name: 'pr.assemblePrs',
        inputSchema: AssemblePrsInputSchema,
        importer: async () =>
          (async (input: AssemblePrsInput) => makeAssemblePrs(opts.gh)(input)) as Op<
            unknown,
            unknown
          >,
      },
    ],
  ]);
  const view: OpRegistryView = {
    // The bottom instantiation cast (the review-loop's centralRegistryView
    // precedent: unknown-instantiated entries do not widen down to never).
    get: (name) =>
      (overridden.get(name) ?? central.get(name)) as OpRegistryEntry<never, never> | undefined,
  };

  // Phase B: the expanded graph, journaled. stopOnError + the assemble job's
  // dependsOn-every-unit is the fleet gate: one failed unit withholds the PRs.
  const plan = buildSweepPlan(opts.config, planner);
  const run = await runPlan(
    plan,
    { concurrency: 1, stopOnError: true, journalDir: opts.journalDir },
    view,
  );
  return { planner, run, output: renderSweepOutput(opts.config, planner, run) };
}

/** The fake endpoint table: a provider whose key never leaves the test's env var. */
function fakeRoutingTable(opts: RunSweepOpts): RoutingTable {
  return {
    endpoints: {
      [opts.provider]: {
        baseUrlEnv: opts.baseUrlEnv,
        baseUrlDefault: 'http://127.0.0.1:9',
        keyEnv: opts.keyEnv,
        models: [opts.model],
        notes: 'D4 e2e fake endpoint — the agent fixture is the model; nothing is contacted',
      },
    },
  };
}

/** The unit op's git transport (the review-loop's makeGhRunner posture, bin git). */
function makeGitRunner(): GhFn {
  return (args) => gitRun(args);
}

// ---------------------------------------------------------------------------
// The failures-only DEFAULT output — the sweep's reporting contract
// ---------------------------------------------------------------------------

/**
 * The default output prints ONLY failures — one line per failed unit naming
// the package and the reason, then a bare count. A clean run carries no
// per-package noise at all (the footer's totals name no package).
 */
export function renderSweepOutput(
  config: SweepPlanConfig,
  planner: PlanSweepReport,
  run: RunReport,
): string {
  const lines: string[] = [`sweep ${config.runPrefix}: ${String(planner.units.length)} unit(s)`];
  let failing = 0;
  for (const job of planner.jobs) {
    const unit = job.input as WorkUnit;
    const row = run.jobs.find((candidate) => candidate.jobId === job.id);
    if (row === undefined) continue;
    if (row.result.status === 'ok') continue;
    failing += 1;
    const detail =
      row.result.status === 'failed'
        ? row.result.error
        : row.result.status === 'needs-human'
          ? row.result.reason
          : row.result.status === 'indeterminate'
            ? row.result.detail
            : 'budget exhausted';
    lines.push(`FAIL ${unit.package}/${unit.fixer}: ${detail}`);
  }
  lines.push(
    `sweep finished: ${String(failing)} failing unit(s) of ${String(planner.units.length)}`,
  );
  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Interrupted-run salvage — the journal tail, scanned + classified
// ---------------------------------------------------------------------------

/** Scan the LATEST run of the plan id and classify its interrupted trees (the REAL salvage op). */
export async function salvageInterruptedRun(opts: {
  journalDir: string;
  planId: string;
  config: SweepPlanConfig;
  planner: PlanSweepReport;
}): Promise<SalvagePlan> {
  const events = await latestRunEvents(opts.journalDir, opts.planId);
  const salvaged = await makeSalvage(makeSubprocessSalvageEffects())({
    repoRoot: opts.config.repoRoot,
    entries: salvageEntriesFor(opts.config, opts.planner, events),
  });
  if (salvaged.status !== 'ok') {
    throw new Error(`e2e: salvage failed — ${JSON.stringify(salvaged)}`);
  }
  return salvaged.value;
}

/**
 * The journal-tail derivation: one SalvageEntry per manifest package, its
 * tail read from the run's events IN JOURNAL ORDER.
 *
 * Per package (allTerminal = EVERY unit job of the package finished ok — a
 * failed unit is terminal but NOT done: the work did not happen, so the tree
 * is not clean-done; salvage must see it as pending, not done):
 *   - allTerminal — every unit job's LAST finish is ok;
 *   - lastStep    — the job ID of the LAST matching job-finished event in
 *     journal order (jobs can finish out of plan order; the tail is the
 *     journal's last word, not the plan's). No terminal event for the
 *     package → NO lastStep (a run interrupted before its first write
 *     carries no done evidence — salvage's absent-evidence branch, I9).
 */
export function salvageEntriesFor(
  config: SweepPlanConfig,
  planner: PlanSweepReport,
  events: readonly JournalEvent[],
): SalvageEntry[] {
  const finishes = new Map<string, string | undefined>(); // jobId → last terminal status
  const finishOrder: Array<{ jobId: string; status: string }> = []; // journal order
  for (const event of events) {
    if (event.type === 'job-finished') {
      finishes.set(event.jobId, event.result.status);
      finishOrder.push({ jobId: event.jobId, status: event.result.status });
    }
  }
  const byPackage = new Map<string, string[]>();
  for (const job of planner.jobs) {
    const unit = job.input as WorkUnit;
    const jobIds = byPackage.get(unit.package) ?? [];
    jobIds.push(job.id);
    byPackage.set(unit.package, jobIds);
  }
  const entries: SalvageEntry[] = [];
  for (const [packageName, jobIds] of byPackage) {
    const first = planner.jobs.find((job) => (job.input as WorkUnit).package === packageName);
    const unit = first?.input as WorkUnit;
    const segments = sweepUnitSegments(config.runPrefix, unit);
    const lastTerminal = finishOrder.findLast((finish) => jobIds.includes(finish.jobId));
    entries.push({
      path: absoluteWorktreePath(config, segments.kind, segments.slug),
      branch: segments.branch,
      journal: {
        ...(lastTerminal !== undefined ? { lastStep: lastTerminal.jobId } : {}),
        allTerminal: jobIds.every((jobId) => finishes.get(jobId) === 'ok'),
      },
    });
  }
  return entries;
}

/** The lexical worktree path (salvage canonicalizes it itself). */
function absoluteWorktreePath(config: SweepPlanConfig, kind: string, slug: string): string {
  return resolve(config.repoRoot, config.worktreesDir, kind, slug);
}

/** The event list of the plan's LATEST journaled run (runs() is oldest-first). */
export async function latestRunEvents(journalDir: string, planId: string): Promise<JournalEvent[]> {
  const log = openRunLog(journalDir);
  const runIds = candidateRunsForPlan(await log.runs(), planId);
  const latest = runIds[runIds.length - 1];
  if (latest === undefined) {
    throw new Error(`e2e: no journaled run of plan '${planId}' under '${journalDir}'`);
  }
  return log.read(latest);
}

// ---------------------------------------------------------------------------
// Small local seams
// ---------------------------------------------------------------------------

/** The unit op's git runner result shape (the GhFn vocabulary). */
interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Bounded real git for the unit op's diff/status/add/commit steps. */
function gitRun(args: string[], timeoutMs = 30_000): Promise<GitResult> {
  return new Promise((resolve) => {
    const child = spawn('git', ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args], {
      shell: false,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (err: Error) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: '', stderr: String(err) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 127,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
  });
}
