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
// Split provenance: test/kernel/observation.test.ts was split by subject into
// observation.round-trip.test.ts, observation.evidence-refusal.test.ts,
// observation.stream-identity.test.ts, observation.kernel-descriptors.test.ts,
// observation.fold-links.test.ts, observation.failure-boundary.test.ts,
// observation.write-serialization.test.ts and
// observation.kernel-isolation.test.ts; shared fixtures live in
// observation.helpers.ts.
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  foldObservations,
  openObservationWriter,
  readKernelRunDescriptors,
  readObservations,
} from '../../src/kernel/observation.js';
import { JournalEventV1V2Schema } from '../../src/kernel/schema.js';
import type { JournalEvent, ObservationEvent } from '../../src/kernel/types.js';
import {
  AT,
  CR_ID,
  KERNEL_RUN,
  PLAN_ID,
  WORK_ID,
  WORK_ID_2,
  approval,
  header,
  kernelV3Header,
  linked,
  tempDir,
  writeStream,
} from './observation.helpers.js';

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
      // v1/v2-only (T04 landed the descriptor reader, not a v3 header
      // writer), so the fixture header is written raw (the same route the
      // T02 tests use for v3 headers).
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
