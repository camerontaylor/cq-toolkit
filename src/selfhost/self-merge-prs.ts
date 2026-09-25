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
//
// W1.2 — SHA-BOUND ACCEPTANCE AT MERGE TIME + DURABLE SETTLE. Reviews are
// re-fetched IMMEDIATELY before every merge call: gateMergeEffects wraps the
// executor's mergePr, so there is no classify→merge window. Acceptance comes
// only from a trusted actor's CURRENT review whose commit.oid equals the
// live headRefOid; unresolved external threads refuse; the base branch name
// the executor's readBaseRef saw right before the call must still be the
// live base, and a live base of SelfhostDefaults.protectedBranch refuses.
// Settle comes from >= 2 durable observations of the identical (head, base,
// force-push epoch) tuple >= settleMs apart, recorded on the `cq-state`
// branch through the git-data API with the run's GH_TOKEN (the automation
// identity; no worker holds it — conflict resolution is disabled in self-
// host). Never the Actions cache: the journal root under .selfhost/journal
// is cached and evictable, so the state branch is the persistence. Every
// real run first observes all open candidates (at most one write, and only
// when an anchor is new or a record is pruned), and the recheck adds its
// own observation before judging (written only on ok or a new anchor).
//
// AUTOMATION IDENTITY. A real run first resolves the token's own login
// (`gh api user`) and excludes it from trust — the automation can never
// accept its own work. An integration (App) token cannot read /user
// (HTTP 403 "Resource not accessible by integration" — only that exact
// message; any other 403 fails closed); that is fine only while NO bot is
// trusted (the App's own bot login is unknowable, so with any trustedBots
// entry the run fails closed): App
// bot identities are never trusted unless allowlisted, and the structural
// automation bots are always excluded. Any OTHER failure fails closed —
// every merge-time recheck refuses 'automation identity unresolved'. The
// dry run skips resolution. A refusal surfaces as a
// failed merge row ("cq merge-time recheck refused pr N: …") in needsHuman —
// recorded limitation: executeMerges has no 'deferred' outcome, so a PR
// that is merely not yet settled shows there until a later run merges it.
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
import { defaultClassifyPrConfig } from '../ops/merge/classify.config.js';
import { classifyPr } from '../ops/merge/classifyPrs.js';
import type { PrClassification } from '../ops/merge/classifyPrs.js';
import type { ClassifyPrConfig } from '../ops/merge/classify.config.js';
import { realMergeEffects, type MergeEffects } from '../ops/merge/effects.js';
import { makeRunMergePrsOp } from '../ops/merge/runPrs.js';
import type { MergePrsCandidate, MergePrsOutcome, RunMergePrsInput } from '../ops/merge/runPrs.js';
import { GhError, ghJson, makeGhRunner, type GhFn } from '../ops/review/gh.js';
import { list } from '../registry/index.js';
import { makeMergePrsPlan } from '../plans/merge-prs.js';
import { fetchMergeCandidates, type ExcludedCandidate } from './candidates.js';
import { defaultJournalRoot, parseSelfhostArgs, SelfhostDefaults } from './config.js';
import {
  CONSERVATIVE_TRUST_POLICY,
  gateMergeEffects,
  observeOpenPrs,
  recheckBeforeMerge,
  type ObserveOpenPrsResult,
  type RecheckResult,
  type TrustPolicy,
} from './merge-recheck.js';

/** Production self-host policy: conflict resolution is always withheld. */
export const SELFHOST_DISABLES_CONFLICT_RESOLUTION = true;

/** The merge plan's single job id (makeMergePrsPlan's shape, kept in sync). */
const MERGE_PRS_PLAN_RUN_JOB_ID = 'merge-prs-run';

/** The op the recheck gate rebinds (makeMergePrsPlan's single job's op). */
const MERGE_RUN_PRS_OP = 'merge.runPrs';

/** The entry's injected seams. Plain data; no ambient access behind them. */
export interface SelfMergePrsDeps {
  /** The gh transport — the candidates fetch's listing + enrichment reads. */
  gh: GhFn;
  /**
   * The op registry view the governed run dispatches through. Default: the
   * central registry view built exactly the way run-plan builds it, with
   * merge.runPrs rebound through {@link recheckedRegistryView} (the W1.2
   * merge-time recheck gate). An injected view is used VERBATIM — no gate
   * is layered on: tests of scripted ops own their merge path. Only tests
   * inject.
   */
  driverRegistryView?: OpRegistryView;
  /**
   * Test seam: the INNER merge effects under the recheck gate (the gate
   * always wraps them). Default: realMergeEffects over cfg.repoRoot with the
   * SelfhostDefaults protected branch. Ignored when driverRegistryView is
   * injected.
   */
  mergeEffects?: MergeEffects;
  /**
   * The injected clock; default Date.now. Classification reads it ONCE per
   * run; the observation pass and every merge-time recheck read it LIVE
   * per call (settle is measured at the actual merge instant).
   */
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
  /**
   * The merge-time recheck's trust set (plan D3). Default
   * CONSERVATIVE_TRUST_POLICY — the resolved D3 trust config from W1.1 /
   * RS-15 Annex B (via trustPolicyFromConfig) replaces this default when it
   * lands. The resolved automation login is always added to its exclusions.
   */
  trustPolicy?: TrustPolicy;
  /** Resolved reviewer trust policy for the shipped merge classifier. */
  classifyConfig?: ClassifyPrConfig;
}

/**
 * The run-start resolution of the token's own login. The login is a
 * structural fact (an account name, never a secret) and rides the payload.
 */
export interface AutomationIdentity {
  /** True iff `gh api user` answered a login. */
  resolved: boolean;
  /** The resolved login. */
  login?: string;
  /** Why it is unresolved (one line, capped); absent when resolved. */
  reason?: string;
}

/** Cap for the unresolved-identity reason (the recheck's REASON_MAX). */
const IDENTITY_REASON_MAX = 500;

/**
 * Resolve the automation identity. `refusal` is null when the run may
 * proceed (resolved, or an integration token under a policy that trusts NO
 * bot — see the module doc) and the one-line refusal every recheck must
 * answer otherwise. An integration token cannot name its own App bot, so
 * with any `trustedBots` entry the App could be one of them and accept its
 * own work: that case fails closed. Never throws.
 */
export async function resolveAutomationIdentity(
  gh: GhFn,
  policy: Pick<TrustPolicy, 'trustedBots'> = CONSERVATIVE_TRUST_POLICY,
): Promise<{ identity: AutomationIdentity; refusal: string | null }> {
  const cap = (text: string): string =>
    (text.split('\n', 1)[0] ?? '').slice(0, IDENTITY_REASON_MAX);
  try {
    const user = await ghJson<unknown>(gh, ['api', 'user']);
    const login =
      typeof user === 'object' && user !== null && !Array.isArray(user)
        ? (user as Record<string, unknown>)['login']
        : undefined;
    if (typeof login === 'string' && login.trim() !== '') {
      return { identity: { resolved: true, login }, refusal: null };
    }
    const reason = 'gh api user returned no login';
    return { identity: { resolved: false, reason }, refusal: reason };
  } catch (error) {
    const stderr = error instanceof GhError ? error.stderr : '';
    if (/Resource not accessible by integration/.test(stderr)) {
      const reason = cap(`integration token (no /user): ${stderr.trim()}`);
      return {
        identity: { resolved: false, reason },
        // The App's own bot login is unknowable here; proceed only when no
        // bot can grant acceptance at all.
        refusal:
          policy.trustedBots.size === 0
            ? null
            : cap(`integration token with trustedBots configured: ${reason}`),
      };
    }
    const reason = cap(
      error instanceof GhError
        ? `gh exit ${String(error.code)}: ${stderr.trim() === '' ? error.message : stderr.trim()}`
        : error instanceof Error
          ? error.message
          : String(error),
    );
    return { identity: { resolved: false, reason }, refusal: reason };
  }
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
      /** The run-start durable settle observation pass over the open candidates. */
      settleObservation: ObserveOpenPrsResult;
      /** The run-start automation-identity resolution (excluded from trust). */
      automationIdentity: AutomationIdentity;
    };

/**
 * The pure input builder for the merge.runPrs job — EXPORTED because the
 * caps-and-seams wiring is exactly what a unit test must pin without
 * running anything: every value comes from the frozen SelfhostDefaults or
 * the cfg; nothing is invented here.
 */
export function buildRunInput(
  candidates: MergePrsCandidate[],
  cfg: {
    repoRoot: string;
    journalRoot?: string;
    disableConflictResolution?: boolean;
    classifyConfig?: ClassifyPrConfig;
  },
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
    ...(cfg.classifyConfig === undefined
      ? {}
      : {
          config: {
            ...(cfg.classifyConfig.settleWindowMs === undefined
              ? {}
              : { settleWindowMs: cfg.classifyConfig.settleWindowMs }),
            ...(cfg.classifyConfig.trustedBots === undefined
              ? {}
              : { trustedBots: cfg.classifyConfig.trustedBots }),
            ...(cfg.classifyConfig.trustedAssociations === undefined
              ? {}
              : { trustedAssociations: cfg.classifyConfig.trustedAssociations }),
            ...(cfg.classifyConfig.automationLogin === undefined
              ? {}
              : { automationLogin: cfg.classifyConfig.automationLogin }),
            ...(cfg.classifyConfig.excludedLogins === undefined
              ? {}
              : { excludedLogins: cfg.classifyConfig.excludedLogins }),
            ...(cfg.classifyConfig.acceptReviewStates === undefined
              ? {}
              : { acceptReviewStates: cfg.classifyConfig.acceptReviewStates }),
          },
        }),
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
 * The recheck-gated driver view: identical to `baseView` except
 * `merge.runPrs`, whose entry keeps baseView's name and inputSchema but whose
 * importer resolves the op built over `gateMergeEffects(innerEffects,
 * recheck)` — every forge merge the op attempts is preceded by `recheck`.
 * When baseView has no merge.runPrs entry the answer stays undefined (never
 * fabricated).
 */
export function recheckedRegistryView(opts: {
  baseView: OpRegistryView;
  innerEffects: MergeEffects;
  recheck: (
    pr: number,
    expectedHead: string | undefined,
    expectedBase: string | undefined,
  ) => Promise<RecheckResult>;
}): OpRegistryView {
  const { baseView, innerEffects, recheck } = opts;
  return {
    get: (name) => {
      const entry = baseView.get(name);
      if (name !== MERGE_RUN_PRS_OP || entry === undefined) return entry;
      const gated = makeRunMergePrsOp({ effects: gateMergeEffects(innerEffects, recheck) });
      return {
        name: entry.name,
        inputSchema: entry.inputSchema,
        // Same bottom-instantiation variance adapter as centralRegistryView.
        importer: async () => gated as unknown as Awaited<ReturnType<typeof entry.importer>>,
      };
    },
  };
}

/**
 * Fetch this repository's merge candidates and, when not a dry run, observe
 * the open candidates durably and execute the governed merge-prs plan
 * (module doc). The classify clock is read ONCE per run (classify
 * determinism: same fetch + same reading → same verdicts); the observation
 * pass and the merge-time rechecks read the live clock per call.
 */
export async function runSelfMergePrs(
  deps: SelfMergePrsDeps,
  cfg: SelfMergePrsCfg,
): Promise<SelfMergePrsResult> {
  // The LIVE clock: the observation pass and every recheck read it per call
  // (settle is measured at the actual merge instant). The classify reading
  // below is taken ONCE.
  const clock = deps.nowMs ?? ((): number => Date.now());
  const nowMs = clock();
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
        ...classifyPr(candidate, nowMs, cfg.classifyConfig),
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
  // AUTOMATION IDENTITY (module doc): resolved once, before any merge can
  // be attempted; an unresolved identity (other than an integration token)
  // refuses every recheck rather than throwing the run.
  const { identity: automationIdentity, refusal: identityRefusal } =
    await resolveAutomationIdentity(deps.gh, cfg.trustPolicy ?? CONSERVATIVE_TRUST_POLICY);
  // RUN-START DURABLE OBSERVATION (W1.2): one snapshot per open candidate,
  // at most ONE state-branch write, and only for a new/reset anchor or a
  // pruned record (records of PRs outside this set are pruned — a PR
  // excluded this run restarts its settle, which can only delay a merge).
  // Never throws; a failed write does not stop the run — the
  // recheck refuses any merge that lacks a durable observation anyway.
  const settleObservation = await observeOpenPrs(
    { gh: deps.gh, owner: cfg.owner, repo: cfg.repo, nowMs: clock },
    fetched.candidates
      .filter((candidate) => candidate.state === 'open')
      .map((candidate) => candidate.pr),
  );
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
  // Production: the central registry with merge.runPrs gated by the
  // merge-time recheck over the real (or seam-injected) inner effects. An
  // injected driverRegistryView is used verbatim (its scripted op owns its
  // merge path).
  const basePolicy = cfg.trustPolicy ?? CONSERVATIVE_TRUST_POLICY;
  const policy: TrustPolicy =
    automationIdentity.login === undefined
      ? basePolicy
      : {
          ...basePolicy,
          excludedLogins: new Set([
            ...basePolicy.excludedLogins,
            automationIdentity.login.toLowerCase(),
          ]),
        };
  const settleMs = defaultClassifyPrConfig.settleWindowMs; // the I2 settle constant
  const view =
    deps.driverRegistryView ??
    recheckedRegistryView({
      baseView: await centralRegistryView(),
      innerEffects:
        deps.mergeEffects ??
        realMergeEffects({
          repoRoot: cfg.repoRoot,
          protectedBranch: SelfhostDefaults.protectedBranch,
        }),
      recheck: (pr, head, base) =>
        identityRefusal !== null
          ? Promise.resolve<RecheckResult>({
              ok: false,
              reason: `automation identity unresolved: ${identityRefusal}`,
            })
          : recheckBeforeMerge(
              {
                gh: deps.gh,
                owner: cfg.owner,
                repo: cfg.repo,
                nowMs: clock,
                settleMs,
                policy,
                protectedBranch: SelfhostDefaults.protectedBranch,
              },
              pr,
              head,
              base,
            ),
    });
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
  return { excluded: fetched.excluded, outcome, report, settleObservation, automationIdentity };
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
          // Structural facts only: PR numbers, one-line reasons, write ok,
          // and the automation login (an account name, never a secret).
          settleObservation: {
            observed: result.settleObservation.observed,
            skipped: result.settleObservation.skipped,
            discarded: result.settleObservation.discarded,
            write:
              result.settleObservation.write === null
                ? null
                : result.settleObservation.write.ok
                  ? { ok: true }
                  : { ok: false, reason: result.settleObservation.write.reason },
          },
          automationIdentity: result.automationIdentity,
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
