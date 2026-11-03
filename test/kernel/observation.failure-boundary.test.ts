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
import { open, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openObservationWriter } from '../../src/kernel/observation.js';
import { CR_ID, WORK_ID, header, linked, tempDir } from './observation.helpers.js';

describe('T29 failure boundary', () => {
  test('a REAL write failure fail-stops the writer: same error, file unchanged, close re-rejects', async () => {
    const dir = await tempDir();
    // FileHandle's class is not exported as a value in the ESM build: take
    // the prototype from a real handle. Declared out here so the finally
    // below can restore it even when an assertion throws (the patch is
    // process-global: leaving it in place would fail every later write).
    const probe = await open('/dev/null', 'r');
    const proto = Object.getPrototypeOf(probe) as {
      datasync: () => Promise<void>;
    };
    await probe.close();
    const real = proto.datasync;
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
      // events() must not report events that never reached disk: neither the
      // failed header nor any later event is in the snapshot (P2-B).
      expect(writer.events()).toEqual([]);
      // close() re-rejects with the write error (P2-1) after closing up.
      await expect(writer.close()).rejects.toBe(boom);
      expect(writer.failure).toBe(boom);
      expect(writer.events()).toEqual([]);
      // The on-disk file carries at most the failed header line and never a
      // later event: the stream is indeterminate, not partially advanced.
      const raw = await readFile(
        join(dir, 'observations', WORK_ID, `${CR_ID}.ndjson`),
        'utf8',
      ).catch(() => '');
      expect(raw).not.toContain('kernel-run-linked');
    } finally {
      // The prototype patch is process-global: restore it even when an
      // assertion above throws, or every later test's writes fail.
      proto.datasync = real;
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
});
