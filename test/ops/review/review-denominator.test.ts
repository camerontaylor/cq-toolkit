// ADR-0008 T21 — `review-observed`: retain reviewed head exposures
// (measurement slice M9).
//
// What is pinned here:
//   1. Round-trip: makeReviewAddress appends one review-observed event per
//      review source exposure — per source/head/round, never a last-head
//      overwrite (every round-1 population survives round 2's exposure) —
//      with the review scope, the initial blocking population and the
//      delivered/completed coverage of each vendor; foldObservations mirrors
//      them into report v2 `reviews` with `/reviews` known.
//   2. Unknown evidence: a legacy record without a reviewed base proof is
//      WITHHELD (an observation failure, never a fabricated base) while the
//      composition's own exposures still land; a source without coverage
//      proof reports vendorCompletion `unknown` with not-collected lists
//      (empty is unknown, never known-empty); legacy coverage contributes
//      receipt references and cannot prove omissions.
//   3. Failure boundary: an incomplete vendor is `not-completed` (a budget
//      session, a delivered-not-completed piece, an excluded piece and a
//      blocked sibling source are all recorded), and a failed review-observed
//      append marks the surface indeterminate without moving the verdict.
// Fake/local inputs only: no provider, no network, no credentials.
import { randomUUID } from 'node:crypto';
import { expect, test } from 'vitest';
import { makeReviewAddress } from '../../../src/ops/review/address.js';
import type { ReviewCoverageV2 } from '../../../src/ops/review/internal/reviewCoverageV2.js';
import type { ReviewSource } from '../../../src/ops/review/findings.js';
import { foldObservations } from '../../../src/ops/fix/reportFold.js';
import { ReportV2Schema } from '../../../src/kernel/schema.js';
import { openObservationWriter, readObservations } from '../../../src/kernel/observation.js';
import type { ObservationWriter } from '../../../src/kernel/observation.js';
import type { ObservationEvent, ReviewObservedPayload } from '../../../src/kernel/types.js';
import { fixture, reportOf } from './address.helpers.js';

const reviewEvents = (events: readonly ObservationEvent[]): ReviewObservedPayload[] =>
  events.flatMap((event) => (event.type === 'review-observed' ? [event.payload] : []));

const hash = (character: string) => character.repeat(64);

/** A v2 coverage fixture: one completed piece, one budget-stalled delivery, one exclusion. */
const incompleteCoverage = (head: string): ReviewCoverageV2 => ({
  version: 2,
  head,
  base: 'c'.repeat(40),
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

/** Legacy (v1) coverage: one whole-component partition, complete. */
const legacyCoverage = (head: string) => ({
  head,
  base: 'c'.repeat(40),
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

// ---- T21 round-trip -------------------------------------------------------

test('T21 round-trip', async () => {
  const f = await fixture();
  try {
    const result = await makeReviewAddress(f.deps)({ ...f.input, rounds: 2 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    expect(reportOf(result).stop).toBe('round-cap');

    const streams = await readObservations(f.input.journalDir);
    expect(streams).toHaveLength(1);
    const reviews = reviewEvents(streams[0]!.events);
    // Round 1's initial population, round 1's re-review and round 2's
    // re-review: every exposure of the head is retained — the round-2 event
    // never overwrote a round-1 population (the stream is append-only).
    expect(reviews.map((payload) => payload.round)).toEqual([1, 1, 2]);
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
      round: 1,
      coverage: 'none-recorded',
      findingFingerprints: [fingerprint],
      initialBlocking: [fingerprint],
      delivered: [],
      completed: [],
      omissions: [],
      vendorCompletion: 'unknown',
    });
    expect(Object.keys(reviews[0]!.availability).sort()).toEqual([
      '/completed',
      '/delivered',
      '/omissions',
    ]);
    // The re-review that found nothing reports a KNOWN-EMPTY population.
    expect(reviews[1]!.headSha).toBe(head);
    expect(reviews[1]!.initialBlocking).toEqual([]);

    // The T36 consumer folds every exposure into report v2.
    const folded = foldObservations({ streams, producer: 'address' });
    expect(folded.reviews).toEqual(reviews);
    expect(folded.availability['/reviews']).toMatchObject({ state: 'known' });
    expect(ReportV2Schema.parse(folded)).toEqual(folded);
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
    // scope row: the exposure is withheld with an observation failure — the
    // verdict is unchanged and nothing is fabricated.
    const { reviewed: _reviewed, ...legacy } = f.record();
    const result = await makeReviewAddress({ ...f.deps, initialRecord: legacy })({
      ...f.input,
      rounds: 2,
    });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const report = reportOf(result);
    expect(report.observation?.failure).toContain('no reviewed base proof');
    expect(report.observation?.status).toBe('indeterminate');
    const streams = await readObservations(f.input.journalDir);
    const reviews = reviewEvents(streams[0]!.events);
    // Only this composition's own exposures (the two re-reviews) landed; the
    // withheld initial population appears as no event at all.
    expect(reviews.map((payload) => payload.round)).toEqual([1, 2]);
    expect(reviews.some((payload) => payload.initialBlocking?.length)).toBe(false);
  } finally {
    await f.cleanup();
  }

  // Legacy coverage contributes receipt references and cannot prove omissions.
  const f2 = await fixture();
  try {
    const head = f2.record().head;
    const sources: ReviewSource[] = [
      { kind: 'agent', status: 'terminal', coverage: legacyCoverage(head) },
    ];
    const result = await makeReviewAddress({
      ...f2.deps,
      review: async () => ({ status: 'ok', value: { ...f2.record(), sources, findings: [] } }),
    })({ ...f2.input, rounds: 2 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const streams = await readObservations(f2.input.journalDir);
    const reviews = reviewEvents(streams[0]!.events);
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
}, 120_000);

// ---- T21 failure boundary -------------------------------------------------

test('T21 failure boundary', async () => {
  // An incomplete vendor is not-completed: a budget session, a delivered but
  // uncompleted piece and an excluded piece are all snapshot, and a blocked
  // sibling source is recorded too — never silently dropped or upgraded.
  const f = await fixture();
  try {
    const head = f.record().head;
    const sources: ReviewSource[] = [
      { kind: 'agent', status: 'terminal', coverage: incompleteCoverage(head) },
      { kind: 'coderabbit', status: 'blocked', reason: 'vendor auth refused' },
    ];
    const result = await makeReviewAddress({
      ...f.deps,
      review: async () => ({ status: 'ok', value: { ...f.record(), sources, findings: [] } }),
    })({ ...f.input, rounds: 1 });
    expect(result.status, JSON.stringify(result)).toBe('needs-human');
    const streams = await readObservations(f.input.journalDir);
    const reviews = reviewEvents(streams[0]!.events);
    // The initial exposure plus one event per refreshed source: the
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
