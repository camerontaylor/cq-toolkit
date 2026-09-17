// The D4 e2e composition — the caller side of the sweep plan's two-phase
// contract (arm-a §4.2 loop steps 1–7), wired the way the future CLI/runner
// layer is expected to wire it:
//
//   phase A  run the planner (sweep.planSweep, REAL subprocess deps) and
//            keep its report — the fan-out data;
//   phase B  buildSweepPlan(config, report) → runPlan through the CENTRAL
//            registry: 'sweep.unit' dispatches through its REGISTERED entry
//            (bindingsFromDispatch → real subprocess worktree effects, the
//            REAL subprocess driver over the input's driver section — the
//            fake agent CLI fixture IS that driver's binary — real probes,
//            the real git push against the scratch repo's LOCAL bare
//            origin), and `pr.assemblePrs` is the ONE override (the injected
//            fake gh — no forge is contacted; tracker-branch creation on a
//            real forge is the deferred WS-K surface, review-debt #144).
//
// Every git leg (worktrees, check.js probes, diffs, commits, pushes) is
// real, in tmpdirs. The journal is the runner's own NDJSON (one file per run
// invocation under journalDir) — the tests read it back as evidence.
//
// Sweep-layer resume is salvage + reuse, never kernel journal-replay (the
// rationale lives in src/plans/sweep.ts): salvageInterruptedRun scans the
// LATEST run of the plan id, derives each UNIT's SalvageEntry journal tail
// (one entry per unit tree; lastStep = the LAST job-finished event in
// journal order), and runs the REAL salvage op over the inventory.
import { resolve } from 'node:path';
import { candidateRunsForPlan, openRunLog } from '../../../src/kernel/journal.js';
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
import { list } from '../../../src/registry/index.js';
import {
  buildSweepPlan,
  sweepPlannerInput,
  SWEEP_PLAN_ID,
  SWEEP_PLAN_JOB_IDS,
  type SweepPlanConfig,
} from '../../../src/plans/sweep.js';
import {
  makePlanSweep,
  makeSubprocessSweepPlannerDeps,
  SWEEP_UNIT_OP,
} from '../../../src/ops/sweep/planSweep.js';
import type { PlanSweepReport, WorkUnit } from '../../../src/ops/sweep/planSweep.js';
import { sweepUnitSegments } from '../../../src/ops/sweep/unit.js';
import type {
  SweepUnitCheckConfig,
  SweepUnitDispatchInput,
  SweepUnitDriverConfig,
} from '../../../src/ops/sweep/unit.js';
import { readCommittedMarkers } from '../../../src/ops/sweep/unit.js';
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
  /** The injected forge (makeFakeGh) — no real gh is ever spawned. */
  gh: PrEffects;
  /** The JSON driver binding (the fake agent CLI + fake endpoint), per unit job. */
  driver: SweepUnitDriverConfig;
  /** The JSON probe binding (the scratch check.js command template), per unit job. */
  check: SweepUnitCheckConfig;
  /** The per-unit fixer prompt TEMPLATE — the scenario steering (faults ride here). */
  promptTemplate?: (unit: WorkUnit) => string;
  /** Push committed branches to the scratch repo's origin; default true. */
  push?: boolean;
  /** Optional staged-path allowlist overlay (the test-fix scope pin). */
  stagePathAllowlist?: { patterns: string[] };
}

/** One sweep invocation's outcome: the phase-A report, the phase-B run, the default output. */
export interface SweepRunOutcome {
  planner: PlanSweepReport;
  run: RunReport;
  /**
   * The marker-filtered assemble run (jTPa8) — present exactly when every
   * unit succeeded AND at least one unit committed+pushed; its journal is
   * its own run file (the plan id's LATEST).
   */
  assembleRun?: RunReport;
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

  // Phase B: the expanded graph with the dispatch knobs layered on (JSON,
  // central-registry dispatchable), journaled. stopOnError:false — I9's
  // collect-all (every unit dispatches and lands a journal outcome). The
  // ASSEMBLE job is REMOVED from this plan: it is dispatched separately
  // below, composed from the units' committed markers (jTPa8 — the static
  // Job cannot know which units committed until they have run).
  const fullPlan = buildSweepPlan(opts.config, planner, SWEEP_PLAN_ID, {
    driver: opts.driver,
    check: opts.check,
    push: opts.push ?? true,
    ...(opts.stagePathAllowlist !== undefined
      ? { stagePathAllowlist: opts.stagePathAllowlist }
      : {}),
  });
  const assembleTemplate = fullPlan.jobs.find((job) => job.id === SWEEP_PLAN_JOB_IDS.assemble);
  const plan = {
    ...fullPlan,
    jobs: fullPlan.jobs.filter((job) => job.id !== SWEEP_PLAN_JOB_IDS.assemble),
  };
  for (const job of plan.jobs) {
    if (job.op !== SWEEP_UNIT_OP || opts.promptTemplate === undefined) continue;
    (job.input as SweepUnitDispatchInput).promptTemplate = opts.promptTemplate(
      job.input as WorkUnit,
    );
  }

  // The dispatch view: the CENTRAL registry (sweep.planSweep AND the
  // registered sweep.unit — the e2e exercises the real dispatch path), with
  // the ONE injected seam: pr.assemblePrs over the fake forge.
  const central = new Map((await list()).map((entry) => [entry.name, entry] as const));
  if (!central.has('sweep.unit')) throw new Error('e2e setup: sweep.unit is not registered');
  if (!central.has('pr.assemblePrs'))
    throw new Error('e2e setup: pr.assemblePrs is not registered');
  const overridden = new Map<string, OpRegistryEntry>([
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
  const run = await runPlan(
    plan,
    { concurrency: 1, stopOnError: false, journalDir: opts.journalDir },
    view,
  );

  // The in-plan planner job must re-derive the SAME fan-out the caller
  // expanded from — job ids and units (workspace-all/explicit are
  // deterministic over the static input; changed-vs-base re-derives from
  // live state, so a stale phase-A report diverges HERE, loudly).
  const planRow = run.jobs.find((job) => job.jobId === SWEEP_PLAN_JOB_IDS.plan);
  if (planRow?.result.status === 'ok') {
    const rederived = planRow.result.value as PlanSweepReport;
    const planIds = rederived.jobs.map((job) => job.id).join(',');
    const callerIds = planner.jobs.map((job) => job.id).join(',');
    const planUnits = JSON.stringify(rederived.units);
    const callerUnits = JSON.stringify(planner.units);
    if (planIds !== callerIds || planUnits !== callerUnits) {
      throw new Error(
        `e2e: the in-plan planner re-derived DIFFERENT units than the caller expanded from — the expanded graph is stale; re-run phase A. caller: ${callerUnits} in-plan: ${planUnits}`,
      );
    }
  }

  // THE ASSEMBLE LEG (jTPa8), composed post-run from the committed markers —
  // the fleet gate first (every unit must have succeeded; a failed unit
  // withholds the whole fleet's PRs), then the marker filter (only units
  // that COMMITTED AND PUSHED assemble; a no-change unit never yields an
  // empty-diff PR). An empty result assembles nothing at all.
  const fleetOk = planner.jobs.every((job) => {
    const row = run.jobs.find((candidate) => candidate.jobId === job.id);
    return row?.result.status === 'ok';
  });
  let assembleRun: RunReport | undefined;
  if (fleetOk && planner.units.length > 0 && assembleTemplate !== undefined) {
    const markers = await readCommittedMarkers(
      opts.config.repoRoot,
      opts.config.worktreesDir,
      opts.config.runPrefix,
    );
    const templateInput = assembleTemplate.input as AssemblePrsInput;
    const assembleInput: AssemblePrsInput = {
      ...templateInput,
      packages: templateInput.packages.filter((pkg) =>
        markers.some((marker) => marker.branch === pkg.branch),
      ),
    };
    const assemblePlan = {
      id: SWEEP_PLAN_ID,
      label: 'sweep: marker-filtered fleet assembly (the committed units only)',
      jobs: [{ id: SWEEP_PLAN_JOB_IDS.assemble, op: 'pr.assemblePrs', input: assembleInput }],
    };
    assembleRun = await runPlan(
      assemblePlan,
      { concurrency: 1, stopOnError: false, journalDir: opts.journalDir },
      view,
    );
  }
  return {
    planner,
    run,
    ...(assembleRun !== undefined ? { assembleRun } : {}),
    output: renderSweepOutput(opts.config, planner, run),
  };
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
 * The journal-tail derivation: ONE SalvageEntry per UNIT (per kind/slug — a
 * multi-fixer fleet plans several trees per package; grouping per package
 * would leave sibling trees unclassified), its tail read from the run's
 * events IN JOURNAL ORDER.
 *
 * Per unit (allTerminal = its job's LAST finish is ok — a failed unit is
 * terminal but NOT done: the work did not happen, so the tree is not
 * clean-done; salvage must see it as pending, not done):
 *   - allTerminal — the unit job's last finish is ok;
 *   - lastStep    — the job ID of the LAST matching job-finished event in
 *     journal order (jobs can finish out of plan order; the tail is the
 *     journal's last word, not the plan's). No terminal event for the unit
 *     → NO lastStep (a run interrupted before its first write carries no
 *     done evidence — salvage's absent-evidence branch, I9).
 */
export function salvageEntriesFor(
  config: SweepPlanConfig,
  planner: PlanSweepReport,
  events: readonly JournalEvent[],
): SalvageEntry[] {
  const finishes = new Map<string, string | undefined>(); // jobId → last terminal status
  const finishOrder: string[] = []; // jobIds in journal finish order
  for (const event of events) {
    if (event.type === 'job-finished') {
      finishes.set(event.jobId, event.result.status);
      finishOrder.push(event.jobId);
    }
  }
  const entries: SalvageEntry[] = [];
  for (const unit of planner.units) {
    // The RESOLVED segments from the enriched job input (jTPa1 collisions)
    // when present; the derived ones otherwise — the tail must name the tree
    // the unit ACTUALLY ran in.
    const job = planner.jobs.find(
      (candidate) =>
        (candidate.input as WorkUnit).package === unit.package &&
        (candidate.input as WorkUnit).fixer === unit.fixer,
    );
    const dispatched = job?.input as SweepUnitDispatchInput | undefined;
    const segments =
      dispatched?.kind !== undefined && dispatched?.slug !== undefined
        ? {
            kind: dispatched.kind,
            slug: dispatched.slug,
            branch: `${config.runPrefix}/${dispatched.kind}/${dispatched.slug}`,
          }
        : sweepUnitSegments(config.runPrefix, unit);
    if (job === undefined) continue; // a unit without its job cannot be tailed
    const lastStep = finishOrder.findLast((jobId) => jobId === job.id);
    entries.push({
      path: absoluteWorktreePath(config, segments.kind, segments.slug),
      branch: segments.branch,
      journal: {
        ...(lastStep !== undefined ? { lastStep: job.id } : {}),
        allTerminal: finishes.get(job.id) === 'ok',
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
  return runEventsAt(journalDir, planId, -1);
}

/** The event list of the plan's INDEXth journaled run (-1 = latest; runs() is oldest-first). */
export async function runEventsAt(
  journalDir: string,
  planId: string,
  index: number,
): Promise<JournalEvent[]> {
  const log = openRunLog(journalDir);
  const runIds = candidateRunsForPlan(await log.runs(), planId);
  const selected = runIds.at(index);
  if (selected === undefined) {
    throw new Error(`e2e: no journaled run of plan '${planId}' under '${journalDir}'`);
  }
  return log.read(selected);
}
