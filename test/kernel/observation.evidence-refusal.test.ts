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
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openObservationWriter, readObservations } from '../../src/kernel/observation.js';
import { KernelRunLinkedPayloadSchema, ObservationEventSchema } from '../../src/kernel/schema.js';
import {
  AT,
  CR_ID,
  KERNEL_RUN,
  WORK_ID,
  header,
  linked,
  tempDir,
  writeStream,
} from './observation.helpers.js';

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
    // Same for the kernel-run-linked carrier: unitId required-nullable.
    const bareLink = linked() as unknown as Record<string, unknown>;
    delete bareLink.unitId;
    expect(() => ObservationEventSchema.parse(bareLink)).toThrow();
    // Round 0 is a valid NonnegativeSafeCount: pinned so the bound stays
    // nonnegative, not positive.
    expect(() => ObservationEventSchema.parse(linked(KERNEL_RUN, 0))).not.toThrow();
    // K5: the payload grammar refuses path traversal in kernelRunId at the
    // SCHEMA level (before the descriptor reader's assertSafeRunId).
    expect(
      KernelRunLinkedPayloadSchema.safeParse({ kernelRunId: '../x', planId: 'p', round: 1 })
        .success,
    ).toBe(false);
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
});
