// Journal v3 header + attempt schemas (ADR-0008, T25) — schema-only slice.
//
// Pinned here:
//   1. Round-trip: a v3 run-started header (journalVersion 3, provenance,
//      correlation, availability) and an attempt-finished event parse via the
//      discriminated union and come back byte-identical; old v1/v2 run-started
//      shapes stay readable through the same union (no writer is enabled by
//      this slice — schema only).
//   2. Unknown evidence: unknown future journalVersion and unknown event
//      kinds fail explicitly; a v3 header with an unknown availability state
//      or a v2 run-started reclassified to version 3 fails.
//   3. Failure boundary: strict extras rejection and the schema-only writer
//      rule — the v3 schemas are parseable but the existing v2 writer path
//      (openRunLog append with the frozen v2 run-started) is untouched, and
//      append still validates through the union (a v3 header would only be
//      writable by the future v3 writer, which this slice does not add).
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
  RunStartedV3JournalEvent,
} from '../../src/kernel/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
const BASE = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;

function header(overrides?: Partial<RunStartedV3JournalEvent>): RunStartedV3JournalEvent {
  return {
    type: 'run-started',
    runId: 'plan-x--k--a',
    at: AT,
    journalVersion: 3,
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
    expect(JournalEventSchema.parse(a)).toEqual(a);

    // Old versions stay readable through the same strict union: a v1-shaped
    // run-started (no journalVersion) and a full v2 record parse unchanged.
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
    // Unknown future journal version fails explicitly (the v3 header is its
    // own strict schema; T02's reader will dispatch run-started by version).
    const v4 = { ...header(), journalVersion: 4 };
    expect(RunStartedV3JournalEventSchema.safeParse(v4).success).toBe(false);
    // A v3 header cannot omit the version (an old v1 record is not a v3 one).
    expect(
      RunStartedV3JournalEventSchema.safeParse({ ...header(), journalVersion: undefined }).success,
    ).toBe(false);
    // Unknown availability state fails explicitly.
    const badAvailability = header({
      availability: {
        '/tokens': { state: 'somehow-partial' as AvailabilityState, reason: 'x', source: null },
      },
    });
    expect(RunStartedV3JournalEventSchema.safeParse(badAvailability).success).toBe(false);
    // Unknown event kind fails explicitly.
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

    // Writer disabled: the v2 append path is untouched. Appending a v2
    // run-started still validates and persists; nothing in this slice writes
    // v3 (schema-only).
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'jv3-t25-'));
      const log = openRunLog(dir);
      const v1 = { type: 'run-started', runId: 'plan-x--k--a', at: AT, planId: 'plan-x' };
      await log.append('plan-x--k--a', JournalEventSchema.parse(v1));
      const read = await log.read('plan-x--k--a');
      expect(read).toEqual([v1]);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
