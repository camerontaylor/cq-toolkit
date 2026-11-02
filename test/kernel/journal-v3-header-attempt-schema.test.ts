// Journal v3 header + attempt schemas (ADR-0008, T25) — schema-only slice.
//
// Pinned here:
//   1. Round-trip: a v3 run-started header (journalVersion 3, the preserved
//      v2 envelope fields planId/seq plus exactly one governance marker, and
//      provenance/correlation/availability) and an attempt-finished event
//      parse through their standalone strict schemas byte-identically; old
//      v1/v2 run-started shapes stay readable through the existing v1/v2
//      union. No writer is enabled by this slice.
//   2. Unknown evidence: unknown future journalVersion, unknown availability
//      state and unknown event kinds fail explicitly; a v2 record
//      reclassified to version 3 fails the v3 schema (no additive sleight of
//      hand), and a v3 header with disagreeing baseSha/witnesses.base fails.
//   3. Failure boundary: strict extras rejection; the v1/v2 kernel RunLog
//      (JournalEventSchema, via append and read-back) must keep REJECTING both v3
//      carriers — strict v2 rejection of v3 (ADR acceptance); attempt-finished
//      and the v3 header are observation-stream carriers until T02 assembles
//      the v3 union and dual reader.
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now().
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  AttemptFinishedJournalEventSchema,
  JournalEventSchema,
  RunStartedV3JournalEventSchema,
} from '../../src/kernel/schema.js';
import type {
  AttemptFinishedJournalEvent,
  AttemptStopClass,
  AvailabilityState,
  JournalEvent,
  RunStartedV3JournalEvent,
} from '../../src/kernel/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
const AT_NO_MILLIS = '2026-01-03T04:05:06Z';
const BASE = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;

function header(overrides?: Partial<RunStartedV3JournalEvent>): RunStartedV3JournalEvent {
  return {
    type: 'run-started',
    runId: 'plan-x--k--a',
    at: AT,
    planId: 'plan-x',
    journalVersion: 3,
    seq: 1,
    governance: { attended: false },
    provenance: {
      cqVersion: '0.2.0',
      producerVersion: '0.2.0',
      repoId: null,
      cqJsonHash: HASH,
      baseSha: BASE,
      runPrefix: 'plan-x',
      startedAt: AT,
      endedAt: null,
      journalLink: 'runs/plan-x--k--a.ndjson',
      reportLink: 'reports/plan-x--k--a.json',
      witnesses: {
        base: BASE,
        admitted: null,
        execution: null,
        reviewed: null,
        accepted: null,
      },
    },
    correlation: {
      workId: '3f2b8c1e-1111-4222-8333-444455556666',
      parentWorkId: null,
      branch: 'feat/demo',
      commitSha: null,
      sessionId: null,
      agentId: null,
    },
    availability: {
      '/correlation/sessionId': { state: 'not-collected', reason: 'no session', source: null },
    },
    ...overrides,
  };
}

function attemptFinished(
  overrides?: Partial<AttemptFinishedJournalEvent>,
): AttemptFinishedJournalEvent {
  return {
    type: 'attempt-finished',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: 'unit-1',
    jobId: null,
    taskId: 'task-1',
    attempt: 1,
    payload: {
      tier: 'worker',
      invocation: 'plan-x--k--a:task-1:1',
      model: null,
      provider: 'anthropic',
      requestedModel: 'claude-sonnet',
      servedModel: null,
      tokens: null,
      usageChannels: {},
      requests: null,
      wallMs: 1500,
      modeledUsd: null,
      priceTableRevision: null,
      priceCoverage: null,
      stopReason: 'validation failed',
      stopCode: 'validation-failed',
      class: 'terminal',
      error: null,
      timeout: null,
      budget: {
        allowed: { tokens: 1000, wallMs: 60000 },
        spent: { tokens: 250, wallMs: 1500 },
        remaining: { tokens: 750, wallMs: 58500 },
      },
      availability: {},
    },
    ...overrides,
  };
}

describe('journal v3 header/attempt schemas (T25)', () => {
  test('T25 round-trip', () => {
    const h = header();
    expect(RunStartedV3JournalEventSchema.parse(h)).toEqual(h);

    const a = attemptFinished();
    expect(AttemptFinishedJournalEventSchema.parse(a)).toEqual(a);

    // Old versions stay readable through the existing strict union: a
    // v1-shaped run-started (no journalVersion) and a full v2 record parse
    // unchanged.
    const v1 = { type: 'run-started', runId: 'plan-x--k--a', at: AT, planId: 'plan-x' };
    expect(JournalEventSchema.parse(v1)).toEqual(v1);
    const v2 = {
      type: 'run-started',
      runId: 'plan-x--k--b',
      at: AT,
      planId: 'plan-x',
      journalVersion: 2,
      seq: 1,
      ungoverned: { optIn: true },
    };
    expect(JournalEventSchema.parse(v2)).toEqual(v2);
  });

  test('T25 unknown evidence', () => {
    // Unknown future journal version fails explicitly.
    const v4 = { ...header(), journalVersion: 4 };
    expect(RunStartedV3JournalEventSchema.safeParse(v4).success).toBe(false);
    // A v3 header cannot omit the version (an old v1 record is not a v3 one).
    expect(
      RunStartedV3JournalEventSchema.safeParse({
        ...header(),
        journalVersion: undefined,
      } as unknown as RunStartedV3JournalEvent).success,
    ).toBe(false);
    // A v2 run-started reclassified to version 3 fails: it lacks the v3-only
    // provenance/correlation/availability carriers (no additive sleight of
    // hand — strict schemas forbid it).
    const v2AsV3 = {
      type: 'run-started',
      runId: 'plan-x--k--c',
      at: AT,
      planId: 'plan-x',
      journalVersion: 3,
      seq: 1,
      ungoverned: { optIn: true },
    };
    expect(RunStartedV3JournalEventSchema.safeParse(v2AsV3).success).toBe(false);
    // Unknown availability state fails explicitly.
    const badAvailability = header({
      availability: {
        '/tokens': { state: 'somehow-partial' as AvailabilityState, reason: 'x', source: null },
      },
    });
    expect(RunStartedV3JournalEventSchema.safeParse(badAvailability).success).toBe(false);
    // A non-JSON-Pointer availability key fails (empty or leading '/' only).
    const badPointer = header({
      availability: {
        tokens: { state: 'not-collected', reason: 'x', source: null },
      },
    });
    expect(RunStartedV3JournalEventSchema.safeParse(badPointer).success).toBe(false);
    // A non-UUID workId fails (work ids are UUIDs, ADR-0008).
    const badWorkId = header();
    badWorkId.correlation.workId = 'not-a-uuid';
    expect(RunStartedV3JournalEventSchema.safeParse(badWorkId).success).toBe(false);
    // Unknown event kind fails explicitly on the v1/v2 union.
    expect(
      JournalEventSchema.safeParse({ type: 'attempt-started', runId: 'r', at: AT }).success,
    ).toBe(false);
    // Unknown stop class and malformed hash spelling fail.
    const badClass = attemptFinished();
    badClass.payload.class = 'flaky' as AttemptStopClass;
    expect(AttemptFinishedJournalEventSchema.safeParse(badClass).success).toBe(false);
    const badHash = header();
    badHash.provenance.cqJsonHash = 'b'.repeat(64);
    expect(RunStartedV3JournalEventSchema.safeParse(badHash).success).toBe(false);
    // Uppercase SHA is rejected (lowercase repository-native rule).
    const upperSha = header();
    upperSha.provenance.baseSha = BASE.toUpperCase();
    expect(RunStartedV3JournalEventSchema.safeParse(upperSha).success).toBe(false);
    // Seconds-only `at` fails on both v3 envelopes: UTC ISO-8601 WITH
    // milliseconds is the envelope rule (ADR-0008).
    expect(RunStartedV3JournalEventSchema.safeParse(header({ at: AT_NO_MILLIS })).success).toBe(
      false,
    );
    expect(
      AttemptFinishedJournalEventSchema.safeParse(attemptFinished({ at: AT_NO_MILLIS })).success,
    ).toBe(false);
  });

  test('T25 failure boundary', async () => {
    // Strict extras rejection on both new carriers.
    const extraHeader = header();
    (extraHeader as unknown as Record<string, unknown>).extra = 1;
    expect(RunStartedV3JournalEventSchema.safeParse(extraHeader).success).toBe(false);
    const extraAttempt = attemptFinished();
    (extraAttempt.payload as unknown as Record<string, unknown>).tokenCap = 1000;
    expect(AttemptFinishedJournalEventSchema.safeParse(extraAttempt).success).toBe(false);
    // No cap/used aliases on the budget block.
    const aliased = attemptFinished();
    (aliased.payload.budget.allowed as unknown as Record<string, unknown>).tokenCap = 1000;
    expect(AttemptFinishedJournalEventSchema.safeParse(aliased).success).toBe(false);
    // attempt is a positive integer.
    expect(
      AttemptFinishedJournalEventSchema.safeParse(attemptFinished({ attempt: 0 })).success,
    ).toBe(false);
    // Exactly-one governance coupling, as in v2.
    expect(
      RunStartedV3JournalEventSchema.safeParse({
        ...header(),
        ungoverned: { optIn: true },
      }).success,
    ).toBe(false);
    expect(
      RunStartedV3JournalEventSchema.safeParse({
        ...header(),
        governance: undefined,
      } as unknown as RunStartedV3JournalEvent).success,
    ).toBe(false);
    // The header's baseSha and witnesses.base must agree (ADR envelope rule).
    const disagreeing = header();
    disagreeing.provenance.witnesses.base = 'c'.repeat(40);
    expect(RunStartedV3JournalEventSchema.safeParse(disagreeing).success).toBe(false);

    // Strict v2 rejection of v3, directly on the union: both v3 carriers
    // fail JournalEventSchema (the schema behind append and the read-back).
    expect(JournalEventSchema.safeParse(header()).success).toBe(false);
    expect(JournalEventSchema.safeParse(attemptFinished()).success).toBe(false);

    // The kernel v1/v2 RunLog validates through JournalEventSchema (append
    // AND read-back), so both v3 carriers must fail there — attempt-finished
    // and the v3 header are observation-stream carriers until T02 assembles
    // the v3 union and dual reader. Old shapes still write and read back
    // unchanged.
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'jv3-t25-'));
      const log = openRunLog(dir);
      const v1 = { type: 'run-started', runId: 'plan-x--k--a', at: AT, planId: 'plan-x' };
      await log.append('plan-x--k--a', JournalEventSchema.parse(v1));
      await expect(
        log.append('plan-x--k--a', attemptFinished() as unknown as JournalEvent),
      ).rejects.toThrow();
      await expect(log.append('plan-x--k--a', header() as never)).rejects.toThrow();
      const read = await log.read('plan-x--k--a');
      expect(read).toEqual([v1]);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
