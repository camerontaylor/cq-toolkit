// M10e: compute harm and missed-defect panels from explicit observation
// records in the merged report v2 payload shapes (ADR-0008). One case per
// asserted condition:
//   - reviewed-range re-fixes are candidates until prior-correctness/
//     finding-edit evidence;
//   - CI red classification flake/regression/infrastructure/unknown;
//   - restored crq finding must exist at pre-merge covered range to count
//     missed;
//   - missing lineage -> unknown (a re-fix no review observed, a post-merge
//     review with no accepted head, an acceptance with no pre-merge review,
//     a declared PR with no PASS acceptance);
//   - mature eligible PR population and follow-up days/right censoring
//     explicit.
// Failure cases keep the M10b discipline: malformed or conflicting rows are
// unknown evidence with a reason — never a crash, never a fallback zero —
// and invalid panel arguments throw TypeError. Local fixtures only: no
// providers, no network, no files.
import { describe, expect, test } from 'vitest';
import { computeOutcomePanels } from '../scripts/measurement-outcomes.mjs';
import type {
  AcceptancePayload,
  DispositionPayload,
  FindingFingerprint,
  ReviewObservedPayload,
} from '../src/kernel/types.js';

const BASE = 'a'.repeat(40);
const HEAD1 = 'b'.repeat(40);
const HEAD2 = 'c'.repeat(40);
const HEAD3 = 'd'.repeat(40);
const HEAD4 = 'e'.repeat(40);
const HEAD6 = 'f'.repeat(40);
const HEAD7 = '0'.repeat(40);
const HEAD8 = '1'.repeat(40);
const HEAD9 = '2'.repeat(40);
const T1 = '2026-11-01T00:00:00.000Z';
const T2 = '2026-11-02T00:00:00.000Z';
const OBSERVED_AT = '2026-11-20T00:00:00.000Z';

const fingerprint = (path: string): FindingFingerprint => ({
  version: 1,
  checkId: 'oxlint',
  rule: 'no-unused-vars',
  path,
  spanContentHash: null,
});

const F1 = fingerprint('src/one.ts');
const F2 = fingerprint('src/two.ts');
const F3 = fingerprint('src/three.ts');
const F9 = fingerprint('src/new.ts');

const disposition = (
  of: FindingFingerprint,
  observedHead: string,
  evidence: string[],
  observedAt = T1,
): DispositionPayload => ({
  fingerprint: of,
  status: 'fixed',
  reason: 'fix run verified the change',
  owner: 'fixer',
  evidence,
  reviewTrigger: null,
  observedHead,
  observedAt,
  acceptedRisk: null,
  availability: {},
});

const review = (over: Partial<ReviewObservedPayload> = {}): ReviewObservedPayload => ({
  baseSha: BASE,
  headSha: HEAD1,
  findingFingerprints: [],
  coverage: 'v2:diff:patch',
  initialBlocking: null,
  reviewerId: 'reviewer',
  source: 'agent',
  round: 1,
  delivered: ['piece.ts'],
  completed: ['piece.ts'],
  omissions: [],
  vendorCompletion: 'completed',
  availability: {},
  ...over,
});

const acceptance = (over: Partial<AcceptancePayload> = {}): AcceptancePayload => ({
  headSha: HEAD1,
  reviewedBaseSha: BASE,
  reviewerId: 'critic',
  authorId: 'author',
  independent: true,
  verdict: 'PASS',
  evidence: ['exact-head review'],
  availability: {},
  ...over,
});

describe('M10e nominal evidence', () => {
  test('reviewed-range re-fixes are candidates until prior-correctness/finding-edit evidence', () => {
    // The pre-merge review observed F1, F2 and F3 at the covered range, so
    // each second fix is a reviewed-range re-fix: a candidate while its
    // evidence says nothing, explained once prior-correctness or finding-edit
    // evidence is recorded.
    const panels = computeOutcomePanels({
      reviews: [review({ findingFingerprints: [F1, F2, F3] })],
      dispositions: [
        disposition(F1, HEAD1, ['fix verified'], T1),
        disposition(F1, HEAD2, ['fix verified again'], T2),
        disposition(F2, HEAD1, ['fix verified'], T1),
        disposition(F2, HEAD2, ['prior-correctness: the prior fix held'], T2),
        disposition(F3, HEAD1, ['fix verified'], T1),
        disposition(F3, HEAD2, ['finding-edit: the finding text changed'], T2),
      ],
      acceptances: [acceptance()],
      ciRed: [],
      population: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 1, explained: 2, unknown: 0 });
    expect(panels.unknown).toEqual([]);
  });

  test('CI red classification flake/regression/infrastructure/unknown', () => {
    const panels = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: [],
      ciRed: [
        { sha: HEAD1, source: 'gh-actions', classification: 'flake' },
        { sha: HEAD1, source: 'gh-actions', classification: 'regression' },
        { sha: HEAD2, source: 'gh-actions', classification: 'infrastructure' },
        { sha: HEAD2, source: 'gh-actions', classification: 'unknown' },
      ],
      population: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.ciRed).toEqual({
      flake: 1,
      regression: 1,
      infrastructure: 1,
      unknown: 1,
    });
    expect(panels.unknown).toEqual([]);
  });

  test('restored crq finding must exist at pre-merge covered range to count missed', () => {
    // The post-merge crq review (based at the accepted head) restores F1 —
    // which the pre-merge review observed at the covered range — and also
    // reports F9, which did not exist there. F1 is missed; F9 is a new
    // post-merge finding, explicitly not missed.
    const panels = computeOutcomePanels({
      reviews: [
        review({ findingFingerprints: [F1, F2, F3] }),
        review({ headSha: HEAD3 }),
        review({ baseSha: HEAD1, headSha: HEAD2, source: 'crq', findingFingerprints: [F1, F9] }),
      ],
      dispositions: [],
      acceptances: [acceptance(), acceptance({ headSha: HEAD3 })],
      ciRed: [],
      population: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.missed.restored).toEqual({ missed: 1, notMissed: 1, unknown: 0 });
    expect(panels.unknown).toEqual([]);
  });

  test('mature eligible PR population and follow-up days/right censoring explicit', () => {
    // Eligibility is a PASS acceptance at the exact head; maturity is the
    // explicit follow-up window elapsing by the observation instant — at
    // exactly followUpDays a PR is mature, and a younger one is explicitly
    // right-censored, never silently dropped.
    const panels = computeOutcomePanels({
      reviews: [review(), review({ headSha: HEAD3 })],
      dispositions: [],
      acceptances: [
        acceptance(),
        acceptance({ headSha: HEAD3 }),
        acceptance({ headSha: HEAD4, reviewedBaseSha: HEAD1 }),
      ],
      ciRed: [],
      population: [
        { headSha: HEAD1, mergedAt: '2026-11-01T00:00:00.000Z' },
        { headSha: HEAD4, mergedAt: '2026-11-10T00:00:00.000Z' },
        { headSha: HEAD3, mergedAt: '2026-11-18T00:00:00.000Z' },
      ],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.population).toEqual({
      eligible: 3,
      mature: 2,
      rightCensored: 1,
      followUpDays: 10,
    });
    expect(panels.unknown).toEqual([]);
  });
});

describe('M10e missing evidence', () => {
  test('missing lineage -> unknown', () => {
    // Four missing lineages: a re-fix no review ever observed (no reviewed
    // range), a post-merge crq review based at no accepted head, a crq
    // review whose acceptance has no pre-merge review at the covered range,
    // and a declared PR with no PASS acceptance. Each is an unknown with a
    // reason — never a count, never a fallback zero.
    const F5 = fingerprint('src/five.ts');
    const panels = computeOutcomePanels({
      reviews: [
        review({ baseSha: HEAD6, headSha: HEAD2, source: 'crq', findingFingerprints: [F1] }),
        review({ baseSha: HEAD9, headSha: HEAD2, source: 'crq', findingFingerprints: [F2] }),
      ],
      dispositions: [
        disposition(F5, HEAD1, ['fix verified'], T1),
        disposition(F5, HEAD2, ['fix verified again'], T2),
      ],
      acceptances: [
        acceptance({ headSha: HEAD6 }),
        acceptance({ headSha: HEAD8, verdict: 'HOLD' }),
      ],
      ciRed: [],
      population: [{ headSha: HEAD7, mergedAt: '2026-11-01T00:00:00.000Z' }],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 0, explained: 0, unknown: 1 });
    expect(panels.missed.restored).toEqual({ missed: 0, notMissed: 0, unknown: 2 });
    expect(panels.population).toEqual({
      eligible: 0,
      mature: 0,
      rightCensored: 0,
      followUpDays: 10,
    });
    expect(panels.unknown).toHaveLength(4);
    for (const entry of panels.unknown) expect(entry.kind).toBe('missing');
    expect(panels.unknown.map((entry) => entry.reason).join('\n')).toContain('no reviewed range');
    expect(panels.unknown.map((entry) => entry.reason).join('\n')).toContain('no accepted head');
    expect(panels.unknown.map((entry) => entry.reason).join('\n')).toContain('no pre-merge review');
    expect(panels.unknown.map((entry) => entry.reason).join('\n')).toContain('no PASS acceptance');
  });
});

describe('M10e failure evidence', () => {
  test('malformed rows are unknown evidence, never a crash', () => {
    const valid = disposition(F1, HEAD1, ['fix verified'], T1);
    const panels = computeOutcomePanels({
      reviews: [
        review({ findingFingerprints: [F1] }),
        review({ baseSha: 'short', headSha: HEAD1, findingFingerprints: [F2] }),
      ],
      dispositions: [
        valid,
        disposition(F1, HEAD2, ['fix verified again'], T2),
        { ...disposition(F2, HEAD2, ['fix verified'], T2), observedHead: 'not-a-sha' },
        { ...disposition(F3, HEAD2, ['fix verified'], T2), status: 'delivered' as never },
      ],
      acceptances: [acceptance(), { ...acceptance({ headSha: HEAD9 }), verdict: 'MAYBE' as never }],
      ciRed: [
        { sha: HEAD1, source: 'gh-actions', classification: 'flake' },
        { sha: 'nope', source: 'gh-actions', classification: 'flake' },
      ],
      population: [
        { headSha: HEAD1, mergedAt: '2026-11-01T00:00:00.000Z' },
        { headSha: 4 as never, mergedAt: '2026-11-01T00:00:00.000Z' },
      ],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    // The valid re-fix pair still counts beside the damage; every malformed
    // row is an unknown with a reason and adds nothing to any count.
    expect(panels.harm.refix).toEqual({ candidates: 1, explained: 0, unknown: 0 });
    expect(panels.harm.ciRed).toEqual({ flake: 1, regression: 0, infrastructure: 0, unknown: 1 });
    expect(panels.population).toEqual({
      eligible: 1,
      mature: 1,
      rightCensored: 0,
      followUpDays: 10,
    });
    expect(panels.unknown).toHaveLength(6);
    for (const entry of panels.unknown) expect(entry.kind).toBe('corrupt');
  });

  test('conflicting duplicate observations are all unknown, identical ones dedup', () => {
    // Two dispositions of one identity with different evidence conflict and
    // both leave the panel (a re-fix pair fabricated from the disagreement
    // must not count), while an identical copy of another observation is one
    // observation, not two.
    const panels = computeOutcomePanels({
      reviews: [review({ findingFingerprints: [F1, F2] })],
      dispositions: [
        disposition(F1, HEAD1, ['one story'], T1),
        disposition(F1, HEAD1, ['another story'], T1),
        disposition(F2, HEAD1, ['fix verified'], T1),
        disposition(F2, HEAD1, ['fix verified'], T1),
        disposition(F2, HEAD2, ['fix verified again'], T2),
      ],
      acceptances: [],
      ciRed: [],
      population: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 1, explained: 0, unknown: 0 });
    expect(panels.unknown).toHaveLength(1);
    expect(panels.unknown[0]?.kind).toBe('conflict');
  });

  test('an unrecognized CI red classification is unknown evidence', () => {
    const panels = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: [],
      ciRed: [
        { sha: HEAD1, source: 'gh-actions', classification: 'timeout-guessed' },
        // A row with no classification at all: absent, never guessed.
        { sha: HEAD1, source: 'gh-actions' } as never,
      ],
      population: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.ciRed).toEqual({ flake: 0, regression: 0, infrastructure: 0, unknown: 2 });
    expect(panels.unknown).toHaveLength(2);
    for (const entry of panels.unknown) expect(entry.kind).toBe('unsupported');
  });

  test('invalid panel arguments throw TypeError', () => {
    const valid = {
      reviews: [],
      dispositions: [],
      acceptances: [],
      ciRed: [],
      population: [],
      observedAt: OBSERVED_AT,
    };
    expect(() => computeOutcomePanels({ ...valid, followUpDays: 0 })).toThrow(TypeError);
    expect(() => computeOutcomePanels({ ...valid, followUpDays: '10' as never })).toThrow(
      TypeError,
    );
    expect(() =>
      computeOutcomePanels({
        reviews: [],
        dispositions: [],
        acceptances: [],
        ciRed: [],
        population: [],
        followUpDays: 10,
        observedAt: 'yesterday',
      }),
    ).toThrow(TypeError);
    expect(() =>
      computeOutcomePanels({
        ...valid,
        followUpDays: 10,
        reviews: 'nope' as never,
      }),
    ).toThrow(TypeError);
  });
});
