// Journal v3 gate/task/approval/write schemas (ADR-0008, T26) — schema-only slice.
//
// Pinned here:
//   1. Round-trip: gate-verdict, task-finished and the approval/write
//      observation carriers (including both RESERVED members
//      approval-expired and write-path-cap-tripped, which have no producer
//      at the pin) parse through their standalone strict schemas
//      byte-identically. No writer and no new enforcement is enabled.
//   2. Unknown evidence: unknown event kinds, unknown gate verdicts, raw
//      (unhashed) approval identifiers, non-lowercase SHAs, unknown
//      availability states and negative counts fail explicitly; a gate
//      event without the required non-null taskId fails.
//   3. Failure boundary: strict extras rejection (including cap/used
//      aliases); the v1/v2 kernel RunLog (JournalEventSchema, via append and
//      read-back) must keep REJECTING all four v3 carriers — strict v2
//      rejection of v3 (ADR acceptance); they are observation-stream
//      carriers until T02 assembles the v3 union and dual reader.
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now().
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  ApprovalJournalEventSchema,
  GateVerdictJournalEventSchema,
  JournalEventSchema,
  TaskFinishedJournalEventSchema,
  WriteObservationJournalEventSchema,
} from '../../src/kernel/schema.js';
import type {
  ApprovalJournalEvent,
  AvailabilityState,
  GateVerdictJournalEvent,
  JournalEvent,
  TaskFinishedJournalEvent,
  WriteObservationJournalEvent,
} from '../../src/kernel/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
const HASH = `sha256:${'b'.repeat(64)}`;

function gateVerdict(overrides?: Partial<GateVerdictJournalEvent>): GateVerdictJournalEvent {
  return {
    type: 'gate-verdict',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: 'unit-1',
    jobId: null,
    taskId: 'task-1',
    attempt: 1,
    payload: {
      gate: 'lint',
      verdict: 'fail',
      fingerprintVersion: null,
      availability: {},
    },
    ...overrides,
  };
}

function taskFinished(overrides?: Partial<TaskFinishedJournalEvent>): TaskFinishedJournalEvent {
  return {
    type: 'task-finished',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: 'unit-1',
    jobId: null,
    taskId: 'task-1',
    attempt: 1,
    payload: {
      taskId: 'task-1',
      changed: true,
      availability: {},
    },
    ...overrides,
  };
}

function approval(overrides?: Partial<ApprovalJournalEvent>): ApprovalJournalEvent {
  return {
    type: 'approval-granted',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: {
      approvalId: HASH,
      reason: 'lease admitted',
      availability: {},
    },
    ...overrides,
  };
}

function writeDenied(
  overrides?: Partial<WriteObservationJournalEvent>,
): WriteObservationJournalEvent {
  return {
    type: 'write-path-denied',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: 'unit-1',
    jobId: null,
    taskId: 'task-1',
    attempt: 1,
    payload: {
      path: 'src/index.ts',
      reason: 'path outside candidate scope',
      cap: null,
      observed: null,
      availability: {},
    },
    ...overrides,
  };
}

describe('journal v3 gate/task/approval/write schemas (T26)', () => {
  test('T26 round-trip', () => {
    const g = gateVerdict();
    expect(GateVerdictJournalEventSchema.parse(g)).toEqual(g);

    // bail omitted if absent; present bail round-trips too.
    const withBail = gateVerdict({ payload: { ...g.payload, bail: 'spawn failed' } });
    expect(GateVerdictJournalEventSchema.parse(withBail)).toEqual(withBail);

    const t = taskFinished();
    expect(TaskFinishedJournalEventSchema.parse(t)).toEqual(t);

    const a = approval();
    expect(ApprovalJournalEventSchema.parse(a)).toEqual(a);

    // approval-expired is a RESERVED schema member with no producer at the
    // pin; the schema keeps it parseable (ADR-0008).
    const expired = approval({ type: 'approval-expired' });
    expect(ApprovalJournalEventSchema.parse(expired)).toEqual(expired);

    const w = writeDenied();
    expect(WriteObservationJournalEventSchema.parse(w)).toEqual(w);

    // write-path-cap-tripped is likewise RESERVED with no producer.
    const capped = writeDenied({
      type: 'write-path-cap-tripped',
      payload: { ...w.payload, cap: 10, observed: 10 },
    });
    expect(WriteObservationJournalEventSchema.parse(capped)).toEqual(capped);
  });

  test('T26 unknown evidence', () => {
    // Unknown gate verdict fails explicitly (the I1-adjacent verdict enum is
    // exactly pass/fail/indeterminate/needs-human — never FLAKY).
    const flaky = gateVerdict();
    flaky.payload.verdict = 'flaky' as 'fail';
    expect(GateVerdictJournalEventSchema.safeParse(flaky).success).toBe(false);
    // Unknown event kinds fail.
    expect(
      GateVerdictJournalEventSchema.safeParse({ ...gateVerdict(), type: 'gate-started' }).success,
    ).toBe(false);
    expect(
      ApprovalJournalEventSchema.safeParse({ ...approval(), type: 'approval-requested' }).success,
    ).toBe(false);
    expect(
      WriteObservationJournalEventSchema.safeParse({
        ...writeDenied(),
        type: 'write-path-allowed',
      }).success,
    ).toBe(false);
    // Raw approval capability material is never carried: approvalId must be
    // the SHA-256 hash spelling.
    const raw = approval();
    raw.payload.approvalId = 'opaque-raw-token';
    expect(ApprovalJournalEventSchema.safeParse(raw).success).toBe(false);
    // Uppercase SHA is rejected (lowercase repository-native rule).
    const upper = approval();
    upper.payload.approvalId = `sha256:${'B'.repeat(64)}`;
    expect(ApprovalJournalEventSchema.safeParse(upper).success).toBe(false);
    // Unknown availability state fails.
    const badAvailability = gateVerdict();
    badAvailability.payload.availability = {
      '/fingerprintVersion': {
        state: 'somehow-partial' as AvailabilityState,
        reason: 'x',
        source: null,
      },
    };
    expect(GateVerdictJournalEventSchema.safeParse(badAvailability).success).toBe(false);
    // Negative count fails on the write carriers.
    const negative = writeDenied();
    negative.payload.observed = -1;
    expect(WriteObservationJournalEventSchema.safeParse(negative).success).toBe(false);
    // Gate/task events require non-null taskId (task/gate scope rule).
    expect(
      GateVerdictJournalEventSchema.safeParse({ ...gateVerdict(), taskId: null }).success,
    ).toBe(false);
    expect(
      TaskFinishedJournalEventSchema.safeParse({ ...taskFinished(), taskId: null }).success,
    ).toBe(false);
    // attempt is a positive integer there.
    expect(GateVerdictJournalEventSchema.safeParse(gateVerdict({ attempt: 0 })).success).toBe(
      false,
    );
  });

  test('T26 failure boundary', async () => {
    // Strict extras rejection on every carrier.
    const extraGate = gateVerdict();
    (extraGate as unknown as Record<string, unknown>).extra = 1;
    expect(GateVerdictJournalEventSchema.safeParse(extraGate).success).toBe(false);
    const extraApproval = approval();
    (extraApproval.payload as unknown as Record<string, unknown>).rawToken = 'x';
    expect(ApprovalJournalEventSchema.safeParse(extraApproval).success).toBe(false);
    // No cap/used aliases on the write payload.
    const aliased = writeDenied();
    (aliased.payload as unknown as Record<string, unknown>).capUsed = 1;
    expect(WriteObservationJournalEventSchema.safeParse(aliased).success).toBe(false);
    const aliasedTask = taskFinished();
    (aliasedTask.payload as unknown as Record<string, unknown>).outcome = 'fixed';
    expect(TaskFinishedJournalEventSchema.safeParse(aliasedTask).success).toBe(false);

    // Strict v2 rejection of v3, directly on the v1/v2 union: all four
    // carriers fail JournalEventSchema (the schema behind append and the
    // read-back).
    expect(JournalEventSchema.safeParse(gateVerdict()).success).toBe(false);
    expect(JournalEventSchema.safeParse(taskFinished()).success).toBe(false);
    expect(JournalEventSchema.safeParse(approval()).success).toBe(false);
    expect(JournalEventSchema.safeParse(writeDenied()).success).toBe(false);

    // The kernel v1/v2 RunLog validates through JournalEventSchema (append
    // AND read-back), so the carriers must fail there; old shapes still
    // write and read back unchanged.
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'jv3-t26-'));
      const log = openRunLog(dir);
      const v1 = { type: 'run-started', runId: 'plan-x--k--a', at: AT, planId: 'plan-x' };
      await log.append('plan-x--k--a', JournalEventSchema.parse(v1));
      await expect(
        log.append('plan-x--k--a', approval() as unknown as JournalEvent),
      ).rejects.toThrow();
      await expect(log.append('plan-x--k--a', gateVerdict() as never)).rejects.toThrow();
      const read = await log.read('plan-x--k--a');
      expect(read).toEqual([v1]);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
