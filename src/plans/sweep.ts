// sweep — the shipped sweep plan (goal D4; ws-d item 5; arm-a §4.2 loop
// steps 1–7): the fleet-sweep pipeline as DATA, plus the expansion contract
// and the per-unit executor its phase-B jobs name.
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
//   graph: the planner job FIRST (the plan's producer, re-run honestly —
//   the planner is deterministic over its static input, so it re-derives
//   exactly the units the caller expanded from), one unit job per
//   PlanSweepReport job (embedded VERBATIM, re-rooted on the planner job),
//   and ONE `pr.assemblePrs` job depending on every unit (the fleet
//   assembles only when every unit succeeded — a failed unit blocks the
//   whole fleet's PRs; per-unit isolation happened at the unit jobs).
//
// THE UNIT JOB'S OP — 'sweep.unit' is a COMPOSITION, not an atomic op: its
// pipeline is a dataflow (worktreeFor's workspace feeds the probe's cwd, the
// baseline FailureSet feeds the gate, …), so — per the merge-prs precedent —
// the whole per-package pipeline is ONE job whose op composes the atomic ops
// in memory. makeSweepUnitOp is that composition, shipped HERE because
// src/ops/sweep is a frozen lane surface (FLAG: the op belongs in
// src/ops/sweep as `sweep.unit` with a registry entry; until then the
// central registry cannot dispatch this plan's unit jobs — callers bind
// makeSweepUnitOp into their own OpRegistryView under SWEEP_UNIT_OP, exactly
// what the D4 e2e does). The caller re-binds it per run because every effect
// seam is injected: git (worktrees + commits), the check runner (probes),
// the Driver seam (the fixer worker), and the per-run naming config.
//
// RESUME (the interrupted-run story, arm-a §4.2): a sweep re-invoke is
// SALVAGE + REUSE, not kernel journal-replay. Replaying the journal would
// SKIP a finished unit job — hiding exactly the I7 surface a re-invoke must
// show (a reused tree re-probes its baseline). Instead the caller salvages
// the interrupted trees (sweep.salvage over the journal tail it scanned),
// re-invokes the SAME expanded plan, and every unit job re-executes:
// `sweep.worktreeFor` REUSES the strictly-clean tree (evicting baseline
// caches — I7), the unit re-probes, the fixer no-ops on an already-fixed
// tree, and the commit step skips when the tree is clean. Idempotency lives
// in the ops, not in a skip.
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
// needs no runtime output — sweepUnitSegments is the one derivation shared
// by the builder (assemble input) and the unit op (worktreeFor input).
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { Budget, Driver, ModelSpec, ToolPolicy } from '../driver/types.js';
import { SessionStore } from '../harness/session.js';
import type { Op, OpResult, Plan, PlanRegistryEntry } from '../kernel/types.js';
import type { AdapterName, CheckCommand, FailureSet, RunCheck } from '../ops/gates/checkRunner.js';
import { makeBaselineProbe } from '../ops/gates/baselineProbe.js';
import type { BaselineProbeInput } from '../ops/gates/baselineProbe.js';
import { hackDetector } from '../ops/gates/hackDetector.js';
import type { TamperFinding } from '../ops/gates/hackDetector.js';
import { regressionGate } from '../ops/gates/regressionGate.js';
import type { RegressionReport } from '../ops/gates/regressionGate.js';
import type { AssemblePrsInput } from '../ops/pr/assemblePrs.js';
import type { GhFn } from '../ops/review/gh.js';
import type {
  PlanSweepInput,
  PlanSweepLedgerConfig,
  PlanSweepPackage,
  PlanSweepReport,
  PlanSweepSelector,
  WorkUnit,
} from '../ops/sweep/planSweep.js';
import { makeSubprocessWorktreeEffects, makeWorktreeFor } from '../ops/sweep/worktreeFor.js';
import type { SweepWorkspace, WorktreeForInput } from '../ops/sweep/worktreeFor.js';

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

/** The default I7 baseline-cache dir a unit's baseline snapshot is written under. */
export const SWEEP_BASELINE_CACHE_DIR = '.cq/baseline';

/**
 * Registry-time mirror of the unit job's input — the planner's WorkUnit
 * verbatim (D1's contract: every unit becomes exactly one 'sweep.unit' job
 * carrying the unit as its input).
 */
export const SweepUnitInputSchema = z
  .object({
    package: z.string().min(1),
    fixer: z.string().min(1),
    files: z.array(z.string()),
  })
  .strict();

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

/** The per-unit branch segments, derived EXACTLY the way worktreeFor derives them. */
export interface SweepUnitSegments {
  /** The work kind segment: the sanitized fixer label. */
  kind: string;
  /** The package slug segment: the sanitized package name. */
  slug: string;
  /** The full branch `<runPrefix>/<kind>/<slug>`. */
  branch: string;
}

/**
 * The ONE branch derivation shared by buildSweepPlan (the assembler's static
 * input) and makeSweepUnitOp (the worktreeFor input): kind = fixer, slug =
 * package, both folded to safe segments (`[^A-Za-z0-9._-]` runs fold to '-'
 * — the planner's own job-id fold). Names a fold cannot rescue (a leading
 * dash, a '..' run, a '.lock' suffix) are refused by the worktreeFor
 * boundary — loudly, at run time; this fold mirrors planSweep's, it does not
 * replace that boundary.
 */
export function sweepUnitSegments(
  runPrefix: string,
  unit: Pick<WorkUnit, 'package' | 'fixer'>,
): SweepUnitSegments {
  const kind = sanitizedSegment(unit.fixer);
  const slug = sanitizedSegment(unit.package);
  return { kind, slug, branch: `${runPrefix}/${kind}/${slug}` };
}

/** Fold to '-' every run of characters a git segment may not carry (planSweep's idiom). */
function sanitizedSegment(raw: string): string {
  return raw.replace(/[^A-Za-z0-9._-]+/g, '-');
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
function assembleInputOf(config: SweepPlanConfig, report: PlanSweepReport): AssemblePrsInput {
  return {
    repoRoot: config.repoRoot,
    runPrefix: config.runPrefix,
    base: config.base,
    tracker: {
      title: config.trackerTitle ?? `Sweep run ${config.runPrefix}`,
      branch: config.trackerBranch ?? `${config.runPrefix}/tracker`,
    },
    packages: report.units.map((unit) => ({
      name: unit.package,
      branch: sweepUnitSegments(config.runPrefix, unit).branch,
      title: `fix(${unit.package}): sweep ${unit.fixer}`,
    })),
    draft: true,
  };
}

/**
 * Author the EXPANDED sweep plan (phase B) from the config plus the phase-A
 * planner report — see the module header for the two-phase contract. The
 * planner job stays FIRST and re-runs honestly (same input → same units →
 * the same embedded unit jobs); each planner-emitted job is embedded
 * VERBATIM (id, op, input) re-rooted on the planner job; the assembler
 * depends on every unit job. `planId` overrides the plan id (the test-fix
 * plan reuses this builder under its own id).
 */
export function buildSweepPlan(
  config: SweepPlanConfig,
  report: PlanSweepReport,
  planId: string = SWEEP_PLAN_ID,
): Plan {
  const unitJobs = report.jobs.map((job) => ({
    ...job,
    dependsOn: [SWEEP_PLAN_JOB_IDS.plan],
  }));
  return {
    id: planId,
    label:
      'sweep: planSweep → per-unit [worktree → probe → fixer → gates → commit] → tracker-first PR assembly ' +
      '(two-phase contract: phase A runs the planner, phase B is THIS expanded graph; ' +
      'the per-unit pipeline is ONE composition job — the frozen Job has no cross-job data channel)',
    jobs: [
      { id: SWEEP_PLAN_JOB_IDS.plan, op: 'sweep.planSweep', input: sweepPlannerInput(config) },
      ...unitJobs,
      // The assembler exists only for a non-empty fleet: `pr.assemblePrs` is
      // TRACKER-FIRST (UC row 22) — even zero packages would search for (and
      // create) a tracker on the real forge, so the floor's empty fleet
      // assembles nothing and stays a harmless pass.
      ...(unitJobs.length > 0
        ? [
            {
              id: SWEEP_PLAN_JOB_IDS.assemble,
              op: 'pr.assemblePrs',
              input: assembleInputOf(config, report),
              dependsOn: unitJobs.map((job) => job.id),
            },
          ]
        : []),
    ],
  };
}

// ---------------------------------------------------------------------------
// The unit op — the per-package pipeline as ONE composition
// ---------------------------------------------------------------------------

/** Everything one unit's pipeline needs, bound per run by the caller. */
export interface SweepUnitBindings {
  /** Repository the worktrees check out from. */
  repoRoot: string;
  /** Parent dir for worktree checkouts (the worktreeFor seam). */
  worktreesDir: string;
  /** The run's reserved branch prefix. */
  runPrefix: string;
  /** The base the worktrees check out (and the PRs target). */
  base: string;
  /**
   * I7 baseline-cache dirs handed to worktreeFor (evicted from a REUSED
   * tree); the FIRST entry is where the unit writes its own baseline
   * snapshot — git-ignored tool state that makes a reuse's eviction visible.
   */
  baselineCacheDirs: string[];
  /** The probe's wire-format adapter. */
  adapter: AdapterName;
  /** The check execution seam (probes NEVER cache — two calls, two runs, I7). */
  runCheck: RunCheck;
  /** The per-package check command, resolved against the unit's worktree. */
  checkCommand: (unit: WorkUnit, worktreePath: string) => CheckCommand;
  /** The fixer worker, on the frozen Driver seam (vendor-neutral, I1). */
  driver: Driver;
  /** Model identity for the fixer invocation (plain data, never a vendor handle). */
  modelSpec: ModelSpec;
  /** Sessions dir backing the per-unit session record (the workspace IS the worktree). */
  sessionsDir: string;
  /** Tool policy for the fixer invocation; default an 'edit'-only allowlist. */
  toolPolicy?: ToolPolicy;
  /** Budget caps for the fixer invocation; default uncapped. */
  budget?: Budget;
  /** The fixer prompt — caller-composed data (the toolkit bakes in no vendor prompt). */
  prompt: (unit: WorkUnit, worktree: SweepWorkspace) => string;
  /** The git transport for the diff, status, add, and commit steps. */
  git: GhFn;
}

/**
 * One unit probe leg, NARROWED to gateable evidence: the probe completed and
 * parsed (verdict clean/failing, a FailureSet present — a bail or an
 * unparseable run never reaches the report, it fails the unit instead).
 */
export interface UnitProbe {
  verdict: 'clean' | 'failing';
  attempts: number;
  failureSet: FailureSet;
}

/** The unit op's report — every stage's evidence, plain JSON. */
export interface SweepUnitReport {
  package: string;
  fixer: string;
  /** The worktree the unit ran in (create or I7 reuse). */
  worktree: SweepWorkspace;
  /** The BEFORE probe (the baseline; never cached — I7). */
  baseline: UnitProbe;
  /** The AFTER probe. */
  final: UnitProbe;
  /** The regression gate's decision over the two probes. */
  regression: RegressionReport;
  /** The tamper scan of the fix's diff (empty = clean). */
  tamperFindings: TamperFinding[];
  /** true when the fix was committed; false when the tree was already clean (an idempotent re-run). */
  committed: boolean;
  /** The branch the unit's PR carries (`<runPrefix>/<kind>/<slug>`). */
  prBranch: string;
}

/**
 * The 'sweep.unit' op factory: the per-package pipeline as ONE composition —
 * worktreeFor → baselineProbe → fixer (via the Driver seam) → baselineProbe
 * again → regressionGate → hackDetector → commit — over the injected
 * SweepUnitBindings. Every stage's fault is a `failed` result naming the
 * stage (no throws across the op seam, no fabricated progress); a REGRESSION
 * verdict or a tamper finding fails the unit WITHOUT committing — the tree
 * stays dirty, salvage preserves it, and no PR is assembled.
 *
 * Pipeline contract, in order:
 *   1. worktreeFor — create or STRICT-clean reuse (I7: a reused tree's
 *      baseline caches are evicted, so step 2 always re-probes).
 *   2. baseline probe — the BEFORE FailureSet; bail/indeterminate is a unit
 *      failure (no trustworthy baseline, no honest gate).
 *   3. the baseline snapshot is written under the FIRST baselineCacheDirs
 *      entry — the cache that makes a reuse's I7 eviction visible; it is
 *      NEVER read back (the probe always re-runs).
 *   4. the fixer — one Driver run in the worktree (the session workspace IS
 *      the tree, I6); a non-'complete' stop reason fails the unit.
 *   5. final probe — the AFTER FailureSet, same verdict guards.
 *   6. regressionGate — tolerate the baseline's failures, block novel ones
 *      (the crown jewel, R2 D5); a regression fails the unit uncommitted.
 *   7. hackDetector over `git diff` — a tamper finding fails the unit
 *      uncommitted (the diff is unstaged working-tree vs HEAD).
 *   8. commit — skipped when the tree is already clean (an idempotent
 *      re-run's no-op fixer); only the unit's own files are staged.
 */
export function makeSweepUnitOp(bindings: SweepUnitBindings): Op<WorkUnit, SweepUnitReport> {
  const probe = makeBaselineProbe(bindings.runCheck);
  const worktreeFor = makeWorktreeFor(
    makeSubprocessWorktreeEffects(bindings.repoRoot, { timeoutMs: UNIT_GIT_TIMEOUT_MS }),
  );
  return async (unit) => {
    const segments = sweepUnitSegments(bindings.runPrefix, unit);

    // 1–2. The tree, then the BEFORE probe (a reused tree arrives with its
    // baseline caches evicted — the probe below is the re-probe, I7).
    const before = await probeLeg(probe, bindings, unit, worktreeFor, 'baseline');
    if (before.worktree === undefined || before.probe === undefined) {
      return { status: 'failed', error: before.fault ?? '(no detail)' };
    }
    const worktree = before.worktree;
    const baseline = before.probe;

    // 3. The baseline snapshot: git-ignored tool state under the first
    // configured cache dir — written, never read (the probe always re-runs).
    const cacheFault = await writeBaselineCache(bindings, segments.slug, worktree.path, baseline);
    if (cacheFault !== null) return { status: 'failed', error: cacheFault };

    // 4. The fixer: one Driver run whose workspace IS the worktree (a fresh
    // session record in the caller's sessions dir; the record's messages
    // never touch the tree).
    let stopReason: string;
    let denial: string | undefined;
    try {
      const store = new SessionStore(bindings.sessionsDir);
      const record = await store.create(worktree.path);
      const worker = await bindings.driver.run({
        prompt: bindings.prompt(unit, worktree),
        modelSpec: bindings.modelSpec,
        toolPolicy: bindings.toolPolicy ?? { allow: ['edit'], mode: 'allowlist' },
        sandboxPolicy: { level: 'none' },
        sessionRef: record.sessionId,
        budget: bindings.budget ?? {},
      });
      stopReason = worker.stopReason;
      const first = worker.denials[0];
      if (first !== undefined) denial = `${first.tool}: ${first.reason}`;
    } catch (err) {
      return {
        status: 'failed',
        error: `sweep.unit ${unit.package}: the fixer driver failed — ${messageOf(err)}`,
      };
    }
    if (stopReason !== 'complete') {
      return {
        status: 'failed',
        error:
          `sweep.unit ${unit.package}: the fixer worker stopped with reason '${stopReason}'` +
          (denial !== undefined ? ` — ${denial}` : ''),
      };
    }

    // 5–6. The AFTER probe, then the gate: tolerate the baseline's failures,
    // block novel ones. A regression fails the unit BEFORE any commit.
    const after = await probeLeg(probe, bindings, unit, worktreeFor, 'final', worktree);
    if (after.probe === undefined) {
      return { status: 'failed', error: after.fault ?? '(no detail)' };
    }
    const final = after.probe;
    const gated = await regressionGate({
      base: baseline.failureSet,
      final: final.failureSet,
    });
    if (gated.status !== 'ok') {
      return {
        status: 'failed',
        error: `sweep.unit ${unit.package}: the regression gate returned ${gated.status} — ${resultDetail(gated)}`,
      };
    }
    if (gated.value.verdict === 'regression') {
      const novel = gated.value.novelFailures
        .map((f) => `${f.file ?? '(no file)'}:${String(f.line ?? '?')} ${f.message}`)
        .join('; ');
      return {
        status: 'failed',
        error: `sweep.unit ${unit.package}: REGRESSION — the fix introduced ${String(gated.value.novelFailures.length)} novel failure(s): ${novel}`,
      };
    }

    // 7. The tamper scan over the fix's diff (uncommitted working-tree diff
    // vs HEAD — the fix has not been staged yet).
    const diff = await bindings.git(['-C', worktree.path, 'diff', '--']);
    if (diff.code !== 0) {
      return {
        status: 'failed',
        error: `sweep.unit ${unit.package}: git diff failed — ${diff.stderr.trim()}`,
      };
    }
    const hack = await hackDetector({ diff: diff.stdout });
    if (hack.status !== 'ok') {
      return {
        status: 'failed',
        error: `sweep.unit ${unit.package}: the tamper scan returned ${hack.status} — ${resultDetail(hack)}`,
      };
    }
    if (hack.value.length > 0) {
      const named = hack.value
        .map((f) => `${f.kind} ${f.file}:${String(f.line ?? '?')} (${f.message})`)
        .join('; ');
      return {
        status: 'failed',
        error: `sweep.unit ${unit.package}: tamper findings — the fix games the checks: ${named}`,
      };
    }

    // 8. Commit — skipped when the tree is already clean (the fixer no-oped).
    const commit = await commitWorktree(bindings, unit, worktree);
    if (commit.fault !== null) return { status: 'failed', error: commit.fault };

    const report: SweepUnitReport = {
      package: unit.package,
      fixer: unit.fixer,
      worktree,
      baseline,
      final,
      regression: gated.value,
      tamperFindings: hack.value,
      committed: commit.committed,
      prBranch: segments.branch,
    };
    return { status: 'ok', value: report };
  };
}

/** One probe leg, creating the worktree on the baseline leg when not in hand yet. */
async function probeLeg(
  probe: ReturnType<typeof makeBaselineProbe>,
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktreeFor: Op<WorktreeForInput, SweepWorkspace>,
  leg: 'baseline' | 'final',
  existing?: SweepWorkspace,
): Promise<{ worktree?: SweepWorkspace; probe?: UnitProbe; fault?: string }> {
  let worktree: SweepWorkspace;
  if (existing !== undefined) {
    worktree = existing;
  } else {
    const result = await callTotal(`sweep.unit ${unit.package}: worktreeFor`, () =>
      worktreeFor(worktreeInputOf(bindings, unit)),
    );
    if (result.status !== 'ok') {
      return { fault: `sweep.unit ${unit.package}: worktreeFor — ${resultDetail(result)}` };
    }
    worktree = result.value;
  }
  const input: BaselineProbeInput = {
    adapter: bindings.adapter,
    command: bindings.checkCommand(unit, worktree.path),
  };
  const probed = await callTotal(`sweep.unit ${unit.package}: the ${leg} probe`, () =>
    probe(input),
  );
  if (probed.status !== 'ok') {
    return {
      worktree,
      fault: `sweep.unit ${unit.package}: the ${leg} probe returned ${probed.status} — ${resultDetail(probed)}`,
    };
  }
  if (probed.value.verdict === 'bail') {
    return {
      worktree,
      fault: `sweep.unit ${unit.package}: the ${leg} probe BAILED after ${String(probed.value.attempts)} attempt(s) — the check never completed, so there is no trustworthy state to gate on`,
    };
  }
  if (probed.value.failureSet === undefined) {
    return {
      worktree,
      fault: `sweep.unit ${unit.package}: the ${leg} probe reported ${probed.value.verdict} with no failure set — ungateable evidence`,
    };
  }
  // NARROWED past the guards: clean/failing with a FailureSet present.
  const narrowed: UnitProbe = {
    verdict: probed.value.verdict,
    attempts: probed.value.attempts,
    failureSet: probed.value.failureSet,
  };
  return { worktree, probe: narrowed };
}

/** The unit's worktreeFor input — the bindings' naming config over the derived segments. */
function worktreeInputOf(bindings: SweepUnitBindings, unit: WorkUnit): WorktreeForInput {
  const segments = sweepUnitSegments(bindings.runPrefix, unit);
  return {
    repoRoot: bindings.repoRoot,
    worktreesDir: bindings.worktreesDir,
    runPrefix: bindings.runPrefix,
    kind: segments.kind,
    slug: segments.slug,
    base: bindings.base,
    baselineCacheDirs: bindings.baselineCacheDirs,
  };
}

/**
 * Await an op that must not throw across the seam; a rejection (an effect
 * adapter contract violation) becomes a `failed` result naming the stage —
 * never an escaping rejected promise, never a fabricated ok.
 */
async function callTotal<R>(stage: string, run: () => Promise<OpResult<R>>): Promise<OpResult<R>> {
  try {
    return await run();
  } catch (err) {
    return { status: 'failed', error: `${stage} threw — ${messageOf(err)}` };
  }
}

/** Stage the unit's own files and commit; skip honestly when the tree is clean. */
async function commitWorktree(
  bindings: SweepUnitBindings,
  unit: WorkUnit,
  worktree: SweepWorkspace,
): Promise<{ committed: boolean; fault: string | null }> {
  const status = await bindings.git(['-C', worktree.path, 'status', '--porcelain']);
  if (status.code !== 0) {
    return {
      committed: false,
      fault: `sweep.unit ${unit.package}: git status failed — ${status.stderr.trim()}`,
    };
  }
  if (status.stdout.trim() === '') {
    return { committed: false, fault: null }; // the fixer no-oped — nothing to commit
  }
  const addArgs =
    unit.files.length > 0
      ? ['-C', worktree.path, 'add', '--', ...unit.files]
      : ['-C', worktree.path, 'add', '-A'];
  const added = await bindings.git(addArgs);
  if (added.code !== 0) {
    return {
      committed: false,
      fault: `sweep.unit ${unit.package}: git add failed — ${added.stderr.trim()}`,
    };
  }
  const committed = await bindings.git([
    '-C',
    worktree.path,
    'commit',
    '-m',
    `fix(${unit.package}): apply ${unit.fixer} sweep fix`,
  ]);
  if (committed.code !== 0) {
    return {
      committed: false,
      fault: `sweep.unit ${unit.package}: git commit failed — ${committed.stderr.trim()}`,
    };
  }
  return { committed: true, fault: null };
}

/** Write the baseline snapshot under the first configured cache dir; a fault names the stage. */
async function writeBaselineCache(
  bindings: SweepUnitBindings,
  slug: string,
  worktreePath: string,
  baseline: UnitProbe,
): Promise<string | null> {
  const dir = bindings.baselineCacheDirs[0] ?? SWEEP_BASELINE_CACHE_DIR;
  try {
    await mkdir(join(worktreePath, dir), { recursive: true });
    await writeFile(
      join(worktreePath, dir, `${slug}.json`),
      `${JSON.stringify(baseline.failureSet ?? null)}\n`,
      'utf8',
    );
    return null;
  } catch (err) {
    return `sweep.unit: could not write the baseline cache under '${dir}' — ${messageOf(err)}`;
  }
}

/** Status error/reason/detail of a non-ok OpResult, for `failed` messages. */
function resultDetail(result: {
  status: string;
  error?: string;
  reason?: string;
  detail?: string;
}): string {
  return result.error ?? result.reason ?? result.detail ?? '(no detail)';
}

/** Error message of an unknown throwable. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The unit op's git wall clock — bounds one worktree/commit step, never a policy. */
const UNIT_GIT_TIMEOUT_MS = 60_000;

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
