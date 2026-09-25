// sweep-run — the caller side of the sweep plan's two-phase contract (arm-a
// §4.2 loop steps 1–7): the composition a sweep invocation runs AROUND the
// kernel runner. INTERNAL: not re-exported from the plans barrel or the
// package root (a public SDK surface is a separate decision); the e2e wiring
// (test/e2e/sweep/run-sweep.ts) and the in-process tests import it directly.
//
//   phase A  run the planner (`sweep.planSweep`) and keep its report — the
//            fan-out data;
//   phase B  buildSweepPlan(config, report) → runPlan through the op
//            registry view, minus the declared tracker-branch and assemble
//            legs (recomposed post-run below);
//   rescue   re-dispatch retryable unit faults (the budget below);
//   assemble the fleet gate, then the committed-marker filter, then the
//            tracker-branch + assemble dispatch — or NO dispatch at all.
//
// WHY THIS IS NOT ONE STATIC PLAN: a Job's input is static JSON (the
// runner dispatches each job's own input verbatim; src/plans/sweep.ts
// records the constraint), so which units committed — the assemble leg's
// input — is only knowable after the units ran. The rescue policy lives here
// for the same reason and under I8: rescue is a plan-runner concern, the
// unit op only reports its fault class; drivers never rescue themselves.
//
// Sweep-layer resume is salvage + reuse, never kernel journal-replay (the
// rationale lives in src/plans/sweep.ts): salvageInterruptedRun scans ONE
// journaled run of the plan id, derives each UNIT's SalvageEntry journal
// tail (one entry per unit tree; lastStep = the LAST job-finished event in
// journal order), and runs the salvage op over the inventory.
import { resolve } from 'node:path';
import { candidateRunsForPlan, openRunLog } from '../kernel/journal.js';
import { runPlan, type OpRegistryView } from '../kernel/runner.js';
import type { JournalEvent, Job, Op, OpRegistryEntry, Plan, RunReport } from '../kernel/types.js';
import type { AssemblePrsInput } from '../ops/pr/assemblePrs.js';
import {
  makePlanSweep,
  makeSubprocessSweepPlannerDeps,
  SWEEP_UNIT_OP,
} from '../ops/sweep/planSweep.js';
import type { PlanSweepInput, PlanSweepReport, WorkUnit } from '../ops/sweep/planSweep.js';
import {
  makeSalvage,
  makeSubprocessSalvageEffects,
  type SalvageEffects,
  type SalvageEntry,
  type SalvagePlan,
} from '../ops/sweep/salvage.js';
import {
  readCommittedMarkers,
  RETRYABLE_FAULT_CLASSES,
  sweepUnitFaultClass,
  sweepUnitSegments,
  type CommittedMarker,
  type SweepUnitCheckConfig,
  type SweepUnitDispatchInput,
  type SweepUnitDriverConfig,
} from '../ops/sweep/unit.js';
import { list } from '../registry/index.js';
import {
  buildSweepPlan,
  sweepPlannerInput,
  SWEEP_PLAN_ID,
  SWEEP_PLAN_JOB_IDS,
  type SweepPlanConfig,
} from './sweep.js';

/** Everything one sweep invocation needs; the caller owns the scenario. */
export interface SweepRunOpts {
  /** Config-grade sweep inputs (repo, worktrees, naming, manifest, selector, rescue). */
  config: SweepPlanConfig;
  /** NDJSON journal dir — one run file per dispatch, shared across re-invokes. */
  journalDir: string;
  /** The JSON driver binding, per unit job. */
  driver: SweepUnitDriverConfig;
  /** The JSON probe binding (the check command template), per unit job. */
  check: SweepUnitCheckConfig;
  /**
   * The explicit run-state dir every unit job carries (review-debt #174's
   * trust vouch): it must sit OUTSIDE the driver's write reach so the
   * strand-retry's scanned-commit record is trustworthy. `null` OMITS the
   * field — the unit derives a driver-reachable location and its
   * strand-retry refuses. No default: the vouch is the caller's decision.
   */
  runStateDir: string | null;
  /** The per-unit fixer prompt TEMPLATE; absent keeps the dispatch default. */
  promptTemplate?: (unit: WorkUnit) => string;
  /** Push committed branches to the origin; default true. */
  push?: boolean;
  /** Optional staged-path allowlist overlay (the test-fix scope pin). */
  stagePathAllowlist?: { patterns: string[] };
  /** The units dispatch's concurrency; default 1. */
  concurrency?: number;
}

/** The injected seams; each default is the production wiring. */
export interface SweepRunDeps {
  /** Phase A's planner; default `sweep.planSweep` over subprocess deps at `config.repoRoot`. */
  planner?: Op<PlanSweepInput, PlanSweepReport>;
  /** The dispatch view for every runPlan; default the central op registry. */
  registry?: OpRegistryView;
  /** The kernel runner every dispatch goes through; default the kernel's runPlan. */
  runPlan?: typeof runPlan;
  /** The committed-marker read the assemble filter uses; default readCommittedMarkers. */
  readMarkers?: (
    repoRoot: string,
    worktreesDir: string,
    runPrefix: string,
    runStateDir?: string,
  ) => Promise<CommittedMarker[]>;
}

/** One sweep invocation's outcome: the phase-A report, the phase-B run, the default output. */
export interface SweepRunOutcome {
  planner: PlanSweepReport;
  run: RunReport;
  /** The EXPANDED units plan (its job inputs carry the resolved kind/slug — the salvage-tail source). */
  plan: Plan;
  /**
   * The marker-filtered assemble run (jTPa8) — present exactly when every
   * unit succeeded AND at least one unit committed+pushed; its journal is
   * its own run file (the plan id's LATEST).
   */
  assembleRun?: RunReport;
  /** The rescue re-dispatch runs, in dispatch order (arm-a §4.2 step 5). */
  rescueRuns?: RunReport[];
  /** The failures-only DEFAULT output (see renderSweepOutput). */
  output: string;
}

/**
 * The default dispatch view: the central registry, typed at the bottom
 * instantiation exactly the way review-loop's centralRegistryView is
 * (unknown-instantiated entries do not widen down to never).
 */
const centralRegistryView = async (): Promise<OpRegistryView> => {
  const central = new Map((await list()).map((entry) => [entry.name, entry] as const));
  return { get: (name) => central.get(name) as OpRegistryEntry<never, never> | undefined };
};

/** Run the full sweep once: plan (phase A) → expand → journaled runPlan (phase B) → rescue → assemble. */
export async function runSweep(
  opts: SweepRunOpts,
  deps: SweepRunDeps = {},
): Promise<SweepRunOutcome> {
  // Phase A: the planner (input-driven).
  const plannerOp =
    deps.planner ?? makePlanSweep(makeSubprocessSweepPlannerDeps(opts.config.repoRoot));
  const planned = await plannerOp(sweepPlannerInput(opts.config));
  if (planned.status !== 'ok') {
    throw new Error(`sweep: the planner failed — ${JSON.stringify(planned)}`);
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
  const trackerBranchTemplate = fullPlan.jobs.find(
    (job) => job.id === SWEEP_PLAN_JOB_IDS.trackerBranch,
  );
  // BOTH the declared tracker-branch leg and the declared assembler are
  // removed here: the ACTUAL assemble leg is recomposed post-run from the
  // committed markers (jTPa8), so the tracker branch is pushed only when a
  // non-empty fleet actually assembles (review-debt #173) — never for an
  // all-no-op fleet.
  const plan = {
    ...fullPlan,
    jobs: fullPlan.jobs.filter(
      (job) =>
        job.id !== SWEEP_PLAN_JOB_IDS.assemble && job.id !== SWEEP_PLAN_JOB_IDS.trackerBranch,
    ),
  };
  for (const job of plan.jobs) {
    if (job.op !== SWEEP_UNIT_OP) {
      continue;
    }
    // The #174 trust vouch: the caller supplies the run-state dir
    // EXPLICITLY (outside the worktrees dir) so the strand-retry's
    // scanned-commit record is trustworthy. `null` OMITS it (the no-vouch
    // refusal branch).
    if (opts.runStateDir === null) {
      delete (job.input as SweepUnitDispatchInput).runStateDir;
    } else {
      (job.input as SweepUnitDispatchInput).runStateDir = opts.runStateDir;
    }
    if (opts.promptTemplate !== undefined) {
      (job.input as SweepUnitDispatchInput).promptTemplate = opts.promptTemplate(
        job.input as WorkUnit,
      );
    }
  }

  const view = deps.registry ?? (await centralRegistryView());
  const dispatch = deps.runPlan ?? runPlan;
  const run = await dispatch(
    plan,
    {
      concurrency: opts.concurrency ?? 1,
      stopOnError: false,
      journalDir: opts.journalDir,
    },
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
        `sweep: the in-plan planner re-derived DIFFERENT units than the caller expanded from — the expanded graph is stale; re-run phase A. caller: ${callerUnits} in-plan: ${planUnits}`,
      );
    }
  }

  // THE RESCUE LANE (arm-a §4.2 step 5; I8 — the rescue POLICY lives HERE in
  // the plan/runner layer, never in the agent driver): a failed unit whose
  // fault class is RETRYABLE ([PROBE]/[INFRA]/[REGRESSION]) is re-dispatched
  // up to config.rescue.maxRedispatch times (default 1), each attempt its
  // OWN journaled job (`<jobId>-r2`, `-r3`, …). TAMPER/SCOPE verdicts are
  // NEVER re-dispatched — they are verdicts about the work, and after the
  // budget is spent every unit lands in the salvage lanes (preserve/resume
  // per tree state).
  const rescueBudget = opts.config.rescue?.maxRedispatch ?? 1;
  const rescueRuns: RunReport[] = [];
  const unitStatusAfterRescue = new Map<string, 'ok' | 'not-ok'>();
  if (rescueBudget > 0) {
    for (const job of planner.jobs) {
      const row = run.jobs.find((candidate) => candidate.jobId === job.id);
      if (row === undefined || row.result.status === 'ok') continue;
      const error = row.result.status === 'failed' ? row.result.error : '';
      const faultClass = sweepUnitFaultClass(error);
      if (!RETRYABLE_FAULT_CLASSES.includes(faultClass)) continue;
      const unitJob = plan.jobs.find((candidate) => candidate.id === job.id);
      if (unitJob === undefined) continue;
      let lastError = error;
      for (let attempt = 2; attempt <= 1 + rescueBudget; attempt += 1) {
        const rescuePlan = {
          id: SWEEP_PLAN_ID,
          label: `sweep: rescue re-dispatch (attempt ${attempt} of ${1 + rescueBudget})`,
          jobs: [
            {
              ...unitJob,
              id: `${unitJob.id}-r${attempt}`,
              dependsOn: [] as string[],
            },
          ],
        };
        const rescueReport = await dispatch(
          rescuePlan,
          { concurrency: 1, stopOnError: false, journalDir: opts.journalDir },
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
          // A rescue attempt that fails with a NON-retryable class stops the
          // loop for this unit immediately (no budget burn on verdicts).
          if (!RETRYABLE_FAULT_CLASSES.includes(sweepUnitFaultClass(lastError))) break;
        }
      }
      unitStatusAfterRescue.set(job.id, lastError === '' ? 'ok' : 'not-ok');
    }
  }

  // THE ASSEMBLE LEG (jTPa8), composed post-run from the committed markers —
  // the fleet gate first (every unit must have succeeded — a unit its rescue
  // attempt rescued counts as succeeded; a still-failed unit withholds the
  // whole fleet's PRs), then the marker filter (a package assembles only
  // when its unit COMMITTED AND PUSHED — matched by branch AND package name;
  // a no-change unit never yields an empty-diff PR). An empty filtered fleet
  // dispatches NO assemble at all (no empty tracker).
  const fleetOk = planner.jobs.every((job) => {
    const row = run.jobs.find((candidate) => candidate.jobId === job.id);
    if (row?.result.status === 'ok') return true;
    return unitStatusAfterRescue.get(job.id) === 'ok';
  });
  let assembleRun: RunReport | undefined;
  if (
    fleetOk &&
    planner.units.length > 0 &&
    assembleTemplate !== undefined &&
    trackerBranchTemplate !== undefined
  ) {
    const markers = await (deps.readMarkers ?? readCommittedMarkers)(
      opts.config.repoRoot,
      opts.config.worktreesDir,
      opts.config.runPrefix,
      opts.runStateDir ?? undefined,
    );
    const templateInput = assembleTemplate.input as AssemblePrsInput;
    const assembleInput: AssemblePrsInput = {
      ...templateInput,
      packages: templateInput.packages.filter((pkg) =>
        markers.some((marker) => marker.branch === pkg.branch && marker.package === pkg.name),
      ),
    };
    if (assembleInput.packages.length > 0) {
      // The tracker-branch leg FIRST (review-debt #173): the tracker-first
      // assembler needs the tracker head on the remote before it opens the
      // PR. Its declared unit dependencies are dropped (the units are not
      // jobs of this composed run) — the fleet gate above already proved
      // every unit succeeded.
      const assemblePlan = {
        id: SWEEP_PLAN_ID,
        label:
          'sweep: tracker-branch push + marker-filtered fleet assembly (the committed units only)',
        jobs: [
          {
            id: SWEEP_PLAN_JOB_IDS.trackerBranch,
            op: 'pr.ensureTrackerBranch',
            input: trackerBranchTemplate.input,
          },
          {
            id: SWEEP_PLAN_JOB_IDS.assemble,
            op: 'pr.assemblePrs',
            input: assembleInput,
            dependsOn: [SWEEP_PLAN_JOB_IDS.trackerBranch],
          },
        ],
      };
      assembleRun = await dispatch(
        assemblePlan,
        { concurrency: 1, stopOnError: false, journalDir: opts.journalDir },
        view,
      );
    }
  }
  return {
    planner,
    run,
    plan,
    ...(rescueRuns.length > 0 ? { rescueRuns } : {}),
    ...(assembleRun !== undefined ? { assembleRun } : {}),
    output: renderSweepOutput(opts.config, planner, run),
  };
}

// ---------------------------------------------------------------------------
// The failures-only DEFAULT output — the sweep's reporting contract
// ---------------------------------------------------------------------------

/**
 * The default output prints ONLY failures — one line per failed unit naming
 * the package and the reason, then a bare count. A clean run carries no
 * per-package noise at all (the footer's totals name no package).
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

/** Scan one journaled run of the plan id and classify its interrupted trees (the salvage op). */
export async function salvageInterruptedRun(
  opts: {
    journalDir: string;
    planId: string;
    config: SweepPlanConfig;
    planner: PlanSweepReport;
    /**
     * The ENRICHED expanded-plan jobs (SweepRunOutcome.plan.jobs) — the
     * resolved kind/slug source (jTPa1 collisions). Absent: segments are
     * derived, which mis-derives a collision fleet's `-2` tree.
     */
    enrichedJobs?: Job[];
    /** Journal-run index to scan (runs() is oldest-first; default -1 = latest). The rescue lane appends runs AFTER the units run, so target 0 explicitly. */
    runIndex?: number;
  },
  deps: { salvageEffects?: SalvageEffects } = {},
): Promise<SalvagePlan> {
  const events = await runEventsAt(opts.journalDir, opts.planId, opts.runIndex ?? -1);
  const salvaged = await makeSalvage(deps.salvageEffects ?? makeSubprocessSalvageEffects())({
    repoRoot: opts.config.repoRoot,
    entries: salvageEntriesFor(opts.config, opts.planner, events, opts.enrichedJobs),
  });
  if (salvaged.status !== 'ok') {
    throw new Error(`sweep: salvage failed — ${JSON.stringify(salvaged)}`);
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
 *
 * SEGMENTS come from `enrichedJobs` — the EXPANDED plan's unit-job inputs
 * carry the builder's RESOLVED kind/slug (jTPa1 collisions: without them a
 * collision fleet salvages the first tree twice and the `-2` tree is never
 * classified). Absent enrichedJobs: derived from the raw unit (the
 * collision-free default).
 */
export function salvageEntriesFor(
  config: SweepPlanConfig,
  planner: PlanSweepReport,
  events: readonly JournalEvent[],
  enrichedJobs?: readonly Job[],
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
    const job = planner.jobs.find(
      (candidate) =>
        (candidate.input as WorkUnit).package === unit.package &&
        (candidate.input as WorkUnit).fixer === unit.fixer,
    );
    if (job === undefined) continue; // a unit without its job cannot be tailed
    const dispatched = (enrichedJobs?.find((candidate) => candidate.id === job.id) ?? job).input as
      | SweepUnitDispatchInput
      | undefined;
    const segments =
      dispatched?.kind !== undefined && dispatched?.slug !== undefined
        ? {
            kind: dispatched.kind,
            slug: dispatched.slug,
            branch: `${config.runPrefix}/${dispatched.kind}/${dispatched.slug}`,
          }
        : sweepUnitSegments(config.runPrefix, unit);
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
    throw new Error(`sweep: no journaled run of plan '${planId}' under '${journalDir}'`);
  }
  return log.read(selected);
}
