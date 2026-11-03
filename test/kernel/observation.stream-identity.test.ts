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
import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  foldObservations,
  openObservationWriter,
  readObservations,
} from '../../src/kernel/observation.js';
import {
  CR_ID,
  KERNEL_RUN,
  WORK_ID,
  WORK_ID_2,
  approval,
  header,
  linked,
  tempDir,
  writeStream,
} from './observation.helpers.js';

describe('T29 unknown evidence', () => {
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
      await expect(other.close()).resolves.toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
    // Write-time rejection of a header claiming a FOREIGN correlation.workId:
    // the stream file lives under its workId, so a foreign-workId header
    // would misattribute the whole stream at the join.
    const dirFk = await tempDir();
    try {
      const writer = await openObservationWriter({
        journalDir: dirFk,
        workId: WORK_ID,
        compositionRunId: 'cr-foreign-work',
      });
      await expect(
        writer.append(header({ runId: 'cr-foreign-work', correlationWorkId: WORK_ID_2 })),
      ).rejects.toThrow(/does not match this stream's workId/);
      await writer.close();
      // Nothing landed: the file may exist (exclusive create) but no event.
      const raw = await readFile(
        join(dirFk, 'observations', WORK_ID, 'cr-foreign-work.ndjson'),
        'utf8',
      ).catch(() => '');
      expect(raw).toBe('');
      // The same foreign-workId header written OUT OF BAND is refused at
      // READ by the stream schema (header workId vs directory workId).
      const streamDir = join(dirFk, 'observations', WORK_ID);
      await writeFile(
        join(streamDir, 'cr-oob-foreign.ndjson'),
        `${JSON.stringify(header({ runId: 'cr-oob-foreign', correlationWorkId: WORK_ID_2 }))}\n`,
        'utf8',
      );
      await expect(readObservations(dirFk)).rejects.toThrow(/does not match this stream's workId/);
    } finally {
      await rm(dirFk, { recursive: true, force: true });
    }
    // An out-of-band COMPLETE stream with a valid header but a LATER event
    // claiming another runId is misattributed evidence — refused at READ.
    const dirRr = await tempDir();
    try {
      const streamDir = join(dirRr, 'observations', WORK_ID);
      await mkdir(streamDir, { recursive: true });
      const foreignRunId = [
        header({ runId: 'cr-oob' }),
        linked(KERNEL_RUN, 1, { runId: 'cr-other' }),
      ];
      await writeFile(
        join(streamDir, 'cr-oob.ndjson'),
        `${foreignRunId.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8',
      );
      await expect(readObservations(dirRr)).rejects.toThrow(
        /does not match this stream's compositionRunId/,
      );
    } finally {
      await rm(dirRr, { recursive: true, force: true });
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
      // Identity is validated through the stream schema at READ: the
      // headerless stream fails the header-first coupling.
      await expect(readObservations(dir2)).rejects.toThrow(
        /exactly one composition-started header/,
      );
      // And foldObservations refuses a headerless stream handed to it too.
      const headerless = {
        workId: WORK_ID,
        compositionRunId: 'cr-headerless',
        events: [linked('plan-x', 1, { runId: 'cr-headerless' })],
        complete: true,
      };
      expect(() => foldObservations([headerless])).toThrow(
        /exactly one composition-started header/,
      );
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
    // Both spellings are covered: a dotfile the UUID check skips, and a file
    // whose name IS a valid UUID — the readdir-withFileTypes isDirectory
    // filter is what keeps the latter from failing the scan with ENOTDIR.
    const dir0 = await tempDir();
    try {
      await writeStream(dir0, [header()]);
      await writeFile(join(dir0, 'observations', '.DS_Store'), 'junk\n', 'utf8');
      await writeFile(
        join(dir0, 'observations', '9f2b8c1e-1111-4222-8333-444455556666'),
        'junk\n',
        'utf8',
      );
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
    // M16: torn-tail streams whose COMPLETE events are already corrupt are
    // still refused — incompleteness waives only the required-header check
    // for a stream with NO complete event, never a misplaced or duplicate
    // header among complete events.
    for (const [name, events] of [
      [
        'cr-torn-misplaced',
        [
          linked('plan-x', 1, { runId: 'cr-torn-misplaced' }),
          header({ runId: 'cr-torn-misplaced' }),
        ],
      ],
      [
        'cr-torn-duplicate',
        [header({ runId: 'cr-torn-duplicate' }), header({ runId: 'cr-torn-duplicate' })],
      ],
    ] as const) {
      const dirT = await tempDir();
      try {
        const streamDir = join(dirT, 'observations', WORK_ID);
        await mkdir(streamDir, { recursive: true });
        await writeFile(
          join(streamDir, `${name}.ndjson`),
          `${events.map((e) => JSON.stringify(e)).join('\n')}\n{"torn`,
          'utf8',
        );
        await expect(readObservations(dirT)).rejects.toThrow(
          /misplaced or duplicate composition-started/,
        );
      } finally {
        await rm(dirT, { recursive: true, force: true });
      }
    }
  });
});
