// ADR-0008 T37: the explicit lossy legacy projection of a report v2.
// Fake fixtures only; no provider, network or credentials.
import { describe, expect, test } from 'vitest';
import { ReportV2Schema } from '../../../src/kernel/schema.js';
import {
  foldObservations,
  legacyReportProjection,
  type LegacyProjectionEvidence,
} from '../../../src/ops/fix/reportFold.js';
import { distinctFixedCommitCount } from '../../../src/ops/fix/measurement.js';
import { fixesPerRunOf } from '../../../src/ops/fix/runFix.js';
import type { FixTaskReport } from '../../../src/ops/sweep/taskLoop.js';
import type {
  AttemptFinishedJournalEvent,
  AvailabilityRecord,
  CompositionStartedJournalEvent,
  MetricRecord,
  ObservationStream,
  ReportV2,
} from '../../../src/kernel/types.js';

const AT = '2026-01-03T04:05:06.789Z';
const BASE = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;
const WORK_ID = '3f2b8c1e-1111-4222-8333-444455556666';
const CR_ID = 'cr-2026-01-03T04.05.06Z';
const COMMIT_ONE = '1'.repeat(40);
const COMMIT_TWO = '2'.repeat(40);
const COMMIT_THREE = '3'.repeat(40);
const COMMIT_FOUR = '4'.repeat(40);

/** A real FixTaskReport carrier row, shaped as the live writer emits it. */
const fixTask = (outcome: FixTaskReport['outcome'], commits: string[]): FixTaskReport => ({
  task: { id: `t-${outcome}-${commits.join()}`, files: [], failures: [] },
  attempts: [],
  outcome,
  branch: 'cq/fix/legacy/x',
  commits,
});

const provenance = {
  cqVersion: '0.2.0',
  producerVersion: '0.2.0',
  repoId: null,
  cqJsonHash: HASH,
  baseSha: BASE,
  runPrefix: 'plan-x',
  startedAt: AT,
  endedAt: null,
  journalLink: 'runs/plan-x.ndjson',
  reportLink: 'reports/plan-x.json',
  witnesses: { base: BASE, admitted: null, execution: null, reviewed: null, accepted: null },
};
const correlation = {
  workId: WORK_ID,
  parentWorkId: null,
  branch: 'feat/demo',
  commitSha: null,
  sessionId: null,
  agentId: null,
};

const header = (): CompositionStartedJournalEvent => ({
  type: 'composition-started',
  runId: CR_ID,
  at: AT,
  unitId: null,
  jobId: null,
  taskId: null,
  attempt: null,
  payload: { journalVersion: 3, provenance, correlation },
});

const attempt = (): AttemptFinishedJournalEvent => ({
  type: 'attempt-finished',
  runId: CR_ID,
  at: AT,
  unitId: 'u',
  jobId: null,
  taskId: 't',
  attempt: 1,
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

const stream = (events: ObservationStream['events']): ObservationStream => ({
  workId: WORK_ID,
  compositionRunId: CR_ID,
  events,
  complete: true,
});

const baseReport = (events: ObservationStream['events'] = [header()]): ReportV2 =>
  foldObservations({ streams: [stream(events)], producer: 'fix' });

const availability = (state: AvailabilityRecord['state'], reason: string): AvailabilityRecord => ({
  state,
  reason,
  source: null,
});

const closure = (commitSha: string, taskId: string) => ({
  commitSha,
  taskIds: [taskId],
  findingFingerprints: [],
  verificationEvidence: ['validation:pass'],
  todo: false,
});

const measured = (numerator: number, commits: readonly string[]): MetricRecord => ({
  fixesPerRun: { numerator, denominator: 3 },
  verifiedCommits: [...commits],
  closures: commits.map((commitSha, i) => closure(commitSha, `task-${String(i)}`)),
  baselineFailures: [
    { unitId: 'unit-a', probeHead: null, completed: true, count: 3, unknownReason: null },
  ],
});

/** A schema-valid v2 report whose metric carries measured evidence. */
const measuredReport = (
  numerator: number,
  commits: readonly string[],
  events?: ObservationStream['events'],
): ReportV2 => {
  const base = baseReport(events);
  return ReportV2Schema.parse({
    ...base,
    metric: measured(numerator, commits),
    availability: {
      ...base.availability,
      '/metric/fixesPerRun/numerator': availability('known', 'measured numerator'),
      '/metric/fixesPerRun/denominator': availability('known', 'measured denominator'),
    },
  });
};

const frozen = <T>(value: T): T => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) frozen(item);
  }
  return value;
};

describe('report v2 legacy projection (T37)', () => {
  test('T37 round-trip', () => {
    const report = frozen(measuredReport(2, [COMMIT_ONE, COMMIT_TWO]));
    const before = JSON.stringify(report);
    const projection = legacyReportProjection({ reportV2: report });
    expect(projection.lossy).toBe(true);
    expect(projection.fixesPerRun).toBe(2);
    expect(projection.availability.state).toBe('known');
    expect(projection.availability.reason).toContain('report v2 verified commits');
    // The projection is not report v2 and carries no evidence rows: only the
    // old scalar, its availability and the explicit lossy marker survive.
    expect(Object.keys(projection).sort()).toEqual(['availability', 'fixesPerRun', 'lossy']);
    expect('reportVersion' in projection).toBe(false);
    expect('attempts' in projection).toBe(false);
    expect(JSON.stringify(report)).toBe(before);

    // A measured zero is a known zero, never an unknown.
    const zero = legacyReportProjection({ reportV2: measuredReport(0, []) });
    expect(zero.fixesPerRun).toBe(0);
    expect(zero.availability.state).toBe('known-zero');

    // Without reportV2 the normal legacy carrier rows project (and dedupe)
    // through the same old scalar.
    const fixRows: LegacyProjectionEvidence = {
      producer: 'fix',
      tasks: [
        { outcome: 'fixed', commits: [COMMIT_ONE, COMMIT_ONE] },
        { outcome: 'unfixed', commits: [COMMIT_TWO] },
        { outcome: 'fixed', commits: [COMMIT_TWO] },
      ],
    };
    const fixProjection = legacyReportProjection({ evidence: fixRows });
    expect(fixProjection.fixesPerRun).toBe(2);
    expect(fixProjection.availability.state).toBe('known');
    const addressRows: LegacyProjectionEvidence = {
      producer: 'address',
      fixes: [{ commit: COMMIT_ONE }, { commit: undefined }, { commit: COMMIT_ONE }],
    };
    const addressProjection = legacyReportProjection({ evidence: addressRows });
    expect(addressProjection.fixesPerRun).toBe(1);
  });

  test('T37 carrier rows outrank report v2', () => {
    // A real legacy run carries both: the assembled reportV2 has a null
    // numerator today, and once M0-metric lands its numerator measures a
    // different quantity (validation pass, Cq-Task trailer, not todo). The
    // carrier rows carry the pre-v2 rule, so they always win.
    const carrierTasks: FixTaskReport[] = [
      fixTask('fixed', [COMMIT_ONE, COMMIT_ONE]),
      fixTask('unfixed', [COMMIT_FOUR]),
      fixTask('fixed', [COMMIT_TWO]),
      fixTask('fixed', [COMMIT_THREE]),
    ];
    // The carrier count is the writer's own rule, not a copy of it: one
    // duplicate fixed commit collapses, an unfixed row's commit never counts,
    // and fixesPerRunOf and the projection must agree on both.
    const carrierCount = distinctFixedCommitCount(carrierTasks);
    expect(fixesPerRunOf(carrierTasks)).toBe(carrierCount);
    expect(carrierCount).toBe(3);
    const rows: LegacyProjectionEvidence = { producer: 'fix', tasks: carrierTasks };
    const both = legacyReportProjection({
      reportV2: measuredReport(2, [COMMIT_ONE, COMMIT_TWO]),
      evidence: rows,
    });
    expect(both.fixesPerRun).toBe(carrierCount);
    expect(both.fixesPerRun).toBe(3);
    expect(both.availability.state).toBe('known');
    expect(both.availability.reason).toContain('legacy carrier rows');
    expect(both.availability.reason).not.toContain('fallback');

    // Only a carrier without rows reads the v2 payload, and its availability
    // says so: the fallback is the v2 verified commit count, not the old rule.
    const fallback = legacyReportProjection({
      reportV2: measuredReport(2, [COMMIT_ONE, COMMIT_TWO]),
    });
    expect(fallback.fixesPerRun).toBe(2);
    expect(fallback.availability.reason).toContain('fallback');
    expect(fallback.availability.reason).toContain('report v2 verified commits');

    // Rows win even when they count zero: an empty carrier is a known zero,
    // never a reason to consult the v2 numerator.
    const emptyRows = legacyReportProjection({
      reportV2: measuredReport(2, [COMMIT_ONE, COMMIT_TWO]),
      evidence: { producer: 'address', fixes: [{ commit: '' }] },
    });
    expect(emptyRows.fixesPerRun).toBe(0);
    expect(emptyRows.availability.state).toBe('known-zero');
  });

  test('T37 address truthiness matches the writer', () => {
    // The pre-v2 address writer counts `fix.commit ? [fix.commit] : []`, so
    // falsy commits are skipped: never counted and never an availability.
    const rows = {
      producer: 'address',
      fixes: [
        { commit: COMMIT_ONE },
        { commit: '' },
        { commit: null },
        { commit: undefined },
        { commit: COMMIT_ONE },
      ],
    } as unknown as LegacyProjectionEvidence;
    const projection = legacyReportProjection({ evidence: rows });
    expect(projection.fixesPerRun).toBe(1);
    expect(projection.availability.state).toBe('known');

    const allFalsy = legacyReportProjection({
      evidence: { producer: 'address', fixes: [{ commit: '' }, { commit: '' }] },
    });
    expect(allFalsy.fixesPerRun).toBe(0);
    expect(allFalsy.availability.state).toBe('known-zero');
  });

  test('T37 unknown evidence', () => {
    // No reportV2 and no rows is a normal absence, not an error and not zero.
    const absent = legacyReportProjection({});
    expect(absent.lossy).toBe(true);
    expect(absent.fixesPerRun).toBeNull();
    expect(absent.availability.state).toBe('not-collected');
    expect(absent.availability.reason).toContain('no report v2');

    // A folded report whose metric producer has not landed is unknown; the
    // recorded availability is preserved instead of guessing a count.
    const folded = baseReport([header(), attempt()]);
    const unknown = legacyReportProjection({ reportV2: folded });
    expect(unknown.fixesPerRun).toBeNull();
    expect(unknown.availability.state).toBe('unavailable');
    expect(unknown.availability.reason).toContain('producer not yet wired');

    // Evidence is never replayed: the projection holds only the scalar and
    // availability, while the report's attempt row stays exactly where it was.
    expect(Object.keys(unknown).sort()).toEqual(['availability', 'fixesPerRun', 'lossy']);
    expect(folded.attempts).toHaveLength(1);
    expect(folded.attempts[0]).toEqual(attempt());
  });

  test('T37 failure boundary', () => {
    // A malformed report v2 fails closed to unknown without throwing.
    const malformed = legacyReportProjection({
      reportV2: { reportVersion: 2 } as unknown as ReportV2,
    });
    expect(malformed.fixesPerRun).toBeNull();
    expect(malformed.availability.state).toBe('unavailable');
    expect(malformed.availability.reason).toContain('not schema-valid');

    // A numerator that disagrees with its verified commit projection is
    // untrustworthy: withhold the scalar instead of picking one.
    const inconsistent = legacyReportProjection({
      reportV2: measuredReport(2, [COMMIT_ONE]),
    });
    expect(inconsistent.fixesPerRun).toBeNull();
    expect(inconsistent.availability.reason).toContain('disagrees');

    // Malformed legacy rows fail closed too.
    const malformedRows = legacyReportProjection({
      evidence: {
        producer: 'fix',
        tasks: [{ outcome: 'fixed', commits: [42] }],
      } as unknown as LegacyProjectionEvidence,
    });
    expect(malformedRows.fixesPerRun).toBeNull();
    expect(malformedRows.availability.reason).toContain('legacy projection unavailable');

    // The projection changes nothing: the carrying report and its verdict are
    // untouched, and the result adds no status or verdict of its own.
    const report = measuredReport(1, [COMMIT_ONE]);
    const carrier = { reportV2: report, verdict: 'pass', status: 'ok' };
    const before = JSON.stringify(carrier);
    const projection = legacyReportProjection(carrier);
    expect(projection.fixesPerRun).toBe(1);
    expect(JSON.stringify(carrier)).toBe(before);
    expect(carrier.verdict).toBe('pass');
    expect('verdict' in projection).toBe(false);
    expect('status' in projection).toBe(false);

    // Sanitize before returning a durable surface: a credential URL in a
    // carried availability reason is stripped, exactly as T36 sanitizes.
    const secretReport = ReportV2Schema.parse({
      ...baseReport(),
      availability: {
        ...baseReport().availability,
        '/metric/fixesPerRun/numerator': availability(
          'unavailable',
          'probe failed at https://user:secret@example.com/path?token=abc',
        ),
      },
    });
    const sanitized = legacyReportProjection({ reportV2: secretReport });
    expect(sanitized.fixesPerRun).toBeNull();
    expect(sanitized.availability.reason).not.toContain('secret');
    expect(sanitized.availability.reason).not.toContain('token=');
  });
});
