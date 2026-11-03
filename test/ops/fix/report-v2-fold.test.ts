// ADR-0008 T36 — report v2 observation fold (src/ops/fix/reportFold.ts).
//
// Pinned here:
//   1. A complete composition stream folds whole, and its kernel-run link
//      resolves against a supplied v3 descriptor.
//   2. A link without a descriptor stays unknown WITH its kernel-primitive
//      reason; `kernelRuns: []` (T04 has not landed) is explicit, never a
//      guessed value.
//   3. A torn/incomplete stream keeps the fold `partial`; it never becomes
//      `complete`.
//   4. `attempt-finished` folds generically: a sweep-shaped and a
//      fixture-address-shaped event land as the same row kind, with no
//      producer-specific transformation (T14 needs no fold change).
//   5. The fold is read-only and verdict-neutral: deep-frozen inputs are
//      untouched and the result is a fresh, sanitized copy.
//   6. No stream is `unavailable`, not complete-empty; absence is unknown.
// Fake fixtures only: fixed timestamps, no provider, no network, no
// credentials.
import { describe, expect, test } from 'vitest';
import { foldObservations } from '../../../src/ops/fix/reportFold.js';
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
const WORK_ID_2 = '4f2b8c1e-1111-4222-8333-444455556666';
const CR_ID = 'cr-2026-01-03T04.05.06Z';
const CR_ID_2 = 'cr-2026-01-03T04.05.07Z';
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
  test('complete stream with a resolvable link folds whole', () => {
    const fold = foldObservations({
      streams: [stream([header(), linked()])],
      kernelRuns: [descriptor()],
      persistence: 'durable',
    });
    expect(fold.reportVersion).toBe(2);
    expect(fold.state).toBe('complete');
    expect(fold.persistence).toBe('durable');
    expect(fold.streams).toHaveLength(1);
    expect(fold.streams[0]?.kernelRunLinks).toEqual([
      { state: 'resolved', event: linked(), kernelRunId: KERNEL_RUN, planId: PLAN_ID },
    ]);
    expect(fold.kernelRuns).toEqual([descriptor()]);
    expect(fold.availability['/kernelRuns']?.state).toBe('known');
    expect(fold.availability['']?.state).toBe('known');
  });

  test('absent T04 descriptors leave kernelRuns empty and every link unknown with a reason', () => {
    const fold = foldObservations({
      streams: [stream([header(), linked()])],
      persistence: 'durable',
    });
    const link = fold.streams[0]?.kernelRunLinks[0];
    expect(fold.kernelRuns).toEqual([]);
    expect(link?.state).toBe('unknown');
    expect(link?.state === 'unknown' ? link.reason : '').toContain(
      `kernel run '${KERNEL_RUN}' not found`,
    );
    expect(fold.availability['/kernelRuns']?.state).toBe('unavailable');
    expect(fold.availability['/kernelRuns']?.reason).toContain('T04');
  });

  test('a torn stream stays partial and is never reported complete', () => {
    const fold = foldObservations({
      streams: [stream([header()], CR_ID, WORK_ID, false)],
      persistence: 'durable',
    });
    expect(fold.state).toBe('partial');
    expect(fold.availability['']?.state).toBe('partial');
    expect(fold.availability['']?.reason).toContain('partial');
  });

  test('attempt-finished folds generically for sweep and fixture address producers', () => {
    const sweep = attempt(CR_ID, {
      unitId: 'pkg/tests-1',
      jobId: null,
      taskId: 'tests-1',
      attempt: 1,
    });
    const address = attempt(CR_ID_2, {
      unitId: 'address/pr-1',
      jobId: 'job-1',
      taskId: 'finding-1',
      attempt: 2,
    });
    const fold = foldObservations({
      streams: [
        stream([header(), sweep], CR_ID, WORK_ID),
        stream([header(CR_ID_2, WORK_ID_2), address], CR_ID_2, WORK_ID_2),
      ],
      persistence: 'unavailable',
    });
    expect(fold.attempts).toHaveLength(2);
    // Identical, producer-agnostic treatment: the row IS the shared event.
    expect(fold.attempts).toEqual([sweep, address]);
    expect(fold.availability['/attempts']?.state).toBe('known');
  });

  test('no attempt event is not-collected, never a fabricated zero', () => {
    const fold = foldObservations({ streams: [stream([header()])], persistence: 'durable' });
    expect(fold.attempts).toEqual([]);
    expect(fold.availability['/attempts']?.state).toBe('not-collected');
    expect(fold.availability['/attempts']?.reason).toContain('T14');
  });

  test('no stream is unavailable, not a complete empty fold', () => {
    const fold = foldObservations({ streams: [], persistence: 'unavailable' });
    expect(fold.state).toBe('unavailable');
    expect(fold.availability['']?.state).toBe('unavailable');
    expect(fold.attempts).toEqual([]);
  });

  test('the fold is read-only: frozen inputs are untouched and the result is a fresh copy', () => {
    const events = [
      header(),
      linked(),
      attempt(CR_ID, { unitId: 'u', jobId: null, taskId: 't', attempt: 1 }),
    ];
    const streams = frozen([stream(events)]);
    const kernelRuns = frozen([descriptor()]);
    const before = JSON.stringify({ streams, kernelRuns });
    const fold = foldObservations({ streams, kernelRuns, persistence: 'durable' });
    expect(JSON.stringify({ streams, kernelRuns })).toBe(before);
    expect(fold.streams[0]).not.toBe(streams[0]);
    expect(fold.attempts[0]).not.toBe(events[2]);
    expect(fold.attempts[0]).toEqual(events[2]);
    // Mutating the returned durable surface cannot reach the callers' inputs.
    fold.attempts.push(attempt(CR_ID, { unitId: 'x', jobId: null, taskId: 'x', attempt: 9 }));
    expect(streams[0]?.events).toHaveLength(3);
  });
});
