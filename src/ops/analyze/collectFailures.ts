// Analyze lane G1 — failure-set aggregation across packages/runs: the
// single-tool union of typed FailureSets (the gates family's shape). Pure
// decision core: zero I/O — the same sets in any order always yield the same
// aggregate, byte for byte.
//
// Invariants honored here:
//   - Honest attribution (the tool policy): a FailureSet's `tool` is the
//     attribution of EVERY failure inside it for every downstream consumer —
//     the gates fingerprints fold the set's tool into each exact key, and
//     cluster signatures do the same. A composite label ('eslint+tsc') would
//     fabricate a tool name no probe ever reported and could never match a
//     real probe's keys again. The aggregate therefore REQUIRES every input
//     set to share one tool, and the aggregate's tool IS that tool; mixing
//     tools in one call throws (the op boundary maps the throw to `failed`).
//     The tradeoff, accepted and documented: callers aggregate per-tool; a
//     cross-tool report is a caller-side composition of aggregates, never
//     one dishonest set.
//   - I5/I9 (non-passing evidence): aggregating ZERO sets throws — an empty
//     aggregate behind exit code 0 would certify a clean run that never
//     happened. Exit-code aggregation is NULL-CONTAGIOUS over everything:
//     if ANY input exit code is null, the aggregate is null; else any
//     non-zero code → 1; else 0. The interplay that forces this: the
//     regression gate's completeness check (untrustedEvidence) treats ONLY
//     a null exit code as partial evidence — a numeric non-zero with
//     non-empty failures is the trusted "normal failing-run shape". An
//     aggregate [1, null] → 1 would dress a lost run's possibly-INCOMPLETE
//     failure list (timeout, lost worker) as a COMPLETE failing run, and
//     the gate would set-compare that partial evidence — certifying
//     no-regression while the lost run's novel failures were never parsed.
//     The aggregate stays null so the gate's untrustworthy-evidence guard
//     sees exactly what happened: some constituent run was never observed.
//   - Exact duplicate collapse (the fingerprint.ts exactness doctrine): the
//     identity of one failure is the FULL JSON tuple of its seven fields
//     (tool folded in from the sets) — the same exactness approach as the
//     gates' canonical keys, NOT the drift-tolerant fingerprint. Two copies
//     of an identical failure (the same error reported by two package runs)
//     collapse to one; two failures differing in ANY field (even only the
//     message wording or the severity) both survive.
//   - Determinism: output is sorted by that exact identity (UTF-16 code-unit
//     order — plain, engine-independent string comparison; this is
//     in-memory determinism, not the ledger's committed byte-order
//     contract), so the same sets presented in any order produce the
//     identical FailureSet.
//
// Residual limitations, documented: duplicate collapse is by EXACT identity,
// so the same logical error reworded across runs stays two failures (drift
// tolerance is the fingerprint family's job, not the union's); and the
// aggregate carries no provenance — which input set contributed a failure is
// not recorded (per-run attribution never crossed the FailureSet shape to
// begin with).
import type { Op } from '../../kernel/types.js';
import type { CheckFailure, FailureSet } from '../gates/checkRunner.js';

/**
 * The EXACT identity of one failure within a tool namespace: JSON of its
 * seven-component tuple (tool folded in, nulls preserved as nulls) — array-
 * encoded like the gates' canonical keys so no delimiter in any component
 * can make two different failures key identically. This is the duplicate-
 * collapse unit of {@link collectFailures} and the member-ordering unit of
 * the cluster report.
 */
export function failureIdentity(failure: CheckFailure, tool: string): string {
  return JSON.stringify([
    tool,
    failure.file,
    failure.line,
    failure.column,
    failure.ruleId,
    failure.severity,
    failure.message,
  ]);
}

/**
 * Sort failures by their exact {@link failureIdentity} (UTF-16 code-unit
 * order on the identity strings) — the deterministic presentation order for
 * aggregated failures and cluster members. Non-mutating.
 */
export function sortByIdentity(failures: readonly CheckFailure[], tool: string): CheckFailure[] {
  return [...failures].sort((a, b) => {
    const ia = failureIdentity(a, tool);
    const ib = failureIdentity(b, tool);
    return ia < ib ? -1 : ia > ib ? 1 : 0;
  });
}

/**
 * Aggregate typed failure sets (one tool's runs across packages/runs) into
 * ONE {@link FailureSet}: order-invariant, duplicate-collapsed union sorted
 * by exact identity, with the honest tool/exit-code policies of the module
 * header. Throws on an EMPTY input (nothing ran — no aggregate exists) and
 * on MIXED tools (the aggregate would misattribute failures); the
 * `analyze.collectFailures` op maps those throws to `failed`.
 */
export function collectFailures(sets: readonly FailureSet[]): FailureSet {
  const first = sets[0];
  if (first === undefined) {
    throw new RangeError(
      'collectFailures: no input sets — aggregating zero runs would fabricate a clean FailureSet that no check ever produced',
    );
  }
  const tool = first.tool;
  for (const set of sets) {
    if (set.tool !== tool) {
      throw new RangeError(
        `collectFailures: mixed tools — '${tool}' and '${set.tool}' cannot share one FailureSet (the set's tool attributes every failure in it); aggregate per tool`,
      );
    }
  }
  const byIdentity = new Map<string, CheckFailure>();
  for (const set of sets) {
    for (const failure of set.failures) {
      byIdentity.set(failureIdentity(failure, tool), failure);
    }
  }
  return {
    tool,
    failures: sortByIdentity([...byIdentity.values()], tool),
    exitCode: aggregateExitCode(sets.map((set) => set.exitCode)),
  };
}

/**
 * The aggregate exit code, in decision order: ANY null → null — the
 * aggregate must not out-trust its least-trusted constituent (see the
 * module header's untrustedEvidence interplay); else any observed non-zero
 * → 1; else 0 (every input was 0).
 */
function aggregateExitCode(exitCodes: ReadonlyArray<number | null>): number | null {
  let sawNull = false;
  let sawNonZero = false;
  for (const code of exitCodes) {
    if (code === null) sawNull = true;
    else if (code !== 0) sawNonZero = true;
  }
  return sawNull ? null : sawNonZero ? 1 : 0;
}

/** JSON-serializable input of the `analyze.collectFailures` op. */
export interface CollectFailuresInput {
  /** The per-package/per-run sets of ONE tool, in any order, with duplicates. */
  sets: FailureSet[];
}

/**
 * The `analyze.collectFailures` op: `ok` with the aggregate, or `failed`
 * when the library-level policy throws (empty input, mixed tools — the op
 * ran and definitively could not produce an honest aggregate). Schema
 * validation happens before dispatch, so those two throws are the entire
 * failure surface.
 */
export const collectFailuresOp: Op<CollectFailuresInput, FailureSet> = async (input) => {
  try {
    return { status: 'ok', value: collectFailures(input.sets) };
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) };
  }
};

// The family-registry seam (src/ops/README.md): the op function DEFAULT-
// exported for the importer's `.default` resolution; the named export above
// stays for library, barrel, and test consumers.
export default collectFailuresOp;
