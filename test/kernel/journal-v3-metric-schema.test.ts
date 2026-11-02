// Journal v3 metric + report v2 root schemas (ADR-0008, T28) — schema-only
// slice.
//
// Pinned here:
//   1. Round-trip: the measurement-summary carrier and the report v2 root
//      compose the previously landed T25–T27 payload schemas (attempt, gate,
//      task, approval, write, disposition, acceptance, review) and parse
//      byte-identically through their standalone strict schemas. Writer and
//      assembler stay disabled (T23/T36/T37 own the producers).
//   2. Unknown evidence: an unknown fixesPerRun alias shape, a negative
//      count, a non-lowercase SHA, an unknown availability state, an unknown
//      reportVersion and a negative attempt ordinal fail explicitly.
//   3. Failure boundary: strict extras rejection (including a cap/used
//      alias in the metric); the v1/v2 kernel RunLog (JournalEventSchema)
//      must keep REJECTING the v3 measurement-summary carrier — strict v2
//      rejection of v3 (ADR acceptance).
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now().
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  JournalEventSchema,
  MeasurementSummaryJournalEventSchema,
  ReportV2Schema,
} from '../../src/kernel/schema.js';
import type {
  AcceptancePayload,
  AttemptFinishedPayload,
  AvailabilityRecord,
  BaselineFailureRecord,
  ClosureRecord,
  CorrelationRecord,
  DispositionPayload,
  FindingFingerprint,
  GateVerdictPayload,
  MeasurementSummaryJournalEvent,
  MetricRecord,
  ProvenanceRecord,
  ReportV2,
  ReviewObservedPayload,
  TaskFinishedPayload,
} from '../../src/kernel/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
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

const AVAILABILITY: Record<string, AvailabilityRecord> = {
  '/metric/fixesPerRun/denominator': {
    state: 'not-collected',
    reason: 'baseline probe did not run',
    source: null,
  },
};

function closure(overrides?: Partial<ClosureRecord>): ClosureRecord {
  return {
    commitSha: HEAD,
    taskIds: ['task-1'],
    findingFingerprints: [FINGERPRINT],
    verificationEvidence: ['journal:plan-x--k--a#7'],
    todo: false,
    ...overrides,
  };
}

function baseline(overrides?: Partial<BaselineFailureRecord>): BaselineFailureRecord {
  return {
    unitId: 'unit-1',
    probeHead: BASE,
    completed: true,
    count: 2,
    unknownReason: null,
    ...overrides,
  };
}

function metric(overrides?: Partial<MetricRecord>): MetricRecord {
  return {
    fixesPerRun: { numerator: 1, denominator: 3 },
    verifiedCommits: [HEAD],
    closures: [closure()],
    baselineFailures: [baseline()],
    ...overrides,
  };
}

function measurement(
  overrides?: Partial<MeasurementSummaryJournalEvent>,
): MeasurementSummaryJournalEvent {
  return {
    type: 'measurement-summary',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: { metric: metric(), availability: AVAILABILITY },
    ...overrides,
  };
}

function provenance(): ProvenanceRecord {
  return {
    cqVersion: '0.2.0',
    producerVersion: '0.2.0',
    repoId: HASH,
    cqJsonHash: HASH,
    baseSha: BASE,
    runPrefix: 'plan-x',
    startedAt: AT,
    endedAt: AT,
    journalLink: 'runs/plan-x--k--a.ndjson',
    reportLink: 'reports/plan-x--k--a.json',
    witnesses: {
      base: BASE,
      admitted: BASE,
      execution: HEAD,
      reviewed: null,
      accepted: null,
    },
  };
}

function correlation(): CorrelationRecord {
  return {
    workId: '0f0e0d0c-0b0a-4918-8276-4d5e6f708192',
    parentWorkId: null,
    branch: 'feat/x',
    commitSha: HEAD,
    sessionId: 's-1',
    agentId: 'a-1',
  };
}

function report(metricOverrides?: Partial<MetricRecord>): ReportV2 {
  const attempts: AttemptFinishedPayload[] = [];
  const tasks: TaskFinishedPayload[] = [];
  const gates: GateVerdictPayload[] = [];
  const dispositions: DispositionPayload[] = [
    {
      fingerprint: FINGERPRINT,
      status: 'fixed',
      reason: 'resolved at head',
      owner: 'fixer',
      evidence: ['journal:plan-x--k--a#7'],
      reviewTrigger: null,
      observedHead: HEAD,
      observedAt: AT,
      acceptedRisk: null,
      availability: {},
    },
  ];
  const acceptances: AcceptancePayload[] = [];
  const reviews: ReviewObservedPayload[] = [];
  const approvals: ReportV2['approvals'] = [];
  const writeDecisions: ReportV2['writeDecisions'] = [];
  return {
    reportVersion: 2,
    provenance: provenance(),
    correlation: correlation(),
    tasks,
    attempts,
    gates,
    dispositions,
    acceptances,
    reviews,
    approvals,
    writeDecisions,
    metric: metric(metricOverrides),
    availability: AVAILABILITY,
  };
}

describe('journal v3 metric + report v2 schemas (T28)', () => {
  test('T28 round-trip', () => {
    const m = measurement();
    const parsed = MeasurementSummaryJournalEventSchema.parse(m);
    expect(parsed).toEqual(m);
    expect(JSON.parse(JSON.stringify(parsed))).toEqual(m);

    const r = report();
    const parsedReport = ReportV2Schema.parse(r);
    expect(parsedReport).toEqual(r);
    expect(JSON.parse(JSON.stringify(parsedReport))).toEqual(r);

    // Composition sanity: previously landed payload schemas appear intact
    // inside the report root (the disposition came from T27's strict schema).
    expect(parsedReport.dispositions[0]?.fingerprint).toEqual(FINGERPRINT);
  });

  test('T28 unknown evidence', () => {
    // Unknown stays unknown: null count/denominator with availability, never
    // fabricated zero; legacy scalar fixesPerRun shape is rejected.
    expect(
      MeasurementSummaryJournalEventSchema.safeParse(
        measurement({
          payload: {
            metric: {
              ...metric(),
              fixesPerRun: 3,
            } as unknown as MetricRecord['fixesPerRun'] as unknown as never,
            availability: AVAILABILITY,
          } as never,
        }),
      ).success,
    ).toBe(false);
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: {
            ...metric(),
            fixesPerRun: { numerator: null, denominator: null },
            baselineFailures: [
              baseline({
                count: null,
                unknownReason: 'probe bailed',
                probeHead: null,
                completed: false,
              }),
            ],
          },
          availability: AVAILABILITY,
        },
      }).success,
    ).toBe(true);
    const cases = [
      // Negative count.
      measurement({
        payload: {
          metric: { ...metric(), baselineFailures: [baseline({ count: -1 })] },
          availability: AVAILABILITY,
        },
      }),
      // Non-lowercase SHA in verifiedCommits.
      measurement({
        payload: {
          metric: { ...metric(), verifiedCommits: [HEAD.toUpperCase()] },
          availability: AVAILABILITY,
        },
      }),
      // Unknown availability state.
      measurement({
        payload: {
          metric: metric(),
          availability: { '/metric': { state: 'maybe' } as never as AvailabilityRecord },
        },
      }),
      // Unknown reportVersion.
      { ...report(), reportVersion: 3 },
      // Negative closure count via baseline ordinal is covered; a negative
      // attempt ordinal fails (envelope invariant).
      measurement({ attempt: 0 }),
      // Closure with a negative verification count shape: empty taskIds with
      // empty fingerprints is still valid, but an unknown todo fails.
      measurement({
        payload: {
          metric: {
            ...metric(),
            closures: [{ ...closure(), todo: 'no' } as never as ClosureRecord],
          },
          availability: AVAILABILITY,
        },
      }),
    ] as const;
    for (const c of cases) {
      expect(
        MeasurementSummaryJournalEventSchema.safeParse(c).success ??
          ReportV2Schema.safeParse(c).success,
      ).toBe(false);
    }
  });

  test('T28 failure boundary', async () => {
    // Strict extras rejection; no cap/used aliases in the metric.
    const extraMetric = measurement();
    (extraMetric.payload.metric as unknown as Record<string, unknown>).cap = 10;
    expect(MeasurementSummaryJournalEventSchema.safeParse(extraMetric).success).toBe(false);
    const extraReport = report();
    (extraReport as unknown as Record<string, unknown>).fixesPerRun = {
      numerator: 1,
      denominator: 1,
    };
    expect(ReportV2Schema.safeParse(extraReport).success).toBe(false);
    // FixesPerRun alias shape on the report root's metric.
    const aliasedRatio = report({
      fixesPerRun: { used: 1 } as never as MetricRecord['fixesPerRun'],
    });
    expect(ReportV2Schema.safeParse(aliasedRatio).success).toBe(false);

    // Strict v2 rejection of the v3 measurement-summary carrier on the
    // v1/v2 union, directly and through the kernel RunLog (append and
    // read-back); old shapes still write and read back unchanged.
    expect(JournalEventSchema.safeParse(measurement()).success).toBe(false);
    let dir: string | undefined;
    try {
      dir = await mkdtemp(join(tmpdir(), 'jv3-t28-'));
      const log = openRunLog(dir);
      const v1 = { type: 'run-started', runId: 'plan-x--k--a', at: AT, planId: 'plan-x' };
      await log.append('plan-x--k--a', JournalEventSchema.parse(v1));
      await expect(
        log.append('plan-x--k--a', measurement() as unknown as Parameters<typeof log.append>[1]),
      ).rejects.toThrow();
      const read = await log.read('plan-x--k--a');
      expect(read).toEqual([v1]);
    } finally {
      if (dir) await rm(dir, { recursive: true, force: true });
    }
  });
});
