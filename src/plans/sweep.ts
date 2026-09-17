// sweep — the shipped sweep plan (goal D4; ws-d item 5; arm-a §4.2 loop
// steps 1–7): the fleet-sweep pipeline as DATA. Plans compose; ops execute —
// the per-unit executor lives in src/ops/sweep/unit.ts ('sweep.unit'), and
// this module authors the expanded job graph over its D1-pinned contract
// name.
//
// THE TWO-PHASE EXPANSION CONTRACT (why this plan is not one static graph):
// the frozen kernel wires ORDER (`dependsOn`) and never dataflow — a Job's
// `input` is static JSON (src/kernel/runner.ts dispatches each job's own
// input verbatim; the merge-prs and review-loop plans record the same
// constraint). A sweep's phase B is FAN-OUT DATA: only `sweep.planSweep`'s
// output knows how many units exist and what they are. So a sweep run is
// two phases over ONE plan id:
//
//   Phase A — run the planner (`sweep.planSweep`) and keep its report; the
//   report's `units` and dispatch-ready `jobs` (op 'sweep.unit' — the D1-
//   pinned contract name, planSweep.ts) are the fan-out data.
//   Phase B — buildSweepPlan(config, report) emits the expanded static
//   graph: the planner job FIRST (re-run honestly; under the workspace-all
//   and explicit selectors the planner is deterministic over its static
//   input, so it re-derives the same units the caller expanded from —
//   changed-vs-base re-derives from LIVE state by design, so a caller
//   expanded from a stale phase-A report is divergent by construction and
//   the caller must re-run phase A), one unit job per PlanSweepReport job
//   (embedded VERBATIM, re-rooted on the planner job, each input ENRICHED
//   with the run context AND the RESOLVED branch segments so it is
//   dispatch-grade for the central 'sweep.unit' entry), and ONE
//   `pr.assemblePrs` job depending on every unit (the fleet assembles only
//   when every unit succeeded — a failed unit blocks the whole fleet's PRs;
//   per-unit isolation happened at the unit jobs). The builder's knobs
//   (fixer wiring, probe command, push, allowlists) arrive through
//   `unitJobOverlay` / the caller's final enrichment — see
//   SweepUnitDispatchInput (src/ops/sweep/unit.ts).
//
// COMMITTED MARKERS ARE THE ASSEMBLE LEG'S SOURCE OF TRUTH (jTPa8): the
// expanded plan's assemble job is the DECLARED fleet, but only a unit whose
// fix is ON THE REMOTE writes its run-state marker
// (`<runStateDir>/committed/<kind>/<slug>.json`, sweep.unit step 10) — so
// the reference wiring composes the ACTUAL assemble dispatch post-run from
// the markers (a no-change unit never assembles an empty-diff PR), and an
// empty filtered fleet dispatches no assemble at all.
//
// RESUME (the interrupted-run story, arm-a §4.2): a sweep re-invoke is
// SALVAGE + REUSE, not kernel journal-replay. Replaying the journal would
// SKIP a finished unit job — hiding exactly the I7 surface a re-invoke must
// show (a reused tree re-probes its baseline). Instead the caller salvages
// the interrupted trees (sweep.salvage over the journal tail it scanned),
// re-invokes the SAME expanded plan, and every unit job re-executes:
// `sweep.worktreeFor` REUSES the strictly-clean tree, the unit re-probes
// (I7: the baseline probe NEVER caches — every invocation runs the check
// again), the fixer no-ops on an already-fixed tree, and the commit step
// skips when nothing is staged. Idempotency lives in the ops, not in a skip.
// BASELINE STATE NEVER TOUCHES THE TREE: the unit's baseline snapshot is
// written to the run-state dir (sweepRunStateDir — NESTED under
// worktreesDir as `<worktreesDir>/.cq-state/<run-prefix>`), so a tree
// carries no untracked tool state and a reuse is automatically strictly
// clean.
//
// THE FLOOR (the registry entry): an EMPTY fleet run of the same builder —
// a schema-valid plan whose planner job plans nothing (empty manifest) and
// which carries NO assemble job (an empty fleet has no tracker; buildSweepPlan
// emits the assembler only for a non-empty fleet — assemblePrs is
// tracker-first, so even zero packages would touch a real forge). Run
// verbatim the floor is a harmless pass. There is NO placeholder probe job:
// a probe is per-package worktree-scoped data and has no honest static
// floor input.
//
// PR BRANCHES ARE STATIC DATA: `worktreeFor` derives each tree's branch
// deterministically (`<runPrefix>/<kind>/<slug>`), so the assembler's input
// needs no runtime output — sweepUnitSegments (src/ops/sweep/unit.ts) is the
// one derivation shared by the builder (assemble input) and the unit op
// (worktreeFor input), and the builder ships the RESOLVED kind/slug on each
// enriched unit job so derivation collisions (jTPa1: `@a/b` vs `a.b` both
// normalize to `a-b`) are disambiguuated ONCE — a deterministic `-2` suffix
// in unit order, the planner's job-id idiom — and every surface (branch,
// worktree, committed marker, assembler) agrees.
import type { AssemblePrsInput } from '../ops/pr/assemblePrs.js';
import type { Plan, PlanRegistryEntry } from '../kernel/types.js';
import type {
  PlanSweepInput,
  PlanSweepLedgerConfig,
  PlanSweepPackage,
  PlanSweepReport,
  PlanSweepSelector,
} from '../ops/sweep/planSweep.js';
import { sweepUnitSegments } from '../ops/sweep/unit.js';
import type { SweepUnitDispatchInput, SweepUnitSegments } from '../ops/sweep/unit.js';

/**
 * The shipped plan's stable id (the discovery name and the Plan.id — also
 * the journal resume key across a run's phases).
 */
export const SWEEP_PLAN_ID = 'sweep';

/** The stable ids of the jobs the BUILDER authors (unit jobs come from the report). */
export const SWEEP_PLAN_JOB_IDS = {
  /** The planner job — always the plan's first job (the fan-out producer). */
  plan: 'sweep-plan',
  /** The tracker-first fleet assembler — depends on every unit job. */
  assemble: 'sweep-assemble',
} as const;

/**
 * The unit-job knobs a caller layers OVER the run context the builder
 * enriches with — everything that makes an enriched unit job fully
 * dispatchable (see SweepUnitDispatchInput).
 */
export type SweepUnitJobOverlay = Partial<
  Omit<
    SweepUnitDispatchInput,
    'repoRoot' | 'worktreesDir' | 'runPrefix' | 'base' | 'package' | 'fixer' | 'files'
  >
>;

/** Config-grade inputs of one sweep run — everything EXCEPT the fan-out data. */
export interface SweepPlanConfig {
  /** Repository the worktrees check out from and the PRs target. */
  repoRoot: string;
  /** Parent dir for worktree checkouts (CONFIG-GRADE — the worktreeFor seam). */
  worktreesDir: string;
  /** The run's reserved branch prefix (e.g. `cq/09-16a`); every PR head carries it. */
  runPrefix: string;
  /** The base both the worktrees check out and the PRs target. */
  base: string;
  /** The workspace manifest as given — selection never invents packages. */
  packages: PlanSweepPackage[];
  /** REQUIRED — there is no default selector (UC §1 row 16). */
  selector: PlanSweepSelector;
  /** Requested fixer labels; each becomes a work unit per selected package. */
  fixers: string[];
  /** Known file-set per package name; a package absent here carries an empty file-set. */
  packageFiles?: Record<string, string[]>;
  /** When set, the planner consults the ledger view (UC §1 row 8). */
  ledger?: PlanSweepLedgerConfig;
  /** Tracker PR branch override; default `<runPrefix>/tracker`. */
  trackerBranch?: string;
  /** Tracker PR title override; default derived from the run prefix. */
  trackerTitle?: string;
}

/** The planner input a config authors — the planSweep job's static input. */
export function sweepPlannerInput(config: SweepPlanConfig): PlanSweepInput {
  return {
    repoRoot: config.repoRoot,
    packages: config.packages,
    selector: config.selector,
    fixers: config.fixers,
    ...(config.packageFiles !== undefined ? { packageFiles: config.packageFiles } : {}),
    ...(config.ledger !== undefined ? { ledger: config.ledger } : {}),
  };
}

/** The assembler input a config authors — static data, no runtime output needed. */
function assembleInputOf(
  config: SweepPlanConfig,
  report: PlanSweepReport,
  resolved: SweepUnitSegments[],
): AssemblePrsInput {
  // The tracker branch is NAMED here but not created/pushed by this lane —
  // the per-unit branches are pushed (sweep.unit's push leg); the tracker
  // branch creation/push + real-forge PR verification is the deferred
  // phase-4 WS-K real-forge surface (review-debt #173).
  return {
    repoRoot: config.repoRoot,
    runPrefix: config.runPrefix,
    base: config.base,
    tracker: {
      title: config.trackerTitle ?? `Sweep run ${config.runPrefix}`,
      branch: config.trackerBranch ?? `${config.runPrefix}/tracker`,
    },
    packages: report.units.map((unit, index) => ({
      name: unit.package,
      branch: resolved[index]?.branch ?? sweepUnitSegments(config.runPrefix, unit).branch,
      title: `fix(${unit.package}): sweep ${unit.fixer}`,
    })),
    draft: true,
  };
}

/**
 * Author the EXPANDED sweep plan (phase B) from the config plus the phase-A
 * planner report — see the module header for the two-phase contract. The
 * planner job stays FIRST and re-runs honestly (under workspace-all/explicit,
 * same input → same units → the same embedded unit jobs); each
 * planner-emitted job is embedded VERBATIM (id, op, input) re-rooted on the
 * planner job with its input ENRICHED to a dispatch-grade
 * SweepUnitDispatchInput (run context + `unitJobOverlay`); the assembler
 * depends on every unit job. An EMPTY fleet carries no assembler
 * (assemblePrs is tracker-first — zero packages would still touch a forge).
 * `planId` overrides the plan id (the test-fix plan reuses this builder
 * under its own id); `unitJobOverlay` layers the caller's dispatch knobs
 * (driver/check/push/allowlists) onto every unit job.
 */
export function buildSweepPlan(
  config: SweepPlanConfig,
  report: PlanSweepReport,
  planId: string = SWEEP_PLAN_ID,
  unitJobOverlay?: SweepUnitJobOverlay,
): Plan {
  // jTPa1: resolve each unit's segments ONCE, disambiguating normalization
  // collisions deterministically (a `-2` suffix in unit order — the
  // planner's job-id idiom) and shipping the RESOLVED kind/slug on the
  // enriched job so the op's branch, worktree, and committed marker all
  // agree with the assembler.
  // Alignment guard for hand-built reports: planSweep emits EXACTLY one job
  // per unit (same loop, index-aligned) — a report whose jobs and units
  // diverge would silently mis-resolve segments or drop units below.
  if (report.jobs.length !== report.units.length) {
    throw new Error(
      `buildSweepPlan: the phase-A report is misaligned — ${String(report.jobs.length)} job(s) vs ${String(report.units.length)} unit(s); planSweep emits exactly one job per unit`,
    );
  }
  const usedSlugs = new Map<string, number>();
  const resolvedSegments: SweepUnitSegments[] = report.units.map((unit) => {
    const base = sweepUnitSegments(config.runPrefix, unit);
    const key = `${base.kind}/${base.slug}`;
    const ordinal = usedSlugs.get(key) ?? 0;
    usedSlugs.set(key, ordinal + 1);
    return ordinal === 0
      ? base
      : {
          kind: base.kind,
          slug: `${base.slug}-${ordinal + 1}`,
          branch: `${config.runPrefix}/${base.kind}/${base.slug}-${ordinal + 1}`,
        };
  });
  const unitJobs = report.jobs.map((job, index) => ({
    ...job,
    dependsOn: [SWEEP_PLAN_JOB_IDS.plan],
    input: {
      ...(job.input as object),
      repoRoot: config.repoRoot,
      worktreesDir: config.worktreesDir,
      runPrefix: config.runPrefix,
      base: config.base,
      kind: resolvedSegments[index]?.kind,
      slug: resolvedSegments[index]?.slug,
      ...(unitJobOverlay ?? {}),
    },
  }));
  return {
    id: planId,
    label:
      'sweep: planSweep → per-unit [worktree → probe → fixer → gates → commit → push] → tracker-first PR assembly ' +
      '(two-phase contract: phase A runs the planner, phase B is THIS expanded graph; ' +
      'the per-unit pipeline is ONE composition job — the frozen Job has no cross-job data channel)',
    jobs: [
      { id: SWEEP_PLAN_JOB_IDS.plan, op: 'sweep.planSweep', input: sweepPlannerInput(config) },
      ...unitJobs,
      // The assembler exists only for a non-empty fleet: `pr.assemblePrs` is
      // TRACKER-FIRST (UC row 22) — even zero packages would search for (and
      // create) a tracker on the real forge, so the floor's empty fleet
      // assembles nothing and stays a harmless pass. THIS job is the
      // DECLARED fleet: the reference wiring composes the ACTUAL assemble
      // dispatch post-run from the committed markers (jTPa8).
      ...(unitJobs.length > 0
        ? [
            {
              id: SWEEP_PLAN_JOB_IDS.assemble,
              op: 'pr.assemblePrs',
              input: assembleInputOf(config, report, resolvedSegments),
              dependsOn: unitJobs.map((job) => job.id),
            },
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// The floor — the discovered registry entry
// ---------------------------------------------------------------------------

/**
 * The shipped floor's config: an EMPTY manifest over the repo the caller is
 * in — the planner selects nothing, no unit jobs exist, and the assembler
 * assembles nothing (a harmless empty pass, the merge-prs precedent).
 */
function floorConfig(): SweepPlanConfig {
  return {
    repoRoot: '.',
    worktreesDir: 'worktrees/cq',
    runPrefix: 'cq/sweep',
    base: 'main',
    packages: [],
    selector: { mode: 'workspace-all' },
    fixers: ['fix'],
  };
}

/** The empty planner report the floor carries (no phase A has run). */
function emptyReport(): PlanSweepReport {
  return { jobs: [], units: [], suppressed: [], needsHuman: [] };
}

/**
 * The discovered plan entry (src/plans/registry.ts convention): the EMPTY
 * fleet form of buildSweepPlan — the discoverable, schema-valid floor, not a
 * configured sweep. Real runs author the plan per-run via buildSweepPlan
 * over a phase-A planner report.
 */
export const plan: PlanRegistryEntry = {
  name: SWEEP_PLAN_ID,
  importer: async () => buildSweepPlan(floorConfig(), emptyReport()),
};
