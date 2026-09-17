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
import { describe, expect, test } from 'vitest';
import type { PrChecks, PrEffects, PrReviewState } from '../../../src/ops/pr/assemblePrs.js';
import { makeSubprocessPrEffects } from '../../../src/ops/pr/ghEffects.js';
import { makeRunReport, type RunReportInput } from '../../../src/ops/pr/runReport.js';

// ---------------------------------------------------------------------------
// Scripted fake PrEffects
// ---------------------------------------------------------------------------

interface FakeGh {
  gh: PrEffects;
  /** Per-PR scripted checks verdicts. */
  checks: Map<number, PrChecks>;
  /** Per-PR scripted review verdicts. */
  reviews: Map<number, PrReviewState>;
  /** Per-PR scripted draft flags (absent → not a draft). */
  drafts: Map<number, boolean>;
  /** Faults keyed by PR number, per read. */
  checkFaults: Map<number, string>;
  reviewFaults: Map<number, string>;
  metaFaults: Map<number, string>;
  /** editPrBody bodies keyed by PR number. */
  edits: Map<number, string>;
  /** createPr invocations — the report must NEVER make one. */
  creates: number;
}

function fakeGh(seed: Partial<FakeGh> = {}): FakeGh {
  const state: FakeGh = {
    checks: seed.checks ?? new Map<number, PrChecks>(),
    reviews: seed.reviews ?? new Map<number, PrReviewState>(),
    drafts: seed.drafts ?? new Map<number, boolean>(),
    checkFaults: seed.checkFaults ?? new Map<number, string>(),
    reviewFaults: seed.reviewFaults ?? new Map<number, string>(),
    metaFaults: seed.metaFaults ?? new Map<number, string>(),
    edits: seed.edits ?? new Map<number, string>(),
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
      getPrChecks: async (number) => {
        const fault = state.checkFaults.get(number);
        if (fault !== undefined) throw new Error(fault);
        const verdict = state.checks.get(number);
        if (verdict === undefined) throw new Error(`no scripted checks for #${String(number)}`);
        return verdict;
      },
      getPrReviewState: async (number) => {
        const fault = state.reviewFaults.get(number);
        if (fault !== undefined) throw new Error(fault);
        const verdict = state.reviews.get(number);
        if (verdict === undefined) throw new Error(`no scripted review for #${String(number)}`);
        return verdict;
      },
      getPrMeta: async (number) => {
        const fault = state.metaFaults.get(number);
        if (fault !== undefined) throw new Error(fault);
        return { isDraft: state.drafts.get(number) === true };
      },
    },
  };
  return state;
}

const inputOf = (overrides: Partial<RunReportInput> = {}): RunReportInput => ({
  repoRoot: '/repo',
  runPrefix: 'cq/09-16a',
  packages: [
    { name: 'core', number: 11 },
    { name: 'util', number: 12 },
  ],
  ...overrides,
});

async function okReport(op: ReturnType<typeof makeRunReport>, input: RunReportInput) {
  const result = await op(input);
  if (result.status !== 'ok') {
    throw new Error(
      `expected ok, got ${result.status}: ${result.status === 'failed' ? result.error : result.status}`,
    );
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// The three-valued matrix (R2 D9)
// ---------------------------------------------------------------------------

describe('the three-valued readiness matrix', () => {
  const MATRIX: Array<[PrChecks, PrReviewState, 'ready' | 'blocked' | 'unknown', string]> = [
    [{ state: 'pass' }, { state: 'approved' }, 'ready', 'green checks + approval'],
    [
      { state: 'pass' },
      { state: 'none' },
      'ready',
      'green checks + NO review policy (a null decision counts toward ready)',
    ],
    [
      { state: 'pass' },
      { state: 'required' },
      'unknown',
      'REVIEW_REQUIRED is not none — a demanded-but-absent review is never ready (r1#1)',
    ],
    [
      { state: 'pending' },
      { state: 'required' },
      'unknown',
      'required review, checks still running',
    ],
    [{ state: 'fail' }, { state: 'approved' }, 'blocked', 'failing checks beat approval'],
    [{ state: 'fail' }, { state: 'changes-requested' }, 'blocked', 'failing on both halves'],
    [
      { state: 'fail', failing: ['build'] },
      { state: 'none' },
      'blocked',
      'failing names the check',
    ],
    [
      { state: 'pending' },
      { state: 'changes-requested' },
      'blocked',
      'changes-requested beats pending',
    ],
    [{ state: 'none' }, { state: 'changes-requested' }, 'blocked', 'changes-requested beats none'],
    [{ state: 'pass' }, { state: 'unknown' }, 'unknown', 'an unreadable review is not approval'],
    [
      { state: 'pending' },
      { state: 'approved' },
      'unknown',
      'pending checks never pass by assumption',
    ],
    [{ state: 'pending' }, { state: 'none' }, 'unknown', 'pending checks, no review'],
    [{ state: 'none' }, { state: 'approved' }, 'unknown', 'no checks configured is not a pass'],
    [{ state: 'none' }, { state: 'none' }, 'unknown', 'neither half resolvable'],
  ];

  test.each(MATRIX)('%s × %s → %s (%s)', async (checks, review, expected) => {
    const fake = fakeGh({
      checks: new Map([[11, checks]]),
      reviews: new Map([[11, review]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0]?.readiness).toBe(expected);
    // blocked/unknown rows always say why; ready rows stay silent.
    if (expected === 'ready') {
      expect(report.rows[0]?.reason).toBeUndefined();
    } else {
      expect(report.rows[0]?.reason).not.toBeUndefined();
    }
  });

  test('a blocked row by failing checks names the failed check; the row keeps the observed evidence', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'fail', failing: ['build', 'lint'] }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      checks: 'fail',
      review: 'approved',
      readiness: 'blocked',
      reason: 'checks failing (build, lint)',
    });
  });
});

describe('counts and shape', () => {
  test('counts include zeros across all three buckets', async () => {
    const fake = fakeGh({
      checks: new Map([
        [11, { state: 'pass' }],
        [12, { state: 'fail' }],
      ]),
      reviews: new Map([
        [11, { state: 'approved' }],
        [12, { state: 'none' }],
      ]),
    });
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(report.counts).toEqual({ ready: 1, blocked: 1, unknown: 0 });
    expect(report.runPrefix).toBe('cq/09-16a');
  });

  test('an empty fleet reports zero rows and zero counts (tracker optionally still updated)', async () => {
    const fake = fakeGh();
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [], tracker: { number: 7 } }),
    );
    expect(report.rows).toEqual([]);
    expect(report.counts).toEqual({ ready: 0, blocked: 0, unknown: 0 });
    expect(report.trackerUpdated).toBe(true);
    expect(fake.edits.get(7)).toContain('(no package PRs in this run)');
  });

  test('the report is plain JSON (round trip)', async () => {
    const fake = fakeGh({
      checks: new Map([
        [11, { state: 'pass' }],
        [12, { state: 'fail' }],
      ]),
      reviews: new Map([
        [11, { state: 'approved' }],
        [12, { state: 'none' }],
      ]),
    });
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
  });
});

// ---------------------------------------------------------------------------
// I9 — per-package faults collect, never fail the op
// ---------------------------------------------------------------------------

describe('effects faults land on their row (I9)', () => {
  test('a checks fault → unknown row with the fault as reason; the other package still reports ready', async () => {
    const fake = fakeGh({
      checks: new Map([[12, { state: 'pass' }]]),
      reviews: new Map([
        [11, { state: 'none' }],
        [12, { state: 'none' }],
      ]),
      checkFaults: new Map([[11, 'gh pr view exited 4']]),
    });
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(report.rows[0]).toMatchObject({
      name: 'core',
      number: 11,
      readiness: 'unknown',
      checks: 'unknown',
      review: 'none',
      reason: 'checks: gh pr view exited 4',
    });
    expect(report.rows[1]).toMatchObject({ name: 'util', readiness: 'ready' });
    expect(report.counts).toEqual({ ready: 1, blocked: 0, unknown: 1 });
  });

  test('a review fault after clean checks → unknown with the fault; the checks evidence still shows', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviewFaults: new Map([[11, 'review read rate-limited']]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      checks: 'pass',
      review: 'unknown',
      readiness: 'unknown',
      reason: 'review: review read rate-limited',
    });
  });

  test('both reads faulting → one unknown row carrying BOTH faults', async () => {
    const fake = fakeGh({
      checkFaults: new Map([[11, 'checks boom']]),
      reviewFaults: new Map([[11, 'review boom']]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]?.reason).toBe('checks: checks boom; review: review boom');
  });

  test('a META read fault → unknown with the fault as its own reason half', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
      metaFaults: new Map([[11, 'isDraft read timed out']]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      checks: 'pass',
      review: 'approved',
      readiness: 'unknown',
      reason: 'meta: isDraft read timed out',
    });
  });
});

// ---------------------------------------------------------------------------
// Draft dominance (PR-165 r1#2, codex jLt4f): a draft can never be ready
// ---------------------------------------------------------------------------

describe('a draft PR is blocked regardless of checks and review', () => {
  test('draft + green checks + approval → blocked, reason naming the draft', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
      drafts: new Map([[11, true]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      checks: 'pass',
      review: 'approved',
      reason: 'draft — not ready for review',
    });
    expect(report.counts).toEqual({ ready: 0, blocked: 1, unknown: 0 });
  });

  test('draft dominates even when the other reads FAULT', async () => {
    const fake = fakeGh({
      checkFaults: new Map([[11, 'checks boom']]),
      reviewFaults: new Map([[11, 'review boom']]),
      drafts: new Map([[11, true]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({
      readiness: 'blocked',
      checks: 'unknown',
      review: 'unknown',
      reason: 'draft — not ready for review',
    });
  });

  test('not-a-draft changes nothing: green evidence still reports ready', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
      drafts: new Map([[11, false]]),
    });
    const report = await okReport(
      makeRunReport(fake.gh),
      inputOf({ packages: [{ name: 'core', number: 11 }] }),
    );
    expect(report.rows[0]).toMatchObject({ readiness: 'ready' });
  });
});

// ---------------------------------------------------------------------------
// Tracker update in place; never a merge, never a second PR
// ---------------------------------------------------------------------------

describe('the tracker is updated in place, and nothing ever merges', () => {
  test('with tracker present, the rows are written to THAT number; createPr is never called', async () => {
    const fake = fakeGh({
      checks: new Map([[11, { state: 'pass' }]]),
      reviews: new Map([[11, { state: 'approved' }]]),
    });
    const report = await okReport(makeRunReport(fake.gh), inputOf({ tracker: { number: 7 } }));
    expect(report.trackerUpdated).toBe(true);
    expect(fake.edits.get(7)).toContain('`core` — #11 — checks: pass; review: approved — READY');
    expect(fake.edits.get(7)).toContain('never auto-merges');
    expect(fake.creates).toBe(0);
  });

  test('without tracker, no edit runs and trackerUpdated is false', async () => {
    const fake = fakeGh();
    const report = await okReport(makeRunReport(fake.gh), inputOf());
    expect(report.trackerUpdated).toBe(false);
    expect(fake.edits.size).toBe(0);
  });

  test('a tracker edit fault fails the op AND carries the collected rows in the error (r1#5)', async () => {
    const fake = fakeGh({
      checks: new Map([
        [11, { state: 'pass' }],
        [12, { state: 'fail', failing: ['build'] }],
      ]),
      reviews: new Map([
        [11, { state: 'approved' }],
        [12, { state: 'none' }],
      ]),
    });
    fake.gh.editPrBody = async () => {
      throw new Error('edit refused');
    };
    const result = await makeRunReport(fake.gh)(inputOf({ tracker: { number: 7 } }));
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('tracker PR #7');
    // The progressNote pattern: the fleet's evidence rides the failure text.
    expect(result.status === 'failed' && result.error).toContain(
      'core #11 ready; util #12 blocked (checks failing (build))',
    );
  });

  test('TYPE + RUNTIME PIN: the PrEffects seam admits no merge-class member', async () => {
    // The record annotation below fails to COMPILE the moment a member is
    // added to (or removed from) PrEffects — the type-level pin that the
    // seam cannot grow a merge effect unnoticed. The runtime assertions
    // then prove no member name even CONTAINS a merge verb.
    const seamMembers: Record<keyof PrEffects, true> = {
      searchPrByHead: true,
      createPr: true,
      editPrBody: true,
      comment: true,
      getPrChecks: true,
      getPrReviewState: true,
      getPrMeta: true,
    };
    const names = Object.keys(seamMembers);
    expect(names).toHaveLength(7);
    expect(names.some((name) => /merge|rebase|squash|close/i.test(name))).toBe(false);
    // The production adapter is pinned to the same seven — no merge effect
    // by construction there either.
    expect(Object.keys(makeSubprocessPrEffects('/repo')).sort()).toEqual(names.sort());
  });
});

// ---------------------------------------------------------------------------
// Boundary validation — `failed` naming the field
// ---------------------------------------------------------------------------

describe('boundary validation refuses bad inputs before any gh call', () => {
  test('a zero, negative, or non-integer PR number is refused naming the field', async () => {
    const op = makeRunReport(fakeGh().gh);
    for (const bad of [0, -3, 1.5]) {
      const result = await op(inputOf({ packages: [{ name: 'core', number: bad }] }));
      expect(result.status).toBe('failed');
      expect(result.status === 'failed' && result.error).toContain('packages[0].number');
    }
    const trackerResult = await op(inputOf({ tracker: { number: 0 } }));
    expect(trackerResult.status).toBe('failed');
    expect(trackerResult.status === 'failed' && trackerResult.error).toContain('tracker.number');
  });

  test('a non-object input and a non-array packages are refused', async () => {
    const op = makeRunReport(fakeGh().gh);
    expect((await op(null as unknown as RunReportInput)).status).toBe('failed');
    expect(
      (await op(inputOf({ packages: 'core' as unknown as RunReportInput['packages'] }))).status,
    ).toBe('failed');
  });

  test('a control character in a package NAME is refused (it feeds the tracker body)', async () => {
    const fake = fakeGh();
    const op = makeRunReport(fake.gh);
    const result = await op(inputOf({ packages: [{ name: 'util\u0000', number: 12 }] }));
    expect(result.status).toBe('failed');
    expect(result.status === 'failed' && result.error).toContain('packages[0].name');
    expect(fake.edits.size).toBe(0);
  });

  test('a non-object input never reaches the effects (zero calls)', async () => {
    const fake = fakeGh();
    await makeRunReport(fake.gh)(null as unknown as RunReportInput);
    expect(fake.edits.size).toBe(0);
  });
});
