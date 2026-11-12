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
      // A v2 header yields a truthful v2 descriptor: the header as written,
      // only the facts it provably carries (no invented correlation).
      const v2Run = 'plan-x--k--v2';
      const v2Header = {
        type: 'run-started',
        runId: v2Run,
        at: AT,
        planId: PLAN_ID,
        journalVersion: 2,
        seq: 1,
        governance: { attended: false },
      };
      await writeFile(join(dir, `${v2Run}.ndjson`), `${JSON.stringify(v2Header)}\n`, 'utf8');
      const v2Descriptors = await readKernelRunDescriptors(dir, [v2Run]);
      expect(v2Descriptors).toHaveLength(1);
      expect(v2Descriptors[0]).toMatchObject({ journalVersion: 2, runId: v2Run, planId: PLAN_ID });
      expect(v2Descriptors[0]?.header).toEqual(v2Header);
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
      expect(good[0]?.journalVersion).toBe(3);
      expect(good[0]?.header.journalVersion).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// T04 probes (kernel-run-descriptors): the descriptor reader's truthfulness
// contract. The production runner emits v1 run-started (no journalVersion)
// or v2 (journalVersion 2 + seq + governance/ungoverned); it never emits a
// v3 header today (types.ts: "the v3 header writer arrives with T04"). The
// reader (T04 ruling 2026-11-12) returns a descriptor for EVERY header the
// kernel actually writes, verbatim and version-discriminated — never an
// upgraded or padded legacy record. These probes pin: what resolves, what
// still throws, and what a truthful reader must keep refusing. Concrete
// field assertions everywhere — no vacuous descriptor checks.
describe('T04 probes: descriptor truthfulness (version-discriminated reader)', () => {
  test('v1, v2 and v3 headers each yield their own verbatim descriptor in caller order', async () => {
    const dir = await tempDir();
    try {
      const v1Run = 'plan-x--k--v1';
      const v1Header = { type: 'run-started', runId: v1Run, at: AT, planId: PLAN_ID };
      await writeFile(join(dir, `${v1Run}.ndjson`), `${JSON.stringify(v1Header)}\n`, 'utf8');
      const v2Run = 'plan-x--k--v2';
      const v2Header = {
        type: 'run-started',
        runId: v2Run,
        at: AT,
        planId: PLAN_ID,
        journalVersion: 2,
        seq: 1,
        ungoverned: { optIn: true },
      };
      await writeFile(join(dir, `${v2Run}.ndjson`), `${JSON.stringify(v2Header)}\n`, 'utf8');
      const v3Run = 'plan-x--k--v3';
      await writeFile(
        join(dir, `${v3Run}.ndjson`),
        `${JSON.stringify(kernelV3Header(v3Run))}\n`,
        'utf8',
      );
      const descriptors = await readKernelRunDescriptors(dir, [v1Run, v3Run, v2Run]);
      // Mixed-version call: one descriptor per existing run, in the caller's
      // runIds order, each carrying its own journal version.
      expect(descriptors.map((descriptor) => descriptor.journalVersion)).toEqual([1, 3, 2]);
      const v1 = descriptors[0];
      expect(v1).toMatchObject({ journalVersion: 1, runId: v1Run, planId: PLAN_ID });
      expect(v1?.header).toEqual(v1Header); // VERBATIM: exactly the written bytes
      const v2 = descriptors[2];
      expect(v2).toMatchObject({ journalVersion: 2, runId: v2Run, planId: PLAN_ID });
      expect(v2?.header).toEqual(v2Header);
      // No descriptor upgrades a legacy header: the join fields do not exist
      // on v1/v2 records and are never synthesized.
      expect('correlation' in (v1?.header ?? {})).toBe(false);
      expect('provenance' in (v1?.header ?? {})).toBe(false);
      expect('correlation' in (v2?.header ?? {})).toBe(false);
      const v3 = descriptors[1];
      expect(v3?.header.journalVersion).toBe(3);
      expect(v3?.header.runId).toBe(v3Run);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('corruption in a v1-era file still throws: skipping is by VERSION, never by damage', async () => {
    const dir = await tempDir();
    try {
      const v1Run = 'plan-x--k--v1filth';
      await writeFile(
        join(dir, `${v1Run}.ndjson`),
        `${JSON.stringify({ type: 'run-started', runId: v1Run, at: AT, planId: PLAN_ID })}\n` +
          'not-json-at-all\n',
        'utf8',
      );
      await expect(readKernelRunDescriptors(dir, [v1Run])).rejects.toThrow(/corrupt line 2/);
      // Complete JSON that is not a journal event is corruption too: the
      // kernel reader's schema refuses it, so a descriptor probe cannot
      // launder a forged line into "no v3 header, skip".
      const forged = 'plan-x--k--v1forged';
      await writeFile(
        join(dir, `${forged}.ndjson`),
        `${JSON.stringify({ type: 'run-started', runId: forged, at: AT, planId: PLAN_ID })}\n` +
          `${JSON.stringify({ unrelated: true })}\n`,
        'utf8',
      );
      await expect(readKernelRunDescriptors(dir, [forged])).rejects.toThrow(/corrupt line 2/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('torn tail under a v1 header keeps its descriptor; an empty file yields none', async () => {
    const dir = await tempDir();
    try {
      // The torn-tail tolerance is the kernel reader's, not the descriptor
      // reader's: an unterminated last line is dropped as crash debris and
      // the surviving v1 header is a descriptor exactly as if the write had
      // completed — the run started, whatever it later did. The torn
      // CARRIER never enters the descriptor: only events[0] is read.
      const torn = 'plan-x--k--v1torn';
      const tornHeader = { type: 'run-started', runId: torn, at: AT, planId: PLAN_ID };
      await writeFile(
        join(dir, `${torn}.ndjson`),
        `${JSON.stringify(tornHeader)}\n` + '{"type":"job-started"',
        'utf8',
      );
      const tornDescriptors = await readKernelRunDescriptors(dir, [torn]);
      expect(tornDescriptors).toHaveLength(1);
      expect(tornDescriptors[0]).toMatchObject({ journalVersion: 1, runId: torn });
      expect(tornDescriptors[0]?.header).toEqual(tornHeader);
      // A crash between exclusive create and first append leaves an empty
      // file: no evidence, no descriptor, no throw.
      const empty = 'plan-x--k--v1empty';
      await writeFile(join(dir, `${empty}.ndjson`), '', 'utf8');
      expect(await readKernelRunDescriptors(dir, [empty])).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a FAILED v3 run still yields its descriptor: links do not discriminate by outcome', async () => {
    const dir = await tempDir();
    try {
      const failedRun = 'plan-x--k--v3fail';
      // v3 headers are operator-written evidence today (the RunLog append is
      // v1/v2-only), so the file is written raw like the T02 fixtures. The
      // v1/v2 job carriers beneath it are union members, so the kernel
      // reader accepts them under a v3 header.
      await writeFile(
        join(dir, `${failedRun}.ndjson`),
        [
          JSON.stringify(kernelV3Header(failedRun)),
          JSON.stringify({
            type: 'job-started',
            runId: failedRun,
            at: AT,
            jobId: 'j1',
            op: 'sweep.unit',
            attempt: 1,
          }),
          JSON.stringify({
            type: 'job-finished',
            runId: failedRun,
            at: AT,
            jobId: 'j1',
            opId: 'sweep.unit',
            inputsHash: 'h',
            result: { status: 'failed', error: 'boom' },
          }),
        ].join('\n') + '\n',
        'utf8',
      );
      const descriptors = await readKernelRunDescriptors(dir, [failedRun]);
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({
        journalVersion: 3,
        runId: failedRun,
        planId: PLAN_ID,
      });
      expect(descriptors[0]?.header.journalVersion).toBe(3);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
