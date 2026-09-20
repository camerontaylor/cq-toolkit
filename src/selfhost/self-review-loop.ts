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
//   - each PR's head ref is REVALIDATED immediately before its dispatch
//     (one single-PR GET, the candidates module's argv pattern): a branch
//     renamed between the listing and the dispatch would otherwise receive
//     the loop's pushes under its stale name — renamed heads and failed
//     revalidation reads are recorded rows, never dispatches;
//   - each qualifying PR runs the SHIPPED runReviewLoop with the frozen
//     SelfhostDefaults (driver model, maxUsd default) and the loop's own
//     defaults UNCHANGED — in particular classifyConfig is never overridden,
//     so defaultLoopClassifyConfig's bot-authored-thread suppression stays
//     ON (the skipResponderAuthoredThreads:false flip was the live drills'
//     single-identity deviation, never a deployment setting);
//   - the maxUsd cap is SWEEP-LEVEL: the configured (or default) cap is
//     carried forward across the PRs in listing order — each PR's loop gets
//     the REMAINING budget, each loop's fix-run cost rollup (DD-9,
//     fixReport.costUSD) decrements it, and a PR reached at ≤ 0 remaining is
//     recorded `sweep budget exhausted (I9)` instead of silently skipping or
//     silently multiplying the advertised cap by the PR count;
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
// orphans the remaining PRs. One exception to "siblings continue": a thrown
// loop WITH SPEND EVIDENCE may carry UNACCOUNTED spend, so the throw burns
// the sweep budget (remaining zeroed, fail-closed) and the PRs after it are
// recorded `sweep budget exhausted` instead of re-spending an allowance the
// entry can no longer vouch for. The burn is SPEND-EVIDENCE-GATED: the
// evidence is the PR's dispatch log gaining at least one line (the loop's
// own first dispatch write) — a loop that threw BEFORE any dispatch (a
// worktree or registry fault) spent nothing and its budget carries forward,
// so one always-throwing early PR cannot starve every later PR forever.
// The LISTING call is the exception (candidates'
// contract): when it fails there is nothing to isolate — the throw
// propagates and the process exits 1.
//
// NO SECRETS: the summary carries structural facts only — PR numbers,
// statuses, action counts, reason lines, logins at most — never tokens,
// env, or stderr dumps beyond the loop's own capped reason lines.
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { OpRegistryView } from '../kernel/runner.js';
import { GhError, ghJson } from '../ops/review/gh.js';
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
 * One capped line from a thrown revalidation read — a GhError names gh's
 * exit and stderr (the candidates module's same shape), anything else its
 * message. A log fact, never the dump.
 */
const oneLineError = (error: unknown): string =>
  error instanceof GhError
    ? `gh exit ${String(error.code)}: ${oneLine(error.stderr)}`
    : oneLine(error instanceof Error ? error.message : String(error));

/**
 * Spend evidence for a THROWN loop (the spend-evidence-gated budget burn):
 * the LOOP itself writes the PR's dispatch log's lines, so a log carrying at
 * least one line proves the loop got far enough to dispatch — spend may have
 * begun and the sweep budget burns (fail-closed). A loop that threw BEFORE
 * its first dispatch (a worktree or registry fault) leaves no lines and
 * spent nothing: its budget carries forward unchanged.
 */
const dispatchLogHasLines = (dispatchLogPath: string): boolean => {
  try {
    return readFileSync(dispatchLogPath, 'utf8')
      .split('\n')
      .some((line) => line.trim() !== '');
  } catch {
    return false; // no log file (or unreadable) — nothing was dispatched
  }
};

/**
 * Structural read of the single-PR payload's `head.ref` — `''` when the
 * wire omits any step (the same JSON-boundary guard style as the candidates
 * module). An absent ref compares as `''` and so can never match a real
 * listed branch: the PR then reads as renamed and is skipped — the loop
 * never dispatches on a payload that cannot vouch for its head.
 */
const headRefOfPayload = (wire: unknown): string => {
  if (typeof wire !== 'object' || wire === null) return '';
  const head = (wire as Record<string, unknown>)['head'];
  if (typeof head !== 'object' || head === null) return '';
  const ref = (head as Record<string, unknown>)['ref'];
  return typeof ref === 'string' ? ref : '';
};

/**
 * Structural read of the single-PR payload's top-level `state` — `''` when
 * the wire omits it or the value is not a string. Anything but `'open'`
 * fails the revalidation's state requirement: a payload that cannot vouch
 * for openness is never a dispatchable PR (headRefOfPayload's same rule).
 */
const stateOfPayload = (wire: unknown): string => {
  if (typeof wire !== 'object' || wire === null) return '';
  const state = (wire as Record<string, unknown>)['state'];
  return typeof state === 'string' ? state : '';
};

/**
 * Structural read of the single-PR payload's top-level `draft` — undefined
 * when the wire omits it or the value is not a boolean; the revalidation
 * requires exactly `false`.
 */
const draftOfPayload = (wire: unknown): boolean | undefined => {
  if (typeof wire !== 'object' || wire === null) return undefined;
  const draft = (wire as Record<string, unknown>)['draft'];
  return typeof draft === 'boolean' ? draft : undefined;
};

/** A per-run audit directory name: `<pr>-<stamp>` — digits, dash, digits. */
const AUDIT_DIR_PATTERN = /^\d+-\d+$/;

/** How many of the newest per-run audit directories the journal keeps. */
const AUDIT_DIRS_KEPT = 5;

/**
 * Bounded journal growth (CRT1): the workflow's cache restore/save pair
 * re-accumulates every `<pr>-<stamp>/` audit dir a prior run saved, so the
 * real run prunes them to the newest AUDIT_DIRS_KEPT before returning. ONLY
 * that directory shape is ever removed — the flat `dispatch-<pr>.ndjson`
 * dedupe logs (the cross-run memory the whole journal exists to persist),
 * the worktree registry, and the sessions dir never match the pattern. The
 * trailing stamp is a clock reading, so newest-first is a sort on that
 * number — deterministic, no stat calls. Best-effort housekeeping: an
 * unreadable journal root (a first run) or a failed removal must never fail
 * an honest run — the next run's prune retries.
 */
const pruneAuditDirs = (journalRoot: string): void => {
  let dirs: string[];
  try {
    dirs = readdirSync(journalRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && AUDIT_DIR_PATTERN.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return; // no journal root yet — nothing to prune
  }
  const stampOf = (name: string): number => Number(name.slice(name.indexOf('-') + 1));
  for (const name of dirs.sort((a, b) => stampOf(b) - stampOf(a)).slice(AUDIT_DIRS_KEPT)) {
    try {
      rmSync(join(journalRoot, name), { recursive: true, force: true });
    } catch {
      // retried by the next run's prune — never a run-failing effect
    }
  }
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
  /** USD-cap override; default SelfhostDefaults.maxUsd (I9). SWEEP-LEVEL:
   * the cap is carried forward across the run's PRs (each loop gets the
   * remaining budget, decremented by each fix run's cost rollup), never the
   * full cap re-granted per PR. */
  maxUsd?: number;
  /** Journal root override; default `<repoRoot>/.selfhost/journal`. */
  journalRoot?: string;
  /** Fetch + summarize only — resolve nothing, dispatch nothing. */
  dryRun?: boolean;
}

/**
 * The run's honest outcome: one row per looped PR (its full ReviewLoopOutcome)
 * and one row per PR whose loop THREW or whose pre-dispatch revalidation
 * read FAILED — both are facts the workflow records.
 * `dryRun`/`wouldRun` are present only in dry-run mode: the structural
 * would-run summary (log-safe lines, no titles or bodies), with the
 * pre-loop exclusions (fork/draft/no-number/state-fetch-failure) named.
 * `excluded` is present only in real-run mode: every listed-but-not-looped
 * PR (fork, draft, a row without a number, a protected-branch head, a PR
 * reached after the sweep budget ran out, a PR whose head ref was renamed
 * between the listing and its dispatch) with its reason — the SAME
 * strings the dry-run path surfaces in its wouldRun lines, plus the
 * dispatch-time revalidation rows only a real run can discover. A PR absent
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

/** The no-head-ref exclusion reason (shared verbatim by both run modes): a
 * listing row whose `head.ref` is absent maps to an empty headRefName, which
 * can never be dispatched — an unverifiable head is not a dispatchable head
 * (and the pre-dispatch revalidation's `'' === ''` compare would otherwise
 * vouch for it). */
const EXCLUDE_NO_HEAD_REF = 'fetch-failed: listing row without a head ref';

/** The fork exclusion reason (shared verbatim by both run modes). */
const excludeForked = (headRepoFullName: string): string =>
  `forked-pr (head repo ${headRepoFullName === '' ? 'unknown' : headRepoFullName})`;

/** The draft exclusion reason (shared verbatim by both run modes). */
const EXCLUDE_DRAFT = 'draft';

/**
 * The protected-branch exclusion reason (shared verbatim by both run modes):
 * the loop's fix workers push review commits to the PR's HEAD branch, so a
 * PR whose head IS the protected branch must never be looped — the push
 * would land worker commits on it (SelfhostDefaults.protectedBranch, the
 * resolveConflict protectedBranch passthrough's same rule).
 */
const EXCLUDE_PROTECTED_HEAD = `protected-branch head (a review fix would push worker commits to ${SelfhostDefaults.protectedBranch})`;

/** The sweep-budget exclusion reason — real-run only (a dry run spends nothing). */
const EXCLUDE_SWEEP_BUDGET = 'sweep budget exhausted (I9)';

/** The closed-after-listing exclusion reason (the revalidation payload's state). */
const EXCLUDE_CLOSED_AFTER_LISTING = 'closed after listing';

/** The draft-converted-after-listing exclusion reason (the revalidation payload's draft flag). */
const EXCLUDE_DRAFTED_AFTER_LISTING = 'converted to draft after listing';

/**
 * The fail-closed suffix appended to a THROWN loop's failure row (KyI): the
 * thrown loop's spend cannot be read from a report that never resolved, so
 * the sweep is burned and the row records WHY the later PRs read exhausted.
 */
const EXCLUDE_SWEEP_BUDGET_FAIL_CLOSED =
  'sweep budget exhausted (fail-closed: a thrown loop may have unaccounted spend)';

/**
 * The pre-loop exclusion reason for a listing row, or null when the row is
 * loopable: open is the listing's own filter; same-repo (the #142 contract —
 * the loop only ever works the base repository's branches), non-draft, and
 * not-headed-into the protected branch gate here, before any worktree or
 * dispatch exists. ONE classifier serves BOTH run modes — the dry run
 * renders it as a `#<n> excluded <reason>` wouldRun line, the real run
 * records it as an `excluded` row — so the two payloads' reason strings can
 * never drift.
 */
const preLoopExclusion = (
  row: { pr: number; headRepoFullName: string; draft: boolean; headRefName: string },
  owner: string,
  repo: string,
): string | null => {
  if (row.pr === 0) return EXCLUDE_NO_NUMBER;
  if (row.headRefName === '') return EXCLUDE_NO_HEAD_REF;
  if (row.headRepoFullName !== `${owner}/${repo}`) return excludeForked(row.headRepoFullName);
  if (row.draft) return EXCLUDE_DRAFT;
  if (row.headRefName === SelfhostDefaults.protectedBranch) return EXCLUDE_PROTECTED_HEAD;
  return null;
};

/**
 * Run the review loop over every open, same-repo, non-draft PR (module doc).
 *
 * Real run: one runReviewLoop per PR with per-PR fault isolation; the run
 * stamp (one clock reading) namespaces each PR's journal dir; the pre-loop
 * exclusions (fork/draft/no-number/protected-branch head) are RECORDED in
 * `excluded` — same reason strings as the dry run — never silently skipped;
 * the maxUsd cap is sweep-level, carried forward across the PRs (a PR
 * reached at ≤ 0 remaining is recorded, not looped, not charged the full
 * cap again). Dry run: NO
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
  // Persistence seams under journalRoot — created lazily by their consumers
  // (the real-run path creates the ROOT itself first, see the mkdir below);
  // the direct filesystem touches here are that root creation and
  // pruneAuditDirs' bounded cleanup of the audit dirs prior runs left behind.
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
  // FIRST-RUN JOURNAL ROOT (CodeRabbit round 2, KyA): on a first run / cache
  // miss `<journalRoot>` does not exist, and the registry's first `withLock`
  // needs `<journalRoot>/worktree-registry.json.lock` — the lockfile layer
  // requires its PARENT directory before anything creates it, so every PR
  // used to fail at resolvePrWorktree and no cacheable state ever appeared.
  // Create the root recursively BEFORE the registry is used and before the
  // loop's own journal writes (per-PR audit dirs, dispatch logs). Real runs
  // only: the dry run's contract is fetch + summarize with no filesystem
  // effect, and it never touches the registry or the journal.
  mkdirSync(journalRoot, { recursive: true });
  // The SWEEP-LEVEL cap (I9): one budget for the whole run, carried forward
  // in listing order — re-granting the full cap per PR would multiply the
  // advertised cap by the PR count.
  let remaining = cfg.maxUsd ?? SelfhostDefaults.maxUsd;
  const results: Array<{ pr: number; outcome: ReviewLoopOutcome }> = [];
  const failures: Array<{ pr: number; error: string }> = [];
  const excluded: Array<{ pr: number; reason: string }> = [];
  for (const row of rows) {
    // The pre-loop gates RECORD, not skip: every listed-but-not-looped PR
    // (fork/draft/no-number/protected-branch head) rides out in `excluded`
    // with the same reason strings the dry run surfaces — a silent skip
    // would orphan the PR from the summary (an absent row is a lie, not a
    // shrug).
    const exclusion = preLoopExclusion(row, cfg.owner, cfg.repo);
    if (exclusion !== null) {
      excluded.push({ pr: row.pr, reason: exclusion });
      continue;
    }
    // The sweep cap gates before any worktree or dispatch: a PR reached at
    // ≤ 0 remaining is a recorded row, never a silent skip and never a
    // loop under a spent budget (I9 — honest stop, honest bookkeeping).
    if (remaining <= 0) {
      excluded.push({ pr: row.pr, reason: EXCLUDE_SWEEP_BUDGET });
      continue;
    }
    // HEAD-REF REVALIDATION (CodeRabbit P1): the listing at the top was
    // read ONCE, and a head branch renamed after that read but before this
    // dispatch would have the loop push fixes to the STALE name — git
    // recreates the old branch from the worktree, the real PR head never
    // updates, yet the loop's replies and resolves still post. So,
    // immediately before dispatching each PR's loop, re-fetch the
    // single-PR endpoint (`repos/{owner}/{repo}/pulls/{n}` — the same argv
    // pattern the candidates module's enrichment rides) and compare its
    // authoritative `head.ref` to the listed headRefName. On mismatch the
    // PR is recorded excluded-style and skipped — the loop is NEVER
    // dispatched against a branch the forge no longer confirms. The same
    // payload also re-vouches for the PR's STATUS: a PR closed or converted
    // to draft after the listing must never receive the loop's replies and
    // pushes, so `state === 'open'` and `draft === false` are required —
    // an absent or non-conforming field fails closed, as an excluded row.
    // A failed revalidation read fails CLOSED the same way (a failure row,
    // no dispatch): an unverifiable head is never a dispatchable head. The
    // sweep budget is deliberately NOT burned here — nothing was spent:
    // the loop never ran. Dry runs skip this read entirely (they dispatch
    // nothing, so they cannot push to a stale branch).
    try {
      const wire = await ghJson<unknown>(deps.gh, [
        'api',
        `repos/${cfg.owner}/${cfg.repo}/pulls/${String(row.pr)}`,
      ]);
      const freshHeadRef = headRefOfPayload(wire);
      if (freshHeadRef !== row.headRefName) {
        excluded.push({
          pr: row.pr,
          reason: `head ref renamed since listing (${row.headRefName} -> ${freshHeadRef})`,
        });
        continue;
      }
      if (stateOfPayload(wire) !== 'open') {
        excluded.push({ pr: row.pr, reason: EXCLUDE_CLOSED_AFTER_LISTING });
        continue;
      }
      if (draftOfPayload(wire) !== false) {
        excluded.push({ pr: row.pr, reason: EXCLUDE_DRAFTED_AFTER_LISTING });
        continue;
      }
    } catch (error) {
      failures.push({
        pr: row.pr,
        error: `head revalidation failed: ${oneLineError(error)}`,
      });
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
        maxUsd: remaining,
      },
      // The wall-clock ladder's LIMITS half (I8/I9; review-debt #137's arming
      // for the REVIEW path — the merge path arms it in self-merge-prs.ts):
      // the frozen default rides the governor, so a wedged fixer is
      // escalated by the ladder instead of stalling the scheduled run to its
      // workflow timeout. Default-only by design — no cfg override, no CLI
      // flag (the entry invents no number and offers no knob).
      limits: { perJobWallClockMs: SelfhostDefaults.perJobWallClockMs },
      dispatchLogPath: join(journalRoot, `dispatch-${String(row.pr)}.ndjson`),
      worktreeRoot,
      // Tests-only injection: absent → runReviewLoop builds its own default
      // view (the central registry, the run-plan path).
      ...(deps.driverRegistryView !== undefined
        ? { driverRegistryView: deps.driverRegistryView }
        : {}),
    };
    try {
      const outcome = await loop(opts);
      results.push({ pr: row.pr, outcome });
      // Carry the spend forward from THIS PR's fix run — the governed
      // report's derived-only cost rollup (DD-9). A PR whose loop refused
      // before the fix stage (no fixReport) or whose report carries no
      // rollup consumed nothing this entry can account for: decrement only
      // on a present, finite number, never on absence.
      const cost = outcome.fixReport?.costUSD;
      if (typeof cost === 'number' && Number.isFinite(cost)) {
        remaining -= cost;
      }
    } catch (error) {
      // FAIL-CLOSED SWEEP BUDGET, SPEND-EVIDENCE-GATED (CodeRabbit round 2,
      // KyI): a loop that spent and THEN threw leaves its fix-run cost
      // unaccounted — the carry-forward above only subtracts on resolve.
      // Carrying the old remaining forward would let every later PR re-spend
      // the same allowance, so a throw WITH spend evidence BURNS the sweep:
      // remaining is zeroed and the failure row says so, honestly, instead
      // of pretending the budget survives an unaccounted spend. The evidence
      // gate: the loop itself writes the PR's dispatch log's first line at
      // its first dispatch, so a log WITHOUT lines proves the loop threw
      // BEFORE any dispatch (a worktree or registry fault) and spent
      // nothing — the budget then carries forward unchanged, and one
      // always-throwing early PR cannot starve every later PR forever.
      const message = oneLine(error instanceof Error ? error.message : String(error));
      const burned = dispatchLogHasLines(opts.dispatchLogPath);
      if (burned) {
        remaining = 0;
      }
      failures.push({
        pr: row.pr,
        // The fail-closed suffix rides only a BURNED budget — it records why
        // the later PRs read exhausted, so it must not claim a burn that did
        // not happen.
        error: burned ? `${message} — ${EXCLUDE_SWEEP_BUDGET_FAIL_CLOSED}` : message,
      });
    }
  }
  // Bounded journal growth: the workflow's cache save persists everything
  // under journalRoot, so drop all but the newest per-run audit dirs before
  // this run's state is saved (the flat dispatch logs ride untouched).
  pruneAuditDirs(journalRoot);
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
    // The real run's pre-loop exclusions (fork/draft/no-number/protected-
    // branch/sweep-budget), same reason strings the dry run names in
    // wouldRun ([] in dry-run mode, whose exclusions ride the wouldRun
    // lines).
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
