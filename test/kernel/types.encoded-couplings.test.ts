// Split provenance: test/kernel/types.test.ts was split by subject; this file
// holds the encoded-coupling rules (honest-stop pairing, 1-based attempts) and
// the VB1A optional-usage/bogus-discriminant cases. Sibling subjects:
// types.roundtrip.test.ts, types.mirror-tightenings.test.ts,
// types.worker-result-wire.test.ts, types.seam.test.ts,
// types.dispatch-errors.test.ts; shared fixtures live in types.helpers.ts.
import { describe, expect, test } from 'vitest';
import * as kernelSchema from '../../src/kernel/schema.js';
import type {
  JobFinishedJournalEvent,
  JobStartedJournalEvent,
  RunFinishedJournalEvent,
  RunReport,
} from '../../src/kernel/types.js';
import { failsParse, roundTripsThrough } from './types.helpers.js';

// ---------------------------------------------------------------------------
// 4. Encoded couplings (review round 3): honest-stop pairing, 1-based attempts
// ---------------------------------------------------------------------------

/** Minimal valid RunReport with stoppedEarly=false and no optional fields. */
function validRunReportBase(): RunReport {
  return {
    runId: 'run-coupling',
    stoppedEarly: false,
    counts: {
      queued: 0,
      running: 0,
      blocked: 0,
      done: 0,
      failed: 0,
      'budget-exhausted': 0,
    },
    jobs: [],
  };
}

describe('encoded couplings (honest-stop pairing, 1-based attempts)', () => {
  test('RunReportSchema: stoppedEarly=true WITH earlyStopReason parses and round-trips', () => {
    const instance: RunReport = {
      ...validRunReportBase(),
      stoppedEarly: true,
      earlyStopReason: 'budget',
    };
    roundTripsThrough(kernelSchema.RunReportSchema, instance);
  });

  test('RunReportSchema: stoppedEarly=true WITHOUT earlyStopReason fails', () => {
    failsParse(
      kernelSchema.RunReportSchema,
      { ...validRunReportBase(), stoppedEarly: true },
      'stoppedEarly=true without earlyStopReason',
    );
  });

  test('RunReportSchema: stoppedEarly=false WITH earlyStopReason fails', () => {
    failsParse(
      kernelSchema.RunReportSchema,
      { ...validRunReportBase(), earlyStopReason: 'budget' },
      'stoppedEarly=false with earlyStopReason',
    );
  });

  test('RunFinishedJournalEventSchema mirrors the honest-stop coupling (both directions, incl. via the union)', () => {
    const base = {
      type: 'run-finished' as const,
      runId: 'run-x',
      at: '2026-01-01T00:00:00.000Z',
    };
    const good: RunFinishedJournalEvent = {
      ...base,
      stoppedEarly: true,
      earlyStopReason: 'budget',
    };
    roundTripsThrough(kernelSchema.RunFinishedJournalEventSchema, good);
    failsParse(
      kernelSchema.RunFinishedJournalEventSchema,
      { ...base, stoppedEarly: true },
      'run-finished stoppedEarly=true without earlyStopReason',
    );
    failsParse(
      kernelSchema.RunFinishedJournalEventSchema,
      { ...base, stoppedEarly: false, earlyStopReason: 'budget' },
      'run-finished stoppedEarly=false with earlyStopReason',
    );
    // The coupling holds when the event is routed through the union too.
    failsParse(
      kernelSchema.JournalEventSchema,
      { ...base, stoppedEarly: true },
      'JournalEventSchema stoppedEarly=true without earlyStopReason',
    );
  });

  test('JobStartedJournalEventSchema: attempt is 1-based (attempt=0 fails, attempt=1 parses)', () => {
    const base = {
      type: 'job-started' as const,
      runId: 'run-x',
      at: '2026-01-01T00:00:00.000Z',
      jobId: 'job-x',
      op: 'op-x',
    };
    failsParse(kernelSchema.JobStartedJournalEventSchema, { ...base, attempt: 0 }, 'attempt=0');
    const one: JobStartedJournalEvent = { ...base, attempt: 1 };
    roundTripsThrough(kernelSchema.JobStartedJournalEventSchema, one);
  });
});

// ---------------------------------------------------------------------------
// 5. VB1A: resumed-run usage rollup + bogus-discriminant rejection
// ---------------------------------------------------------------------------

describe('JobFinishedJournalEvent optional usage (VB1A: resumed-run rollups)', () => {
  const base = {
    type: 'job-finished' as const,
    runId: 'run-x',
    at: '2026-01-01T00:00:00.000Z',
    jobId: 'job-x',
    opId: 'op-x',
    inputsHash: 'hash-x',
    result: { status: 'ok' as const, value: 42 },
  };

  test('job-finished WITH usage parses and round-trips', () => {
    const event: JobFinishedJournalEvent = {
      ...base,
      usage: { input: 11, output: 7, cacheRead: 2, cacheWrite: 0, reasoning: 1 },
    };
    roundTripsThrough(kernelSchema.JobFinishedJournalEventSchema, event);
    const parsed = kernelSchema.JournalEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });

  test('job-finished WITHOUT usage parses and round-trips (usage stays optional)', () => {
    const event: JobFinishedJournalEvent = { ...base };
    roundTripsThrough(kernelSchema.JobFinishedJournalEventSchema, event);
    const parsed = kernelSchema.JournalEventSchema.parse(JSON.parse(JSON.stringify(event)));
    expect(parsed).toEqual(event);
  });
});

describe('bogus discriminant rejection (VB1A)', () => {
  test('OpResultSchema rejects a bogus status (cancelled)', () => {
    failsParse(
      kernelSchema.OpResultSchema,
      { status: 'cancelled', value: 1 },
      "bogus OpResult status 'cancelled'",
    );
  });

  test('JobStateSchema rejects a bogus state string (success)', () => {
    // JobStateSchema validates the BARE state string (a zod enum), so the
    // rejection must be exercised with the string itself — an object payload
    // would fail on shape, not on the bogus value.
    failsParse(kernelSchema.JobStateSchema, 'success', "bogus JobState 'success'");
  });

  test('JobStatusSchema rejects an object carrying a bogus state (success)', () => {
    failsParse(
      kernelSchema.JobStatusSchema,
      { jobId: 'job-x', state: 'success' },
      "bogus JobState 'success' on JobStatus",
    );
  });
});
