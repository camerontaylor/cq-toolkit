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
//   - Bail detection is conservative: exitCode null OR a known crash-signature
//     pattern (case-insensitive substring) means the check did not complete,
//     so its failure set — whatever it parsed to — is not evidence.
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
 * substrings against stdout+stderr of every attempt. Frozen: consumers can
 * reference and extend (their own list REPLACES this one, per
 * {@link BailConfig}) but not mutate it.
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

/**
 * Bail tuning. `bailPatterns`, when supplied, REPLACES
 * {@link DEFAULT_BAIL_PATTERNS} (not extends); `maxBailRetries` is the
 * retry budget on top of the initial attempt.
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
 * Build the `gates.baselineProbe` op over an injected runner. Up to
 * `1 + maxBailRetries` attempts: an attempt whose exit code is unobservable
 * (signal, timeout, spawn failure) or whose output matches a bail pattern is
 * a BAIL — the check did not complete — and is retried until the budget is
 * spent, then reported as `bail`. A completed attempt parses through the
 * shared I5-guarded entry point: empty failures → `clean`, otherwise
 * `failing`, unparseable shape → op-level `indeterminate`. A thrown or
 * rejected runner is a probe crash, not a check failure:
 * `indeterminate` with a `check runner crashed:` detail. No state is kept
 * between calls (I7): every invocation runs the check again.
 */
export function makeBaselineProbe(run: RunCheck): Op<BaselineProbeInput, ProbeReport> {
  return async (input) => {
    const patterns = (input.bail?.bailPatterns ?? DEFAULT_BAIL_PATTERNS).map((pattern) =>
      pattern.toLowerCase(),
    );
    const maxRetries = Math.max(0, input.bail?.maxBailRetries ?? DEFAULT_MAX_BAIL_RETRIES);
    const attemptBudget = 1 + maxRetries;
    for (let attempt = 1; attempt <= attemptBudget; attempt++) {
      let raw: RawCheckOutput;
      try {
        raw = await run(input.command);
      } catch (err) {
        return { status: 'indeterminate', detail: `check runner crashed: ${messageOf(err)}` };
      }
      if (isBail(raw, patterns)) {
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
      return { status: 'indeterminate', detail: result.reason };
    }
    return { status: 'ok', value: { verdict: 'bail', attempts: attemptBudget } };
  };
}

/**
 * Bail rule: the check did not complete. An unobservable exit code (null)
 * is a bail on its own; otherwise any bail pattern (case-insensitive
 * substring) in stdout+stderr is.
 */
function isBail(raw: RawCheckOutput, lowercasePatterns: readonly string[]): boolean {
  if (raw.exitCode === null) {
    return true;
  }
  const haystack = `${raw.stdout}\n${raw.stderr}`.toLowerCase();
  return lowercasePatterns.some((pattern) => haystack.includes(pattern));
}

/** Error message of an unknown throwable, for the crashed-runner detail. */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
