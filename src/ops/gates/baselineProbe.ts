// Gates lane C2 — the baseline probe: run the check once through the
// injected runner and classify the state of the world — clean, failing, or
// bail (the check itself did not COMPLETE: spawn failure, signal, timeout,
// crash text). The probe is what makes the D5 crown jewel honest: a
// baseline is only worth recording when the probe says the run actually
// happened. Bail is retried a bounded number of times because the bail
// class is transient by nature (flaky infrastructure, not code).
//
// Invariants honored here:
//   - I7 (the probe takes NO cache/baseline input by construction): the op
//     input is adapter + command + bail config only — there is no field a
//     cached result could hide in, and zero memoization: two calls always
//     re-run the check (asserted by call count in tests).
//   - Honest no-verdict: a runner-level CRASH is `indeterminate`, never
//     `failed` and never clean — the probe did not observe the check.
//   - Bail semantics are NARROW: a bail means "the check did not COMPLETE".
//     An unobservable exit code (null) is a bail-candidate on its own; a
//     crash-signature pattern may only classify an attempt that produced NO
//     parseable evidence. A completed, parseable run is classified
//     clean/failing from its evidence even when its TEXT quotes a signature
//     — a test asserting on ECONNREFUSED FAILS, it does not bail.
import type { Op } from '../../kernel/types.js';
import type {
  AdapterName,
  CheckCommand,
  FailureSet,
  RawCheckOutput,
  RunCheck,
} from './checkRunner.js';
import { adapterByName, parseCheckOutput } from './checkRunner.js';

/**
 * The shipped bail-signature patterns, matched case-insensitively as
 * substrings against stdout+stderr of every attempt that produced NO
 * parseable evidence. Frozen: consumers can reference and extend (their own
 * list REPLACES this one, per {@link BailConfig}) but not mutate it.
 */
export const DEFAULT_BAIL_PATTERNS: readonly string[] = Object.freeze([
  'no tests found',
  'no test files found',
  'test run aborted',
  'fatal error',
  'out of memory',
  'maximum call stack',
  'econnrefused',
  'spawn enoent',
]);

/** Default retry budget for bail attempts — 1 initial + 2 retries. */
const DEFAULT_MAX_BAIL_RETRIES = 2;

/** Library-level ceiling for bail retries, mirroring the JSON-boundary bound. */
const BAIL_RETRIES_CEILING = 10;

/**
 * Bail tuning. `bailPatterns`, when supplied, REPLACES
 * {@link DEFAULT_BAIL_PATTERNS} (not extends); `maxBailRetries` is the
 * retry budget on top of the initial attempt. A non-finite, negative, or
 * fractional `maxBailRetries` (reachable at the library level, past any
 * schema) falls back to the default 2 — it never computes a NaN budget;
 * values above 10 clamp to 10, mirroring the JSON-boundary bound.
 */
export interface BailConfig {
  /** Case-insensitive substrings that mark an attempt as a bail. */
  bailPatterns?: string[];
  /** Retries after the initial attempt (default 2). */
  maxBailRetries?: number;
}

/** JSON-serializable input of the `gates.baselineProbe` op. No cache, no baseline field (I7). */
export interface BaselineProbeInput {
  /** Which wire-format adapter will parse the check's output. */
  adapter: AdapterName;
  /** The check command the injected runner executes. */
  command: CheckCommand;
  /** Optional bail tuning; defaults are the shipped signatures and 2 retries. */
  bail?: BailConfig;
}

/** Every state the probe can report, including the no-verdict one. */
export type ProbeVerdict = 'clean' | 'failing' | 'bail' | 'indeterminate';

/**
 * The probe's report for an `ok` result — the verdict rides the OpResult
 * taxonomy, so `indeterminate` never appears here (it is the op STATUS for
 * an unobservable check run).
 */
export interface ProbeReport {
  verdict: Exclude<ProbeVerdict, 'indeterminate'>;
  /** How many times the check was run for this report (1 + bail retries at most). */
  attempts: number;
  /** The parsed failure set, present exactly when the check completed and parsed. */
  failureSet?: FailureSet;
}

/**
 * Build the `gates.baselineProbe` op over an injected runner, up to
 * `1 + maxBailRetries` attempts (the retry count is sanitized at entry:
 * non-finite, negative, or fractional values fall back to the default 2,
 * values above 10 clamp to the ceiling). Per attempt, in order:
 *  (a) exitCode null (signal, timeout, spawn failure) — the run did not
 *      complete: bail-candidate, retry until the budget is spent, then
 *      report `bail`;
 *  (b) the output PARSES — classify clean/failing from the evidence
 *      directly; bail patterns are irrelevant here, even when the failure
 *      text quotes a signature;
 *  (c) the run completed but produced no parseable evidence — a bail
 *      pattern hit classifies it as a bail (retry), otherwise it is
 *      op-level `indeterminate`.
 * A thrown or rejected runner is a probe crash, not a check failure:
 * `indeterminate` with a `check runner crashed:` detail. No state is kept
 * between calls (I7): every invocation runs the check again.
 */
export function makeBaselineProbe(run: RunCheck): Op<BaselineProbeInput, ProbeReport> {
  return async (input) => {
    const patterns = (input.bail?.bailPatterns ?? DEFAULT_BAIL_PATTERNS).map((pattern) =>
      pattern.toLowerCase(),
    );
    const requestedRetries = input.bail?.maxBailRetries ?? DEFAULT_MAX_BAIL_RETRIES;
    const maxRetries =
      Number.isInteger(requestedRetries) && requestedRetries >= 0
        ? Math.min(requestedRetries, BAIL_RETRIES_CEILING)
        : DEFAULT_MAX_BAIL_RETRIES;
    const attemptBudget = 1 + maxRetries;
    for (let attempt = 1; attempt <= attemptBudget; attempt++) {
      let raw: RawCheckOutput;
      try {
        raw = await run(input.command);
      } catch (err) {
        return { status: 'indeterminate', detail: `check runner crashed: ${messageOf(err)}` };
      }
      if (raw.exitCode === null) {
        continue;
      }
      const result = parseCheckOutput(adapterByName(input.adapter), raw);
      if (result.verdict === 'parsed') {
        return {
          status: 'ok',
          value: {
            verdict: result.set.failures.length === 0 ? 'clean' : 'failing',
            attempts: attempt,
            failureSet: result.set,
          },
        };
      }
      if (matchesBailSignature(raw, patterns)) {
        continue;
      }
      return { status: 'indeterminate', detail: result.reason };
    }
    return { status: 'ok', value: { verdict: 'bail', attempts: attemptBudget } };
  };
}

/**
 * Crash-signature match: case-insensitive substring over stdout+stderr.
 * Consulted ONLY for attempts that produced no parseable evidence — never
 * to re-classify a completed, parseable run (see {@link makeBaselineProbe}).
 */
function matchesBailSignature(raw: RawCheckOutput, lowercasePatterns: readonly string[]): boolean {
  const haystack = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
  return lowercasePatterns.some((pattern) => haystack.includes(pattern));
}

/** Error message of an unknown throwable, for the crashed-runner detail. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
