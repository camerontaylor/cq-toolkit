// Separate composition observation stream — ADR-0008 T29 (measurement slice
// M0-sink).
//
// Pinned here:
//   1. T29 round-trip: header + carriers + kernel-run-linked written through
//      openObservationWriter read back byte-identically via readObservations;
//      foldObservations resolves each kernel-run-linked against the kernel v3
//      headers by planId + runId + correlation.workId (unknown stays unknown,
//      never guessed); the kernel RunLog stays untouched (v1/v2-only append,
//      bytes unchanged); memory-only writer retains events in memory and
//      declares persistence unavailable.
//   2. T29 unknown evidence: unknown event kinds, bad payload spellings,
//      wrong runId, duplicate streams (refused at open), id-grammar refusal
//      ('../x', 'a/b', '..', non-UUID workId), headerless/misplaced/duplicate
//      headers written out of band, a stray file under observations/, and
//      composition carriers in a kernel v3 file are all refused or isolated
//      loudly.
//   3. T29 failure boundary: a REAL write failure (EEXIST on the header
//      append) fail-stops the writer — the next append rejects with the same
//      error, failure is exposed, close() re-rejects, and the file is
//      unchanged; append after close rejects; a torn final line (or an empty
//      created file) keeps the stream partial (complete: false), never an
//      invented completion.
//
// Residual: losing a datasync or a directory sync is not detected by any
// test (crash-simulation would require mocking the fs layer); the failure
// boundary tests cover detectable corruption only.
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now(). Temp
// dirs: mkdtemp under os.tmpdir, removed afterwards. No network, no
// providers, no credentials — fake inputs only.
//
// Split provenance: test/kernel/observation.test.ts was split by subject
// into observation.round-trip.test.ts, observation.evidence-refusal.test.ts,
// observation.stream-identity.test.ts, observation.kernel-descriptors.test.ts,
// observation.fold-links.test.ts, observation.failure-boundary.test.ts,
// observation.write-serialization.test.ts and
// observation.kernel-isolation.test.ts; the fixtures below are shared by
// those files.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openObservationWriter } from '../../src/kernel/observation.js';
import type {
  ApprovalJournalEvent,
  CompositionStartedJournalEvent,
  KernelRunLinkedJournalEvent,
  ObservationEvent,
  RunStartedV3JournalEvent,
} from '../../src/kernel/types.js';

export const AT = '2026-01-03T04:05:06.789Z';
export const AT2 = '2026-01-03T04:05:07.000Z';
export const AT3 = '2026-01-03T04:05:08.000Z';
const BASE = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;
export const WORK_ID = '3f2b8c1e-1111-4222-8333-444455556666';
export const WORK_ID_2 = '4f2b8c1e-1111-4222-8333-444455556666';
export const CR_ID = 'cr-2026-01-03T04.05.06Z';
export const KERNEL_RUN = 'plan-x--k--a';
export const PLAN_ID = 'plan-x';

export function header(overrides?: {
  runId?: string;
  correlationWorkId?: string;
}): CompositionStartedJournalEvent {
  const { runId, correlationWorkId, ...rest } = overrides ?? {};
  return {
    type: 'composition-started',
    runId: runId ?? CR_ID,
    at: AT,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: {
      journalVersion: 3,
      provenance: {
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
        witnesses: {
          base: BASE,
          admitted: null,
          execution: null,
          reviewed: null,
          accepted: null,
        },
      },
      correlation: {
        workId: correlationWorkId ?? WORK_ID,
        parentWorkId: null,
        branch: 'feat/demo',
        commitSha: null,
        sessionId: null,
        agentId: null,
      },
    },
    ...rest,
  } as CompositionStartedJournalEvent;
}

export function linked(
  kernelRunId = KERNEL_RUN,
  round = 1,
  overrides?: Partial<KernelRunLinkedJournalEvent>,
): KernelRunLinkedJournalEvent {
  return {
    type: 'kernel-run-linked',
    runId: CR_ID,
    at: AT2,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: { kernelRunId, planId: PLAN_ID, round },
    ...overrides,
  };
}

export function approval(overrides?: Partial<ApprovalJournalEvent>): ApprovalJournalEvent {
  return {
    type: 'approval-granted',
    runId: CR_ID,
    at: AT3,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: {
      approvalId: `sha256:${'c'.repeat(64)}`,
      reason: 'admitted',
      availability: {},
    },
    ...overrides,
  };
}

/** Kernel v3 header matching this test's fixtures (for the fold join). */
export function kernelV3Header(runId = KERNEL_RUN, workId = WORK_ID): RunStartedV3JournalEvent {
  return {
    type: 'run-started',
    runId,
    at: AT,
    planId: PLAN_ID,
    journalVersion: 3,
    seq: 1,
    governance: { attended: false },
    provenance: header().payload.provenance,
    correlation: { ...header().payload.correlation, workId },
    availability: {},
  };
}

export async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cq-observation-'));
}

/** Open (awaited — exclusive create happens at open), append, close. */
export async function writeStream(
  journalDir: string,
  events: readonly ObservationEvent[],
  compositionRunId = CR_ID,
  workId = WORK_ID,
): Promise<void> {
  const writer = await openObservationWriter({ journalDir, workId, compositionRunId });
  try {
    for (const event of events) {
      await writer.append(event);
    }
  } finally {
    await writer.close();
  }
}
