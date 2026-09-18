// selfhost/self-review-loop — the scheduled review-loop ENTRY module (goal
// T4.1 slice 2): what the repo's own automation workflow invokes to run
// runReviewLoop over every open, same-repo, non-draft PR of THIS repository.
// Composition glue, not an op — every judgment call stays downstream (the
// loop's fail-toward-human stages) or upstream (config); this module adds
// exactly the deployment wiring:
//
//   - the PR set comes from the REAL forge via candidates.ts's shared REST
//     listing (listOpenPrs — one read, same argv pattern as the merge
//     candidates fetch);
//   - each qualifying PR runs the SHIPPED runReviewLoop with the frozen
//     SelfhostDefaults (driver model, maxUsd default) and the loop's own
//     defaults UNCHANGED — in particular classifyConfig is never overridden,
//     so defaultLoopClassifyConfig's bot-authored-thread suppression stays
//     ON (the skipResponderAuthoredThreads:false flip was the live drills'
//     single-identity deviation, never a deployment setting);
//   - responderLogin rides cfg (the token's user in CI, passed by the
//     workflow as --responder-login) — the round-3 deployment requirement:
//     the loop's own identity drives the thread last-word suppression, and
//     null (absent) is the honest author-blind fallback, never a guess;
//   - the worktree root is `<repoRoot>/.selfhost/worktrees` (the loop's
//     entries create the root; `.selfhost/` is gitignored runtime state);
//   - the dispatch log and worktree registry live UNDER journalRoot and so
//     PERSIST across runs — the dedupe memory and worktree reuse are the
//     whole point of a loop re-run.
//
// FAULT ISOLATION (the scheduled-run contract): one PR's loop throw is
// caught and recorded as a failure row while its siblings continue — a
// needs-human outcome or a recorded failure is an HONEST result the
// workflow logs (exit 0), never a fabricated green and never a crash that
// orphans the remaining PRs. The LISTING call is the exception (candidates'
// contract): when it fails there is nothing to isolate — the throw
// propagates and the process exits 1.
//
// NO SECRETS: the summary carries structural facts only — PR numbers,
// statuses, action counts, reason lines, logins at most — never tokens,
// env, or stderr dumps beyond the loop's own capped reason lines.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpRegistryView } from '../kernel/runner.js';
import type { GhFn } from '../ops/review/gh.js';
import { makeGhRunner } from '../ops/review/gh.js';
import { fileWorktreeRegistry } from '../ops/review/prWorktree.js';
import { fetchReviewState } from '../ops/review/fetchReviewState.js';
import { runReviewLoop } from '../plans/review-loop.js';
import type { ReviewLoopOutcome, ReviewLoopOpts } from '../plans/review-loop.js';
import { listOpenPrs } from './candidates.js';
import { defaultJournalRoot, parseSelfhostArgs, SelfhostDefaults } from './config.js';

/**
 * Cap for a recorded failure message — an error (a GhError with its argv and
 * stderr) can spew pages into one line; the failure row is a LOG FACT, not
 * the error itself. Mirrors candidates.ts's FETCH_REASON_MAX convention.
 */
const FAILURE_REASON_MAX = 500;

/** First line of an error message, capped — the failure row's raw material. */
const oneLine = (text: string): string => {
  const line = text.split('\n', 1)[0] ?? '';
  return line.length > FAILURE_REASON_MAX ? line.slice(0, FAILURE_REASON_MAX) : line;
};

/**
 * The entry's injected seams. Plain data; no ambient access behind them:
 *   - `gh` — the review/mutation transport (production: makeGhRunner()).
 *   - `git` — the worktree/push transport, the SAME GhFn seam
 *     ReviewLoopOpts.git takes (production: makeGhRunner({ bin: 'git' }) —
 *     the loop's git argv carry explicit `-C` anchors (prWorktree composes
 *     them), so the runner's process cwd never decides where git runs).
 *   - `nowMs` — the injected clock; read once per PR (the loop takes a
 *     timestamp, not a function).
 *   - `driverRegistryView` — the op registry the loop's fix jobs dispatch
 *     through. Default: ABSENT — runReviewLoop then builds its own default
 *     view (the central registry, the run-plan path); only tests inject.
 *   - `loop` — DI FOR TESTS: the loop fn itself, defaulting to the real
 *     runReviewLoop (it is imported directly by the production path, so a
 *     seam is the only way to fake a per-PR outcome without a registry).
 */
export interface SelfReviewLoopDeps {
  gh: GhFn;
  git: GhFn;
  nowMs: () => number;
  driverRegistryView?: OpRegistryView;
  loop?: typeof runReviewLoop;
}

/** The run's coordinates and overrides. Plain data. */
export interface SelfReviewLoopCfg {
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** The checked-out repository root (the worktree host). */
  repoRoot: string;
  /**
   * The loop's OWN identity (the token's user in CI; --responder-login).
   * Null = author-blind verify — the documented fallback, never a guess.
   */
  responderLogin: string | null;
  /** USD-cap override; default SelfhostDefaults.maxUsd (I9). */
  maxUsd?: number;
  /** Journal root override; default `<repoRoot>/.selfhost/journal`. */
  journalRoot?: string;
  /** Fetch + summarize only — resolve nothing, dispatch nothing. */
  dryRun?: boolean;
}

/**
 * The run's honest outcome: one row per looped PR (its full ReviewLoopOutcome)
 * and one row per PR whose loop THREW — both are facts the workflow records.
 * `dryRun`/`wouldRun` are present only in dry-run mode: the structural
 * would-run summary (log-safe lines, no titles or bodies), with the
 * pre-loop exclusions (fork/draft/no-number/state-fetch-failure) named.
 * `excluded` is present only in real-run mode: every listed-but-not-looped
 * PR (fork, draft, a row without a number) with its reason — the SAME
 * strings the dry-run path surfaces in its wouldRun lines. A PR absent
 * from results, failures, AND excluded would be a lie, so the trio is the
 * contract.
 */
export interface SelfReviewLoopSummary {
  results: Array<{ pr: number; outcome: ReviewLoopOutcome }>;
  failures: Array<{ pr: number; error: string }>;
  dryRun?: true;
  wouldRun?: string[];
  excluded?: Array<{ pr: number; reason: string }>;
}

/** The no-number exclusion reason (shared verbatim by both run modes). */
const EXCLUDE_NO_NUMBER = 'fetch-failed: listing row without a PR number';

/** The fork exclusion reason (shared verbatim by both run modes). */
const excludeForked = (headRepoFullName: string): string =>
  `forked-pr (head repo ${headRepoFullName === '' ? 'unknown' : headRepoFullName})`;

/** The draft exclusion reason (shared verbatim by both run modes). */
const EXCLUDE_DRAFT = 'draft';

/**
 * The pre-loop exclusion reason for a listing row, or null when the row is
 * loopable: open is the listing's own filter; same-repo (the #142 contract —
 * the loop only ever works the base repository's branches) and non-draft
 * gate here, before any worktree or dispatch exists. ONE classifier serves
 * BOTH run modes — the dry run renders it as a `#<n> excluded <reason>`
 * wouldRun line, the real run records it as an `excluded` row — so the two
 * payloads' reason strings can never drift.
 */
const preLoopExclusion = (
  row: { pr: number; headRepoFullName: string; draft: boolean },
  owner: string,
  repo: string,
): string | null => {
  if (row.pr === 0) return EXCLUDE_NO_NUMBER;
  if (row.headRepoFullName !== `${owner}/${repo}`) return excludeForked(row.headRepoFullName);
  if (row.draft) return EXCLUDE_DRAFT;
  return null;
};

/**
 * Run the review loop over every open, same-repo, non-draft PR (module doc).
 *
 * Real run: one runReviewLoop per PR with per-PR fault isolation; the run
 * stamp (one clock reading) namespaces each PR's journal dir; the pre-loop
 * exclusions (fork/draft/no-number) are RECORDED in `excluded` — same
 * reason strings as the dry run — never silently skipped. Dry run: NO
 * worktree, NO dispatch, NO loop — only the listing and a per-PR
 * fetchReviewState summary of what WOULD run (a state read failure there is
 * isolated into the wouldRun lines, never fatal — the dry run must sketch,
 * not crash).
 *
 * Throws ONLY when the listing itself fails (see the module doc).
 */
export async function runSelfReviewLoop(
  deps: SelfReviewLoopDeps,
  cfg: SelfReviewLoopCfg,
): Promise<SelfReviewLoopSummary> {
  const loop = deps.loop ?? runReviewLoop;
  const journalRoot = cfg.journalRoot ?? defaultJournalRoot(cfg.repoRoot);
  // Persistence seams under journalRoot — created lazily by their consumers,
  // never here (this module touches no filesystem directly).
  const registry = fileWorktreeRegistry(join(journalRoot, 'worktree-registry.json'));
  const worktreeRoot = join(cfg.repoRoot, '.selfhost', 'worktrees');

  const rows = await listOpenPrs({ gh: deps.gh, owner: cfg.owner, repo: cfg.repo });

  if (cfg.dryRun === true) {
    const wouldRun: string[] = [];
    for (const row of rows) {
      const exclusion = preLoopExclusion(row, cfg.owner, cfg.repo);
      if (exclusion !== null) {
        wouldRun.push(`#${String(row.pr)} excluded ${exclusion}`);
        continue;
      }
      try {
        const state = await fetchReviewState(
          { owner: cfg.owner, repo: cfg.repo, pr: row.pr },
          undefined,
          deps.gh,
        );
        wouldRun.push(
          `#${String(row.pr)} would-run head=${row.headRefName} threads=${String(state.threads.length)} ` +
            `reviews=${String(state.reviews.length)} issueComments=${String(state.restIssueComments.length)} ` +
            `truncated=${String(state.truncated)}`,
        );
      } catch (error) {
        wouldRun.push(
          `#${String(row.pr)} excluded fetch-failed: ${oneLine(
            error instanceof Error ? error.message : String(error),
          )}`,
        );
      }
    }
    return { results: [], failures: [], dryRun: true, wouldRun };
  }

  const stamp = deps.nowMs();
  const results: Array<{ pr: number; outcome: ReviewLoopOutcome }> = [];
  const failures: Array<{ pr: number; error: string }> = [];
  const excluded: Array<{ pr: number; reason: string }> = [];
  for (const row of rows) {
    // The pre-loop gates RECORD, not skip: every listed-but-not-looped PR
    // (fork/draft/no-number) rides out in `excluded` with the same reason
    // strings the dry run surfaces — a silent skip would orphan the PR from
    // the summary (an absent row is a lie, not a shrug).
    const exclusion = preLoopExclusion(row, cfg.owner, cfg.repo);
    if (exclusion !== null) {
      excluded.push({ pr: row.pr, reason: exclusion });
      continue;
    }
    const opts: ReviewLoopOpts = {
      owner: cfg.owner,
      repo: cfg.repo,
      pr: row.pr,
      headRefName: row.headRefName,
      repoRoot: cfg.repoRoot,
      gh: deps.gh,
      git: deps.git,
      registry,
      driver: SelfhostDefaults.driver,
      // classifyConfig deliberately ABSENT: defaultLoopClassifyConfig rides
      // unchanged (bot-authored suppression ON — see the module doc).
      responderLogin: cfg.responderLogin,
      nowMs: deps.nowMs(),
      runOptions: {
        journalDir: join(journalRoot, `${String(row.pr)}-${String(stamp)}`),
        maxUsd: cfg.maxUsd ?? SelfhostDefaults.maxUsd,
      },
      dispatchLogPath: join(journalRoot, `dispatch-${String(row.pr)}.ndjson`),
      worktreeRoot,
      // Tests-only injection: absent → runReviewLoop builds its own default
      // view (the central registry, the run-plan path).
      ...(deps.driverRegistryView !== undefined
        ? { driverRegistryView: deps.driverRegistryView }
        : {}),
    };
    try {
      results.push({ pr: row.pr, outcome: await loop(opts) });
    } catch (error) {
      failures.push({
        pr: row.pr,
        error: oneLine(error instanceof Error ? error.message : String(error)),
      });
    }
  }
  return { results, failures, excluded };
}

/**
 * The CLI entry: parse args, resolve the repository (the --repo flag wins
 * over the GH_REPOSITORY env; absent from both → throw before any effect),
 * build the real runners, run, and print ONE compact JSON summary to stdout.
 * Exit 0 even with failures — honest outcomes are the contract (they are
 * mirrored to stderr, prominently, for the workflow log); only a whole-run
 * throw (bad args, a failed listing) exits 1.
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
      `selfhost-review-loop: no repository — pass --repo <owner/name> or set GH_REPOSITORY (got ${JSON.stringify(repoSpec)})`,
    );
  }
  const repoRoot = process.cwd();
  const summary = await runSelfReviewLoop(
    { gh: makeGhRunner(), git: makeGhRunner({ bin: 'git' }), nowMs: () => Date.now() },
    {
      owner,
      repo,
      repoRoot,
      responderLogin: parsed.responderLogin ?? null,
      ...(parsed.maxUsd !== undefined ? { maxUsd: parsed.maxUsd } : {}),
      ...(parsed.journalRoot !== undefined ? { journalRoot: parsed.journalRoot } : {}),
      ...(parsed.dryRun ? { dryRun: true } : {}),
    },
  );
  const payload = {
    ...(summary.dryRun === true ? { dryRun: true, wouldRun: summary.wouldRun } : {}),
    results: summary.results.map((row) => ({
      pr: row.pr,
      status: row.outcome.status,
      actionsPosted: row.outcome.actionsPosted,
      reasons: row.outcome.reasons,
    })),
    failures: summary.failures,
    // The real run's pre-loop exclusions (fork/draft/no-number), same
    // reason strings the dry run names in wouldRun ([] in dry-run mode,
    // whose exclusions ride the wouldRun lines).
    excluded: summary.excluded ?? [],
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  // Prominent, not buried: every failure is echoed as its own stderr line —
  // a human scanning the workflow log must not parse JSON to find them.
  for (const failure of summary.failures) {
    process.stderr.write(`pr ${String(failure.pr)}: ${failure.error}\n`);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(
      `selfhost-review-loop: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
