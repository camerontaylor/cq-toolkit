// Gates lane C2 — the baseline regression gate (R2 D5, the "crown jewel"):
// tolerate pre-existing failures, block regressions. Compares two
// {@link FailureSet}s through {@link fingerprintPairs} membership —
// pre-existing failures (fingerprints present on both sides) never block; a
// NOVEL fingerprint in `final` is a regression and is reported as the gate's
// DECISION, not as an op failure. Before comparing, the gate applies the
// SAME I5 discipline C1 closed at the parser: a failure set that parsed
// EMPTY behind a non-zero (or unobservable) exit code is not certifiable
// evidence, and neither side's emptiness may be trusted — such input yields
// `indeterminate`, never `no-regression`. Pure decision op: zero I/O, no
// clocks, no environment — the same inputs always yield the same report, in
// any order the failures happen to arrive in.
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
 * membership over fingerprints, so any permutation of identical base/final
 * sets yields the identical verdict (property-tested). Inputs that fail
 * schema validation never reach the op, and with no I/O there is no
 * crash-style failure path — the one non-`ok` status is the I5 guard on
 * untrustworthy empty sets.
 */
export const regressionGate: Op<RegressionGateInput, RegressionReport> = async (input) => {
  const untrusted =
    emptySetBehindNonZeroExit(input.base, 'base') ?? emptySetBehindNonZeroExit(input.final, 'final');
  if (untrusted !== null) {
    return { status: 'indeterminate', detail: untrusted };
  }
  const basePairs = fingerprintPairs(input.base, input.config);
  const finalPairs = fingerprintPairs(input.final, input.config);
  const basePrints = new Set(basePairs.map((pair) => pair.print));
  const finalPrints = new Set(finalPairs.map((pair) => pair.print));
  const novelFailures = finalPairs
    .filter((pair) => !basePrints.has(pair.print))
    .map((pair) => pair.failure);
  const fixedFailures = basePairs
    .filter((pair) => !finalPrints.has(pair.print))
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
 * Central I5 guard at the GATE level (mirrors parseCheckOutput's guard): an
 * empty failure set only certifies clean behind exit code 0. A base or
 * final side that parsed empty behind anything else — including a null exit
 * code (signal, timeout, lost worker) — cannot be trusted as the "nothing
 * failed" half of a comparison, and trusting it would be exactly the
 * unparsable-conflates-with-clean trap. Returns the `indeterminate` detail,
 * or null when the side is trustworthy.
 */
function emptySetBehindNonZeroExit(set: FailureSet, side: 'base' | 'final'): string | null {
  if (set.failures.length === 0 && set.exitCode !== 0) {
    const exit =
      set.exitCode === null
        ? 'an unobservable exit code (signal, timeout, lost worker)'
        : `exit code ${set.exitCode}`;
    return `${side} parsed an empty failure set behind ${exit} — an empty set certifies clean only behind exit code 0 (I5)`;
  }
  return null;
}
