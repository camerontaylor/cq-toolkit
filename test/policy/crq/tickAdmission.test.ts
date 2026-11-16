import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import type { CrqRecord } from '../../../src/policy/crq/receiptIdentity.js';
import {
  admissionDecision,
  heldReservations,
  scanReservations,
  type AdmissionConfig,
  type ReservationHold,
} from '../../../src/policy/crq/tickAdmission.js';
import { parseUtc } from '../../../src/policy/crq/utc.js';
import type { VendorUsage } from '../../../src/policy/crq/usageSlots.js';

/**
 * Differential replay of `tick-admission.json` plus the reservation scan the
 * vector's `reserved` list stands in for. The Python oracle is
 * `crq.admit_available` with its launch loop stubbed: the emitted value is the
 * oracle's own gate, admission count, remaining slots and log lines.
 */

interface AdmissionInput {
  readonly queue: CrqRecord;
  readonly usage: VendorUsage | null;
  readonly reserved: unknown[];
  readonly max_starts_per_hour: number;
  readonly max_starts_per_tick: number;
  readonly max_inflight: number;
  readonly now: string;
}

interface VectorCase {
  readonly name: string;
  readonly source: string;
  readonly input: AdmissionInput;
  readonly expect: { ok: true; value: AdmissionExpect } | { ok: false; error: string };
}

interface AdmissionExpect {
  readonly gate: string | null;
  readonly remaining: number;
  readonly start_attempts: number;
  readonly log: string[];
  readonly starts: number;
  readonly usage: VendorUsage | null;
  readonly backfill_starts_at_observation: number;
}

function cases(): VectorCase[] {
  const document = JSON.parse(
    readFileSync(
      new URL('../../../apps/crq-python/fixtures/group-p/tick-admission.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: VectorCase[] };
  return document.cases;
}

function heldFromInput(reserved: readonly unknown[]): ReservationHold[] {
  return reserved.map((startedAt) => ({ itemIndex: -1, runId: null, startedAt }));
}

function decide(input: AdmissionInput) {
  const now = parseUtc(input.now);
  if (now === null) throw new Error(`vector now is not a timestamp: ${input.now}`);
  const config: AdmissionConfig = {
    maxStartsPerHour: input.max_starts_per_hour,
    maxStartsPerTick: input.max_starts_per_tick,
    maxInflight: input.max_inflight,
  };
  return admissionDecision({
    queue: input.queue,
    usage: input.usage,
    held: heldFromInput(input.reserved),
    config,
    nowMicros: now.epochMicros,
  });
}

describe.each(cases())('tick-admission/$name', (vector) => {
  test('gate, admissions and log lines match the Python oracle', () => {
    expect(vector.expect.ok).toBe(true);
    if (!vector.expect.ok) return;
    const decision = decide(vector.input);
    expect(decision.gate).toBe(vector.expect.value.gate);
    expect(decision.log).toEqual(vector.expect.value.log);
    // Python's launch loop attempts exactly `admissions` starts when no gate
    // closes the tick, and none at all when one does.
    const attempted = decision.gate === null ? decision.admissions : 0;
    expect(attempted).toBe(vector.expect.value.start_attempts);
    // Python's `remaining` is `max(0, slots - spent)`, and the stub spends
    // exactly the starts it is asked for.
    expect(Math.max(0, decision.slots - attempted)).toBe(vector.expect.value.remaining);
  });
});

describe('reservation scan', () => {
  const queue: CrqRecord = {
    items: [
      {
        id: 'rev-progress',
        kind: 'open',
        state: 'reviewing',
        run: { run_id: 'run-progress', started_at: '2026-11-13T23:00:00Z' },
      },
      {
        id: 'rev-silent',
        kind: 'open',
        state: 'reviewing',
        run: { run_id: 'run-silent', started_at: '2026-11-13T23:05:00Z' },
      },
      {
        id: 'rev-observed',
        kind: 'open',
        state: 'reviewing',
        run: { run_id: 'run-observed', started_at: '2026-11-13T23:10:00Z', vendor_observed: true },
      },
      { id: 'retired', kind: 'promotion', state: 'reviewing', run: { run_id: 'run-promotion' } },
      { id: 'idle', kind: 'open', state: 'pending' },
    ],
  };

  test('separates observed progress from silent holds and skips reflected runs', () => {
    const scan = scanReservations(queue, (runId) => runId === 'run-progress');
    expect(scan.observed.map((entry) => entry.runId)).toEqual(['run-progress']);
    expect(scan.held.map((hold) => hold.runId)).toEqual(['run-silent']);
    expect(scan.held[0]?.startedAt).toBe('2026-11-13T23:05:00Z');
  });

  test('an unavailable usage snapshot folds observed holds back into the reservation', () => {
    const scan = scanReservations(queue, (runId) => runId === 'run-progress');
    expect(heldReservations(scan, null).map((hold) => hold.runId)).toEqual([
      'run-silent',
      'run-progress',
    ]);
    expect(heldReservations(scan, { remaining: 4 })).toBe(scan.held);
  });

  test('an undated hold is never reallocated by the hourly fallback', () => {
    const undated: CrqRecord = {
      items: [{ id: 'rev', kind: 'open', state: 'reviewing', run: { run_id: 'run-undated' } }],
    };
    const scan = scanReservations(undated, () => false);
    const now = parseUtc('2026-11-14T00:00:00Z');
    if (now === null) throw new Error('bad clock');
    const decision = admissionDecision({
      queue: undated,
      usage: null,
      held: heldReservations(scan, null),
      config: { maxStartsPerHour: 5, maxStartsPerTick: 10, maxInflight: 10 },
      nowMicros: now.epochMicros,
    });
    expect(decision.slots).toBe(4);
  });
});
