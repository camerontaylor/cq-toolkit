// Gates lane C2 — the baseline regression gate (R2 D5, the "crown jewel"):
// tolerate pre-existing failures, block regressions. Compares two
// {@link FailureSet}s through {@link fingerprintSet} membership — pre-existing
// failures (fingerprints present on both sides) never block; a NOVEL
// fingerprint in `final` is a regression and is reported as the gate's
// DECISION, not as an op failure. Pure decision op: zero I/O, no clocks, no
// environment — the same inputs always yield the same report, in any order
// the failures happen to arrive in.
import { z } from 'zod';
import type { Op } from '../../kernel/types.js';
import type { CheckFailure, FailureSet } from './checkRunner.js';
import { fingerprintFailure, fingerprintSet, type FingerprintConfig } from './fingerprint.js';

/** Registry-time mirror of {@link CheckFailure}: the full failure, and only it. */
export const CheckFailureSchema = z
  .object({
    file: z.string().nullable(),
    line: z.number().nullable(),
    column: z.number().nullable(),
    ruleId: z.string().nullable(),
    message: z.string(),
    severity: z.enum(['error', 'warning']),
  })
  .strict();

/** Registry-time mirror of {@link FailureSet}: the full set, and only it. */
export const FailureSetSchema: z.ZodType<FailureSet> = z
  .object({
    tool: z.string(),
    failures: z.array(CheckFailureSchema),
    exitCode: z.number().nullable(),
  })
  .strict();

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
 * membership, so any permutation of identical base/final sets yields the
 * identical verdict (property-tested). Inputs that fail schema validation
 * never reach the op, and with no I/O there is no crash-style failure path.
 */
export const regressionGate: Op<RegressionGateInput, RegressionReport> = async (input) => {
  const cfg = input.config;
  const basePrints = fingerprintSet(input.base, cfg);
  const finalPrints = fingerprintSet(input.final, cfg);
  const basePairs = input.base.failures.map((failure) => ({
    failure,
    print: fingerprintFailure(failure, cfg),
  }));
  const novelFailures = input.final.failures.filter(
    (failure) => !basePrints.has(fingerprintFailure(failure, cfg)),
  );
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
