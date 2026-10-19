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
import { deepFreeze } from '../shared/deepFreeze.js';

/**
 * The shape of the frozen self-hosting defaults. Plain data only — the
 * workflows serialize these into flags and run options.
 */
export interface SelfhostDefaultsConfig {
  /**
   * The scheduled runs' TOKEN cap (I9 — the budget cap is an HONEST STOP:
   * the governor stops the run when the token rollup crosses it rather than
   * pretending to have finished — a one-job merge plan surfaces the trip as
   * the budget-exhausted job row (stoppedEarly stays false), and the loop
   * path's per-PR governors surface it through the job row too). It feeds
   * BOTH compositions: the merge dispatch path's RunOptions.maxTokens and
   * the review loop's runOptions.maxTokens (sweep-level there, carried
   * forward across the PRs).
   *
   * WHY TOKENS, NOT USD: the served model (`driver`, below) is UNPRICED, so
   * its results carry no costUSD and the governor's DD-9 unpriced-usage
   * trip fails a run loud the moment real usage folds under a configured
   * maxUsd. maxTokens is the DD-9 escape for exactly that case — it binds
   * independently of pricing. A USD cap stays available as an explicit
   * opt-in (`--max-usd`, for an adopter whose model is priced); there is
   * deliberately NO USD default.
   *
   * 2_000_000 ≈ the retired 1 USD stop at a ~$0.50/Mtok blended flash-class
   * rate. The rollup sums input + output + cacheRead + cacheWrite (the
   * governor's totalTokensOf), and one fix-worker run on a mid-size diff
   * reads several hundred thousand cached tokens, so this admits a few
   * fix runs per sweep and stops a runaway one.
   */
  maxTokens: number;
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
   * workers): provider 'zai' — the Z.AI coding endpoint is that provider's
   * default route on the factory's default 'ai-sdk' lane (the GLM Coding
   * Plan's OpenAI-compatible wire) — and model 'glm-5.3-flash', THE SERVED
   * MODEL ID per the run's recorded decision (docs/eval-axes-demo.md,
   * conductor decision 2026-09-14): the coding wire observed serving
   * glm-5.3-flash for a glm-4.6 request. NO alias is declared: the
   * served-model assertion (the factory's wrapper, W1.6 — the guard this
   * comment once promised is now real) fails any dispatch whose observed id
   * is not the requested id, so config requests the served id so every
   * dispatch runs; this also matches the fixtures eval axis, which requests
   * the served id with no aliases. The provider handle is the normalised
   * 'zai', never the deprecated 'ai-sdk' alias (which now means lane
   * 'ai-sdk' on provider 'zai' and prints a `cq:` deprecation notice).
   * NOTE (review r2): the served id is UNPRICED — `glm-5.3-flash` has no
   * published list rates (`src/driver/pricing/data.ts`, docs/dd-2), so a
   * dispatch reports usage with no costUSD and the governor's DD-9
   * unpriced-usage trip fires under a configured maxUsd — which is why the
   * default cap above is `maxTokens`. Pricing the served id is the tracked
   * DD-8 rate-refresh work; this config does not fabricate a rate.
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
  maxTokens: 2_000_000,
  perJobWallClockMs: 300_000,
  driver: { provider: 'zai', model: 'glm-5.3-flash' },
  baseBranch: 'merge-queue',
  protectedBranch: 'main',
});

/**
 * The PEAK-tariff switch's shape: the provider's documented peak window
 * (UTC) and the driver to dispatch inside it. Plain data plus the pure
 * clock functions below — the ONE place the scheduled runs' model is
 * decided (owner directive 2026-10-12: the loop runs ALL DAY; during the
 * Z.ai GLM peak it uses a different provider instead of standing down).
 */
export interface SelfhostPeakConfig {
  /**
   * The peak window in UTC: the weekdays it covers and its `[start, end)`
   * minute bounds, minutes past 00:00 UTC. The clock comparison below is
   * inclusive at `startMinute`, exclusive at `endMinute`.
   */
  window: {
    /** UTC weekday numbers, 1=Mon … 7=Sun (the ISO numbering, NOT Date#getUTCDay's 0=Sun). */
    utcWeekdays: readonly number[];
    /** Peak start, minutes past 00:00 UTC (inclusive). */
    startMinute: number;
    /** Peak end, minutes past 00:00 UTC (exclusive). */
    endMinute: number;
  };
  /**
   * The PEAK-DISPATCH HEADROOM, minutes before `window.startMinute`: the
   * documented maximum scheduled run duration, reserved so a sweep that
   * STARTS just before the peak is dispatched through the PEAK driver
   * instead of the off-peak one. Without it a delayed or manual run
   * starting at 05:59 could keep dispatching off-peak (Z.ai GLM) work
   * INSIDE the ~3× quota window, because a run's driver is fixed when the
   * run starts. With it, every dispatch inside the window is the peak
   * provider's. This reserves dispatch, never a start exclusion: the
   * schedule still runs all day.
   */
  headroomMinutes: number;
  /**
   * The driver dispatched INSIDE the window — the same ModelSpec shape the
   * frozen default carries, so `resolveSelfhostDriver` returns either one.
   */
  driver: ModelSpec;
}

/**
 * The frozen peak switch. The window is the Z.ai GLM Coding Plan's peak
 * hours — 14:00–18:00 Asia/Singapore on weekdays, when quota consumption
 * multiplies (~3×) — written in UTC because every consumer reads a UTC
 * clock: **06:00–10:00 UTC, Monday–Friday**. The peak driver is DeepSeek's
 * served flash model: `deepseek-flash` is the id the endpoint ECHOES back
 * (a `deepseek-chat` request is served as `deepseek-flash` and would fail
 * the served-model identity guard), and the `deepseek` provider factory
 * reads `DEEPSEEK_API_KEY` from the environment at dispatch time.
 *
 * IMMUTABLE BY CONSTRUCTION (deepFreeze), like every other shared default:
 * a nested write throws instead of silently re-pointing a live run's model.
 */
export const SelfhostPeak: SelfhostPeakConfig = deepFreeze({
  window: {
    utcWeekdays: [1, 2, 3, 4, 5],
    startMinute: 6 * 60,
    endMinute: 10 * 60,
  },
  // The template's documented ≤20-minute scheduled run (the retired
  // start-exclusion guard reserved exactly this band: no weekday start from
  // 05:40 inclusive). 20 minutes covers the privileged job's 15-minute
  // `timeout-minutes` with the documented bound's margin.
  headroomMinutes: 20,
  // DEFAULT only: the peak driver is configuration (`CQ_SELFHOST_PEAK_DRIVER`,
  // see resolveSelfhostDrivers). Owner ruling 2026-10-16: by default the peak
  // window keeps the same driver as the rest of the day (Z.ai GLM capacity is
  // ample for this repository's own loop); the window, the pre-peak headroom
  // and the single-clock-read semantics are unchanged.
  driver: SelfhostDefaults.driver,
});

/**
 * True when `nowMs` falls inside the frozen peak window (UTC). Pure: the
 * caller supplies the clock, so the boundaries are unit-testable without a
 * fake timer. Weekday-only, `[startMinute, endMinute)` — 06:00 through
 * 09:59 inclusive, 10:00 exclusive, weekends never.
 */
export function isSelfhostPeak(nowMs: number): boolean {
  return inUtcWeekdayBand(nowMs, SelfhostPeak.window.startMinute, SelfhostPeak.window.endMinute);
}

/**
 * True when `nowMs` falls in the RESERVED PRE-PEAK HEADROOM — the
 * `headroomMinutes` band immediately before the window, on the window's
 * weekdays. A run starting here may still be executing when the peak
 * begins, so `resolveSelfhostDriver` sends it through the PEAK driver: no
 * off-peak (Z.ai GLM) dispatch can be issued inside the ~3× quota window.
 * Disjoint from `isSelfhostPeak`; pure, like it. The band never wraps past
 * midnight (a headroom wider than the window start clamps to 00:00).
 */
export function isSelfhostPeakHeadroom(nowMs: number): boolean {
  return inUtcWeekdayBand(
    nowMs,
    SelfhostPeak.window.startMinute - SelfhostPeak.headroomMinutes,
    SelfhostPeak.window.startMinute,
  );
}

/**
 * The shared comparison: peak weekdays and the `[fromMinute, toMinute)` UTC
 * minute band (each clamped at 00:00 — a band never wraps past midnight).
 * One implementation so the window and headroom predicates can never
 * disagree about the weekday rule; the two CALLS keep the bands disjoint.
 */
function inUtcWeekdayBand(nowMs: number, fromMinute: number, toMinute: number): boolean {
  const at = new Date(nowMs);
  // Date#getUTCDay is 0=Sun … 6=Sat; the window is documented in the ISO
  // numbering, so map Sunday to 7 before the membership test (a Sunday
  // reading 0 must not accidentally match a 1–5 weekday list either way,
  // but the mapping keeps the data and the code naming the same thing).
  const raw = at.getUTCDay();
  const weekday = raw === 0 ? 7 : raw;
  if (!SelfhostPeak.window.utcWeekdays.includes(weekday)) return false;
  const minute = at.getUTCHours() * 60 + at.getUTCMinutes();
  return minute >= Math.max(0, fromMinute) && minute < Math.min(toMinute, 24 * 60);
}

/**
 * THE one place the scheduled runs' driver is decided: inside the peak
 * window — or its reserved pre-peak headroom, so a run that starts just
 * before the peak cannot dispatch off-peak work inside it — the peak
 * driver, otherwise the frozen off-peak default. The caller reads its clock
 * ONCE (the entry reuses the run's start stamp), so every loop of a sweep
 * dispatches through the same provider the run's start instant selected — a
 * delayed fire or a manual dispatch resolves at ITS OWN start, never at the
 * slot's nominal time.
 */
/** Env key naming the off-peak driver as `provider/model` (blank → the frozen default). */
export const SELFHOST_DRIVER_ENV = 'CQ_SELFHOST_DRIVER';
/** Env key naming the peak-window driver as `provider/model` (blank → the frozen default). */
export const SELFHOST_PEAK_DRIVER_ENV = 'CQ_SELFHOST_PEAK_DRIVER';

/**
 * The settle ledger's path on the `cq-state` state branch (`state-branch.ts`
 * is the only writer; `policy/queue/settle-state.ts` owns the schema). The
 * deployed automation pins this wire path — the self-host templates document
 * it and the shipped `cq-policy.yml` reads the ledger at it when it judges a
 * `cq-override` label — so it is configuration data here, not a literal in
 * each consumer: migration step 1.2 passes it as a parameter to
 * `gates.policyDiff` (whose built-in wire default matches this value), which
 * is what lets the gates import the pure schema from `policy/queue` and
 * nothing else from selfhost.
 */
export const SETTLE_STATE_PATH = '.cq/settle-state.json';

/**
 * Parse a `provider/model` spec. Exactly one slash, both halves non-empty,
 * no whitespace: a malformed value THROWS with the offending env name so a
 * typo fails the run loud instead of silently dispatching the default model.
 */
export function parseModelSpec(value: string, source: string): ModelSpec {
  const parts = value.split('/');
  const provider = parts[0];
  const model = parts[1];
  if (
    parts.length !== 2 ||
    provider === undefined ||
    model === undefined ||
    provider === '' ||
    model === '' ||
    /\s/.test(value)
  ) {
    throw new Error(
      `selfhost: ${source} must be '<provider>/<model>' (got ${JSON.stringify(value)})`,
    );
  }
  return { provider, model };
}

/** The off-peak and peak drivers: env overrides first, frozen defaults otherwise. */
export interface SelfhostDrivers {
  offPeak: ModelSpec;
  peak: ModelSpec;
}

/**
 * Model choice is CONFIGURATION, never a constant an operator has to edit
 * in source (owner ruling 2026-10-16): `CQ_SELFHOST_DRIVER` and
 * `CQ_SELFHOST_PEAK_DRIVER` name the drivers; an unset or blank key means the
 * frozen default for that window. Read once per run at the composition root
 * (the entry modules), never inside an op.
 */
export function resolveSelfhostDrivers(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SelfhostDrivers {
  const offPeakRaw = env[SELFHOST_DRIVER_ENV] ?? '';
  const peakRaw = env[SELFHOST_PEAK_DRIVER_ENV] ?? '';
  return {
    offPeak:
      offPeakRaw === '' ? SelfhostDefaults.driver : parseModelSpec(offPeakRaw, SELFHOST_DRIVER_ENV),
    peak: peakRaw === '' ? SelfhostPeak.driver : parseModelSpec(peakRaw, SELFHOST_PEAK_DRIVER_ENV),
  };
}

export function resolveSelfhostDriver(
  nowMs: number,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ModelSpec {
  const drivers = resolveSelfhostDrivers(env);
  return isSelfhostPeak(nowMs) || isSelfhostPeakHeadroom(nowMs) ? drivers.peak : drivers.offPeak;
}

/**
 * The environment variable the selected driver's provider factory reads its
 * API key from (the ai-sdk lane reads each provider's key AT CALL TIME — see
 * `defaultProviders()` in src/driver/ai-sdk/index.ts). `undefined` when no
 * key name is known: an unknown provider cannot be credential-checked, and a
 * caller must treat that as "cannot vouch" rather than "no key needed".
 */
export function driverKeyEnv(driver: ModelSpec): string | undefined {
  switch (driver.provider) {
    // 'zai' is the normalised handle for the Z.ai coding endpoint;
    // 'ai-sdk' is the deprecated driver-kind alias that resolves to the same
    // factory (see the ai-sdk header), so both read the same key.
    case 'zai':
    case 'ai-sdk':
      return 'ZAI_API_KEY';
    // The remaining in-process ai-sdk handles (defaultProviders()): an
    // adopter who re-points SelfhostDefaults.driver / SelfhostPeak.driver at
    // one of these gets the right key name, not an empty handshake.
    case 'deepseek':
      return 'DEEPSEEK_API_KEY';
    case 'openai':
      return 'OPENAI_API_KEY';
    case 'anthropic':
      return 'ANTHROPIC_API_KEY';
    // The OpenCode Go handle (dev-strategy §8 item 7): the key is read at
    // dispatch time by the ai-sdk lane's 'opencode-go' factory, which ALSO
    // requires OPENCODE_GO_BASE_URL — the route is configuration, never a
    // constant. Peak-window exhaustion on this wire is HTTP 402 → 'quota'
    // (the ai-sdk classifier; the profile's endpoint-scoped rule
    // discriminates the Go wire from the Zen pay-per-use one).
    case 'opencode-go':
      return 'OPENCODE_GO_API_KEY';
    default:
      // A handle this map does not know (a host-CLI lane, a typo): the caller
      // must read undefined as "cannot vouch" and refuse, never as "no key
      // needed".
      return undefined;
  }
}

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
