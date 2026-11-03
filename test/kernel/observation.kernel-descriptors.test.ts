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
import { readKernelRunDescriptors } from '../../src/kernel/observation.js';
import { AT, PLAN_ID, kernelV3Header, tempDir } from './observation.helpers.js';

describe('T29 unknown evidence', () => {
  test('readKernelRunDescriptors validates runIds and reads strictly', async () => {
    const dir = await tempDir();
    try {
      // Path traversal in a runId is refused BEFORE any read: the probe
      // '../x/evil' must never resolve a descriptor from outside the
      // journal directory.
      await expect(readKernelRunDescriptors(dir, ['../x/evil'])).rejects.toThrow(
        /runId must match/,
      );
      await expect(readKernelRunDescriptors(dir, ['a/b'])).rejects.toThrow(/runId must match/);
      await mkdir(join(dir, 'x'), { recursive: true });
      await writeFile(join(dir, 'x', 'evil.ndjson'), 'planted\n', 'utf8');
      // An absent run has no descriptor (unknown, not guessed).
      expect(await readKernelRunDescriptors(dir, ['plan-x--k--ghost'])).toEqual([]);
      // CORRUPTION is loud: a complete-but-unparsable line in a kernel file
      // throws from the kernel reader, never silently skipped.
      await writeFile(join(dir, 'cr-filth.ndjson'), 'not-json-at-all\n', 'utf8');
      await expect(readKernelRunDescriptors(dir, ['cr-filth'])).rejects.toThrow(/corrupt line 1/);
      // A HEADER NOT ON LINE 1 is a forged stream: garbage, a kernel event,
      // then a v3 header must NOT resolve the run (strict read, events[0]).
      const late = [
        {
          type: 'job-started',
          runId: 'cr-late',
          at: AT,
          jobId: 'job-1',
          op: 'sweep.unit',
          attempt: 1,
        },
        kernelV3Header('cr-late'),
      ];
      await writeFile(
        join(dir, 'cr-late.ndjson'),
        `garbage not json\n${late.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8',
      );
      await expect(readKernelRunDescriptors(dir, ['cr-late'])).rejects.toThrow(/corrupt line 1/);
      const noFirstHeader = [
        {
          type: 'job-started',
          runId: 'cr-late2',
          at: AT,
          jobId: 'job-1',
          op: 'sweep.unit',
          attempt: 1,
        },
        kernelV3Header('cr-late2'),
      ];
      await writeFile(
        join(dir, 'cr-late2.ndjson'),
        `${noFirstHeader.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf8',
      );
      await expect(readKernelRunDescriptors(dir, ['cr-late2'])).rejects.toThrow(
        /does not open with its run-started header/,
      );
      // A HEADER RUNID DIFFERING FROM THE FILE's run is misattributed
      // evidence: refused, never resolved as the file's run.
      await writeFile(
        join(dir, 'cr-mismatch.ndjson'),
        `${JSON.stringify(kernelV3Header('some-other-run'))}\n`,
        'utf8',
      );
      await expect(readKernelRunDescriptors(dir, ['cr-mismatch'])).rejects.toThrow(
        /does not match/,
      );
      // A v1/v2-era header yields NO descriptor: links stay unknown.
      const v2Run = 'plan-x--k--v2';
      await writeFile(
        join(dir, `${v2Run}.ndjson`),
        `${JSON.stringify({
          type: 'run-started',
          runId: v2Run,
          at: AT,
          planId: PLAN_ID,
          journalVersion: 2,
          seq: 1,
          governance: { attended: false },
        })}\n`,
        'utf8',
      );
      expect(await readKernelRunDescriptors(dir, [v2Run])).toEqual([]);
      // The happy path still resolves exactly one descriptor.
      await writeFile(
        join(dir, 'cr-good.ndjson'),
        `${JSON.stringify(kernelV3Header('cr-good'))}\n`,
        'utf8',
      );
      const good = await readKernelRunDescriptors(dir, ['cr-good', 'plan-x--k--ghost']);
      expect(good).toHaveLength(1);
      expect(good[0]?.runId).toBe('cr-good');
      expect(good[0]?.planId).toBe(PLAN_ID);
      expect(good[0]?.header.journalVersion).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
