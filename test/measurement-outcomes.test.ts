// M10e: compute harm and missed-defect panels from explicit observation
// records in the merged report v2 payload shapes (ADR-0008). One case per
// asserted condition:
//   - reviewed-range re-fixes are candidates until prior-correctness/
//     finding-edit evidence;
//   - CI red classification flake/regression/infrastructure/unknown;
//   - restored crq finding must exist at pre-merge covered range to count
//     missed;
//   - missing lineage -> unknown (a re-fix no covered review observed, a
//     post-merge review with no accepted head, an acceptance with no
//     pre-merge review, a declared PR with no independent PASS acceptance,
//     CI red with no stated examined heads, a red at an unexamined head);
//   - mature eligible PR population and follow-up days/right censoring
//     explicit.
// Failure cases keep the M10b discipline: malformed, conflicting or
// availability-incomplete rows are unknown evidence with a reason — never a
// crash, never a fallback zero — and invalid panel arguments throw
// TypeError. Local fixtures only: no providers, no network, no files.
import { describe, expect, test } from 'vitest';
import { computeOutcomePanels } from '../scripts/measurement-outcomes.mjs';
import type {
  AcceptancePayload,
  AvailabilityRecord,
  AvailabilityState,
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
const HEAD9 = '2'.repeat(40);
const T1 = '2026-11-01T00:00:00.000Z';
const T2 = '2026-11-02T00:00:00.000Z';
const OBSERVED_AT = '2026-11-20T00:00:00.000Z';
const avail = (state: AvailabilityState): Record<string, AvailabilityRecord> => ({
  '': { state, reason: 'fixture', source: null },
});

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

interface DispositionOptions {
  observedAt?: string;
  availability?: Record<string, AvailabilityRecord>;
}

const disposition = (
  of: FindingFingerprint,
  observedHead: string,
  evidence: string[],
  options: DispositionOptions = {},
): DispositionPayload => ({
  fingerprint: of,
  status: 'fixed',
  reason: 'fix run verified the change',
  owner: 'fixer',
  evidence,
  reviewTrigger: null,
  observedHead,
  observedAt: options.observedAt ?? T1,
  acceptedRisk: null,
  availability: options.availability ?? {},
});

interface ReviewOptions extends Partial<ReviewObservedPayload> {
  availability?: Record<string, AvailabilityRecord>;
}

const review = (over: ReviewOptions = {}): ReviewObservedPayload => ({
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
    // The covered pre-merge review observed F1..F5, so each second fix is a
    // reviewed-range re-fix: a candidate while its evidence says nothing or
    // merely mentions a marker in prose, explained only by an exact leading
    // prior-correctness/finding-edit token — and the re-fix is the LATER
    // run by instant order, so its evidence is the evidence evaluated.
    const F4 = fingerprint('src/four.ts');
    const F5 = fingerprint('src/five.ts');
    const panels = computeOutcomePanels({
      reviews: [review({ findingFingerprints: [F1, F2, F3, F4, F5] })],
      dispositions: [
        disposition(F1, HEAD1, ['fix verified'], { observedAt: T1 }),
        disposition(F1, HEAD2, ['fix verified again'], { observedAt: T2 }),
        disposition(F2, HEAD1, ['fix verified'], { observedAt: T1 }),
        disposition(F2, HEAD2, ['prior-correctness: the prior fix held'], { observedAt: T2 }),
        disposition(F3, HEAD1, ['fix verified'], { observedAt: T1 }),
        disposition(F3, HEAD2, ['finding-edit: the finding text changed'], { observedAt: T2 }),
        disposition(F4, HEAD1, ['fix verified'], { observedAt: T1 }),
        disposition(F4, HEAD2, ['no finding-edit occurred'], { observedAt: T2 }),
        disposition(F5, HEAD1, ['fix verified'], { observedAt: '2026-11-01T00:00:00.000Z' }),
        disposition(F5, HEAD2, ['prior-correctness: held'], {
          observedAt: '2026-11-01T00:00:00.500Z',
        }),
      ],
      acceptances: [acceptance()],
      ciObservedHeads: [HEAD1],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 2, explained: 3, unknown: 0 });
    expect(panels.unknown).toEqual([]);
  });

  test('CI red classification flake/regression/infrastructure/unknown', () => {
    const panels = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: [],
      ciRed: [
        { sha: HEAD1, source: 'gh-actions', classification: 'flake' },
        { sha: HEAD1, source: 'circle', classification: 'regression' },
        { sha: HEAD2, source: 'gh-actions', classification: 'infrastructure' },
        { sha: HEAD2, source: 'circle', classification: 'unknown' },
      ],
      ciObservedHeads: [HEAD2, HEAD1],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.ciRed).toEqual({
      flake: 1,
      regression: 1,
      infrastructure: 1,
      unknown: 1,
      observedHeads: [HEAD1, HEAD2],
      unobservedHeads: [],
    });
    expect(panels.unknown).toEqual([]);
  });

  test('restored crq finding must exist at pre-merge covered range to count missed', () => {
    // The post-merge crq review (based at the accepted head) restores F1 —
    // which the covered pre-merge review observed at its range — and also
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
      ciObservedHeads: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.missed.restored).toEqual({ missed: 1, notMissed: 1, unknown: 0 });
    expect(panels.unknown).toEqual([]);
  });

  test('mature eligible PR population and follow-up days/right censoring explicit', () => {
    // Eligibility is an independent PASS acceptance at the exact head;
    // maturity is the explicit follow-up window elapsing by the observation
    // instant — at exactly followUpDays a PR is mature, and a younger one is
    // explicitly right-censored, never silently dropped. CI observation
    // coverage of the eligible population is reported the same way.
    const panels = computeOutcomePanels({
      reviews: [review(), review({ headSha: HEAD3 })],
      dispositions: [],
      acceptances: [
        acceptance(),
        acceptance({ headSha: HEAD3 }),
        acceptance({ headSha: HEAD4, reviewedBaseSha: HEAD1 }),
      ],
      ciObservedHeads: [HEAD1],
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
    expect(panels.harm.ciRed.observedHeads).toEqual([HEAD1]);
    expect(panels.harm.ciRed.unobservedHeads).toEqual([HEAD3, HEAD4]);
    expect(panels.unknown).toEqual([]);
  });
});

describe('M10e missing evidence', () => {
  test('missing lineage -> unknown', () => {
    // Four missing lineages: a re-fix no covered review observed, a
    // post-merge crq review based at no accepted head, a crq review whose
    // acceptance has no pre-merge review, and a declared PR whose only PASS
    // acceptance is not independent. Each is an unknown with a reason —
    // never a count, never a fallback zero.
    const F5 = fingerprint('src/five.ts');
    const panels = computeOutcomePanels({
      reviews: [
        review({ baseSha: HEAD6, headSha: HEAD2, source: 'crq', findingFingerprints: [F1] }),
        review({ baseSha: HEAD9, headSha: HEAD2, source: 'crq', findingFingerprints: [F2] }),
      ],
      dispositions: [
        disposition(F5, HEAD1, ['fix verified']),
        disposition(F5, HEAD2, ['fix verified again'], { observedAt: T2 }),
      ],
      acceptances: [
        acceptance({ headSha: HEAD6 }),
        acceptance({ headSha: HEAD7, independent: false }),
      ],
      ciObservedHeads: [],
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
    const reasons = panels.unknown.map((entry) => entry.reason).join('\n');
    expect(reasons).toContain('no reviewed range');
    expect(reasons).toContain('no accepted head');
    expect(reasons).toContain('no pre-merge review');
    expect(reasons).toContain('no independent PASS acceptance');
  });

  test('producer not-collected markers on unconsumed fields never drop a valid review', () => {
    // address.ts writes /reviewerId not-collected whenever a source has no
    // cycle id, and /omissions not-collected on every legacy coverage proof
    // — fields no panel consumes. A covered review carrying them still
    // establishes its covered range, and a post-merge crq review carrying
    // them still counts its findings.
    const notCollected = (key: string): Record<string, AvailabilityRecord> => ({
      [key]: { state: 'not-collected', reason: 'fixture', source: null },
    });
    const panels = computeOutcomePanels({
      reviews: [
        review({
          coverage: 'legacy:full',
          findingFingerprints: [F1],
          availability: notCollected('/omissions'),
        }),
        review({ round: 2, findingFingerprints: [F2], availability: notCollected('/reviewerId') }),
      ],
      dispositions: [
        disposition(F1, HEAD1, ['fix verified']),
        disposition(F1, HEAD2, ['fix verified again'], { observedAt: T2 }),
        disposition(F2, HEAD1, ['fix verified']),
        disposition(F2, HEAD2, ['fix verified again'], { observedAt: T2 }),
      ],
      acceptances: [],
      ciObservedHeads: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 2, explained: 0, unknown: 0 });
    expect(panels.unknown).toEqual([]);

    const missed = computeOutcomePanels({
      reviews: [
        review({ findingFingerprints: [F1] }),
        review({
          baseSha: HEAD1,
          headSha: HEAD2,
          source: 'crq',
          findingFingerprints: [F1],
          availability: notCollected('/reviewerId'),
        }),
      ],
      dispositions: [],
      acceptances: [acceptance()],
      ciObservedHeads: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(missed.missed.restored).toEqual({ missed: 1, notMissed: 0, unknown: 0 });
    expect(missed.unknown).toEqual([]);
  });

  test('CI red counts are unknown unless the examined heads are stated', () => {
    // With no ciObservedHeads there is no CI evidence at all: the four
    // counts are null with one unavailable unknown — never four zeros.
    const panels = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: [],
      ciRed: [{ sha: HEAD1, source: 'gh-actions', classification: 'flake' }],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.ciRed).toEqual({
      flake: null,
      regression: null,
      infrastructure: null,
      unknown: null,
      observedHeads: null,
      unobservedHeads: null,
    });
    expect(panels.unknown).toHaveLength(1);
    expect(panels.unknown[0]).toMatchObject({
      kind: 'unavailable',
      reason: 'no CI coverage declared',
    });
  });

  test('a red at an unexamined head is partial evidence', () => {
    // The red's head is an eligible PR whose CI was not examined: the four
    // counts still describe only examined reds, the coverage gap rides as a
    // top-level partial entry, and the head is reported unobserved.
    const panels = computeOutcomePanels({
      reviews: [review({ headSha: HEAD2 })],
      dispositions: [],
      acceptances: [acceptance({ headSha: HEAD2 })],
      ciRed: [{ sha: HEAD2, source: 'gh-actions', classification: 'flake' }],
      ciObservedHeads: [HEAD1],
      population: [{ headSha: HEAD2, mergedAt: '2026-11-01T00:00:00.000Z' }],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.ciRed).toEqual({
      flake: 0,
      regression: 0,
      infrastructure: 0,
      unknown: 0,
      observedHeads: [HEAD1],
      unobservedHeads: [HEAD2],
    });
    expect(panels.unknown).toHaveLength(1);
    expect(panels.unknown[0]?.kind).toBe('partial');
  });

  test('a corrupt CI coverage declaration degrades the counts', () => {
    // One non-sha entry makes the whole declaration unusable: the counts are
    // null beside the corrupt entry, never computed over the valid rest.
    const panels = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: [],
      ciRed: [{ sha: HEAD1, source: 'gh-actions', classification: 'flake' }],
      ciObservedHeads: [HEAD1, 'nope'],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.ciRed).toEqual({
      flake: null,
      regression: null,
      infrastructure: null,
      unknown: null,
      observedHeads: null,
      unobservedHeads: null,
    });
    expect(panels.unknown).toHaveLength(2);
    expect(panels.unknown[0]?.kind).toBe('corrupt');
    expect(panels.unknown[1]?.kind).toBe('unavailable');
  });
});

describe('M10e failure evidence', () => {
  test('malformed rows are unknown evidence, never a crash', () => {
    const panels = computeOutcomePanels({
      reviews: [
        review({ findingFingerprints: [F1] }),
        review({ baseSha: 'short', headSha: HEAD1, findingFingerprints: [F2] }),
      ],
      dispositions: [
        disposition(F1, HEAD1, ['fix verified']),
        disposition(F1, HEAD2, ['fix verified again'], { observedAt: T2 }),
        {
          ...disposition(F2, HEAD2, ['fix verified'], { observedAt: T2 }),
          observedHead: 'not-a-sha',
        },
        {
          ...disposition(F3, HEAD2, ['fix verified'], { observedAt: T2 }),
          status: 'delivered' as never,
        },
        { ...disposition(F3, HEAD2, ['fix verified'], { observedAt: T2 }), owner: '' },
        disposition(fingerprint('src/nofrac.ts'), HEAD2, ['fix verified'], {
          observedAt: '2026-11-02T00:00:00Z',
        }),
      ],
      acceptances: [acceptance(), { ...acceptance({ headSha: HEAD9 }), verdict: 'MAYBE' as never }],
      ciRed: [
        { sha: HEAD1, source: 'gh-actions', classification: 'flake' },
        { sha: 'nope', source: 'gh-actions', classification: 'flake' },
      ],
      ciObservedHeads: [HEAD1],
      population: [
        { headSha: HEAD1, mergedAt: '2026-11-01T00:00:00.000Z' },
        { headSha: 4 as never, mergedAt: '2026-11-01T00:00:00.000Z' },
        { headSha: HEAD2, mergedAt: '2026-02-30T00:00:00.000Z' },
      ],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    // The valid re-fix pair still counts beside the damage; every malformed
    // row (short sha, bad status, empty owner, fraction-less or impossible
    // timestamp) is an unknown with a reason and adds nothing to any count.
    expect(panels.harm.refix).toEqual({ candidates: 1, explained: 0, unknown: 0 });
    expect(panels.harm.ciRed).toEqual({
      flake: 1,
      regression: 0,
      infrastructure: 0,
      unknown: 0,
      observedHeads: [HEAD1],
      unobservedHeads: [],
    });
    expect(panels.population).toEqual({
      eligible: 1,
      mature: 1,
      rightCensored: 0,
      followUpDays: 10,
    });
    expect(panels.unknown).toHaveLength(9);
    for (const entry of panels.unknown) expect(entry.kind).toBe('corrupt');
  });

  test('conflicting duplicate observations are all unknown, identical ones dedup', () => {
    // Dispositions: two rows of one identity with different evidence
    // conflict and both leave the panel. ciRed: an identical repeat of one
    // (sha, source) observation is one observation, while a disagreeing
    // classification is a conflict that counts in no bucket. population:
    // the same declared PR twice is one PR, and a disagreeing mergedAt is a
    // conflict that makes it eligible for nothing.
    const panels = computeOutcomePanels({
      reviews: [review({ findingFingerprints: [F1, F2] })],
      dispositions: [
        disposition(F1, HEAD1, ['one story']),
        disposition(F1, HEAD1, ['another story']),
        disposition(F2, HEAD1, ['fix verified']),
        disposition(F2, HEAD2, ['fix verified again'], { observedAt: T2 }),
      ],
      acceptances: [acceptance()],
      ciRed: [
        { sha: HEAD1, source: 'gh-actions', classification: 'flake' },
        { sha: HEAD1, source: 'gh-actions', classification: 'flake' },
        { sha: HEAD2, source: 'gh-actions', classification: 'flake' },
        { sha: HEAD2, source: 'gh-actions', classification: 'regression' },
      ],
      ciObservedHeads: [HEAD1, HEAD2],
      population: [
        { headSha: HEAD1, mergedAt: '2026-11-01T00:00:00.000Z' },
        { headSha: HEAD1, mergedAt: '2026-11-01T00:00:00.000Z' },
      ],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 1, explained: 0, unknown: 0 });
    expect(panels.harm.ciRed).toEqual({
      flake: 1,
      regression: 0,
      infrastructure: 0,
      unknown: 0,
      observedHeads: [HEAD1, HEAD2],
      unobservedHeads: [],
    });
    expect(panels.population).toEqual({
      eligible: 1,
      mature: 1,
      rightCensored: 0,
      followUpDays: 10,
    });
    expect(panels.unknown).toHaveLength(2);
    for (const entry of panels.unknown) expect(entry.kind).toBe('conflict');

    const conflicted = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: [acceptance()],
      ciObservedHeads: [HEAD1],
      population: [
        { headSha: HEAD1, mergedAt: '2026-11-01T00:00:00.000Z' },
        { headSha: HEAD1, mergedAt: '2026-11-18T00:00:00.000Z' },
      ],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });
    expect(conflicted.population).toEqual({
      eligible: 0,
      mature: 0,
      rightCensored: 0,
      followUpDays: 10,
    });
    expect(conflicted.unknown).toHaveLength(1);
    expect(conflicted.unknown[0]?.kind).toBe('conflict');
  });

  test('two independent PASSes at one head with different bases are an ambiguous range', () => {
    // Whichever acceptance arrives first, the pre-merge range the accepted
    // head certifies is ambiguous: the restored finding is unknown, never
    // missed by the luck of input order.
    const crq = review({
      baseSha: HEAD1,
      headSha: HEAD2,
      source: 'crq',
      findingFingerprints: [F1],
    });
    const preMerge = review({ findingFingerprints: [F1] });
    for (const order of [
      [acceptance(), acceptance({ reviewedBaseSha: HEAD2 })],
      [acceptance({ reviewedBaseSha: HEAD2 }), acceptance()],
    ]) {
      const panels = computeOutcomePanels({
        reviews: [preMerge, crq],
        dispositions: [],
        acceptances: order,
        ciObservedHeads: [],
        followUpDays: 10,
        observedAt: OBSERVED_AT,
      });
      expect(panels.missed.restored).toEqual({ missed: 0, notMissed: 0, unknown: 1 });
      expect(panels.unknown).toHaveLength(1);
      expect(panels.unknown[0]?.kind).toBe('conflict');
    }
  });

  test('a row whose availability marks consumed fields incomplete is unknown', () => {
    // A torn disposition (root availability partial) never enters a re-fix
    // run, a review whose finding list is marked unavailable (or whose root
    // is torn) never establishes a covered range — the re-fix that relied on
    // it is missing lineage — and a torn acceptance never makes a PR
    // eligible.
    const FA = fingerprint('src/torn.ts');
    const FB = fingerprint('src/lost-range.ts');
    const FC = fingerprint('src/torn-list.ts');
    const pointer = (key: string): Record<string, AvailabilityRecord> => ({
      [key]: { state: 'unavailable', reason: 'fixture', source: null },
    });
    const panels = computeOutcomePanels({
      reviews: [
        review({ findingFingerprints: [FB], availability: avail('partial') }),
        review({
          round: 2,
          findingFingerprints: [FC],
          availability: pointer('/findingFingerprints'),
        }),
      ],
      dispositions: [
        disposition(FA, HEAD1, ['fix verified']),
        disposition(FA, HEAD2, ['fix verified again'], {
          observedAt: T2,
          availability: avail('partial'),
        }),
        disposition(FB, HEAD1, ['fix verified']),
        disposition(FB, HEAD2, ['fix verified again'], { observedAt: T2 }),
        disposition(FC, HEAD1, ['fix verified']),
        disposition(FC, HEAD2, ['fix verified again'], { observedAt: T2 }),
      ],
      acceptances: [acceptance({ headSha: HEAD2, availability: avail('partial') })],
      ciObservedHeads: [],
      population: [{ headSha: HEAD2, mergedAt: '2026-11-01T00:00:00.000Z' }],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 0, explained: 0, unknown: 2 });
    expect(panels.population).toEqual({
      eligible: 0,
      mature: 0,
      rightCensored: 0,
      followUpDays: 10,
    });
    // The torn acceptance also leaves the declared PR without qualifying
    // lineage: its own 'unavailable' plus the population row's 'missing'.
    expect(panels.unknown).toHaveLength(7);
    expect(panels.unknown.filter((entry) => entry.kind === 'unavailable')).toHaveLength(4);
    expect(panels.unknown.filter((entry) => entry.kind === 'missing')).toHaveLength(3);
  });

  test('an uncovered review never establishes a covered range', () => {
    // A review that recorded no coverage proof, or one the vendor did not
    // complete, observed nothing at a covered range: a re-fix of its
    // finding is missing lineage, not a harm candidate.
    const F5 = fingerprint('src/uncovered.ts');
    const panels = computeOutcomePanels({
      reviews: [
        review({
          coverage: 'none-recorded',
          vendorCompletion: 'unknown',
          findingFingerprints: [F5],
        }),
        review({ round: 2, vendorCompletion: 'not-completed', findingFingerprints: [F1] }),
      ],
      dispositions: [
        disposition(F5, HEAD1, ['fix verified']),
        disposition(F5, HEAD2, ['fix verified again'], { observedAt: T2 }),
      ],
      acceptances: [],
      ciObservedHeads: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.refix).toEqual({ candidates: 0, explained: 0, unknown: 1 });
    expect(panels.unknown).toHaveLength(1);
    expect(panels.unknown[0]?.kind).toBe('missing');
  });

  test('an unrecognized CI red classification is unknown evidence', () => {
    const panels = computeOutcomePanels({
      reviews: [],
      dispositions: [],
      acceptances: [],
      ciRed: [
        { sha: HEAD1, source: 'gh-actions', classification: 'timeout-guessed' },
        // A row with no classification at all: absent, never guessed.
        { sha: HEAD1, source: 'circle' } as never,
      ],
      ciObservedHeads: [HEAD1],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    });

    expect(panels.harm.ciRed).toEqual({
      flake: 0,
      regression: 0,
      infrastructure: 0,
      unknown: 2,
      observedHeads: [HEAD1],
      unobservedHeads: [],
    });
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
      ciObservedHeads: [],
      followUpDays: 10,
      observedAt: OBSERVED_AT,
    };
    expect(() => computeOutcomePanels({ ...valid, followUpDays: 0 })).toThrow(TypeError);
    expect(() => computeOutcomePanels({ ...valid, followUpDays: '10' as never })).toThrow(
      TypeError,
    );
    expect(() => computeOutcomePanels({ ...valid, observedAt: 'Nov 20 2026' })).toThrow(TypeError);
    expect(() => computeOutcomePanels({ ...valid, ciObservedHeads: 'nope' as never })).toThrow(
      TypeError,
    );
    expect(() =>
      computeOutcomePanels({
        ...valid,
        reviews: 'nope' as never,
      }),
    ).toThrow(TypeError);
  });
});
