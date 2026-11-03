// Analyze lane G1 — test evidence for signature clustering: the exact
// normalization pipeline (what is abstracted, what is preserved, rule
// order), content-derived stable ids, the confidence decision table
// (high/low; v1 never merges, never emits 'medium'), the ledger noise seam
// (knownNoise excludes BY CLUSTER SIGNATURE — any other recorded form never
// matches), and a seeded PROPERTY test proving the acceptance constraint:
// the same failure set in any presentation order yields identical cluster
// ids, confidences, and membership. All pure — zero I/O.
//
// Split provenance: test/ops/analyze/clusterErrors.test.ts was split by
// subject into clusterErrors.template.test.ts,
// clusterErrors.quote-boundaries.test.ts, clusterErrors.signature.test.ts,
// clusterErrors.decision-table.test.ts, clusterErrors.ledger.test.ts,
// clusterErrors.order-invariance.test.ts and clusterErrors.op.test.ts; the
// fixtures below are shared by those files.
import type { LedgerView } from '../../../src/ops/ledger/index.js';
import type { CheckFailure, FailureSet } from '../../../src/ops/gates/index.js';

/** A failure with only the fields under test (the gates test idiom). */
export function failureOf(overrides: Partial<CheckFailure>): CheckFailure {
  return {
    file: 'src/a.ts',
    line: 1,
    column: 1,
    ruleId: 'rule',
    message: 'message text',
    severity: 'error',
    ...overrides,
  };
}

/** A FailureSet over the given failures, tool configurable. */
export function setOf(
  failures: CheckFailure[],
  tool = 'eslint',
  exitCode: number | null = 1,
): FailureSet {
  return { tool, failures, exitCode };
}

/** An in-memory ledger view: every knownNoise signature is GROUNDED in a recorded entry (as the real ledger derives it). */
export function ledgerOf(knownNoise: string[]): LedgerView {
  return {
    entries: knownNoise.map((signature) => ({ signature, count: 2, component: 'src/ops/analyze' })),
    knownNoise,
    needsHuman: [],
  };
}
