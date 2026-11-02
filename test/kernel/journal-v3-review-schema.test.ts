// Journal v3 disposition/acceptance/review schemas (ADR-0008, T27) —
// schema-only slice.
//
// Pinned here:
//   1. Round-trip: finding-disposition, head-acceptance and review-observed
//      carriers (including a deferred disposition with its required trigger
//      and a known-empty initialBlocking population) parse through their
//      standalone strict schemas byte-identically. No evidence importer and
//      no acceptance authority is added (T20 stays deferred).
//   2. Unknown evidence: unknown event kinds, unknown disposition statuses,
//      unknown acceptance verdicts, unknown vendorCompletion values,
//      non-lowercase SHAs, fingerprint version other than 1, unknown
//      availability states and a deferred disposition without a nonempty
//      reviewTrigger fail explicitly.
//   3. Failure boundary: strict extras rejection (including acceptance
//      aliases); the v1/v2 kernel RunLog (JournalEventSchema, via append and
//      read-back) must keep REJECTING all three v3 carriers — strict v2
//      rejection of v3 (ADR acceptance); they are observation-stream
//      carriers until T02 assembles the v3 union and dual reader.
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now().
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  FindingDispositionJournalEventSchema,
  HeadAcceptanceJournalEventSchema,
  JournalEventSchema,
  ReviewObservedJournalEventSchema,
} from '../../src/kernel/schema.js';
import type {
  AcceptancePayload,
  AvailabilityState,
  DispositionPayload,
  FindingDispositionJournalEvent,
  FindingFingerprint,
  HeadAcceptanceJournalEvent,
  JournalEvent,
  ReviewObservedJournalEvent,
  ReviewObservedPayload,
} from '../../src/kernel/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
const AT_NO_MILLIS = '2026-01-03T04:05:06Z';
const HASH = `sha256:${'b'.repeat(64)}`;
const HEAD = 'a'.repeat(40);
const BASE = 'c'.repeat(40);

const FINGERPRINT: FindingFingerprint = {
  version: 1,
  checkId: 'lint',
  rule: 'no-unused-vars',
  path: 'src/index.ts',
  spanContentHash: HASH,
};

function disposition(overrides?: Partial<DispositionPayload>): FindingDispositionJournalEvent {
  return {
    type: 'finding-disposition',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: 'unit-1',
    jobId: null,
    taskId: 'task-1',
    attempt: 1,
    payload: {
      fingerprint: FINGERPRINT,
      status: 'fixed',
      reason: 'addressed in commit',
      owner: 'reviewer-agent',
      evidence: ['evidence://commit/abc'],
      reviewTrigger: null,
      observedHead: HEAD,
      observedAt: AT,
      acceptedRisk: null,
      availability: {},
      ...overrides,
    },
  };
}

function acceptance(overrides?: Partial<AcceptancePayload>): HeadAcceptanceJournalEvent {
  return {
    type: 'head-acceptance',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: {
      headSha: HEAD,
      reviewedBaseSha: BASE,
      reviewerId: 'critic-agent',
      authorId: 'worker-agent',
      independent: true,
      verdict: 'PASS',
      evidence: ['evidence://review/123'],
      availability: {},
      ...overrides,
    },
  };
}

function review(overrides?: Partial<ReviewObservedPayload>): ReviewObservedJournalEvent {
  return {
    type: 'review-observed',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: 'unit-1',
    jobId: null,
    taskId: null,
    attempt: null,
    payload: {
      baseSha: BASE,
      headSha: HEAD,
      findingFingerprints: [FINGERPRINT],
      coverage: 'full diff',
      initialBlocking: [FINGERPRINT],
      reviewerId: 'critic-agent',
      source: 'coderabbit-cli',
      round: 1,
      delivered: ['src/index.ts'],
      completed: ['src/index.ts'],
      omissions: [],
      vendorCompletion: 'completed',
      availability: {},
      ...overrides,
    },
  };
}

describe('journal v3 disposition/acceptance/review schemas (T27)', () => {
  test('T27 round-trip', () => {
    const d = disposition();
    expect(FindingDispositionJournalEventSchema.parse(d)).toEqual(d);

    // Deferred requires a nonempty reviewTrigger; it round-trips.
    const deferred = disposition({
      status: 'deferred',
      reviewTrigger: 're-review after ADR merge',
    });
    expect(FindingDispositionJournalEventSchema.parse(deferred)).toEqual(deferred);

    // A rejected disposition can carry an accepted risk.
    const rejected = disposition({
      status: 'rejected',
      acceptedRisk: 'test-only log line',
    });
    expect(FindingDispositionJournalEventSchema.parse(rejected)).toEqual(rejected);

    const a = acceptance();
    expect(HeadAcceptanceJournalEventSchema.parse(a)).toEqual(a);

    // HOLD and RETRACT verdicts parse too.
    const hold = acceptance({ verdict: 'HOLD' });
    expect(HeadAcceptanceJournalEventSchema.parse(hold)).toEqual(hold);
    const retract = acceptance({ verdict: 'RETRACT' });
    expect(HeadAcceptanceJournalEventSchema.parse(retract)).toEqual(retract);

    const r = review();
    expect(ReviewObservedJournalEventSchema.parse(r)).toEqual(r);

    // A run-level disposition (all scope fields null) parses too.
    const runLevel = disposition();
    runLevel.unitId = null;
    runLevel.jobId = null;
    runLevel.taskId = null;
    runLevel.attempt = null;
    expect(FindingDispositionJournalEventSchema.parse(runLevel)).toEqual(runLevel);

    // Empty population only when known empty; null when unknown.
    const knownEmpty = review({ initialBlocking: [] });
    expect(ReviewObservedJournalEventSchema.parse(knownEmpty)).toEqual(knownEmpty);
    const unknown = review({
      initialBlocking: null,
      vendorCompletion: 'unknown',
    });
    expect(ReviewObservedJournalEventSchema.parse(unknown)).toEqual(unknown);
  });

  test('T27 unknown evidence', () => {
    // Unknown disposition status fails explicitly.
    const skipped = disposition();
    skipped.payload.status = 'skipped' as 'fixed';
    expect(FindingDispositionJournalEventSchema.safeParse(skipped).success).toBe(false);
    // Unknown acceptance verdict fails (exactly PASS/HOLD/RETRACT).
    const rubber = acceptance();
    rubber.payload.verdict = 'RUBBER-STAMP' as 'PASS';
    expect(HeadAcceptanceJournalEventSchema.safeParse(rubber).success).toBe(false);
    // Unknown vendorCompletion fails.
    const mystery = review();
    mystery.payload.vendorCompletion = 'probably' as 'completed';
    expect(ReviewObservedJournalEventSchema.safeParse(mystery).success).toBe(false);
    // Unknown event kinds fail.
    expect(
      FindingDispositionJournalEventSchema.safeParse({
        ...disposition(),
        type: 'finding-resurrection',
      }).success,
    ).toBe(false);
    expect(
      HeadAcceptanceJournalEventSchema.safeParse({ ...acceptance(), type: 'head-passed' }).success,
    ).toBe(false);
    expect(
      ReviewObservedJournalEventSchema.safeParse({ ...review(), type: 'review-skipped' }).success,
    ).toBe(false);
    // Fingerprint identity is versioned: version other than 1 fails.
    const v2 = disposition();
    v2.payload.fingerprint = { ...FINGERPRINT, version: 2 as 1 };
    expect(FindingDispositionJournalEventSchema.safeParse(v2).success).toBe(false);
    // Unprovable span content stays unknown (null) — never a guessed line.
    const unknownSpan = disposition({
      fingerprint: { ...FINGERPRINT, spanContentHash: null },
    });
    expect(FindingDispositionJournalEventSchema.safeParse(unknownSpan).success).toBe(true);
    // spanContentHash spelling is exact: uppercase hex, missing sha256:
    // prefix and truncated digests all fail.
    for (const badSpan of [
      `sha256:${'B'.repeat(64)}`,
      'b'.repeat(64),
      `sha256:${'b'.repeat(63)}`,
    ]) {
      const badSpanDisposition = disposition({
        fingerprint: { ...FINGERPRINT, spanContentHash: badSpan },
      });
      expect(FindingDispositionJournalEventSchema.safeParse(badSpanDisposition).success).toBe(
        false,
      );
    }
    // Fingerprint version propagates into review populations: version 2 is
    // rejected there too (different versions never silently match).
    const v2Review = review({
      findingFingerprints: [{ ...FINGERPRINT, version: 2 as 1 }],
    });
    expect(ReviewObservedJournalEventSchema.safeParse(v2Review).success).toBe(false);
    // Uppercase SHA is rejected (lowercase repository-native rule).
    const upperHead = acceptance();
    upperHead.payload.headSha = HEAD.toUpperCase();
    expect(HeadAcceptanceJournalEventSchema.safeParse(upperHead).success).toBe(false);
    const upperObserved = disposition();
    upperObserved.payload.observedHead = HEAD.toUpperCase();
    expect(FindingDispositionJournalEventSchema.safeParse(upperObserved).success).toBe(false);
    // Uppercase reviewedBaseSha and review baseSha/headSha are rejected too
    // (all SHA fields share the lowercase rule).
    const upperBaseAcceptance = acceptance();
    upperBaseAcceptance.payload.reviewedBaseSha = BASE.toUpperCase();
    expect(HeadAcceptanceJournalEventSchema.safeParse(upperBaseAcceptance).success).toBe(false);
    const upperReviewBase = review();
    upperReviewBase.payload.baseSha = BASE.toUpperCase();
    expect(ReviewObservedJournalEventSchema.safeParse(upperReviewBase).success).toBe(false);
    const upperReviewHead = review();
    upperReviewHead.payload.headSha = HEAD.toUpperCase();
    expect(ReviewObservedJournalEventSchema.safeParse(upperReviewHead).success).toBe(false);
    // A deferred disposition without a nonempty reviewTrigger fails.
    expect(
      FindingDispositionJournalEventSchema.safeParse(disposition({ status: 'deferred' })).success,
    ).toBe(false);
    expect(
      FindingDispositionJournalEventSchema.safeParse(
        disposition({ status: 'deferred', reviewTrigger: null }),
      ).success,
    ).toBe(false);
    expect(
      FindingDispositionJournalEventSchema.safeParse(
        disposition({ status: 'deferred', reviewTrigger: '' }),
      ).success,
    ).toBe(false);
    // attempt is a positive integer where present: zero fails.
    expect(
      FindingDispositionJournalEventSchema.safeParse({ ...disposition(), attempt: 0 }).success,
    ).toBe(false);
    expect(
      HeadAcceptanceJournalEventSchema.safeParse({ ...acceptance(), attempt: 0 }).success,
    ).toBe(false);
    // Unknown availability state fails.
    const badAvailability = acceptance();
    badAvailability.payload.availability = {
      '/independent': {
        state: 'assumed' as AvailabilityState,
        reason: 'x',
        source: null,
      },
    };
    expect(HeadAcceptanceJournalEventSchema.safeParse(badAvailability).success).toBe(false);
    // Seconds-only `at` fails on every v3 envelope: UTC ISO-8601 WITH
    // milliseconds is the envelope rule.
    for (const at of [
      {
        schema: FindingDispositionJournalEventSchema,
        event: disposition({ observedAt: AT_NO_MILLIS }),
      },
      {
        schema: FindingDispositionJournalEventSchema,
        event: { ...disposition(), at: AT_NO_MILLIS },
      },
      { schema: HeadAcceptanceJournalEventSchema, event: { ...acceptance(), at: AT_NO_MILLIS } },
      { schema: ReviewObservedJournalEventSchema, event: { ...review(), at: AT_NO_MILLIS } },
    ] as const) {
      expect(at.schema.safeParse(at.event).success).toBe(false);
    }
  });

  test('T27 failure boundary', async () => {
    // Strict extras rejection on every carrier.
    const extraDisposition = disposition();
    (extraDisposition as unknown as Record<string, unknown>).extra = 1;
    expect(FindingDispositionJournalEventSchema.safeParse(extraDisposition).success).toBe(false);
    const extraFingerprint = disposition();
    (extraFingerprint.payload.fingerprint as unknown as Record<string, unknown>).line = 3;
    expect(FindingDispositionJournalEventSchema.safeParse(extraFingerprint).success).toBe(false);
    // No acceptance aliases: the payload is exact.
    const aliasedAcceptance = acceptance();
    (aliasedAcceptance.payload as unknown as Record<string, unknown>).staleHead = HEAD;
    expect(HeadAcceptanceJournalEventSchema.safeParse(aliasedAcceptance).success).toBe(false);
    const aliasedReview = review();
    (aliasedReview.payload as unknown as Record<string, unknown>).findings = [];
    expect(ReviewObservedJournalEventSchema.safeParse(aliasedReview).success).toBe(false);

    // Strict v2 rejection of v3, directly on the v1/v2 union: all three v3
    // carriers fail JournalEventSchema (the schema behind append and the
    // read-back).
    const variants = [disposition(), acceptance(), review()] as const;
    for (const variant of variants) {
      expect(JournalEventSchema.safeParse(variant).success).toBe(false);
    }

    // The kernel v1/v2 RunLog validates through JournalEventSchema (append
    // AND read-back), so every variant must fail there; old shapes still
    // write and read back unchanged.
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'jv3-t27-'));
      const log = openRunLog(dir);
      const v1 = { type: 'run-started', runId: 'plan-x--k--a', at: AT, planId: 'plan-x' };
      await log.append('plan-x--k--a', JournalEventSchema.parse(v1));
      for (const variant of variants) {
        await expect(
          log.append('plan-x--k--a', variant as unknown as JournalEvent),
        ).rejects.toThrow();
      }
      const read = await log.read('plan-x--k--a');
      expect(read).toEqual([v1]);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
