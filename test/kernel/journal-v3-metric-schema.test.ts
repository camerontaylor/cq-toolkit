// Journal v3 metric + report v2 root schemas (ADR-0008, T28) — schema-only
// slice.
//
// Pinned here:
//   1. Round-trip: the measurement-summary carrier and the report v2 root
//      compose the previously landed T25–T27 carrier/payload schemas (report
//      attempts/gates/approvals/writeDecisions mirror the full journal
//      ENVELOPE + payload per ADR-0008 registry rows 199/202/203/204;
//      tasks/dispositions/acceptances/reviews are payload-only) and parse
//      byte-identically through their standalone strict schemas. Writer and
//      assembler stay disabled (T23/T36/T37 own the producers).
//   2. Unknown evidence: null metric values without availability, an unknown
//      denominator with an unknown baseline count, non-unique or non-projected
//      verifiedCommits, unknown availability states, unknown reportVersion,
//      payload-only envelope rows, bad JSON Pointers, non-uuid correlation and
//      non-lowercase SHAs fail explicitly.
//   3. Failure boundary: strict extras rejection (including cap/used aliases
//      in the metric); the v1/v2 kernel RunLog (JournalEventSchema) must keep
//      REJECTING the v3 measurement-summary carrier — strict v2 rejection of
//      v3 (ADR acceptance).
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now().
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  JournalEventSchema,
  JournalEventV1V2Schema,
  MeasurementSummaryJournalEventSchema,
  ReportV2Schema,
} from '../../src/kernel/schema.js';
import type {
  AcceptancePayload,
  ApprovalJournalEvent,
  AttemptFinishedJournalEvent,
  AvailabilityRecord,
  BaselineFailureRecord,
  ClosureRecord,
  CorrelationRecord,
  DispositionPayload,
  FindingFingerprint,
  GateVerdictJournalEvent,
  MeasurementSummaryJournalEvent,
  MetricRecord,
  ProvenanceRecord,
  ReportV2,
  ReviewObservedPayload,
  TaskFinishedPayload,
  WriteObservationJournalEvent,
} from '../../src/kernel/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
const HASH = `sha256:${'b'.repeat(64)}`;
const HEAD = 'a'.repeat(40);
const HEAD2 = 'd'.repeat(40);
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

function envelopeApproval(): ApprovalJournalEvent {
  return {
    type: 'approval-granted',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: { approvalId: HASH, reason: 'lease granted', availability: {} },
  };
}

function envelopeAttempt(): AttemptFinishedJournalEvent {
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
      invocation: 'inv-1',
      model: null,
      provider: 'fake',
      requestedModel: 'fake-model',
      servedModel: null,
      tokens: null,
      usageChannels: {},
      requests: null,
      wallMs: 100,
      modeledUsd: null,
      priceTableRevision: null,
      priceCoverage: null,
      stopReason: 'done',
      stopCode: 'completed',
      class: 'terminal',
      error: null,
      timeout: null,
      budget: {
        allowed: { tokens: null, wallMs: null },
        spent: { tokens: null, wallMs: null },
        remaining: { tokens: null, wallMs: null },
      },
      availability: {},
    },
  };
}

function envelopeGate(): GateVerdictJournalEvent {
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
      verdict: 'pass',
      fingerprintVersion: null,
      availability: {},
    },
  };
}

function envelopeWrite(): WriteObservationJournalEvent {
  return {
    type: 'write-path-denied',
    runId: 'plan-x--k--a',
    at: AT,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: { path: 'src/x.ts', reason: 'denied', cap: null, observed: null, availability: {} },
  };
}

function report(metricOverrides?: Partial<MetricRecord>): ReportV2 {
  const tasks: TaskFinishedPayload[] = [{ taskId: 'task-1', changed: true, availability: {} }];
  const attempts: AttemptFinishedJournalEvent[] = [envelopeAttempt()];
  const gates: GateVerdictJournalEvent[] = [envelopeGate()];
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
  const acceptances: AcceptancePayload[] = [
    {
      headSha: HEAD,
      reviewedBaseSha: BASE,
      reviewerId: 'critic',
      authorId: 'author',
      independent: true,
      verdict: 'PASS',
      evidence: ['pr:819'],
      availability: {},
    },
  ];
  const reviews: ReviewObservedPayload[] = [
    {
      baseSha: BASE,
      headSha: HEAD,
      findingFingerprints: [],
      coverage: 'full',
      initialBlocking: null,
      reviewerId: 'critic',
      source: 'coderabbit',
      round: 1,
      delivered: [],
      completed: [],
      omissions: [],
      vendorCompletion: 'unknown',
      availability: {},
    },
  ];
  const approvals: ApprovalJournalEvent[] = [envelopeApproval()];
  const writeDecisions: WriteObservationJournalEvent[] = [envelopeWrite()];
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

    // One valid row in EVERY report array: tasks, attempts, gates,
    // dispositions, acceptances, reviews, approvals, writeDecisions.
    const r = report();
    const parsedReport = ReportV2Schema.parse(r);
    expect(parsedReport).toEqual(r);
    expect(JSON.parse(JSON.stringify(parsedReport))).toEqual(r);
    expect(parsedReport.tasks[0]?.taskId).toBe('task-1');
    expect(parsedReport.attempts[0]?.type).toBe('attempt-finished');
    expect(parsedReport.gates[0]?.type).toBe('gate-verdict');
    expect(parsedReport.dispositions[0]?.fingerprint).toEqual(FINGERPRINT);
    expect(parsedReport.acceptances[0]?.verdict).toBe('PASS');
    expect(parsedReport.reviews[0]?.round).toBe(1);
    expect(parsedReport.approvals[0]?.type).toBe('approval-granted');
    expect(parsedReport.writeDecisions[0]?.type).toBe('write-path-denied');
  });

  test('T28 unknown evidence', () => {
    // Unknown stays unknown: null with availability parses; the legacy scalar
    // fixesPerRun shape is rejected.
    const unknownOk = measurement({
      payload: {
        metric: metric({
          fixesPerRun: { numerator: null, denominator: null },
          baselineFailures: [
            baseline({
              count: null,
              unknownReason: 'probe bailed',
              probeHead: null,
              completed: false,
            }),
          ],
        }),
        availability: {
          ...AVAILABILITY,
          '/metric/fixesPerRun/numerator': {
            state: 'not-collected',
            reason: 'no verified closures',
            source: null,
          },
          '/metric/baselineFailures/0/count': {
            state: 'unavailable',
            reason: 'probe bailed',
            source: null,
          },
        },
      },
    });
    expect(MeasurementSummaryJournalEventSchema.safeParse(unknownOk).success).toBe(true);

    // P1-2: each null without its availability pointer fails — numerator,
    // denominator, baselineFailures[i].count — and an unknown baseline count
    // with a known denominator fails.
    const nullCases: { metric: MetricRecord; availability: Record<string, AvailabilityRecord> }[] =
      [
        {
          metric: { ...metric(), fixesPerRun: { numerator: null, denominator: 3 } },
          availability: {},
        },
        {
          metric: { ...metric(), fixesPerRun: { numerator: 1, denominator: null } },
          availability: {},
        },
        {
          // count:null with denominator:null: only the missing baseline count
          // pointer fails (the denominator pointer is present).
          metric: {
            ...metric(),
            fixesPerRun: { numerator: 1, denominator: null },
            baselineFailures: [baseline({ count: null })],
          },
          availability: {
            '/metric/fixesPerRun/denominator': {
              state: 'not-collected',
              reason: 'probe bailed',
              source: null,
            },
          },
        },
      ];
    for (const c of nullCases) {
      expect(
        MeasurementSummaryJournalEventSchema.safeParse({
          ...measurement(),
          payload: { metric: c.metric, availability: c.availability },
        }).success,
      ).toBe(false);
    }
    const unknownCountKnownDenominator = {
      ...measurement(),
      payload: {
        metric: metric({ baselineFailures: [baseline({ count: null })] }),
        availability: {
          ...AVAILABILITY,
          '/metric/baselineFailures/0/count': { state: 'unavailable', reason: 'r', source: null },
        },
      },
    };
    expect(
      MeasurementSummaryJournalEventSchema.safeParse(unknownCountKnownDenominator).success,
    ).toBe(false);
    // Same three null cases on the report root (same per-case availability
    // maps, so only the missing pointer fails each case).
    for (const c of nullCases) {
      const r = report(c.metric);
      (r as unknown as Record<string, unknown>).availability = c.availability;
      expect(ReportV2Schema.safeParse(r).success).toBe(false);
    }

    // P2-4: verifiedCommits is the deduplicated projection of verified
    // non-todo closures — duplicate, absent and todo-only entries fail.
    expect(ReportV2Schema.safeParse(report({ verifiedCommits: [HEAD, HEAD] })).success).toBe(false);
    expect(ReportV2Schema.safeParse(report({ verifiedCommits: [HEAD2] })).success).toBe(false);
    expect(
      ReportV2Schema.safeParse(
        report({ verifiedCommits: [HEAD], closures: [closure({ todo: true })] }),
      ).success,
    ).toBe(false);

    // P3-3: a null value cannot carry availability state 'known' or
    // 'known-zero' (contradiction — a known zero is not null).
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: { ...metric(), fixesPerRun: { numerator: 1, denominator: null } },
          availability: {
            '/metric/fixesPerRun/denominator': {
              state: 'known-zero',
              reason: 'no units',
              source: null,
            },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: { ...metric(), fixesPerRun: { numerator: null, denominator: 3 } },
          availability: {
            '/metric/fixesPerRun/numerator': { state: 'known', reason: 'counted', source: null },
          },
        },
      }).success,
    ).toBe(false);

    // Legacy scalar fixesPerRun shape rejected (unknown evidence).
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: { ...metric(), fixesPerRun: 3 } as unknown as MetricRecord,
          availability: AVAILABILITY,
        },
      }).success,
    ).toBe(false);

    // Negative count, non-lowercase SHA, unknown availability state, unknown
    // reportVersion, negative attempt ordinal, non-boolean todo.
    expect(
      MeasurementSummaryJournalEventSchema.safeParse(
        measurement({
          payload: {
            metric: { ...metric(), baselineFailures: [baseline({ count: -1 })] },
            availability: AVAILABILITY,
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      MeasurementSummaryJournalEventSchema.safeParse(
        measurement({
          payload: {
            metric: { ...metric(), verifiedCommits: [HEAD.toUpperCase()] },
            availability: AVAILABILITY,
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: metric(),
          // Only the enum fails: otherwise-valid record shape.
          availability: {
            '/metric': {
              state: 'maybe',
              reason: 'x',
              source: null,
            } as unknown as AvailabilityRecord,
          },
        },
      }).success,
    ).toBe(false);
    expect(ReportV2Schema.safeParse({ ...report(), reportVersion: 3 }).success).toBe(false);
    expect(
      MeasurementSummaryJournalEventSchema.safeParse(measurement({ attempt: 0 })).success,
    ).toBe(false);
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: {
            ...metric(),
            closures: [{ ...closure(), todo: 'no' } as unknown as ClosureRecord],
          },
          availability: AVAILABILITY,
        },
      }).success,
    ).toBe(false);
  });

  test('T28 failure boundary', async () => {
    // Strict extras rejection; no cap/used aliases in the metric (P2-2:
    // otherwise-valid metric shapes).
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: { ...metric(), cap: 10 } as unknown as MetricRecord,
          availability: AVAILABILITY,
        },
      }).success,
    ).toBe(false);
    expect(
      ReportV2Schema.safeParse(
        report({
          fixesPerRun: {
            numerator: 1,
            denominator: 1,
            used: 1,
          } as unknown as MetricRecord['fixesPerRun'],
        }),
      ).success,
    ).toBe(false);
    expect(
      ReportV2Schema.safeParse(
        report({
          fixesPerRun: {
            numerator: 1,
            denominator: 1,
            cap: 1,
          } as unknown as MetricRecord['fixesPerRun'],
        }),
      ).success,
    ).toBe(false);
    // Strict extras rejection on the report root itself.
    const extraReport = report();
    (extraReport as unknown as Record<string, unknown>).fixesPerRun = {
      numerator: 1,
      denominator: 1,
    };
    expect(ReportV2Schema.safeParse(extraReport).success).toBe(false);

    // P1-1: report envelope rows mirror the journal carriers — a payload-only
    // approval row fails; the envelope row parses.
    const payloadOnlyApproval = report();
    (payloadOnlyApproval.approvals as unknown as ReportV2['approvals']) = [
      { approvalId: HASH, reason: 'r', availability: {} },
    ] as unknown as ReportV2['approvals'];
    expect(ReportV2Schema.safeParse(payloadOnlyApproval).success).toBe(false);
    expect(ReportV2Schema.safeParse({ ...report(), approvals: [envelopeApproval()] }).success).toBe(
      true,
    );

    // P2-3: seconds-only `at` on the measurement-summary carrier.
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        at: '2026-01-03T04:05:06Z',
      }).success,
    ).toBe(false);

    // P2-3: bad JSON-Pointer availability keys on payload and report.
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: metric(),
          availability: { 'metric/x': { state: 'known', reason: 'r', source: null } },
        },
      }).success,
    ).toBe(false);
    expect(
      ReportV2Schema.safeParse({
        ...report(),
        availability: { 'metric/x': { state: 'known', reason: 'r', source: null } },
      }).success,
    ).toBe(false);

    // P2-3: non-uuid correlation.workId on the report.
    expect(
      ReportV2Schema.safeParse({
        ...report(),
        correlation: { ...correlation(), workId: 'not-a-uuid' },
      }).success,
    ).toBe(false);

    // P2-3: uppercase sha256: hashes (closure fingerprint spanContentHash,
    // provenance.cqJsonHash).
    const upperHash = `sha256:${'B'.repeat(64)}`;
    const upperSpan = report({
      closures: [
        { ...closure(), findingFingerprints: [{ ...FINGERPRINT, spanContentHash: upperHash }] },
      ],
    });
    expect(ReportV2Schema.safeParse(upperSpan).success).toBe(false);
    const upperCqJson = report();
    (upperCqJson.provenance as unknown as Record<string, unknown>).cqJsonHash = upperHash;
    expect(ReportV2Schema.safeParse(upperCqJson).success).toBe(false);

    // P2-3: unknown metric name (nested fixesPerRun.ratio, top-level
    // fixesPerRunRatio) via strict rejection.
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: {
            ...metric(),
            fixesPerRun: { numerator: 1, denominator: 3, ratio: 0.33 },
          } as unknown as MetricRecord,
          availability: AVAILABILITY,
        },
      }).success,
    ).toBe(false);
    expect(
      MeasurementSummaryJournalEventSchema.safeParse({
        ...measurement(),
        payload: {
          metric: {
            ...metric(),
            fixesPerRunRatio: { numerator: 1, denominator: 3 },
          } as unknown as MetricRecord,
          availability: AVAILABILITY,
        },
      }).success,
    ).toBe(false);

    // P2-3: unknown nested enum in a report row (gate verdict).
    const badGate = report();
    (badGate.gates[0]!.payload as unknown as Record<string, unknown>).verdict = 'green';
    expect(ReportV2Schema.safeParse(badGate).success).toBe(false);

    // The kernel RunLog's append still validates v1/v2 shapes only (dual
    // reader first — ADR-0008 Migration §1): the measurement-summary carrier
    // fails there, while the widened READER accepts it (pinned in
    // journal-v3-read.test.ts). Old shapes still write and read back
    // unchanged.
    expect(JournalEventV1V2Schema.safeParse(measurement()).success).toBe(false);
    expect(JournalEventSchema.safeParse(measurement()).success).toBe(true);
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
