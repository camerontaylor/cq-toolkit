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
import {
  foldObservations,
  openObservationWriter,
  readKernelRunDescriptors,
  readObservations,
} from '../../src/kernel/observation.js';
import type { KernelRunLinkedJournalEvent } from '../../src/kernel/types.js';
import {
  CR_ID,
  KERNEL_RUN,
  WORK_ID,
  WORK_ID_2,
  header,
  kernelV3Header,
  linked,
  tempDir,
} from './observation.helpers.js';

describe('T29 unknown evidence', () => {
  test('fold resolves valid links and keeps missing/foreign-work/foreign-plan links unknown', async () => {
    const dir = await tempDir();
    try {
      // The kernel v3 headers live in real kernel files (read via
      // readKernelRunDescriptors); written raw — the kernel RunLog's append
      // stays v1/v2-only (T04 landed the descriptor reader, not a v3
      // header writer).
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
      // Descriptors are version-discriminated read models of the headers as
      // written; these fixtures are operator-written v3 headers.
      expect(descriptors.map((descriptor) => descriptor.journalVersion)).toEqual([3, 3]);

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
      // Links are built from the VALIDATED stream, so each link's event is
      // the same object as its entry in folded.stream.events — a consumer can
      // match links back to stream events by reference.
      const foldedEvents = folded[0]?.stream.events ?? [];
      for (const link of links) expect(foldedEvents).toContain(link.event);
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
        expect(wrongPlan[0].kernelRunLinks[0].reason).toContain("not 'plan-other'");
      }
      // With NO kernel descriptors, every link stays unknown (never guessed).
      const noRuns = foldObservations(await readObservations(dir), []);
      expect(noRuns[0]?.kernelRunLinks.every((l) => l.state === 'unknown')).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
