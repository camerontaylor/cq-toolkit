// selfhost/config — the stage-2 self-hosting switch's DEFAULT-FROM-CONFIG
// module (goal T4.1): the one place the repo's own automation workflows read
// their run configuration from. The workflows instantiate these values as
// CLI flags and RunOptions overlays; NOTHING in src/selfhost invents a
// second copy of a number — an entry module imports the frozen default or
// parses an override, it never hardcodes.
//
// This module is CONFIG DATA plus a tiny argument parser — composition
// glue, not an op: no I/O, no gh, no driver, no clock. Deep-frozen like
// every other shared default (deepFreeze makes a nested write THROW in
// strict mode instead of silently poisoning every later consumer — the
// same contract as defaultHarnessConfig).
//
// WHY THERE IS NO reviewLoop SECTION: the review loop's fan-out concurrency
// is FIXED BY THE PLAN ITSELF (runReviewLoop forces 1 — the
// shared-per-PR-worktree sequencing contract) and its RunOptions overlay
// takes only journalDir/maxUsd/maxTokens — there is no knob here to
// configure, so config records none (a knob that cannot turn must not
// pretend to exist).
import { join } from 'node:path';
import type { ModelSpec } from '../driver/types.js';
import { deepFreeze } from '../harness/config.js';

/**
 * The shape of the frozen self-hosting defaults. Plain data only — the
 * workflows serialize these into flags and run options.
 */
export interface SelfhostDefaultsConfig {
  /**
   * The scheduled runs' USD cap (I9 — the budget cap is an HONEST STOP: the
   * governor stops the run when the derived cost rollup crosses it rather
   * than pretending to have finished — a one-job merge plan surfaces the
   * trip as the budget-exhausted job row (stoppedEarly stays false), and
   * the loop path's per-PR governors surface it through the job row too).
   * This is the workflow's `--max-usd` default and feeds BOTH compositions:
   * the merge dispatch path's RunOptions.maxUsd and the review loop's
   * runOptions.maxUsd. The effective cap is min(RunOptions.maxUsd,
   * Limits.maxUsd) — the frozen cap-precedence rule — so a caller may lower
   * it per run but no composition can raise it past what the workflow
   * passed.
   */
  maxUsd: number;
  /**
   * Per-job wall clock in milliseconds — arms the governor's wall-clock
   * ladder (rung 1 = this value) on the MERGE DISPATCH PATHS
   * (review-debt #137's arming for the merge path): a conflict-agent or
   * fix-worker job that wedges is escalated by the ladder instead of
   * stalling the scheduled run forever. 300000 = 5 minutes per job —
   * enough for one bounded worktree resolution, small enough that a
   * scheduled run cannot spend its whole window on one hung job.
   */
  perJobWallClockMs: number;
  /**
   * The driver binding for every agent dispatch (conflict resolutions, fix
   * workers): provider 'ai-sdk' — the Z.AI coding endpoint is the ai-sdk
   * default route (the GLM Coding Plan's OpenAI-compatible wire) — and
   * model 'glm-5.3-flash', THE SERVED MODEL ID per the run's recorded
   * decision (docs/eval-axes-demo.md, conductor decision 2026-09-14): the
   * coding wire observed serving glm-5.3-flash for a glm-4.6 request, and
   * requesting anything else trips the drivers' served-model-mismatch
   * guard. Config requests the served id so every dispatch runs. NOTE
   * (review r2): the served id is UNPRICED — `glm-5.3-flash` has no
   * published list rates (`src/driver/pricing/data.ts`, docs/dd-2), so a
   * dispatch reports usage with no costUSD and the governor's DD-9
   * unpriced-usage trip fires under a configured maxUsd. Pricing the
   * served id is the tracked DD-8 rate-refresh work; this PR does not
   * fabricate a rate.
   */
  driver: ModelSpec;
  /**
   * The queue branch the merge-prs plan merges into for THIS repo (the
   * documented merge-queue policy: PRs land on `merge-queue`, never
   * directly on the trunk). The merge.runPrs op hardcodes no branch name —
   * baseBranch is configuration, and this is its self-hosted value.
   */
  baseBranch: string;
  /**
   * The branch the conflict-resolution pushes may NEVER land on (the
   * resolveConflict protectedBranch passthrough): the agent's resolved
   * branches push to the PR's head branch only — `main` is human territory.
   */
  protectedBranch: string;
}

/**
 * The frozen self-hosting defaults — the "default from config" the
 * self-hosting workflows read. IMMUTABLE BY CONSTRUCTION (deepFreeze): a
 * nested write throws instead of mutating the shared value.
 */
export const SelfhostDefaults: SelfhostDefaultsConfig = deepFreeze({
  maxUsd: 1,
  perJobWallClockMs: 300_000,
  driver: { provider: 'ai-sdk', model: 'glm-5.3-flash' },
  baseBranch: 'merge-queue',
  protectedBranch: 'main',
});

/**
 * The default journal root for a checkout: `<repoRoot>/.selfhost/journal` —
 * where the entry modules put per-run journals, dispatch logs, the worktree
 * registry, and the merge sessions dir when no `--journal-root` override was
 * passed. `.selfhost/` is gitignored (runtime state, never committed); the
 * path is pure derivation — no directory is created here.
 */
export const defaultJournalRoot = (repoRoot: string): string =>
  join(repoRoot, '.selfhost', 'journal');

/**
 * The parsed entry-module arguments: plain data, total (parse either
 * returns a complete value or throws — never a partial guess). `maxUsd` and
 * `journalRoot` are absent when the flag was not passed (the entry module
 * falls back to the frozen default); `dryRun` is always present (false when
 * not requested).
 */
export interface ParsedSelfhostArgs {
  /** `--max-usd <n>` override — validated finite >= 0; undefined when absent (the entry module falls back to the frozen default). */
  maxUsd?: number;
  /** `--journal-root <dir>` override — a non-empty directory path; undefined when absent (the entry module falls back to defaultJournalRoot). */
  journalRoot?: string;
  /**
   * `--repo <owner/name>` — the target repository; undefined when absent
   * (the entry module falls back to the GH_REPOSITORY env — required to be
   * present in one of the two before any gh call).
   */
  repo?: string;
  /**
   * `--responder-login <login>` — the review loop's OWN identity (in CI the
   * token's user; the round-3 deployment requirement, docs for
   * src/plans/review-loop.ts). Undefined when absent — the review-loop entry
   * maps that to null (author-blind verify), never to a guessed login.
   */
  responderLogin?: string;
  /** `--dry-run` — fetch + classify only, no merge and no fix dispatch. */
  dryRun: boolean;
}

/** The usage text every parse failure carries (fail loud, fail instructive). */
const USAGE =
  'usage: <entry> [--max-usd <n>] [--journal-root <dir>] [--repo <owner/name>] [--responder-login <login>] [--dry-run] — unknown flags and bare arguments are rejected';

/**
 * Parse the self-hosting entry modules' arguments — tiny, dependency-free,
 * total. Flags (space-separated values only, last occurrence wins):
 *   - `--max-usd <n>`    — optional USD-cap override; MUST be finite >= 0
 *     (a NaN/Infinity/negative cap would read as "no cap" downstream —
 *     malformed config fails loud here, never silently unlimited; I9).
 *   - `--journal-root <dir>` — optional non-empty journal directory.
 *   - `--repo <owner/name>` — optional target repository; both segments
 *     must be non-empty (the full gh-charset validation stays with the
 *     fetch layer, which owns the ghNameOk rule).
 *   - `--responder-login <login>` — optional loop identity for the review
 *     loop's self-reply suppression.
 *   - `--dry-run`        — fetch + classify only; the entry module must
 *     neither merge nor dispatch fixes.
 * Anything else — an unknown flag or a bare positional — THROWS with the
 * usage text: a scheduled workflow that typos a flag must fail before any
 * gh/git/driver effect, not run with the flag silently ignored.
 */
export function parseSelfhostArgs(argv: readonly string[]): ParsedSelfhostArgs {
  const parsed: ParsedSelfhostArgs = { dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      parsed.dryRun = true;
      continue;
    }
    if (arg === '--max-usd') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`selfhost: ${arg} requires a value. ${USAGE}`);
      }
      i++;
      const usd = Number(value);
      if (!Number.isFinite(usd) || usd < 0) {
        throw new Error(
          `selfhost: --max-usd must be a finite number >= 0 — got ${JSON.stringify(value)}. ${USAGE}`,
        );
      }
      parsed.maxUsd = usd;
      continue;
    }
    if (arg === '--journal-root' || arg === '--repo' || arg === '--responder-login') {
      const value = argv[i + 1];
      if (value === undefined) {
        throw new Error(`selfhost: ${arg} requires a value. ${USAGE}`);
      }
      if (value === '') {
        throw new Error(`selfhost: ${arg} requires a non-empty value. ${USAGE}`);
      }
      i++;
      if (arg === '--journal-root') {
        parsed.journalRoot = value;
        continue;
      }
      if (arg === '--repo') {
        const parts = value.split('/');
        const owner = parts[0];
        const name = parts[1];
        if (
          parts.length !== 2 ||
          owner === undefined ||
          owner === '' ||
          name === undefined ||
          name === ''
        ) {
          throw new Error(
            `selfhost: --repo must be <owner>/<name> with both segments non-empty — got ${JSON.stringify(value)}. ${USAGE}`,
          );
        }
        parsed.repo = value;
        continue;
      }
      parsed.responderLogin = value;
      continue;
    }
    throw new Error(`selfhost: unknown argument ${JSON.stringify(arg)}. ${USAGE}`);
  }
  return parsed;
}
