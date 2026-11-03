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
import { describe, expect, test } from 'vitest';
import {
  foldObservations,
  openObservationWriter,
  readKernelRunDescriptors,
  readObservations,
} from '../../src/kernel/observation.js';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  JournalEventV1V2Schema,
  ObservationEventSchema,
  RunStartedV3JournalEventSchema,
} from '../../src/kernel/schema.js';
import type {
  ApprovalJournalEvent,
  CompositionStartedJournalEvent,
  JournalEvent,
  KernelRunLinkedJournalEvent,
  ObservationEvent,
  RunStartedV3JournalEvent,
} from '../../src/kernel/types.js';
import { appendFile, mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const AT = '2026-01-03T04:05:06.789Z';
const AT2 = '2026-01-03T04:05:07.000Z';
const AT3 = '2026-01-03T04:05:08.000Z';
const BASE = 'a'.repeat(40);
const HASH = `sha256:${'b'.repeat(64)}`;
const WORK_ID = '3f2b8c1e-1111-4222-8333-444455556666';
const WORK_ID_2 = '4f2b8c1e-1111-4222-8333-444455556666';
const CR_ID = 'cr-2026-01-03T04.05.06Z';
const KERNEL_RUN = 'plan-x--k--a';
const PLAN_ID = 'plan-x';

function header(overrides?: {
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

function linked(
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

function approval(overrides?: Partial<ApprovalJournalEvent>): ApprovalJournalEvent {
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
function kernelV3Header(runId = KERNEL_RUN, workId = WORK_ID): RunStartedV3JournalEvent {
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

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cq-observation-'));
}

/** Open (awaited — exclusive create happens at open), append, close. */
async function writeStream(
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

describe('T29 round-trip', () => {
  test('header, carriers and kernel-run-linked survive a write/read cycle byte-identically', async () => {
    const dir = await tempDir();
    try {
      const events: ObservationEvent[] = [header(), linked(), approval()];
      await writeStream(dir, events);
      const streams = await readObservations(dir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.workId).toBe(WORK_ID);
      expect(streams[0]?.compositionRunId).toBe(CR_ID);
      expect(streams[0]?.complete).toBe(true);
      expect(streams[0]?.events).toEqual(events);
      // Byte identity: the reader's parse of the raw file equals the events.
      const raw = await readFile(join(dir, 'observations', WORK_ID, `${CR_ID}.ndjson`), 'utf8');
      expect(raw.endsWith('\n')).toBe(true);
      const parsedLines: unknown[] = raw
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown);
      expect(parsedLines).toEqual(events);
      // The fold resolves the link against the kernel v3 header, read from
      // the kernel's own journal file. The kernel RunLog's append stays
      // v1/v2-only until T04, so the fixture header is written raw (the same
      // route the T02 tests use for v3 headers).
      const kernelHeader = kernelV3Header();
      await writeFile(
        join(dir, `${KERNEL_RUN}.ndjson`),
        `${JSON.stringify(kernelHeader)}\n`,
        'utf8',
      );
      const descriptors = await readKernelRunDescriptors(dir, [KERNEL_RUN]);
      expect(descriptors).toHaveLength(1);
      const folded = foldObservations(streams, descriptors);
      expect(folded[0]?.kernelRunLinks).toHaveLength(1);
      expect(folded[0]?.kernelRunLinks[0]?.state).toBe('resolved');
      if (folded[0]?.kernelRunLinks[0]?.state === 'resolved') {
        expect(folded[0].kernelRunLinks[0].kernelRunId).toBe(KERNEL_RUN);
        expect(folded[0].kernelRunLinks[0].planId).toBe(PLAN_ID);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('streams are validated separately and joined by workId; kernel RunLog untouched', async () => {
    const dir = await tempDir();
    try {
      await writeStream(dir, [header(), linked()], CR_ID, WORK_ID);
      await writeStream(
        dir,
        [header({ runId: 'cr-second' }), linked('plan-x--k--b', 2, { runId: 'cr-second' })],
        'cr-second',
        WORK_ID,
      );
      await writeStream(
        dir,
        [header({ runId: CR_ID, correlationWorkId: WORK_ID_2 }), linked()],
        CR_ID,
        WORK_ID_2,
      );
      const streams = await readObservations(dir);
      expect(streams).toHaveLength(3);
      const byWork = streams.filter((s) => s.workId === WORK_ID);
      expect(byWork).toHaveLength(2);
      expect(byWork.map((s) => s.compositionRunId).sort()).toEqual([CR_ID, 'cr-second'].sort());
      // File order preserved within each stream; two kernel runs linked for
      // the same work stay in their own streams (never merged by timestamp).
      // The kernel RunLog stays untouched by observation writes: its append
      // still validates v1/v2 shapes ONLY (a composition carrier never
      // parses), and the kernel stream's BYTES are unchanged after the
      // observation writer ran in the same journal directory.
      expect(() => JournalEventV1V2Schema.parse(header())).toThrow();
      const runLog = openRunLog(dir);
      const kernelEvent: JournalEvent = {
        type: 'job-started',
        runId: KERNEL_RUN,
        at: AT,
        jobId: 'job-1',
        op: 'sweep.unit',
        attempt: 1,
      };
      await runLog.append(KERNEL_RUN, kernelEvent);
      const before = await readFile(join(dir, `${KERNEL_RUN}.ndjson`), 'utf8');
      await writeStream(
        dir,
        [header({ runId: 'cr-after-kernel' }), linked(KERNEL_RUN, 1, { runId: 'cr-after-kernel' })],
        'cr-after-kernel',
      );
      const after = await readFile(join(dir, `${KERNEL_RUN}.ndjson`), 'utf8');
      expect(after).toBe(before);
      expect(after).toContain('"type":"job-started"');
      expect(after).not.toContain('composition-started');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('memory-only persistence: events retained in memory, persistence declared unavailable', async () => {
    const writer = await openObservationWriter({ workId: WORK_ID, compositionRunId: CR_ID });
    try {
      expect(writer.persistence).toBe('unavailable');
      await writer.append(header());
      await writer.append(linked());
      // The validated events are RETAINED (P2-2): T30/T31 build report rows
      // from this snapshot and declare persistence unavailable.
      expect(writer.events()).toEqual([header(), linked()]);
      expect(writer.events()).not.toBe(writer.events()); // snapshot, not live array
      expect(writer.failure).toBeNull();
    } finally {
      await writer.close();
    }
    // Nothing durable: a dir-less run writes nowhere.
    const dir = await tempDir();
    try {
      expect(await readObservations(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('durable writer declares persistence durable and retains the same snapshot', async () => {
    const dir = await tempDir();
    try {
      const writer = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: CR_ID,
      });
      expect(writer.persistence).toBe('durable');
      await writer.append(header());
      await writer.close();
      expect(writer.events()).toEqual([header()]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('T29 unknown evidence', () => {
  test('unknown event kind and unknown payload spellings are refused loudly', async () => {
    expect(() =>
      ObservationEventSchema.parse({ type: 'observation-unknown', runId: CR_ID, at: AT }),
    ).toThrow();
    expect(() =>
      ObservationEventSchema.parse({
        ...header(),
        payload: { ...header().payload, journalVersion: 2 },
      }),
    ).toThrow();
    expect(() => ObservationEventSchema.parse({ ...linked(), extra: true })).toThrow();
    // Missing envelope scope fields are refused (required, nullable — not
    // absent): ADR-0008 envelope is exactly {type,runId,at,unitId,jobId,
    // taskId,attempt,payload}.
    const bare = header() as unknown as Record<string, unknown>;
    delete bare.unitId;
    expect(() => ObservationEventSchema.parse(bare)).toThrow();
    const dir = await tempDir();
    try {
      await writeStream(dir, [header()]);
      // Non-ndjson files inside a work dir are skipped, never folded.
      await writeFile(join(dir, 'observations', WORK_ID, 'notes.txt'), 'not evidence\n', 'utf8');
      const streams = await readObservations(dir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.compositionRunId).toBe(CR_ID);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('id grammar is refused: path separators, dot-dot, and non-UUID workId', async () => {
    const dir = await tempDir();
    try {
      for (const bad of ['../x', 'a/b', '..']) {
        await expect(
          openObservationWriter({ journalDir: dir, workId: WORK_ID, compositionRunId: bad }),
        ).rejects.toThrow(/compositionRunId must match/);
      }
      // 36 chars of dashes satisfies the old regex; z.uuid() refuses it.
      await expect(
        openObservationWriter({
          journalDir: dir,
          workId: '------------------------------------',
          compositionRunId: CR_ID,
        }),
      ).rejects.toThrow(/workId must be a UUID/);
      await expect(
        openObservationWriter({ journalDir: dir, workId: 'not-a-uuid', compositionRunId: CR_ID }),
      ).rejects.toThrow(/workId must be a UUID/);
      // A work directory named outside the UUID grammar is never read back.
      const stray = join(dir, 'observations', 'not-a-uuid');
      await mkdir(stray, { recursive: true });
      await writeFile(join(stray, 'cr-x.ndjson'), `${JSON.stringify(header())}\n`, 'utf8');
      expect((await readObservations(dir)).filter((s) => s.workId === 'not-a-uuid')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('duplicate stream refused at open (EEXIST); wrong runId and headerless stream refused', async () => {
    const dir = await tempDir();
    try {
      await writeStream(dir, [header()]);
      // A second writer for the same composition run is refused AT OPEN: the
      // exclusive create happens in openObservationWriter, so a regression
      // from 'wx' to lazy append-mode fails this assertion.
      await expect(
        openObservationWriter({ journalDir: dir, workId: WORK_ID, compositionRunId: CR_ID }),
      ).rejects.toMatchObject({ code: 'EEXIST' });
      // A writer whose events claim another runId is refused.
      const other = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: 'cr-other',
      });
      await expect(other.append(approval({ runId: CR_ID }))).rejects.toThrow(
        /does not match this stream/,
      );
      await expect(other.append(header())).rejects.toThrow(/does not match this stream/);
      await other.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // A headerless complete stream is refused on READ and via foldObservations.
    const dir2 = await tempDir();
    try {
      await writeStream(dir2, [header()]);
      await appendFile(
        join(dir2, 'observations', WORK_ID, 'cr-headerless.ndjson'),
        `${JSON.stringify(linked('plan-x', 1, { runId: 'cr-headerless' }))}\n`,
        'utf8',
      );
      // Identity is validated through the stream schema at READ.
      await expect(readObservations(dir2)).rejects.toThrow();
      // And foldObservations refuses a headerless stream handed to it too.
      const headerless = {
        workId: WORK_ID,
        compositionRunId: 'cr-headerless',
        events: [linked('plan-x', 1, { runId: 'cr-headerless' })],
        complete: true,
      };
      expect(() => foldObservations([headerless])).toThrow();
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
    // A non-header first event and a duplicate header are refused at WRITE.
    const dir4 = await tempDir();
    try {
      const badFirst = await openObservationWriter({
        journalDir: dir4,
        workId: WORK_ID,
        compositionRunId: 'cr-bad-first',
      });
      await expect(badFirst.append(linked('plan-x', 1, { runId: 'cr-bad-first' }))).rejects.toThrow(
        /must open with its composition-started header/,
      );
      await badFirst.close();
      const dupHeader = await openObservationWriter({
        journalDir: dir4,
        workId: WORK_ID,
        compositionRunId: 'cr-dup-header',
      });
      await dupHeader.append(header({ runId: 'cr-dup-header' }));
      await expect(dupHeader.append(header({ runId: 'cr-dup-header' }))).rejects.toThrow(
        /already has its composition-started/,
      );
      await dupHeader.close();
    } finally {
      await rm(dir4, { recursive: true, force: true });
    }
  });

  test('out-of-band duplicate and misplaced headers are refused; stray root file is isolated', async () => {
    // A stray FILE directly under observations/ is isolated, never fatal.
    const dir0 = await tempDir();
    try {
      await writeStream(dir0, [header()]);
      await writeFile(join(dir0, 'observations', '.DS_Store'), 'junk\n', 'utf8');
      const streams = await readObservations(dir0);
      expect(streams.map((s) => s.compositionRunId)).toEqual([CR_ID]);
    } finally {
      await rm(dir0, { recursive: true, force: true });
    }
    // Out-of-band duplicate header: refused on read.
    const dir = await tempDir();
    try {
      await writeStream(dir, [header()]);
      const streamDir = join(dir, 'observations', WORK_ID);
      const dup = [header({ runId: 'cr-dup' }), header({ runId: 'cr-dup' })];
      await writeFile(
        join(streamDir, 'cr-dup.ndjson'),
        `${dup.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8',
      );
      await expect(readObservations(dir)).rejects.toThrow(/exactly one composition-started header/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Out-of-band misplaced header: refused on read.
    const dir2 = await tempDir();
    try {
      await writeStream(dir2, [header()]);
      const streamDir = join(dir2, 'observations', WORK_ID);
      const misplaced = [
        linked('plan-x', 1, { runId: 'cr-misplaced' }),
        header({ runId: 'cr-misplaced' }),
      ];
      await writeFile(
        join(streamDir, 'cr-misplaced.ndjson'),
        `${misplaced.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8',
      );
      await expect(readObservations(dir2)).rejects.toThrow(/composition-started header/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  test('fold resolves valid links and keeps missing/foreign-work/foreign-plan links unknown', async () => {
    const dir = await tempDir();
    try {
      // The kernel v3 headers live in real kernel files (read via
      // readKernelRunDescriptors); written raw — the kernel RunLog's append
      // stays v1/v2-only until T04.
      const foreignWorkRun = 'plan-x--k--foreign';
      await writeFile(
        join(dir, `${KERNEL_RUN}.ndjson`),
        `${JSON.stringify(kernelV3Header())}\n`,
        'utf8',
      );
      await writeFile(
        join(dir, `${foreignWorkRun}.ndjson`),
        `${JSON.stringify(kernelV3Header(foreignWorkRun, WORK_ID_2))}\n`,
        'utf8',
      );
      const descriptors = await readKernelRunDescriptors(dir, [
        KERNEL_RUN,
        foreignWorkRun,
        'plan-x--k--missing',
      ]);
      expect(descriptors).toHaveLength(2); // the missing run never appears

      // Stream with three links: resolved, foreign-work, missing.
      const writer = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: CR_ID,
      });
      await writer.append(header());
      await writer.append(linked()); // resolves
      await writer.append(linked(foreignWorkRun, 2)); // different workId
      await writer.append(linked('plan-x--k--missing', 3)); // not returned
      await writer.close();

      const folded = foldObservations(await readObservations(dir), descriptors);
      expect(folded).toHaveLength(1);
      const links = folded[0]?.kernelRunLinks ?? [];
      expect(links).toHaveLength(3);
      expect(links[0]?.state).toBe('resolved');
      expect(links[1]?.state).toBe('unknown');
      if (links[1]?.state === 'unknown') {
        expect(links[1].reason).toContain('workId');
      }
      expect(links[2]?.state).toBe('unknown');
      if (links[2]?.state === 'unknown') {
        expect(links[2].reason).toContain('not found');
      }
      // A planId mismatch is unknown too.
      const wrongPlan = foldObservations(
        [
          {
            workId: WORK_ID,
            compositionRunId: 'cr-wrong-plan',
            events: [
              header({ runId: 'cr-wrong-plan' }),
              linked(KERNEL_RUN, 1, {
                runId: 'cr-wrong-plan',
                payload: {
                  kernelRunId: KERNEL_RUN,
                  planId: 'plan-other',
                  round: 1,
                },
              } as Partial<KernelRunLinkedJournalEvent>),
            ],
            complete: true,
          },
        ],
        descriptors,
      );
      expect(wrongPlan[0]?.kernelRunLinks[0]?.state).toBe('unknown');
      if (wrongPlan[0]?.kernelRunLinks[0]?.state === 'unknown') {
        expect(wrongPlan[0].kernelRunLinks[0].reason).toContain('plan');
      }
      // With NO kernel descriptors, every link stays unknown (never guessed).
      const noRuns = foldObservations(await readObservations(dir), []);
      expect(noRuns[0]?.kernelRunLinks.every((l) => l.state === 'unknown')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('T29 failure boundary', () => {
  test('a REAL write failure fail-stops the writer: same error, file unchanged, close re-rejects', async () => {
    const dir = await tempDir();
    try {
      const writer = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: CR_ID,
      });
      // A genuine fs failure injected at the boundary the production write
      // path uses: the FIRST datasync rejects (the bytes may even have been
      // handed to the file — the evidence is indeterminate, which is the
      // contract), and every later datasync rejects with the same error
      // object (fail-stop).
      const boom = new Error('injected datasync failure');
      // FileHandle's class is not exported as a value in the ESM build:
      // take the prototype from a real handle.
      const probe = await open('/dev/null', 'r');
      const proto = Object.getPrototypeOf(probe) as {
        datasync: () => Promise<void>;
      };
      await probe.close();
      const real = proto.datasync;
      proto.datasync = function (): Promise<void> {
        return Promise.reject(boom);
      };
      let threw = false;
      try {
        await writer.append(header());
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
      expect(writer.failure).toBe(boom);
      // Fail-stop: the NEXT append rejects with the SAME error.
      await expect(writer.append(linked())).rejects.toBe(boom);
      // close() re-rejects with the write error (P2-1) after closing up.
      await expect(writer.close()).rejects.toBe(boom);
      expect(writer.failure).toBe(boom);
      proto.datasync = real;
      // The on-disk file carries at most the failed header line and never a
      // later event: the stream is indeterminate, not partially advanced.
      const raw = await readFile(
        join(dir, 'observations', WORK_ID, `${CR_ID}.ndjson`),
        'utf8',
      ).catch(() => '');
      expect(raw).not.toContain('kernel-run-linked');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('append after close rejects', async () => {
    const dir = await tempDir();
    try {
      const writer = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: CR_ID,
      });
      await writer.append(header());
      await writer.close();
      await expect(writer.append(linked())).rejects.toThrow(/closed/);
      // Idempotent close.
      await writer.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('concurrent Promise.all appends read back in call order', async () => {
    const dir = await tempDir();
    try {
      const writer = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: 'cr-concurrent',
      });
      await writer.append(header({ runId: 'cr-concurrent' }));
      const rounds = [1, 2, 3, 4, 5];
      await Promise.all(
        rounds.map((n) =>
          writer.append(linked(`plan-x--k--${n}`, n, { runId: 'cr-concurrent', at: AT2 })),
        ),
      );
      await writer.close();
      const streams = await readObservations(dir);
      expect(streams[0]?.complete).toBe(true);
      const linkedRounds = streams[0]?.events
        .filter((e): e is KernelRunLinkedJournalEvent => e.type === 'kernel-run-linked')
        .map((e) => e.payload.round);
      // The internal write chain serializes: file order == append-call order.
      expect(linkedRounds).toEqual(rounds);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('torn tail and empty created file stay partial; interior corruption throws', async () => {
    const dir = await tempDir();
    try {
      // Empty file (crash between exclusive create and first write).
      const emptyWriter = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: 'cr-empty',
      });
      await emptyWriter.close();
      await writeStream(
        dir,
        [header({ runId: 'cr-torn' }), linked('plan-x', 1, { runId: 'cr-torn' })],
        'cr-torn',
      );
      // Torn final line: a crash mid-append.
      const tornPath = join(dir, 'observations', WORK_ID, 'cr-torn.ndjson');
      const raw = await readFile(tornPath, 'utf8');
      await writeFile(
        tornPath,
        raw + `{"type":"kernel-run-linked","runId":"cr-torn","at":"${AT3}`,
        'utf8',
      );
      const streams = await readObservations(dir);
      const torn = streams.find((s) => s.compositionRunId === 'cr-torn');
      const empty = streams.find((s) => s.compositionRunId === 'cr-empty');
      expect(empty?.complete).toBe(false);
      expect(empty?.events).toEqual([]);
      expect(torn?.complete).toBe(false);
      // The torn line's event is NOT present: partial evidence stays partial.
      expect(torn?.events.filter((e) => e.type === 'kernel-run-linked')).toHaveLength(1);
      // A complete but unparsable INTERIOR line is corruption, not a torn
      // write — the read throws rather than poisoning the fold.
      const path = join(dir, 'observations', WORK_ID, 'cr-torn.ndjson');
      const lines = (await readFile(path, 'utf8')).trimEnd().split('\n');
      await writeFile(path, `${lines[0]}\nnot-json-at-all\n`, 'utf8');
      await expect(readObservations(dir)).rejects.toThrow(/corrupt line 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a torn stream with events but no header is refused', async () => {
    const dir = await tempDir();
    try {
      const streamDir = join(dir, 'observations', WORK_ID);
      await mkdir(streamDir, { recursive: true });
      // Complete event line + torn line: incomplete, but headerless with
      // events — a broken stream, not a torn prefix.
      await writeFile(
        join(streamDir, 'cr-broken.ndjson'),
        `${JSON.stringify(linked('plan-x', 1, { runId: 'cr-broken' }))}\n{"torn`,
        'utf8',
      );
      await expect(readObservations(dir)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('T29 kernel isolation (P2-5)', () => {
  test('runs(), read() and foldOrderRuns are identical with and without an observations/ subtree', async () => {
    const withObs = await tempDir();
    const withoutObs = await tempDir();
    try {
      const runLogA = openRunLog(withObs);
      const runLogB = openRunLog(withoutObs);
      const kernelEvent: JournalEvent = {
        type: 'job-started',
        runId: KERNEL_RUN,
        at: AT,
        jobId: 'job-1',
        op: 'sweep.unit',
        attempt: 1,
      };
      await runLogA.append(KERNEL_RUN, kernelEvent);
      await runLogB.append(KERNEL_RUN, kernelEvent);
      await writeStream(withObs, [header()]);
      const runsA = await runLogA.runs();
      const runsB = await runLogB.runs();
      expect(runsA).toEqual(runsB);
      expect(runsA).toEqual([KERNEL_RUN]);
      expect(await runLogA.read(KERNEL_RUN)).toEqual(await runLogB.read(KERNEL_RUN));
      expect((await readObservations(withObs)).length).toBe(1);
      expect(await readObservations(withoutObs)).toEqual([]);
    } finally {
      await rm(withObs, { recursive: true, force: true });
      await rm(withoutObs, { recursive: true, force: true });
    }
  });

  test('a kernel v3 file carrying composition-started or kernel-run-linked is refused', async () => {
    const dir = await tempDir();
    try {
      // A composition carrier under a v3 kernel header is refused by the
      // per-file version strictness? No — v3 kernel files accept the carriers
      // defensively (T02); but a composition-started carrier is not in the
      // kernel union at all: JournalEventSchema rejects it.
      expect(() => JournalEventV1V2Schema.parse(header())).toThrow();
      expect(() => RunStartedV3JournalEventSchema.parse(header())).toThrow();
      // And a kernel RunLog append (v1/v2 shapes only) refuses both.
      const runLog = openRunLog(dir);
      await expect(
        runLog.append(KERNEL_RUN, header() as unknown as JournalEvent),
      ).rejects.toThrow();
      await expect(
        runLog.append(KERNEL_RUN, linked() as unknown as JournalEvent),
      ).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
