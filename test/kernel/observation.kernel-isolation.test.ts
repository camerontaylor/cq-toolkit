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
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { foldOrderRuns, openRunLog } from '../../src/kernel/journal.js';
import { readObservations } from '../../src/kernel/observation.js';
import { JournalEventV1V2Schema, RunStartedV3JournalEventSchema } from '../../src/kernel/schema.js';
import type { JournalEvent } from '../../src/kernel/types.js';
import {
  AT,
  KERNEL_RUN,
  header,
  kernelV3Header,
  linked,
  tempDir,
  writeStream,
} from './observation.helpers.js';

describe('T29 kernel isolation (P2-5)', () => {
  test('runs(), read(), statusOf() and foldOrderRuns are identical with and without an observations/ subtree', async () => {
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
      // foldOrderRuns requires each run to open with its run-started header:
      // written raw in both dirs (the RunLog's append stays v1/v2-only
      // until T04) — identical bytes on both sides.
      const v3HeaderLine = `${JSON.stringify(kernelV3Header())}\n`;
      await writeFile(join(withObs, `${KERNEL_RUN}.ndjson`), v3HeaderLine, 'utf8');
      await writeFile(join(withoutObs, `${KERNEL_RUN}.ndjson`), v3HeaderLine, 'utf8');
      await writeStream(withObs, [header()]);
      const runsA = await runLogA.runs();
      const runsB = await runLogB.runs();
      expect(runsA).toEqual(runsB);
      expect(runsA).toEqual([KERNEL_RUN]);
      expect(await runLogA.read(KERNEL_RUN)).toEqual(await runLogB.read(KERNEL_RUN));
      // The fold over kernel runs (foldOrderRuns) is identical too: the
      // observations/ subtree cannot reorder or disturb kernel evidence.
      const foldA = foldOrderRuns(
        await runLogA
          .runs()
          .then((ids) =>
            Promise.all(ids.map(async (id) => ({ runId: id, events: await runLogA.read(id) }))),
          ),
      );
      const foldB = foldOrderRuns(
        await runLogB
          .runs()
          .then((ids) =>
            Promise.all(ids.map(async (id) => ({ runId: id, events: await runLogB.read(id) }))),
          ),
      );
      expect(foldA).toEqual(foldB);
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
      // Composition carriers are not members of the kernel union at all:
      // JournalEventSchema rejects them.
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
      // A REAL v3 kernel file carrying a composition carrier is refused by
      // the kernel reader itself (readEvents throws on the line): write a
      // valid v3 header then a composition-started carrier beneath it, and
      // assert runLog.read() throws rather than folding the carrier.
      const kernelHeader = kernelV3Header();
      await writeFile(
        join(dir, `${KERNEL_RUN}.ndjson`),
        `${JSON.stringify(kernelHeader)}\n${JSON.stringify(header({ runId: KERNEL_RUN }))}\n`,
        'utf8',
      );
      await expect(runLog.read(KERNEL_RUN)).rejects.toThrow(/corrupt line 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
