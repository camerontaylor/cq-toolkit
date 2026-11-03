// PR lane (goal D3; R2 D9) — evidence for the fleet run report
// (src/ops/pr/runReport.ts).
//
// Pinned here, on a scripted fake PrEffects (zero processes, zero network):
//   1. THE THREE-VALUED MATRIX: every checks × review combination folds to
//      exactly the R2 D9 verdict — blocked wins (failing checks or
//      changes-requested), ready requires BOTH halves green, and every
//      unresolvable combination is `unknown` with the reason spelled out.
//      Nothing is ever fabricated into a pass or a fail.
//   2. NO MERGE EFFECT (the "never auto-merges" pin): the PrEffects seam
//      carries no merge-class member — pinned at the TYPE level (the
//      member-key record fails to compile if one is added or removed) and
//      asserted at runtime; the production subprocess adapter's key set is
//      pinned to the same six members.
//   3. I9: a per-package effects fault lands on that row as `unknown` with
//      the fault as the reason; the other packages still report; the op
//      stays ok.
//   4. TRACKER IN PLACE: with `tracker` present the rows are written to
//      THAT PR number via editPrBody (trackerUpdated true; createPr never
//      called — never a second tracker); a tracker edit fault fails the op;
//      without `tracker` no edit runs and trackerUpdated is false.
//   5. Counts include zeros; the report is plain JSON.
//
// Split provenance: test/ops/pr/runReport.test.ts was split by subject into
// runReport.matrix.test.ts, runReport.counts.test.ts, runReport.faults.test.ts,
// runReport.draft.test.ts, runReport.lifecycle.test.ts,
// runReport.tracker.test.ts and runReport.boundary.test.ts; this module holds
// the fixtures they share.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';
import type {
  PrChecks,
  PrEffects,
  PrMergeStateStatus,
  PrMergeable,
  PrReviewState,
  PrState,
} from '../../../src/ops/pr/assemblePrs.js';
import type { makeRunReport, RunReportInput } from '../../../src/ops/pr/runReport.js';

// ---------------------------------------------------------------------------
// Scripted fake PrEffects
// ---------------------------------------------------------------------------

export interface FakeGh {
  gh: PrEffects;
  /** Per-PR scripted checks verdicts. */
  checks: Map<number, PrChecks>;
  /** Per-PR scripted review verdicts. */
  reviews: Map<number, PrReviewState>;
  /** Per-PR scripted draft flags (absent → not a draft). */
  drafts: Map<number, boolean>;
  /** Per-PR scripted lifecycle states (absent → open). */
  metas: Map<number, PrState>;
  /** Per-PR scripted mergeability (absent → mergeable). */
  mergeables: Map<number, PrMergeable>;
  /** Per-PR scripted merge state status (absent → clean). */
  statuses: Map<number, PrMergeStateStatus>;
  /** Snapshot faults keyed by PR number (ONE consolidated read → whole-snapshot faults). */
  readinessFaults: Map<number, string>;
  /** editPrBody bodies keyed by PR number. */
  edits: Map<number, string>;
  /** Existing bodies keyed by PR number (the getPrBody read). */
  bodies: Map<number, string>;
  /** createPr invocations — the report must NEVER make one. */
  creates: number;
}

function fakeGh(seed: Partial<FakeGh> = {}): FakeGh {
  const state: FakeGh = {
    checks: seed.checks ?? new Map<number, PrChecks>(),
    reviews: seed.reviews ?? new Map<number, PrReviewState>(),
    drafts: seed.drafts ?? new Map<number, boolean>(),
    metas: seed.metas ?? new Map<number, PrState>(),
    mergeables: seed.mergeables ?? new Map<number, PrMergeable>(),
    statuses: seed.statuses ?? new Map<number, PrMergeStateStatus>(),
    readinessFaults: seed.readinessFaults ?? new Map<number, string>(),
    edits: seed.edits ?? new Map<number, string>(),
    bodies: seed.bodies ?? new Map<number, string>(),
    creates: 0,
    gh: {
      searchPrByHead: async () => null,
      createPr: async () => {
        state.creates += 1;
        throw new Error('the run report must never open a PR');
      },
      editPrBody: async (number, body) => {
        state.edits.set(number, body);
      },
      comment: async () => {},
      getPrReadiness: async (number) => {
        const fault = state.readinessFaults.get(number);
        if (fault !== undefined) throw new Error(fault);
        // Unscripted PRs default to the ordinary fold (not draft, open,
        // mergeable, clean) — tests script only the halves they pin.
        return {
          checks: state.checks.get(number) ?? { state: 'none' },
          review: state.reviews.get(number) ?? { state: 'none' },
          meta: {
            isDraft: state.drafts.get(number) === true,
            state: state.metas.get(number) ?? 'open',
            mergeable: state.mergeables.get(number) ?? 'mergeable',
            mergeStateStatus: state.statuses.get(number) ?? 'clean',
          },
        };
      },
      getPrBody: async (number) => state.bodies.get(number) ?? '',
    },
  };
  return state;
}

async function okReport(op: ReturnType<typeof makeRunReport>, input: RunReportInput) {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

export interface ReportHarness {
  fakeGh: typeof fakeGh;
  inputOf: (overrides?: Partial<RunReportInput>) => RunReportInput;
  okReport: typeof okReport;
}

/**
 * One harness per test file: a hermetic repo root (the default tracker-body
 * lock is repo-rooted, review-debt #171), the scripted effects fake, the
 * input builder and the ok-report unwrapper.
 */
export function makeReportHarness(): ReportHarness {
  // The default tracker-body lock is repo-rooted (review-debt #171), so the op
  // needs a real, writable repo root; a tmpdir keeps the suite hermetic.
  const repoRoot = mkdtempSync(join(tmpdir(), 'pr-report-lock-'));
  afterAll(() => {
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const inputOf = (overrides: Partial<RunReportInput> = {}): RunReportInput => ({
    repoRoot,
    runPrefix: 'cq/09-16a',
    packages: [
      { name: 'core', number: 11 },
      { name: 'util', number: 12 },
    ],
    ...overrides,
  });

  return { fakeGh, inputOf, okReport };
}
