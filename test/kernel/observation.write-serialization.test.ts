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
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { openObservationWriter, readObservations } from '../../src/kernel/observation.js';
import type { KernelRunLinkedJournalEvent } from '../../src/kernel/types.js';
import { AT2, AT3, WORK_ID, header, linked, tempDir, writeStream } from './observation.helpers.js';

describe('T29 failure boundary', () => {
  test('concurrent Promise.all appends land on disk in call order', async () => {
    const dir = await tempDir();
    try {
      const writer = await openObservationWriter({
        journalDir: dir,
        workId: WORK_ID,
        compositionRunId: 'cr-concurrent',
      });
      await writer.append(header({ runId: 'cr-concurrent' }));
      // Decreasing per-call delays: without a real serialization chain, later
      // appends would win the race and the on-disk order would invert. The
      // patch targets the same prototype the production write path uses.
      const probe = await open('/dev/null', 'r');
      const proto = Object.getPrototypeOf(probe) as {
        writeFile: (data: string, encoding: string) => Promise<void>;
      };
      await probe.close();
      const real = proto.writeFile;
      const rounds = [1, 2, 3, 4, 5];
      proto.writeFile = function (data: string, encoding: string): Promise<void> {
        const payload = JSON.parse(data) as { payload?: { round?: number } };
        const n = Number(payload.payload?.round ?? 0);
        const delay = (rounds.length - n) * 10; // round 1 waits longest
        return new Promise((resolve) => setTimeout(resolve, delay)).then(() =>
          real.call(this, data, encoding),
        );
      };
      try {
        await Promise.all(
          rounds.map((n) =>
            writer.append(linked(`plan-x--k--${n}`, n, { runId: 'cr-concurrent', at: AT2 })),
          ),
        );
      } finally {
        proto.writeFile = real;
      }
      await writer.close();
      // The ON-DISK order is the assertion: read the raw bytes, not the
      // writer's in-memory snapshot.
      const raw = await readFile(
        join(dir, 'observations', WORK_ID, 'cr-concurrent.ndjson'),
        'utf8',
      );
      const onDiskRounds = raw
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as KernelRunLinkedJournalEvent)
        .filter((e) => e.type === 'kernel-run-linked')
        .map((e) => e.payload.round);
      // The internal write chain serializes: file order == append-call order.
      expect(onDiskRounds).toEqual(rounds);
      // And the read path agrees.
      const streams = await readObservations(dir);
      expect(streams[0]?.complete).toBe(true);
      const linkedRounds = streams[0]?.events
        .filter((e): e is KernelRunLinkedJournalEvent => e.type === 'kernel-run-linked')
        .map((e) => e.payload.round);
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
