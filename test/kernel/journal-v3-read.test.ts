// Journal v3 dual reader (ADR-0008, T02) — v1/v2/v3 version dispatch over the
// kernel journal.
//
// Pinned here:
//   1. Round-trip: a v3 run (v3 header + observational carriers, written RAW
//      — the kernel RunLog's append stays v1/v2 until T04/T29) and v1/v2
//      kernel events read back byte-identically; foldOrderRuns dispatches
//      absent → v1 (at-ordered), 2 → v2 and 3 → v3 (sequenced, one shared
//      ordering), all v2/v3 before v1.
//   2. Unknown evidence: an unknown journal version (4) on a run-started
//      header is refused loudly by the schema and by foldOrderRuns — never
//      silently folded.
//   3. Failure boundary: observational v3 events never alter job outcome
//      derivation (deriveJobStatuses ignores them; kernel replay unchanged);
//      seq/reservation/torn-tail rules are preserved; per-file version
//      strictness refuses a v3-only line in a v1/v2-header file and a second
//      run-started anywhere.
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now().
import { describe, expect, test } from 'vitest';
import {
  openRunLog,
  foldOrderRuns,
  deriveJobStatuses,
  type FoldRun,
} from '../../src/kernel/journal.js';
import {
  JournalEventSchema,
  JournalEventV1V2Schema,
  RunStartedV3JournalEventSchema,
} from '../../src/kernel/schema.js';
import type {
  ApprovalJournalEvent,
  JournalEvent,
  MeasurementSummaryJournalEvent,
  MetricRecord,
  OpResult,
  RunStartedV3JournalEvent,
} from '../../src/kernel/types.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
const AT2 = '2026-01-03T04:05:07.000Z';
const AT3 = '2026-01-03T04:05:08.000Z';
const BASE = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;
const RUN_A = 'plan-x--k--a';
const RUN_B = 'plan-x--k--b';

function v3Header(overrides?: Partial<RunStartedV3JournalEvent>): RunStartedV3JournalEvent {
  return {
    type: 'run-started',
    runId: RUN_A,
    at: AT,
    planId: 'plan-x',
    journalVersion: 3,
    seq: 1,
    governance: { attended: false },
    provenance: {
      cqVersion: '0.2.0',
      producerVersion: '0.2.0',
      repoId: null,
      cqJsonHash: HASH,
      baseSha: BASE,
      runPrefix: 'plan-x',
      startedAt: AT,
      endedAt: null,
      journalLink: `runs/${RUN_A}.ndjson`,
      reportLink: `reports/${RUN_A}.json`,
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

function approval(overrides?: Partial<ApprovalJournalEvent>): ApprovalJournalEvent {
  return {
    type: 'approval-granted',
    runId: RUN_A,
    at: AT2,
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

function measurement(): MeasurementSummaryJournalEvent {
  const metric: MetricRecord = {
    fixesPerRun: { numerator: 1, denominator: 2 },
    verifiedCommits: ['d'.repeat(40)],
    closures: [
      {
        commitSha: 'd'.repeat(40),
        taskIds: ['task-1'],
        findingFingerprints: [],
        verificationEvidence: ['journal:plan-x#7'],
        todo: false,
      },
    ],
    baselineFailures: [],
  };
  return {
    type: 'measurement-summary',
    runId: RUN_A,
    at: AT3,
    unitId: null,
    jobId: null,
    taskId: null,
    attempt: null,
    payload: { metric, availability: {} },
  };
}

function v1Started(runId = RUN_A): JournalEvent {
  return { type: 'run-started', runId, at: AT, planId: 'plan-x' };
}

function v2Started(runId = RUN_A, seq = 1): JournalEvent {
  return {
    type: 'run-started',
    runId,
    at: AT,
    planId: 'plan-x',
    journalVersion: 2,
    seq,
    ungoverned: { optIn: true },
  };
}

function jobStarted(jobId: string, runId = RUN_A): JournalEvent {
  return { type: 'job-started', runId, at: AT2, jobId, op: `op-${jobId}`, attempt: 1 };
}

function jobFinished(jobId: string, result: OpResult<unknown>, runId = RUN_A): JournalEvent {
  return {
    type: 'job-finished',
    runId,
    at: AT3,
    jobId,
    opId: `op-${jobId}`,
    inputsHash: `hash-${jobId}`,
    result,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), 'jv3-read-'));
    await fn(dir);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
}

/** Write a raw NDJSON stream (the kernel writer stays v1/v2 until T04/T29). */
async function writeRaw(dir: string, runId: string, events: readonly unknown[]): Promise<void> {
  const body = events.map((event) => `${JSON.stringify(event)}\n`).join('');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${runId}.ndjson`), body, 'utf8');
}

describe('journal v3 read (T02)', () => {
  test('T02 round-trip', async () => {
    const v3 = v3Header();
    expect(RunStartedV3JournalEventSchema.parse(v3)).toEqual(v3);
    const events: JournalEvent[] = [v3, approval(), measurement()];
    for (const event of events) expect(JournalEventSchema.parse(event)).toEqual(event);

    // The kernel RunLog's widened READER reads a raw-written v3 stream
    // byte-identically; its append still validates v1/v2 shapes only (dual
    // reader first — ADR-0008 Migration §1), pinned in the T25–T28 tests.
    await withTempDir(async (dir) => {
      await writeRaw(dir, RUN_A, events);
      const log = openRunLog(dir);
      expect(await log.read(RUN_A)).toEqual(events);

      // v1 kernel streams are unchanged on the same reader.
      const v1 = [
        v1Started(RUN_B),
        jobStarted('j1', RUN_B),
        jobFinished('j1', { status: 'ok', value: 1 }, RUN_B),
      ];
      await writeRaw(dir, RUN_B, v1);
      expect(await log.read(RUN_B)).toEqual(v1);
    });

    // Fold order: v1 runs ordered by `at` then runId, ALL before every v2/v3
    // run; v2 and v3 share one seq-ordered era.
    const foldV1A: FoldRun = { runId: RUN_A, events: [v1Started(RUN_A)] };
    const foldV1B: FoldRun = {
      runId: RUN_B,
      events: [{ ...v1Started(RUN_B), at: AT2 }],
    };
    const foldV2: FoldRun = {
      runId: 'plan-x--k--c',
      events: [v2Started('plan-x--k--c', 1)],
    };
    const foldV3: FoldRun = {
      runId: RUN_A,
      events: [v3Header({ seq: 2 })],
    };
    // v1 first (at order), then v2/v3 by seq across versions.
    expect(foldOrderRuns([foldV3, foldV2, foldV1B, foldV1A]).map((run) => run.runId)).toEqual([
      RUN_A,
      RUN_B,
      'plan-x--k--c',
      RUN_A,
    ]);
    // seq ordering across v2 and v3: the v3 seq 2 run folds after the v2 seq 1 run.
    const v3Seq2 = { runId: RUN_B, events: [v3Header({ runId: RUN_B, seq: 2 })] };
    const v2Seq1: FoldRun = { runId: 'plan-x--k--c', events: [v2Started('plan-x--k--c', 1)] };
    expect(foldOrderRuns([v3Seq2, v2Seq1]).map((run) => run.runId)).toEqual([
      'plan-x--k--c',
      RUN_B,
    ]);
    // Duplicate seq across a v2 and a v3 run of one plan is corruption.
    expect(() =>
      foldOrderRuns([
        { runId: 'plan-x--k--c', events: [v2Started('plan-x--k--c', 1)] },
        { runId: RUN_B, events: [v3Header({ runId: RUN_B, seq: 1 })] },
      ]),
    ).toThrow(/duplicate seq/);
  });

  test('T02 unknown evidence', async () => {
    // Unknown future journal version fails the schema explicitly...
    const v4 = { ...v3Header(), journalVersion: 4 } as unknown as RunStartedV3JournalEvent;
    expect(RunStartedV3JournalEventSchema.safeParse(v4).success).toBe(false);
    expect(JournalEventSchema.safeParse(v4).success).toBe(false);
    // ...and the v1/v2 union keeps rejecting every v3 shape.
    expect(JournalEventV1V2Schema.safeParse(v3Header()).success).toBe(false);
    expect(JournalEventV1V2Schema.safeParse(approval()).success).toBe(false);

    // A v4 header that somehow lands in a run file is refused loudly — the
    // widened union has no journalVersion-4 member, so the line is corrupt.
    // (Written raw because the writer validates shapes it understands.)
    await withTempDir(async (dir) => {
      const raw = JSON.stringify({
        type: 'run-started',
        runId: RUN_A,
        at: AT,
        planId: 'plan-x',
        journalVersion: 4,
        seq: 1,
        governance: { attended: false },
      });
      await writeFile(join(dir, `${RUN_A}.ndjson`), `${raw}\n`, 'utf8');
      const log = openRunLog(dir);
      await expect(log.read(RUN_A)).rejects.toThrow(/corrupt line 1/u);
      // A synthesized FoldRun carrying the same unknown version fails the
      // fold dispatch explicitly (never silently bucketed).
      expect(() =>
        foldOrderRuns([
          {
            runId: RUN_A,
            events: [
              {
                type: 'run-started',
                runId: RUN_A,
                at: AT,
                planId: 'plan-x',
                journalVersion: 4,
                seq: 1,
              } as unknown as JournalEvent,
            ],
          },
        ]),
      ).toThrow(/unsupported journalVersion 4/u);
    });
  });

  test('T02 failure boundary', async () => {
    // Observational events NEVER alter job outcome derivation: the same
    // kernel stream derives identical statuses with and without them, and a
    // kernel stream of ONLY observational events derives no jobs at all.
    const kernel = [v1Started(), jobStarted('j1'), jobFinished('j1', { status: 'ok', value: 1 })];
    const observational = [approval(), measurement()];
    expect(deriveJobStatuses(kernel)).toEqual([{ jobId: 'j1', state: 'done' }]);
    expect(deriveJobStatuses([...kernel, ...observational])).toEqual(deriveJobStatuses(kernel));
    expect(deriveJobStatuses(observational)).toEqual([]);
    // Needs-human/indeterminate keeps its last derived state (frozen rule).
    expect(
      deriveJobStatuses([
        jobStarted('j1'),
        jobFinished('j1', { status: 'indeterminate', detail: 'flaky check' }),
        ...observational,
      ]),
    ).toEqual([{ jobId: 'j1', state: 'running' }]);
    // A v2 fixture folds through the SAME fold + derivation unchanged
    // (P3): at-irrelevant sequenced ordering, job statuses intact.
    const v2Fold: FoldRun = {
      runId: RUN_A,
      events: [
        v2Started(),
        jobStarted('j2'),
        jobFinished('j2', { status: 'failed', error: 'boom' }),
      ],
    };
    expect(foldOrderRuns([v2Fold]).map((run) => run.runId)).toEqual([RUN_A]);
    expect(deriveJobStatuses(v2Fold.events)).toEqual([{ jobId: 'j2', state: 'failed' }]);

    // A v3 run rides the same read path with the same torn-tail tolerance:
    // an unterminated trailing line is dropped; a corrupt complete line in
    // the middle still throws.
    await withTempDir(async (dir) => {
      const stream = [v3Header(), approval(), measurement()];
      await writeRaw(dir, RUN_A, stream);
      const raw = await readFile(join(dir, `${RUN_A}.ndjson`), 'utf8');
      await writeFile(
        join(dir, `${RUN_A}.ndjson`),
        `${raw}${JSON.stringify({ torn: true })}`,
        'utf8',
      );
      const log = openRunLog(dir);
      expect(await log.read(RUN_A)).toEqual(stream);
      // Reservations/sequence rules are untouched: the duplicate-seq refusal
      // from foldOrderRuns covers v3 exactly as v2 (pinned in round-trip),
      // and the full kernel replay path (statusOf) folds a v3 stream's
      // kernel events unchanged — observational events derive nothing.
      const dir2 = join(dir, 'replay');
      const log2 = openRunLog(dir2);
      await writeRaw(dir2, RUN_A, [
        v3Header(),
        jobStarted('j1'),
        jobFinished('j1', { status: 'failed', error: 'boom' }),
        measurement(),
      ]);
      expect(await log2.statusOf(RUN_A)).toEqual([{ jobId: 'j1', state: 'failed' }]);
    });
  });

  test('T02 per-file version strictness', async () => {
    await withTempDir(async (dir) => {
      const log = openRunLog(dir);
      // A v2 header refuses a v3-only observational line.
      await writeRaw(dir, RUN_A, [v2Started(), approval()]);
      await expect(log.read(RUN_A)).rejects.toThrow(/corrupt line 2.*approval-granted/u);
      // A v3-only line BEFORE any header is refused too (the header must be
      // first; a leading observational line is a broken stream).
      await writeRaw(dir, RUN_A, [approval(), v2Started()]);
      await expect(log.read(RUN_A)).rejects.toThrow(/corrupt line 1.*approval-granted/u);
      // A v1 header refuses a v3 run-started (a second header of the new era).
      await writeRaw(dir, RUN_B, [v1Started(RUN_B), v3Header({ runId: RUN_B })]);
      await expect(log.read(RUN_B)).rejects.toThrow(/corrupt line 2/u);
      // Any file refuses a second run-started (concatenated/forged stream).
      const dir2 = join(dir, 'dup');
      const log2 = openRunLog(dir2);
      await writeRaw(dir2, RUN_A, [v1Started(), v1Started()]);
      await expect(log2.read(RUN_A)).rejects.toThrow(/second run-started/u);
      // Sanity: the same v2 kernel stream WITHOUT the v3 line reads clean.
      const dir3 = join(dir, 'clean');
      const log3 = openRunLog(dir3);
      await writeRaw(dir3, RUN_A, [
        v2Started(),
        jobStarted('j1'),
        jobFinished('j1', { status: 'ok', value: 1 }),
      ]);
      expect(await log3.read(RUN_A)).toHaveLength(3);
    });
  });
});
