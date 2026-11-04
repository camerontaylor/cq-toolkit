// ADR-0008 T21 — `review-observed`: retain reviewed head exposures
// (measurement slice M9).
//
// What is pinned here:
//   1. Round-trip: makeReviewAddress appends one review-observed event per
//      review source exposure — per source/head/round, never a last-head
//      overwrite (every earlier population survives later rounds) — with the
//      review scope, the per-source blocking population and the
//      delivered/completed coverage of each vendor; the inherited initial
//      population is stamped round 0; foldObservations mirrors them into
//      report v2 `reviews` with `/reviews` known.
//   2. Unknown evidence: a legacy record without a reviewed base proof is
//      WITHHELD silently and counted (the report's /reviews reads partial,
//      the observation surface stays durable); a source without coverage
//      proof reports vendorCompletion `unknown` with not-collected lists;
//      a FOREIGN coverage proof (another head or base) is never attached;
//      legacy coverage contributes receipt references and cannot prove
//      omissions; a missing cycle id degrades reviewerId with availability.
//   3. Failure boundary: an incomplete vendor is `not-completed` (a budget
//      session, a delivered-not-completed piece, an excluded piece and a
//      blocked sibling source are all recorded); abort paths EMIT the
//      blocked re-review report or COUNT the exposure withheld with a
//      distinct reason (no anchored head, identity changed, merge-base
//      unresolved) — never dropped, /reviews never known over a gap; and a
//      failed review-observed append marks the surface indeterminate
//      without moving the verdict.
// Fake/local inputs only: no provider, no network, no credentials.
import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { ReviewCoverageV2 } from '../../../src/ops/review/internal/reviewCoverageV2.js';
import type { FindingsRecord, Finding, ReviewSource } from '../../../src/ops/review/findings.js';
import { foldObservations } from '../../../src/ops/fix/reportFold.js';
import { ReportV2Schema } from '../../../src/kernel/schema.js';
import { openObservationWriter, readObservations } from '../../../src/kernel/observation.js';
import type { ObservationWriter } from '../../../src/kernel/observation.js';
import type { ObservationEvent, ReviewObservedPayload } from '../../../src/kernel/types.js';
import { fixture, finding, reportOf } from './address.helpers.js';
import { initial, world } from './address-pr.helpers.js';

const reviewEvents = (events: readonly ObservationEvent[]): ReviewObservedPayload[] =>
  events.flatMap((event) => (event.type === 'review-observed' ? [event.payload] : []));

const reviewsOf = async (journalDir: string) => {
  const streams = await readObservations(journalDir);
  return { streams, reviews: reviewEvents(streams[0]!.events) };
};

const hash = (character: string) => character.repeat(64);

/** A v2 coverage fixture: one completed piece, one budget-stalled delivery, one exclusion. */
const incompleteCoverage = (head: string, base: string): ReviewCoverageV2 => ({
  version: 2,
  head,
  base,
  scope: 'full',
  mode: 'session',
  modeReason: 'fixture',
  pieces: [
    {
      component: 'c0',
      path: 'src/a.ts',
      sha256: hash('a'),
      chars: 4,
      bytes: 4,
      state: 'completed',
      sessionId: 's1',
    },
    {
      component: 'c1',
      path: 'src/b.ts',
      sha256: hash('b'),
      chars: 4,
      bytes: 4,
      state: 'delivered',
      sessionId: 's2',
    },
    {
      component: 'c2',
      path: 'src/c.ts',
      sha256: hash('c'),
      chars: 4,
      bytes: 4,
      state: 'excluded',
      exclusion: { rule: 'generated', limitation: 'not a reviewable source' },
    },
  ],
  sessions: [
    {
      id: 's1',
      status: 'complete',
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      deliveries: [{ component: 'c0', start: 0, end: 4, sha256: hash('a') }],
      requests: [{ serializedChars: 1, decodedChars: 1 }],
    },
    {
      id: 's2',
      status: 'budget',
      usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 },
      deliveries: [{ component: 'c1', start: 0, end: 2, sha256: hash('d') }],
      requests: [{ serializedChars: 1, decodedChars: 1 }],
    },
  ],
});

/**
 * Legacy (v1) coverage: one whole-component partition, complete. The base and
 * scope mirror the record's `reviewed` proof — `isComplete` demands they agree
 * before a re-reviewed record counts as a complete review source.
 */
const legacyCoverage = (head: string, base: string) => ({
  head,
  base,
  scope: 'full' as const,
  components: [{ component: 'c0', path: 'src/a.ts', sha256: hash('a'), chars: 4, bytes: 4 }],
  partitions: [
    {
      receipt: hash('b'),
      ranges: [{ component: 0, start: 0, end: 4 }],
      complete: true,
      promptChars: 100,
      requests: [{ serializedChars: 1, decodedChars: 1 }],
    },
  ],
});

const withReviewed = (record: FindingsRecord): FindingsRecord => {
  const { reviewed: _reviewed, ...legacy } = record;
  return legacy;
};

// ---- T21 round-trip -------------------------------------------------------

test('T21 round-trip', async () => {
  const f = await fixture();
  try {
    const result = await makeReviewAddress(f.deps)({ ...f.input, rounds: 2 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(reportOf(result).stop).toBe('round-cap');

    const { streams, reviews } = await reviewsOf(f.input.journalDir);
    // The inherited initial population (round 0), round 1's re-review and
    // round 2's re-review: every exposure of the head is retained — a later
    // round never overwrote an earlier population (append-only stream).
    expect(reviews.map((payload) => payload.round)).toEqual([0, 1, 2]);
    const base = f.repo.git('merge-base', 'origin/main', 'HEAD').trim();
    const head = f.record().head;
    const fingerprint = {
      version: 1,
      checkId: 'agent',
      rule: null,
      path: 'src/a.ts',
      spanContentHash: null,
    };
    expect(reviews[0]).toMatchObject({
      baseSha: base,
      headSha: head,
      source: 'agent',
      reviewerId: 'agent',
      round: 0,
      coverage: 'none-recorded',
      findingFingerprints: [fingerprint],
      initialBlocking: [fingerprint],
      delivered: [],
      completed: [],
      omissions: [],
      vendorCompletion: 'unknown',
    });
    // No cycle id on the fixture source: the kind stands in, disclosed.
    expect(Object.keys(reviews[0]!.availability).sort()).toEqual([
      '/completed',
      '/delivered',
      '/omissions',
      '/reviewerId',
    ]);
    // The re-review that found nothing reports a KNOWN-EMPTY population.
    expect(reviews[1]!.headSha).toBe(head);
    expect(reviews[1]!.initialBlocking).toEqual([]);

    // The T36 consumer folds every exposure into report v2.
    const folded = foldObservations({ streams, producer: 'address' });
    expect(folded.reviews).toEqual(reviews);
    expect(folded.availability['/reviews']).toMatchObject({ state: 'known' });
    expect(ReportV2Schema.parse(folded)).toEqual(folded);
    // Nothing withheld: the composition's own report reads /reviews known.
    expect(reportOf(result).reportV2?.availability['/reviews']).toMatchObject({
      state: 'known',
    });
    expect(reportOf(result).reportV2?.reviews).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
}, 120_000);

// ---- T21 unknown evidence -------------------------------------------------

test('T21 unknown evidence', async () => {
  const f = await fixture();
  try {
    // A legacy initial record without a reviewed base proof cannot anchor a
    // scope row: the exposure is withheld SILENTLY — nothing is fabricated,
    // the withholding is neutral to the observation surface, and the count
    // alone carries the gap into /reviews as partial.
    const result = await makeReviewAddress({ ...f.deps, initialRecord: withReviewed(f.record()) })({
      ...f.input,
      rounds: 2,
    });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const report = reportOf(result);
    expect(report.observation?.failure).toBeNull();
    expect(report.observation?.status).toBe('durable');
    const { reviews } = await reviewsOf(f.input.journalDir);
    // Only this composition's own exposures (the two re-reviews) landed; the
    // withheld initial population appears as no event at all.
    expect(reviews.map((payload) => payload.round)).toEqual([1, 2]);
    expect(reviews.some((payload) => payload.initialBlocking?.length)).toBe(false);
    expect(report.reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: no reviewed base proof',
    });
    expect(report.reportV2?.reviews).toHaveLength(2);
  } finally {
    await f.cleanup();
  }

  // Legacy coverage contributes receipt references and cannot prove omissions.
  const f2 = await fixture();
  try {
    const head = f2.record().head;
    const base = f2.record().reviewed!.base;
    const sources: ReviewSource[] = [
      { kind: 'agent', status: 'terminal', coverage: legacyCoverage(head, base) },
    ];
    const result = await makeReviewAddress({
      ...f2.deps,
      review: async () => ({ status: 'ok', value: { ...f2.record(), sources, findings: [] } }),
    })({ ...f2.input, rounds: 2 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const { reviews } = await reviewsOf(f2.input.journalDir);
    expect(reviews).toHaveLength(3);
    const legacy = reviews[1]!;
    expect(legacy).toMatchObject({
      coverage: 'legacy:full',
      delivered: [hash('b')],
      completed: [hash('b')],
      omissions: [],
      vendorCompletion: 'completed',
    });
    expect(legacy.availability['/omissions']).toMatchObject({ state: 'not-collected' });
    expect(legacy.availability['/delivered']).toBeUndefined();
    // The terminal source without any coverage proof stays unknown, never
    // known-empty (pinned by the round-trip's initial exposure above).
    expect(reviews[0]!.vendorCompletion).toBe('unknown');
  } finally {
    await f2.cleanup();
  }

  // A foreign coverage proof — one naming another head — is never attached.
  const f3 = await fixture();
  try {
    const base = f3.record().reviewed!.base;
    const sources: ReviewSource[] = [
      {
        kind: 'agent',
        status: 'terminal',
        coverage: incompleteCoverage('e'.repeat(40), base),
      },
    ];
    const result = await makeReviewAddress({
      ...f3.deps,
      review: async () => ({ status: 'ok', value: { ...f3.record(), sources, findings: [] } }),
    })({ ...f3.input, rounds: 1 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const { reviews } = await reviewsOf(f3.input.journalDir);
    const foreign = reviews[1]!;
    expect(foreign.coverage).toBe('foreign');
    expect(foreign.vendorCompletion).toBe('unknown');
    expect(foreign.delivered).toEqual([]);
    expect(foreign.availability['/delivered']?.state).toBe('not-collected');
    expect(foreign.availability['/delivered']?.reason).toContain('foreign proof is never attached');
  } finally {
    await f3.cleanup();
  }
}, 120_000);

// ---- T21 withheld exposure beside a normal one ----------------------------

test('T21 withheld exposure beside a normal one', async () => {
  // T21 ruling: a withheld exposure never reads as complete evidence. The
  // stream stays clean (no event, no surface effect — the status is durable),
  // the normal exposure in the same stream is still recorded, and only the
  // report's /reviews availability carries the gap as partial.
  const f = await fixture();
  try {
    const result = await makeReviewAddress({ ...f.deps, initialRecord: withReviewed(f.record()) })({
      ...f.input,
      rounds: 1,
    });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const report = reportOf(result);
    expect(report.observation?.status).toBe('durable');
    expect(report.observation?.failure).toBeNull();
    const { reviews } = await reviewsOf(f.input.journalDir);
    expect(reviews.map((payload) => payload.round)).toEqual([1]);
    expect(report.reportV2?.reviews).toHaveLength(1);
    expect(report.reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: no reviewed base proof',
    });
  } finally {
    await f.cleanup();
  }
}, 120_000);

// ---- T21 failure boundary -------------------------------------------------

test('T21 failure boundary', async () => {
  // An incomplete vendor is not-completed: a budget session, a delivered but
  // uncompleted piece and an excluded piece are all snapshot, and a blocked
  // sibling source is recorded too — never silently dropped or upgraded.
  const f = await fixture();
  try {
    const head = f.record().head;
    const base = f.record().reviewed!.base;
    const sources: ReviewSource[] = [
      { kind: 'agent', status: 'terminal', coverage: incompleteCoverage(head, base) },
      { kind: 'coderabbit', status: 'blocked', reason: 'vendor auth refused' },
    ];
    const result = await makeReviewAddress({
      ...f.deps,
      review: async () => ({ status: 'ok', value: { ...f.record(), sources, findings: [] } }),
    })({ ...f.input, rounds: 1 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const { reviews } = await reviewsOf(f.input.journalDir);
    // The inherited exposure plus one event per refreshed source: the
    // incomplete agent vendor AND the blocked coderabbit sibling.
    expect(reviews.map((payload) => payload.source)).toEqual(['agent', 'agent', 'coderabbit']);
    expect(reviews[1]).toMatchObject({
      coverage: 'v2:session:full',
      delivered: ['src/a.ts', 'src/b.ts'],
      completed: ['src/a.ts'],
      omissions: ['src/c.ts'],
      vendorCompletion: 'not-completed',
    });
    expect(reviews[2]).toMatchObject({
      source: 'coderabbit',
      coverage: 'none-recorded',
      delivered: [],
      completed: [],
      omissions: [],
      vendorCompletion: 'not-completed',
    });
    expect(reviews[2]!.availability['/delivered']).toMatchObject({ state: 'not-collected' });
  } finally {
    await f.cleanup();
  }

  // A failed review-observed append marks the surface indeterminate and never
  // moves the verdict: the run still completes its rounds.
  const f2 = await fixture();
  try {
    const raw = await openObservationWriter({
      workId: randomUUID(),
      compositionRunId: 'cq-t21-append-refused',
    });
    const writer: ObservationWriter = {
      compositionRunId: raw.compositionRunId,
      workId: raw.workId,
      persistence: raw.persistence,
      get failure() {
        return raw.failure;
      },
      events: () => raw.events(),
      append: (event) =>
        event.type === 'review-observed'
          ? Promise.reject(new Error('review-observed append refused (fixture)'))
          : raw.append(event),
      close: () => raw.close(),
    };
    const result = await makeReviewAddress({ ...f2.deps, observationWriter: writer })({
      ...f2.input,
      rounds: 2,
    });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(reportOf(result).stop).toBe('round-cap');
    const report = reportOf(result);
    expect(report.observation?.failure).toContain('review-observed append refused');
    expect(report.observation?.status).toBe('indeterminate');
    // The refused events never became evidence; the rest of the stream lives.
    const events = writer.events();
    expect(reviewEvents(events)).toEqual([]);
    expect(events[0]?.type).toBe('composition-started');
    expect(events.some((event) => event.type === 'finding-disposition')).toBe(true);
  } finally {
    await f2.cleanup();
  }
}, 120_000);

// ---- T21 abort paths ------------------------------------------------------

test('T21 re-review exposures survive abort paths', async () => {
  // P1 probe C: a blocked vendor re-review (needs-human WITH a report) is
  // EMITTED — blocked sources as not-completed — instead of dropped, and
  // /reviews reads known (a measured exposure, no gap).
  const f = await fixture();
  try {
    const blockedReport: FindingsRecord = {
      ...f.record(),
      sources: [{ kind: 'coderabbit', status: 'blocked', reason: 'vendor auth refused' }],
      findings: [],
    };
    const result = await makeReviewAddress({
      ...f.deps,
      review: async () => ({
        status: 'needs-human',
        reason: 'review unavailable',
        report: blockedReport,
      }),
    })({ ...f.input, rounds: 2 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const report = reportOf(result);
    const { reviews } = await reviewsOf(f.input.journalDir);
    expect(reviews.map((payload) => [payload.round, payload.source])).toEqual([
      [0, 'agent'],
      [1, 'coderabbit'],
    ]);
    expect(reviews[1]!.vendorCompletion).toBe('not-completed');
    expect(report.reportV2?.availability['/reviews']).toMatchObject({ state: 'known' });
  } finally {
    await f.cleanup();
  }

  // No report at all: counted withheld with its distinct reason; never dropped.
  const f2 = await fixture();
  try {
    const result = await makeReviewAddress({
      ...f2.deps,
      review: async () => ({ status: 'failed', error: 'scripted reviewer crash' }),
    })({ ...f2.input, rounds: 1 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(reportOf(result).reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: re-review returned no anchored head',
    });
    const { reviews } = await reviewsOf(f2.input.journalDir);
    expect(reviews.map((payload) => payload.round)).toEqual([0]);
  } finally {
    await f2.cleanup();
  }

  // Identity changed: withheld with its distinct reason.
  const f3 = await fixture();
  try {
    const result = await makeReviewAddress({
      ...f3.deps,
      review: async () => ({ status: 'ok', value: { ...f3.record(), head: 'd'.repeat(40) } }),
    })({ ...f3.input, rounds: 1 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(reportOf(result).reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: identity changed before the re-review was recorded',
    });
  } finally {
    await f3.cleanup();
  }

  // The identity check itself failing (git unreadable between the produced
  // record and its emission) counts the row withheld — /reviews partial with
  // its own reason — and the rethrow keeps the run outcome unchanged.
  const f4 = await fixture();
  try {
    const result = await makeReviewAddress({
      ...f4.deps,
      review: async () => {
        await rm(join(f4.repo.root, '.git', 'HEAD'));
        return { status: 'ok', value: { ...f4.record(), findings: [] } };
      },
    })({ ...f4.input, rounds: 1 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const report = reportOf(result);
    expect(report.reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: identity check failed before the re-review was recorded',
    });
    const { reviews } = await reviewsOf(f4.input.journalDir);
    expect(reviews.map((payload) => payload.round)).toEqual([0]);
    expect(report.observation?.status).toBe('durable');
  } finally {
    await f4.cleanup();
  }
}, 120_000);

// ---- T21 per-source rows --------------------------------------------------

test('T21 rows are per source with per-source identity', async () => {
  // P3-2: each row carries only its own source's findings and blocking
  // population; reviewerId comes from the source's cycle identity when
  // recorded, and degrades with availability (never a guessed identity).
  const f = await fixture();
  try {
    const record: FindingsRecord = {
      ...f.record(),
      sources: [
        { kind: 'agent', status: 'terminal', cycleId: 'cyc-42' },
        { kind: 'coderabbit', status: 'terminal' },
      ],
      findings: [
        { ...finding('a1'), severity: 'major' } satisfies Finding,
        { ...finding('a2'), severity: 'minor' } satisfies Finding,
        { ...finding('c1'), source: 'coderabbit' } satisfies Finding,
      ],
    };
    const result = await makeReviewAddress({ ...f.deps, initialRecord: record })({
      ...f.input,
      rounds: 1,
    });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const { reviews } = await reviewsOf(f.input.journalDir);
    expect(reviews.map((payload) => [payload.source, payload.round])).toEqual([
      ['agent', 0],
      ['coderabbit', 0],
      ['agent', 1],
    ]);
    expect(reviews[0]!.reviewerId).toBe('cyc-42');
    expect(reviews[0]!.availability['/reviewerId']).toBeUndefined();
    expect(reviews[0]!.findingFingerprints.map((fp) => fp.path)).toEqual([
      'src/a1.ts',
      'src/a2.ts',
    ]);
    expect(reviews[0]!.initialBlocking?.map((fp) => fp.path)).toEqual(['src/a1.ts']);
    expect(reviews[1]!.reviewerId).toBe('coderabbit');
    expect(reviews[1]!.availability['/reviewerId']).toMatchObject({ state: 'not-collected' });
    expect(reviews[1]!.findingFingerprints.map((fp) => fp.path)).toEqual(['src/c1.ts']);
  } finally {
    await f.cleanup();
  }
}, 120_000);

// ---- T21 PR lane ----------------------------------------------------------

test('T21 PR lane emits both exposure sites with the pinned base', async () => {
  const w = await world(false, { expectedHead: initial });
  try {
    const result = await w.run();
    const report = result.status === 'ok' ? result.value : result.report!;
    const { reviews } = await reviewsOf(join(w.root, 'journal'));
    // Site 1: the PR-thread population of the round's head. Site 2: the
    // agent re-review of the same head. One lane base pins both scopes.
    expect(reviews.map((payload) => [payload.source, payload.round])).toEqual([
      ['pr-threads', 1],
      ['agent', 1],
    ]);
    expect(reviews[0]!.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(reviews[1]!.baseSha).toBe(reviews[0]!.baseSha);
    expect(reviews[0]!.headSha).toBe(reviews[1]!.headSha);
    expect(report.observation?.status).toBe('durable');
  } finally {
    await w.cleanup();
  }
}, 180_000);

test('T21 PR lane counts a withheld exposure when the merge-base is unresolved', async () => {
  // P3-3: the pin failure carries its own distinct withheld reason (never
  // the record's "no reviewed base proof"), and the surface stays durable.
  const w = await world(false, { expectedHead: initial, failMergeBase: true });
  try {
    const result = await w.run();
    const report = result.status === 'ok' ? result.value : result.report!;
    const { reviews } = await reviewsOf(join(w.root, 'journal'));
    expect(reviews).toEqual([]);
    expect(report.reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: merge-base unresolved',
    });
    expect(report.observation?.status).toBe('durable');
  } finally {
    await w.cleanup();
  }
}, 180_000);

test('T21 PR lane abort paths count withheld re-reviews', async () => {
  // P1 PR equivalent: a failed re-review (no report) and an identity change
  // are counted withheld with distinct reasons; the PR-thread population
  // that already landed stays recorded, and /reviews reads partial.
  const w = await world(false, { expectedHead: initial, reviewOutcome: 'failed' });
  try {
    const result = await w.run();
    const report = result.status === 'ok' ? result.value : result.report!;
    const { reviews } = await reviewsOf(join(w.root, 'journal'));
    expect(reviews.map((payload) => [payload.source, payload.round])).toEqual([['pr-threads', 1]]);
    expect(report.reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: re-review returned no anchored head',
    });
  } finally {
    await w.cleanup();
  }

  const w2 = await world(false, { expectedHead: initial, reviewOutcome: 'wrong-head' });
  try {
    const result = await w2.run();
    const report = result.status === 'ok' ? result.value : result.report!;
    const { reviews } = await reviewsOf(join(w2.root, 'journal'));
    expect(reviews.map((payload) => [payload.source, payload.round])).toEqual([['pr-threads', 1]]);
    expect(report.reportV2?.availability['/reviews']).toMatchObject({
      state: 'partial',
      reason: '1 exposure(s) withheld: identity changed before the re-review was recorded',
    });
  } finally {
    await w2.cleanup();
  }
}, 240_000);
