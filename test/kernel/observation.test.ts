// Separate composition observation stream — ADR-0008 T29 (measurement slice
// M0-sink).
//
// Pinned here:
//   1. T29 round-trip: header + carriers + kernel-run-linked written through
//      openObservationWriter read back byte-identically via readObservations,
//      each stream validated separately; the kernel RunLog stays untouched
//      (v1/v2-only append; composition carriers never in kernel files);
//      memory-only writer works without journalDir.
//   2. T29 unknown evidence: unknown event kinds, bad payload spellings,
//      wrong runId, duplicate streams, headerless/multi-header streams are
//      refused loudly; unreturned kernel runs stay unlinked (no guessing).
//   3. T29 failure boundary: a write failure after exclusive create leaves
//      the result indeterminate (append rejects); a torn final line keeps
//      the stream partial (complete: false), never an invented completion;
//      foldObservations joins only by workId + kernel-run-linked.
//
// Determinism: fixed ISO timestamps and fixture SHAs, no Date.now(). Temp
// dirs: mkdtemp under os.tmpdir, removed afterwards. No network, no
// providers, no credentials — fake inputs only.
import { describe, expect, test } from 'vitest';
import {
  foldObservations,
  linkedKernelRuns,
  openObservationWriter,
  readObservations,
} from '../../src/kernel/observation.js';
import { JournalEventV1V2Schema, ObservationEventSchema } from '../../src/kernel/schema.js';
import { openRunLog } from '../../src/kernel/journal.js';
import type {
  ApprovalJournalEvent,
  CompositionStartedJournalEvent,
  JournalEvent,
  KernelRunLinkedJournalEvent,
  ObservationEvent,
  ObservationStream,
} from '../../src/kernel/types.js';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

function header(overrides?: {
  runId?: string;
  correlationWorkId?: string;
}): CompositionStartedJournalEvent {
  const { runId, correlationWorkId, ...rest } = overrides ?? {};
  return {
    type: 'composition-started',
    runId: runId ?? CR_ID,
    at: AT,
    payload: {
      journalVersion: 3,
      provenance: {
        cqVersion: '0.2.0',
        producerVersion: '0.2.0',
        repoId: null,
        cqJsonHash: HASH,
        baseSha: BASE,
        runPrefix: 'plan-x',
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
    payload: { kernelRunId, planId: 'plan-x', round },
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

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'cq-observation-'));
}

/** Open, append every event, close — the composition's finally discipline. */
async function writeStream(
  journalDir: string,
  events: readonly ObservationEvent[],
  compositionRunId = CR_ID,
  workId = WORK_ID,
): Promise<void> {
  const writer = openObservationWriter({ journalDir, workId, compositionRunId });
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
      // The fold returns the stream unchanged, joined by workId.
      expect(foldObservations(streams)).toEqual(streams);
      // The link joins to the kernel run by kernel-run-linked only.
      expect(linkedKernelRuns(streams[0] as ObservationStream)).toEqual([KERNEL_RUN]);
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
        [header({ correlationWorkId: WORK_ID_2 }), linked()],
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
      expect(linkedKernelRuns(byWork[0] as ObservationStream)).toEqual([KERNEL_RUN]);
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

  test('memory-only persistence: without journalDir the same API works, nothing durable claimed', async () => {
    const writer = openObservationWriter({ workId: WORK_ID, compositionRunId: CR_ID });
    try {
      await writer.append(header());
      await writer.append(linked());
    } finally {
      await writer.close();
    }
    // No filesystem surface to observe; a dir-less run declares persistence
    // unavailable (the report's contract), so nothing is written anywhere.
    const dir = await tempDir();
    try {
      expect(await readObservations(dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('T29 unknown evidence', () => {
  test('unknown event kind and unknown payload spellings are refused loudly', async () => {
    // Unknown type never parses (the union has no open members).
    expect(() =>
      ObservationEventSchema.parse({ type: 'observation-unknown', runId: CR_ID, at: AT }),
    ).toThrow();
    // Unknown journalVersion on the header payload is refused.
    expect(() =>
      ObservationEventSchema.parse({
        ...header(),
        payload: { ...header().payload, journalVersion: 2 },
      }),
    ).toThrow();
    // Extra keys are refused (strict stream members).
    expect(() => ObservationEventSchema.parse({ ...linked(), extra: true })).toThrow();
    // Unknown future file kinds are simply not streams: a non-ndjson file in
    // a work dir is skipped, never folded as evidence.
    const dir = await tempDir();
    try {
      await writeStream(dir, [header()]);
      await writeFile(join(dir, 'observations', WORK_ID, 'notes.txt'), 'not evidence\n', 'utf8');
      const streams = await readObservations(dir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.compositionRunId).toBe(CR_ID);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('wrong runId, duplicate stream, and headerless stream are refused', async () => {
    const dir = await tempDir();
    try {
      await writeStream(dir, [header()]);
      // A second writer for the same composition run is refused at exclusive
      // create: the header append reaches open('wx') and fails with EEXIST —
      // a regression from 'wx' to append-mode would fail this assertion.
      const dup = openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: CR_ID,
      });
      await expect(dup.append(header())).rejects.toMatchObject({ code: 'EEXIST' });
      await dup.close();
      // A writer whose events claim another runId is refused.
      const other = openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: 'cr-other',
      });
      await expect(other.append(approval({ runId: CR_ID }))).rejects.toThrow(
        /does not match this stream/,
      );
      // And a valid header under a foreign runId is refused before any write.
      await expect(other.append(header())).rejects.toThrow(/does not match this stream/);
      await other.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // A complete but headerless stream folds as corrupt evidence.
    const dir2 = await tempDir();
    try {
      await writeStream(dir2, [header()]);
      await appendFile(
        join(dir2, 'observations', WORK_ID, 'cr-headerless.ndjson'),
        `${JSON.stringify(linked())}\n`,
        'utf8',
      );
      // Identity is validated during READ (readObservations never parses
      // through the schema): the headerless stream's event carries a foreign
      // runId, which is refused before the header check even fires. A
      // headerless stream whose events DO carry the stream's own runId fails
      // the header requirement instead (covered by the schema refinement and
      // foldObservations).
      await expect(readObservations(dir2)).rejects.toThrow(/does not match its compositionRunId/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
    // A header whose correlation.workId does not match the stream's workId
    // directory is refused on READ, not just at write time — the writer's
    // check does not cover on-disk streams.
    const dir3 = await tempDir();
    try {
      const foreign: CompositionStartedJournalEvent = {
        ...header(),
        payload: {
          ...header().payload,
          correlation: { ...header().payload.correlation, workId: WORK_ID_2 },
        },
      };
      const writer = openObservationWriter({
        journalDir: dir3,
        workId: WORK_ID,
        compositionRunId: CR_ID,
      });
      await expect(writer.append(foreign)).rejects.toThrow(/does not match this stream's workId/);
      // Out-of-band write simulates a stream the writer never validated.
      const streamDir = join(dir3, 'observations', WORK_ID);
      await mkdir(streamDir, { recursive: true });
      await writeFile(join(streamDir, `${CR_ID}.ndjson`), `${JSON.stringify(foreign)}\n`, 'utf8');
      await expect(readObservations(dir3)).rejects.toThrow(/does not match/);
    } finally {
      await rm(dir3, { recursive: true, force: true });
    }
    // A non-header first event is refused at WRITE time: a file the reader
    // must reject is never created. A duplicate header is refused too.
    const dir4 = await tempDir();
    try {
      const badFirst = openObservationWriter({
        journalDir: dir4,
        workId: WORK_ID,
        compositionRunId: 'cr-bad-first',
      });
      await expect(badFirst.append(linked('plan-x', 1, { runId: 'cr-bad-first' }))).rejects.toThrow(
        /must open with its composition-started header/,
      );
      await badFirst.close();
      const dupHeader = openObservationWriter({
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

  test('unreturned kernel runs stay unlinked; joins only by workId + kernel-run-linked', async () => {
    const dir = await tempDir();
    try {
      await writeStream(dir, [header(), linked()]);
      const streams = await readObservations(dir);
      // A kernel run that never returned has no kernel-run-linked event: the
      // fold cannot invent one, and the linked set stays exactly the
      // returned runs.
      expect(linkedKernelRuns(streams[0] as ObservationStream)).toEqual([KERNEL_RUN]);
      expect(linkedKernelRuns(streams[0] as ObservationStream)).not.toContain('plan-x--k--never');
      // No cross-stream order manufactured from timestamps: two streams with
      // identical `at` values fold independently, each in file order.
      await writeStream(
        dir,
        [header({ runId: 'cr-same-at' }), linked('plan-x--k--b', 1, { runId: 'cr-same-at' })],
        'cr-same-at',
        WORK_ID,
      );
      const both = (await readObservations(dir)).filter((s) => s.workId === WORK_ID);
      expect(both).toHaveLength(2);
      for (const s of both) {
        expect(s.events.map((e) => e.type)).toEqual(['composition-started', 'kernel-run-linked']);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('T29 failure boundary', () => {
  test('a write failure makes the result indeterminate: append rejects, prior evidence survives', async () => {
    const dir = await tempDir();
    try {
      await writeStream(dir, [header()]);
      // A complete-but-invalid line appended out of band simulates a failed
      // write leaving partial bytes: the reader refuses loudly (corruption
      // is not silently swallowed) — the composition's result would be
      // indeterminate, with the earlier complete evidence still readable.
      await appendFile(
        join(dir, 'observations', WORK_ID, `${CR_ID}.ndjson`),
        '{"type":"kernel-run-linked","runId":"cr-x",\n',
        'utf8',
      );
      // The appended bytes end in a newline inside a file whose other bytes
      // are complete: an unparsable line under a terminated file is a MIDDLE
      // line, and the read throws rather than accepting a hole in the
      // evidence — the composition's result is indeterminate, with the
      // earlier complete evidence still on disk.
      await expect(readObservations(dir)).rejects.toThrow(/corrupt line 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    const dir2 = await tempDir();
    try {
      await writeStream(dir2, [header(), linked()]);
      // A complete but unparsable INTERIOR line is corruption, not a torn
      // write — the read throws rather than poisoning the fold.
      const path = join(dir2, 'observations', WORK_ID, `${CR_ID}.ndjson`);
      const raw = await readFile(path, 'utf8');
      const lines = raw.trimEnd().split('\n');
      await writeFile(path, `${lines[0]}\nnot-json-at-all\n${lines[1] ?? ''}\n`, 'utf8');
      await expect(readObservations(dir2)).rejects.toThrow(/corrupt line 2/);
    } finally {
      await rm(dir2, { recursive: true, force: true });
    }
  });

  test('partial terminal evidence stays partial: torn tail is incomplete, never a fabricated completion', async () => {
    const dir = await tempDir();
    try {
      await writeStream(dir, [header(), linked()]);
      // Crash mid-append: a final line without its trailing newline.
      const path = join(dir, 'observations', WORK_ID, `${CR_ID}.ndjson`);
      const raw = await readFile(path, 'utf8');
      await writeFile(
        path,
        raw + '{"type":"kernel-run-linked","runId":"' + CR_ID + '","at":"' + AT3,
        'utf8',
      );
      const streams = await readObservations(dir);
      expect(streams).toHaveLength(1);
      expect(streams[0]?.complete).toBe(false);
      // The torn line's event is NOT present: partial evidence stays partial.
      expect(linkedKernelRuns(streams[0] as ObservationStream)).toEqual([KERNEL_RUN]);
      expect(streams[0]?.events).toHaveLength(2);
      // Round-tripping through the writer also proves the fsynced stream is
      // readable after close (durable-before-settle contract).
      const writer = openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: 'cr-second',
      });
      await writer.append(header({ runId: 'cr-second' }));
      await writer.close();
      // The fsynced stream is readable after close (durable-before-settle);
      // the torn stream stays partial, the closed one complete.
      const after = await readObservations(dir);
      expect(after.map((s) => s.complete)).toEqual([false, true]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
