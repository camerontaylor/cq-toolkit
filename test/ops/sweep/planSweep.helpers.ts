// Split provenance: test/ops/sweep/planSweep.test.ts was split into
// planSweep.{selector,selection,ledger,jobs,legacy-scheme,signature,subprocess}.test.ts
// plus this shared fixtures module. Everything below the fixtures banner moved
// unchanged; this header is the original file header, kept with the family.
//
// Sweep lane (WS-D, goal D1) — evidence for the sweep planner
// (src/ops/sweep/planSweep.ts) and the gates→ledger signature recipe.
//
// Pinned here:
//   1. THE SELECTOR IS REQUIRED (UC §1 row 16): a missing selector and an
//      unknown selector mode are `failed` results naming the requirement —
//      no hardcoded default selector exists at any layer.
//   2. SELECTION: workspace-all takes the whole manifest; changed-vs-base
//      maps the injected changed-file listing by LONGEST path-prefix with a
//      path boundary (`packages/core` ≠ `packages/corex`), does not select
//      packages no changed file touches, and reports orphans instead of
//      dropping them; explicit validates every name (unknown → failed
//      naming it).
//   3. THE LEDGER CONSULT (UC §1 row 8, on the fixture pinned by
//      test/ops/ledger/planner-contract.test.ts — the memory-backed fake
//      below goes through makeLedgerQuery exactly as that contract does):
//      a package whose baseline signatures are ALL known noise contributes
//      NO fix units; needsHuman signatures route to the report rows; a
//      mixed package (one fresh, one noise) is NOT suppressed; a failing
//      query is `failed` — store faults never fabricate ok.
//   4. JOBS ARE DISPATCH-READY: JSON-serializable, one per unit, op always
//      SWEEP_UNIT_OP, stable sanitized ids, collisions disambiguated
//      deterministically.
//   5. ledgerSignature: deterministic, tool-namespaced, pinned to the FNV-1a
//      compact form over the exact canonical tuple (fnv1a32Hex is itself
//      pinned to the PUBLISHED vectors in test/ops/gates/fingerprint.test.ts,
//      so this chain inherits a non-circular anchor), and RangeError on an
//      empty/non-string tool — the fingerprint default-tool trap.
import type { Op } from '../../../src/kernel/types.js';
import type { CheckFailure } from '../../../src/ops/gates/checkRunner.js';
import type {
  LedgerEntry,
  LedgerFile,
  LedgerStore,
  LedgerView,
} from '../../../src/ops/ledger/ledger.js';
import { makeLedgerQuery } from '../../../src/ops/ledger/ledger.js';
import { makePlanSweep } from '../../../src/ops/sweep/planSweep.js';
import type {
  ChangedFile,
  PlanSweepDeps,
  PlanSweepInput,
  PlanSweepPackage,
  PlanSweepReport,
} from '../../../src/ops/sweep/planSweep.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A small monorepo manifest: nested prefix pair (longest-prefix pin), siblings, an app. */
export const PACKAGES: PlanSweepPackage[] = [
  { name: 'core', path: 'packages/core' },
  { name: 'core-tests', path: 'packages/core/test' },
  { name: 'cli', path: 'packages/cli' },
  { name: 'web', path: 'apps/web' },
];

export function baseInput(overrides?: Partial<PlanSweepInput>): PlanSweepInput {
  return {
    repoRoot: '/repo',
    packages: PACKAGES,
    selector: { mode: 'workspace-all' },
    fixers: ['lint'],
    ...overrides,
  };
}

/** Changed-file entries for a fake listing: modified paths (never deleted). */
export function changed(...paths: string[]): ChangedFile[] {
  return paths.map((path) => ({ path, status: 'M', deleted: false, fixerTarget: true }));
}

/** A DELETED changed-file entry — selection evidence, never a fixer target. */
export function deleted(path: string): ChangedFile {
  return { path, status: 'D', deleted: true, fixerTarget: false };
}

export function makePlanner(
  overrides?: Partial<PlanSweepDeps>,
): Op<PlanSweepInput, PlanSweepReport> {
  return makePlanSweep({ changedFiles: async () => [], ...overrides });
}

/** Unwraps an `ok` result; anything else fails the test with what came back. */
export async function okPlan(op: Op<PlanSweepInput, PlanSweepReport>, input: PlanSweepInput) {
  const result = await op(input);
  if (result.status !== 'ok') {
    const detail =
      result.status === 'failed'
        ? result.error
        : result.status === 'indeterminate'
          ? result.detail
          : result.status === 'needs-human'
            ? result.reason
            : 'budget-exhausted';
    throw new Error(`expected ok, got ${result.status}: ${detail}`);
  }
  return result.value;
}

/** Unwraps a `failed` result's error; any other status fails the test. */
export async function failedPlan(op: Op<PlanSweepInput, PlanSweepReport>, input: PlanSweepInput) {
  const result = await op(input);
  if (result.status !== 'failed') throw new Error(`expected failed, got ${result.status}`);
  return result.error;
}

/** In-memory ledger store over a deep-cloned file — the planner-contract fake. */
export function memoryStore(entries: LedgerEntry[]): LedgerStore {
  let file: LedgerFile = { version: 1, entries };
  return {
    load: () => structuredClone(file),
    save: (next) => {
      file = structuredClone(next);
    },
  };
}

/**
 * A planner whose ledger dep is the REAL makeLedgerQuery over a memory
 * store — the same wiring test/ops/ledger/planner-contract.test.ts pins.
 */
export function plannerWithLedger(entries: LedgerEntry[]): Op<PlanSweepInput, PlanSweepReport> {
  const query = makeLedgerQuery(() => memoryStore(entries));
  return makePlanSweep({ changedFiles: async () => [], queryLedger: query });
}

export const EMPTY_VIEW: LedgerView = { entries: [], knownNoise: [], needsHuman: [] };

/** A positioned failure; the message is filler (positioned identity ignores it). */
export const A_FAILURE: CheckFailure = {
  file: 'src/a.ts',
  line: 1,
  column: 1,
  ruleId: 'rule',
  message: 'message text',
  severity: 'error',
};
