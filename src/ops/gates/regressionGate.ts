// Gates lane C2 — the baseline regression gate (R2 D5, the "crown jewel"):
// tolerate pre-existing failures, block regressions. Compares two
// {@link FailureSet}s through {@link fingerprintPairs} membership —
// pre-existing failures (fingerprints present on both sides) never block; a
// NOVEL fingerprint in `final` is a regression and is reported as the gate's
// DECISION, not as an op failure. Before comparing, the gate applies the
// SAME I5 discipline C1 closed at the parser, extended to partial evidence:
// a side with an UNOBSERVABLE exit code (null — signal, timeout, lost
// worker) is untrusted no matter how many failures parsed (a killed run's
// output is partial, and certifying no-regression from it would be the
// unparsable-conflates-with-clean trap in a subtler costume), and an EMPTY
// set behind a non-zero exit is equally untrustworthy — either way the gate
// returns `indeterminate`, never `no-regression`. Numeric exits stay
// trusted when non-empty (the normal failing-run shape). Pure decision op:
// zero I/O, no clocks, no environment — the same inputs always yield the
// same report, in any order the failures happen to arrive in.
import type { Op } from '../../kernel/types.js';
import type { CheckFailure, FailureSet } from './checkRunner.js';
import { fingerprintPairs, type FingerprintConfig } from './fingerprint.js';

/** The gate's decision: a regression exists in `final`, or it does not. */
export type RegressionVerdict = 'no-regression' | 'regression';

/** What the gate found, beyond the verdict. All fields plain data. */
export interface RegressionReport {
  verdict: RegressionVerdict;
  /** Final failures whose fingerprint is absent from the baseline. Empty when `no-regression`. */
  novelFailures: CheckFailure[];
  /** The BASE failures whose fingerprints vanished from `final` — progress, reported not rewarded. */
  fixedFailures: CheckFailure[];
  /** Baseline failures still present in `final` (the tolerated ones). */
  preExistingCount: number;
}

/** JSON-serializable input of the `gates.regressionGate` op. */
export interface RegressionGateInput {
  /** The captured baseline (e.g. before the change). */
  base: FailureSet;
  /** The captured final state (e.g. after the change). */
  final: FailureSet;
  /** Optional fingerprint tuning; defaults are the documented buckets. */
  config?: FingerprintConfig;
}

/**
 * The `gates.regressionGate` op: `ok` in BOTH verdict cases — the verdict is
 * the op's decision output, and what to do about a regression is the
 * caller's business. Ordering-invariant by construction: comparison is Set
 * membership over EXACT canonical keys (JSON component tuples — not
 * hashes), so any permutation of identical base/final sets yields the
 * identical verdict, deterministically (property-tested). Inputs that fail
 * schema validation never reach the op, and with no I/O there is no
 * crash-style failure path — the one non-`ok` status is the I5 guard on
 * untrustworthy sides (unobservable exit code, or empty behind non-zero).
 */
export const regressionGate: Op<RegressionGateInput, RegressionReport> = async (input) => {
  const untrusted =
    untrustedEvidence(input.base, 'base') ?? untrustedEvidence(input.final, 'final');
  if (untrusted !== null) {
    return { status: 'indeterminate', detail: untrusted };
  }
  const basePairs = fingerprintPairs(input.base, input.config);
  const finalPairs = fingerprintPairs(input.final, input.config);
  const baseKeys = new Set(basePairs.map((pair) => pair.key));
  const finalKeys = new Set(finalPairs.map((pair) => pair.key));
  const novelFailures = finalPairs
    .filter((pair) => !baseKeys.has(pair.key))
    .map((pair) => pair.failure);
  const fixedFailures = basePairs
    .filter((pair) => !finalKeys.has(pair.key))
    .map((pair) => pair.failure);
  const preExistingCount = basePairs.length - fixedFailures.length;
  return {
    status: 'ok',
    value: {
      verdict: novelFailures.length > 0 ? 'regression' : 'no-regression',
      novelFailures,
      fixedFailures,
      preExistingCount,
    },
  };
};

/**
 * Central I5 guard at the GATE level (mirrors and extends parseCheckOutput's
 * guard). Two untrusted shapes, checked per side:
 *   - exitCode null — the run did not COMPLETE (signal, timeout, lost
 *     worker), so whatever failures parsed are PARTIAL evidence; trusting
 *     them could certify no-regression from a killed run. Untrusted
 *     regardless of failure count, on both sides.
 *   - empty failures behind a non-zero exit — an empty set certifies clean
 *     only behind exit code 0.
 * Returns the `indeterminate` detail, or null when the side is trustworthy
 * (exit 0 with any count, or a numeric non-zero exit with non-empty
 * failures — the normal failing-run shape).
 */
function untrustedEvidence(set: FailureSet, side: 'base' | 'final'): string | null {
  if (set.exitCode === null) {
    return `${side} carries an unobservable exit code (signal, timeout, lost worker) — its ${set.failures.length} parsed failure(s) are partial evidence from an incomplete run (I5)`;
  }
  if (set.failures.length === 0 && set.exitCode !== 0) {
    return `${side} parsed an empty failure set behind exit code ${set.exitCode} — an empty set certifies clean only behind exit code 0 (I5)`;
  }
  return null;
}
