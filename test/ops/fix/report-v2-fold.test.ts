// ADR-0008 T36: schema round-trip, unavailable evidence and report failure boundary.
// Fake fixtures only; no provider or network.
import { describe, expect, test } from 'vitest';
import { ReportV2Schema } from '../../../src/kernel/schema.js';
import { assembleReportV2, foldObservations } from '../../../src/ops/fix/reportFold.js';
import type { KernelRunDescriptor } from '../../../src/kernel/observation.js';
import type {
  AttemptFinishedJournalEvent,
  CompositionStartedJournalEvent,
  KernelRunLinkedJournalEvent,
  ObservationStream,
  RunStartedV3JournalEvent,
} from '../../../src/kernel/types.js';

const AT = '2026-01-03T04:05:06.789Z';
const BASE = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;
const WORK_ID = '3f2b8c1e-1111-4222-8333-444455556666';
const CR_ID = 'cr-2026-01-03T04.05.06Z';
const KERNEL_RUN = 'plan-x--k--a';
const PLAN_ID = 'plan-x';

const provenance = {
  cqVersion: '0.2.0',
  producerVersion: '0.2.0',
  repoId: null,
  cqJsonHash: HASH,
  baseSha: BASE,
  runPrefix: PLAN_ID,
  startedAt: AT,
  endedAt: null,
  journalLink: `runs/${KERNEL_RUN}.ndjson`,
  reportLink: `reports/${KERNEL_RUN}.json`,
  witnesses: { base: BASE, admitted: null, execution: null, reviewed: null, accepted: null },
};
const correlation = (workId = WORK_ID) => ({
  workId,
  parentWorkId: null,
  branch: 'feat/demo',
  commitSha: null,
  sessionId: null,
  agentId: null,
});

const header = (runId = CR_ID, workId = WORK_ID): CompositionStartedJournalEvent => ({
  type: 'composition-started',
  runId,
  at: AT,
  unitId: null,
  jobId: null,
  taskId: null,
  attempt: null,
  payload: { journalVersion: 3, provenance, correlation: correlation(workId) },
});

const linked = (runId = CR_ID): KernelRunLinkedJournalEvent => ({
  type: 'kernel-run-linked',
  runId,
  at: AT,
  unitId: null,
  jobId: null,
  taskId: null,
  attempt: null,
  payload: { kernelRunId: KERNEL_RUN, planId: PLAN_ID, round: 1 },
});

const attempt = (
  runId: string,
  envelope: Pick<AttemptFinishedJournalEvent, 'unitId' | 'jobId' | 'taskId' | 'attempt'>,
): AttemptFinishedJournalEvent => ({
  type: 'attempt-finished',
  runId,
  at: AT,
  ...envelope,
  payload: {
    tier: 'worker',
    invocation: 'fix',
    model: null,
    provider: 'fixture',
    requestedModel: 'scripted',
    servedModel: null,
    tokens: 10,
    usageChannels: { input: 6, output: 4 },
    requests: 1,
    wallMs: 5,
    modeledUsd: 0,
    priceTableRevision: 'fixture-v1',
    priceCoverage: null,
    stopReason: 'complete',
    stopCode: 'completed',
    class: 'terminal',
    error: null,
    timeout: null,
    budget: {
      allowed: { tokens: 1000, wallMs: 60_000 },
      spent: { tokens: 10, wallMs: 5 },
      remaining: { tokens: 990, wallMs: 59_995 },
    },
    availability: {},
  },
});

const stream = (
  events: ObservationStream['events'],
  runId = CR_ID,
  workId = WORK_ID,
  complete = true,
): ObservationStream => ({ workId, compositionRunId: runId, events, complete });

const descriptor = (
  runId = KERNEL_RUN,
  workId = WORK_ID,
  planId = PLAN_ID,
): KernelRunDescriptor => ({
  journalVersion: 3,
  runId,
  planId,
  header: {
    type: 'run-started',
    runId,
    at: AT,
    planId,
    journalVersion: 3,
    seq: 1,
    governance: { attended: false },
    provenance,
    correlation: correlation(workId),
    availability: {},
  } as RunStartedV3JournalEvent,
});

const frozen = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) frozen(item);
  }
  return value;
};

describe('report v2 fold (T36)', () => {
  test('T36 round-trip', () => {
    const events = [
      header(),
      linked(),
      attempt(CR_ID, { unitId: 'u', jobId: null, taskId: 't', attempt: 1 }),
    ];
    const streams = frozen([stream(events)]);
    const before = JSON.stringify(streams);
    const report = foldObservations({ streams, kernelRuns: [descriptor()], producer: 'fix' });
    expect(ReportV2Schema.parse(JSON.parse(JSON.stringify(report)))).toEqual(report);
    expect(report.provenance).toEqual(provenance);
    expect(report.correlation).toEqual(correlation());
    expect(report.attempts).toEqual([events[2]]);
    expect(report.attempts[0]).not.toBe(events[2]);
    expect(JSON.stringify(streams)).toBe(before);
    expect(report.availability['']?.state).toBe('known');
  });

  test('T36 unknown evidence', () => {
    const report = foldObservations({
      streams: [stream([header(), linked()], CR_ID, WORK_ID, false)],
      producer: 'address',
    });
    expect(report.availability['']?.state).toBe('partial');
    expect(report.availability['/attempts']?.state).toBe('partial');
    const provenanceRecord = report.availability['/provenance'];
    expect(provenanceRecord?.state).toBe('known');
    expect(provenanceRecord?.reason).toContain('composition header');
    expect(provenanceRecord?.source).toBeNull();
    expect(report.availability['/provenance/journalLink']?.reason).toContain('T04');
    expect(report.availability['/provenance/journalLink']?.reason).toContain(KERNEL_RUN);
    for (const record of Object.values(report.availability)) {
      expect(record.reason).not.toMatch(/[;,]\s*$/);
    }
    expect(report.acceptances).toEqual([]);
    expect(report.availability['/acceptances']?.state).toBe('unavailable');
    expect(report.availability['/acceptances']?.reason).toContain('T20');
    // T19 wires the address disposition producer, so a torn stream is partial
    // evidence here rather than the old "not wired" unavailable.
    expect(report.availability['/dispositions']?.state).toBe('partial');
    // T21 wires the address review-observed producer: same transition.
    expect(report.availability['/reviews']?.state).toBe('partial');
    expect(report.metric.fixesPerRun).toEqual({ numerator: null, denominator: null });
    for (const path of ['/tasks', '/gates', '/approvals', '/writeDecisions', '/metric']) {
      expect(report.availability[path]?.state).toBe('unavailable');
    }
    const torn = foldObservations({
      streams: [
        stream(
          [header(), attempt(CR_ID, { unitId: 'u', jobId: null, taskId: 't', attempt: 1 })],
          CR_ID,
          WORK_ID,
          false,
        ),
      ],
      producer: 'fix',
    });
    expect(torn.attempts).toHaveLength(1);
    expect(torn.availability['/attempts']?.state).toBe('partial');
    // T36 semantics are unchanged: a fix composition has NO disposition
    // producer, so a torn stream stays unavailable rather than becoming
    // "partial" evidence for a producer that does not exist.
    expect(torn.availability['/dispositions']).toMatchObject({
      state: 'unavailable',
      reason: 'the fix composition has no finding-disposition producer yet',
    });
    expect(torn.availability['/reviews']).toMatchObject({
      state: 'unavailable',
      reason: 'the fix composition has no review-observed producer',
    });
    const complete = [stream([header()])];
    expect(
      foldObservations({ streams: complete, producer: 'fix' }).availability['/dispositions'],
    ).toMatchObject({ state: 'unavailable' });
    expect(
      foldObservations({ streams: complete, producer: 'fix' }).availability['/reviews'],
    ).toMatchObject({ state: 'unavailable' });
    expect(
      foldObservations({ streams: complete, producer: 'fix' }).availability['/attempts']?.state,
    ).toBe('known-zero');
    expect(
      foldObservations({ streams: complete, producer: 'fix' }).availability['/attempts']?.reason,
    ).not.toContain('T14');
    expect(
      foldObservations({ streams: complete, producer: 'address' }).availability['/attempts']
        ?.reason,
    ).toContain('T14');
  });

  test('T36 failure boundary', () => {
    const valid = stream([header()]);
    const invalid = { ...valid, workId: 'wrong' };
    for (const streams of [[invalid], [valid, valid], []]) {
      const result = assembleReportV2({
        streams,
        header: header(),
        producer: 'fix',
        failureFree: true,
      });
      expect(result.availability.state).toBe('unavailable');
      expect(result.availability.reason).toContain('assembly unavailable');
      expect(ReportV2Schema.safeParse(result.reportV2).success).toBe(true);
      expect(result.reportV2?.availability['/attempts']?.state).toBe('unavailable');
      expect(result.reportV2?.attempts).toEqual([]);
    }
  });
});
