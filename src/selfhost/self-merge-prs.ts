// selfhost/self-merge-prs — the scheduled merge-dispatch ENTRY module (goal
// T4.1 slice 2): what the repo's own automation workflow invokes to classify
// and (when eligible) merge THIS repository's own open PRs through the
// GOVERNED kernel. Composition glue, not an op:
//
//   - candidates come from the REAL forge via candidates.ts's
//     fetchMergeCandidates (fork/draft exclusions ride through in the result
//     for the workflow log — the #142 contract is visible, never silent);
//   - the real run executes makeMergePrsPlan's ONE job (op 'merge.runPrs')
//     through the recorded governed pipeline, mirroring src/cli/run-plan.ts
//     exactly: BudgetGovernor over governorConfig(runOptions, limits) →
//     runPlan(plan, runOptions, governRegistry(view, governor)) →
//     withBudgetStop. The caps are the frozen SelfhostDefaults (maxUsd
//     default, perJobWallClockMs arming the wall-clock ladder, #137) — this
//     module invents no number;
//   - the registry view is the central registry built exactly the way
//     run-plan builds it (bottom-instantiation variance adapter); only
//     tests inject a view;
//   - the merge.runPrs job's MergePrsOutcome rides the result, and the
//     governed RunReport rides WITH it (a budget stop or a failed job is
//     visible in both — honest stop, I9).
//
// DRY RUN: fetch + classify ONLY — the pure classifyPr decision table runs
// on the fetched candidates and the verdicts are returned; NO plan is
// built, the governor and registry view are never consulted, and the
// injected op (the only merge-capable seam) can never fire.
//
// HONEST OUTCOMES (the scheduled-run contract): needs-human rows, stale /
// failed merges, escalations, and a budget stop are all RESULTS — printed
// and logged at exit 0. Only a whole-run throw (bad args, a failed listing
// fetch) exits 1. NO SECRETS: the payload carries PR numbers, verdicts,
// branch-safe reasons, and report counts — never tokens or env.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BudgetGovernor,
  governRegistry,
  governorConfig,
  withBudgetStop,
} from '../kernel/governor.js';
import { runPlan, type OpRegistryView } from '../kernel/runner.js';
import type { OpRegistryEntry, RunOptions, RunReport } from '../kernel/types.js';
import { classifyPr } from '../ops/merge/classifyPrs.js';
import type { PrClassification } from '../ops/merge/classifyPrs.js';
import type { MergePrsCandidate, MergePrsOutcome, RunMergePrsInput } from '../ops/merge/runPrs.js';
import { makeGhRunner, type GhFn } from '../ops/review/gh.js';
import { list } from '../registry/index.js';
import { makeMergePrsPlan } from '../plans/merge-prs.js';
import { fetchMergeCandidates, type ExcludedCandidate } from './candidates.js';
import { defaultJournalRoot, parseSelfhostArgs, SelfhostDefaults } from './config.js';

/** Production self-host policy: conflict resolution is always withheld. */
export const SELFHOST_DISABLES_CONFLICT_RESOLUTION = true;

/** The merge plan's single job id (makeMergePrsPlan's shape, kept in sync). */
const MERGE_PRS_PLAN_RUN_JOB_ID = 'merge-prs-run';

/** The entry's injected seams. Plain data; no ambient access behind them. */
export interface SelfMergePrsDeps {
  /** The gh transport — the candidates fetch's listing + enrichment reads. */
  gh: GhFn;
  /**
   * The op registry view the governed run dispatches through. Default: the
   * central registry view built exactly the way run-plan builds it. Only
   * tests inject (their view binds a scripted merge.runPrs op).
   */
  driverRegistryView?: OpRegistryView;
  /** The injected clock; default Date.now (read once, at classify time). */
  nowMs?: () => number;
}

/** The run's coordinates and overrides. Plain data. */
export interface SelfMergePrsCfg {
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** The checked-out repository root (the merge effects target). */
  repoRoot: string;
  /** USD-cap override; default SelfhostDefaults.maxUsd (I9). */
  maxUsd?: number;
  /** Journal root override (hosts the merge sessions dir); default `<repoRoot>/.selfhost/journal`. */
  journalRoot?: string;
  /** Fetch + classify only — never build the plan, never execute a merge. */
  dryRun?: boolean;
  /** Disable model-dispatched conflict resolution; DIRTY rows become needs-human. */
  disableConflictResolution?: boolean;
}

/**
 * The run's outcome. A discriminated union because the two modes produce
 * different truth:
 *   - dry run: the classification verdicts (pure decision table) plus the
 *     fetch's exclusion bookkeeping and the candidate count — no execution
 *     exists, so no execution report may be pretended;
 *   - real run: the merge.runPrs job's MergePrsOutcome (`outcome` is NULL
 *     when the job did not end ok — the report is the evidence) with the
 *     governed RunReport riding alongside, plus the fetch exclusions.
 */
export type SelfMergePrsResult =
  | {
      dryRun: true;
      excluded: ExcludedCandidate[];
      candidateCount: number;
      classification: Array<{ pr: number } & PrClassification>;
    }
  | {
      dryRun?: false;
      excluded: ExcludedCandidate[];
      outcome: MergePrsOutcome | null;
      report: RunReport;
    };

/**
 * The pure input builder for the merge.runPrs job — EXPORTED because the
 * caps-and-seams wiring is exactly what a unit test must pin without
 * running anything: every value comes from the frozen SelfhostDefaults or
 * the cfg; nothing is invented here.
 */
export function buildRunInput(
  candidates: MergePrsCandidate[],
  cfg: { repoRoot: string; journalRoot?: string; disableConflictResolution?: boolean },
  nowMs: number,
): RunMergePrsInput {
  return {
    baseBranch: SelfhostDefaults.baseBranch,
    repoRoot: cfg.repoRoot,
    prs: candidates,
    protectedBranch: SelfhostDefaults.protectedBranch,
    wallClockMs: SelfhostDefaults.perJobWallClockMs,
    ...(cfg.disableConflictResolution === true
      ? { conflictResolutionDisabled: true }
      : { modelSpec: SelfhostDefaults.driver }),
    sessionsDir: join(cfg.journalRoot ?? defaultJournalRoot(cfg.repoRoot), 'sessions'),
    nowMs,
  };
}

/**
 * The default driver view: the central registry, adapted exactly the way
 * run-plan adapts it (src/cli/run-plan.ts — the view is typed at the bottom
 * instantiation <never, never> while registry entries are <unknown,
 * unknown>, and unknown does not widen down to never; the runner only ever
 * calls parseAsync/importer through the bottom instantiation).
 */
const centralRegistryView = async (): Promise<OpRegistryView> => {
  const entries = await list();
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  return {
    get: (name) => entryByName.get(name) as OpRegistryEntry<never, never> | undefined,
  };
};

/**
 * Fetch this repository's merge candidates and, when not a dry run, execute
 * the governed merge-prs plan (module doc). The clock is read ONCE per run
 * (classify determinism: same fetch + same reading → same verdicts).
 */
export async function runSelfMergePrs(
  deps: SelfMergePrsDeps,
  cfg: SelfMergePrsCfg,
): Promise<SelfMergePrsResult> {
  const nowMs = (deps.nowMs ?? (() => Date.now()))();
  // The ONE clock reading rides into the fetch too: the closed-ancestor
  // sweep's freshness window is judged from the same instant the
  // classification will be (same fetch + same reading → same verdicts).
  const fetched = await fetchMergeCandidates({
    gh: deps.gh,
    owner: cfg.owner,
    repo: cfg.repo,
    nowMs,
  });

  if (cfg.dryRun === true) {
    return {
      dryRun: true,
      excluded: fetched.excluded,
      candidateCount: fetched.candidates.length,
      classification: fetched.candidates.map((candidate) => ({
        pr: candidate.pr,
        ...classifyPr(candidate, nowMs),
      })),
    };
  }

  // FIRST-RUN JOURNAL ROOT (the review-loop entry's same first-run fix): on
  // a first run / cache miss `<journalRoot>` does not exist, and this run's
  // effects under it — the merge sessions dir (`buildRunInput`'s
  // sessionsDir) and the kernel journal (`merge-<stamp>`) — need their
  // parent before any writer touches them. Create it recursively before the
  // plan is built. Real runs only: the dry run classifies and returns above,
  // never touching the journal.
  const journalRoot = cfg.journalRoot ?? defaultJournalRoot(cfg.repoRoot);
  mkdirSync(journalRoot, { recursive: true });
  const input = buildRunInput(fetched.candidates, cfg, nowMs);
  // The governed composition — the recorded seam, not optional (I9),
  // mirroring src/cli/run-plan.ts: the caps ride BOTH the RunOptions (the
  // kernel's advisory surface) and the governor construction; the wall
  // clock arms the ladder through Limits (#137). The merge plan is ONE job
  // and its pipeline is internally sequential — concurrency 1.
  const runOptions: RunOptions = {
    concurrency: 1,
    stopOnError: false,
    maxUsd: cfg.maxUsd ?? SelfhostDefaults.maxUsd,
    // The governed run's durable kernel journal (the RunReport's evidence
    // trail), namespaced `merge-<stamp>` under the journal root — stamp =
    // the same once-read clock the loop entry stamps its per-PR dirs with.
    // The CLI's optional --journal-dir is a human-run choice; a scheduled
    // run has no human to copy stdout, so the entry always persists it.
    journalDir: join(cfg.journalRoot ?? defaultJournalRoot(cfg.repoRoot), `merge-${String(nowMs)}`),
  };
  const governor = new BudgetGovernor(
    governorConfig(runOptions, { perJobWallClockMs: SelfhostDefaults.perJobWallClockMs }),
  );
  const plan = makeMergePrsPlan(input);
  const view = deps.driverRegistryView ?? (await centralRegistryView());
  const report = withBudgetStop(
    await runPlan(plan, runOptions, governRegistry(view, governor)),
    plan,
    governor,
  );
  const jobRow = report.jobs.find((row) => row.jobId === MERGE_PRS_PLAN_RUN_JOB_ID);
  const outcome =
    jobRow !== undefined && jobRow.result.status === 'ok'
      ? (jobRow.result.value as MergePrsOutcome)
      : null;
  return { excluded: fetched.excluded, outcome, report };
}

/**
 * The CLI entry: parse args, resolve the repository (the --repo flag wins
 * over the GH_REPOSITORY env; absent from both → throw before any effect),
 * build the real gh runner, run, and print ONE compact JSON payload to
 * stdout. Exit 0 even when the outcome is needs-human or budget-stopped —
 * honest outcomes are the contract; only a whole-run throw exits 1.
 */
async function main(): Promise<void> {
  const parsed = parseSelfhostArgs(process.argv.slice(2));
  const repoSpec = parsed.repo ?? process.env['GH_REPOSITORY'] ?? '';
  const parts = repoSpec.split('/');
  const owner = parts[0];
  const repo = parts[1];
  if (
    parts.length !== 2 ||
    owner === undefined ||
    owner === '' ||
    repo === undefined ||
    repo === ''
  ) {
    throw new Error(
      `selfhost-merge-prs: no repository — pass --repo <owner/name> or set GH_REPOSITORY (got ${JSON.stringify(repoSpec)})`,
    );
  }
  const repoRoot = process.cwd();
  const result = await runSelfMergePrs(
    { gh: makeGhRunner(), nowMs: () => Date.now() },
    {
      owner,
      repo,
      repoRoot,
      ...(parsed.maxUsd !== undefined ? { maxUsd: parsed.maxUsd } : {}),
      ...(parsed.journalRoot !== undefined ? { journalRoot: parsed.journalRoot } : {}),
      ...(parsed.dryRun ? { dryRun: true } : {}),
      disableConflictResolution: SELFHOST_DISABLES_CONFLICT_RESOLUTION,
    },
  );
  const payload =
    result.dryRun === true
      ? {
          dryRun: true,
          candidateCount: result.candidateCount,
          excluded: result.excluded,
          classification: result.classification,
        }
      : {
          firstPass: result.outcome?.firstPass ?? null,
          secondPass: result.outcome?.secondPass ?? null,
          resolutions: result.outcome?.resolutions ?? [],
          needsHuman: result.outcome?.needsHuman ?? [],
          diagnosis: result.outcome?.diagnosis ?? null,
          excluded: result.excluded,
          report: {
            stoppedEarly: result.report.stoppedEarly,
            ...(result.report.earlyStopReason !== undefined
              ? { earlyStopReason: result.report.earlyStopReason }
              : {}),
            counts: result.report.counts,
            ...(result.report.costUSD !== undefined ? { costUSD: result.report.costUSD } : {}),
          },
        };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  // Prominent, not buried: every needs-human row is echoed as its own
  // stderr line — a human scanning the workflow log must not parse JSON.
  if (result.dryRun !== true) {
    for (const row of result.outcome?.needsHuman ?? []) {
      process.stderr.write(`pr ${String(row.pr)}: ${row.reason}\n`);
    }
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `selfhost-merge-prs: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
