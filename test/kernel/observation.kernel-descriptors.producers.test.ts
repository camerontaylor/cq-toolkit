// T04 producer-realistic probes (kernel-run-descriptors): the descriptor
// reader against the ACTUAL producer. The runner's run-started writer emits
// v1 (ungoverned, no journalVersion) or v2 (governed, journalVersion 2 +
// seq + governance/ungoverned); it never emits a v3 header today (types.ts:
// "the v3 header writer arrives with T04"). The T04 reader (ruling
// 2026-11-12) yields a truthful, version-discriminated descriptor for each
// real header — verbatim bytes, no invented correlation/provenance — while
// the fold's composition workId join stays UNKNOWN for those runs with a
// version-accurate reason (the join is never forged from runId alone).
//
// Determinism: no fixed clock needed — assertions are on structural fields,
// never timestamps. Temp dirs under os.tmpdir, removed afterwards. No
// network, no providers, no credentials — the op is an in-process fake.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { foldObservations, readKernelRunDescriptors } from '../../src/kernel/observation.js';
import { createGovernor } from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import type { RunStartedJournalEvent } from '../../src/kernel/types.js';
import {
  ACQUISITION_STEP_MS,
  entry,
  independentPlan,
  journalEnclosure,
  okOp,
  settleFixtureWork,
  viewWith,
} from './runner-governed.helpers.js';
import {
  CR_ID,
  WORK_ID,
  header as observationHeader,
  linked,
  writeStream,
} from './observation.helpers.js';

describe('T04 producer probes: actual runPlan headers through the descriptor reader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-t04-producers-'));
  });

  afterEach(async () => {
    await settleFixtureWork();
    await rm(dir, { recursive: true, force: true });
  }, ACQUISITION_STEP_MS + 5_000);

  test(
    'an actual UNGOVERNED run yields a truthful v1 descriptor (verbatim, nothing invented)',
    async () => {
      const registry = viewWith(entry('ok', okOp));
      const report = await runPlan(
        independentPlan('plan-t04-v1', 1, 'ok'),
        { concurrency: 1, stopOnError: false, journalDir: dir },
        registry,
      );
      const events = await openRunLog(dir).read(report.runId);
      const header = events[0];
      expect(header?.type).toBe('run-started');
      if (header?.type !== 'run-started') return;
      const v1 = header as RunStartedJournalEvent;
      // The real producer's v1 header carries exactly: type/runId/at/planId.
      expect(v1.journalVersion).toBeUndefined();
      expect(v1.seq).toBeUndefined();
      expect(v1.planId).toBe('plan-t04-v1');
      expect(v1.runId).toBe(report.runId);
      // The v3 join fields do NOT exist on it (the reader cannot resolve a
      // workId from this evidence, and inventing one would be fabrication).
      expect('correlation' in v1).toBe(false);
      expect('provenance' in v1).toBe(false);
      expect('availability' in v1).toBe(false);
      // The T04 reader returns the run's actual header VERBATIM.
      const descriptors = await readKernelRunDescriptors(dir, [report.runId]);
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({ journalVersion: 1, runId: report.runId });
      expect(descriptors[0]?.planId).toBe('plan-t04-v1');
      expect(descriptors[0]?.header).toEqual(v1);
    },
    journalEnclosure(1),
  );

  test(
    'an actual GOVERNED run yields a truthful v2 descriptor (verbatim, nothing invented)',
    async () => {
      const governor = createGovernor({ maxUsd: 5 });
      const registry = viewWith(entry('ok', okOp));
      const report = await runPlan(
        independentPlan('plan-t04-v2', 1, 'ok'),
        { concurrency: 1, stopOnError: false, journalDir: dir },
        registry,
        { governor, allowAdvisory: true },
      );
      const events = await openRunLog(dir).read(report.runId);
      const header = events[0];
      expect(header?.type).toBe('run-started');
      if (header?.type !== 'run-started') return;
      const v2 = header as RunStartedJournalEvent;
      // The real producer's v2 header: journalVersion 2, the claimed seq, and
      // the governance block (cap + attendance) — plus the same v1 envelope.
      expect(v2.journalVersion).toBe(2);
      expect(v2.seq).toBe(1);
      expect(v2.planId).toBe('plan-t04-v2');
      expect(v2.runId).toBe(report.runId);
      expect(v2.governance).toMatchObject({ capUsd: 5, attended: false });
      // Still no v3 join fields.
      expect('correlation' in v2).toBe(false);
      expect('provenance' in v2).toBe(false);
      expect('availability' in v2).toBe(false);
      // The T04 reader returns the run's actual header VERBATIM.
      const descriptors = await readKernelRunDescriptors(dir, [report.runId]);
      expect(descriptors).toHaveLength(1);
      expect(descriptors[0]).toMatchObject({ journalVersion: 2, runId: report.runId });
      expect(descriptors[0]?.header).toEqual(v2);
    },
    journalEnclosure(1),
  );

  test(
    'a legacy descriptor never resolves the fold workId join: unknown with the version named',
    async () => {
      const governor = createGovernor({ maxUsd: 5 });
      const registry = viewWith(entry('ok', okOp));
      const report = await runPlan(
        independentPlan('plan-t04-fold', 1, 'ok'),
        { concurrency: 1, stopOnError: false, journalDir: dir },
        registry,
        { governor, allowAdvisory: true },
      );
      const descriptors = await readKernelRunDescriptors(dir, [report.runId]);
      expect(descriptors.map((descriptor) => descriptor.journalVersion)).toEqual([2]);
      // A real composition stream links the run; the descriptor exists and
      // even matches runId+planId, but its v2 header carries no
      // correlation.workId — the join must stay UNKNOWN, never forged.
      await writeStream(
        dir,
        [
          observationHeader(),
          linked(report.runId, 1, {
            payload: { kernelRunId: report.runId, planId: 'plan-t04-fold', round: 1 },
          }),
        ],
        CR_ID,
        WORK_ID,
      );
      const { readObservations } = await import('../../src/kernel/observation.js');
      const folded = foldObservations(await readObservations(dir), descriptors);
      const links = folded[0]?.kernelRunLinks ?? [];
      expect(links).toHaveLength(1);
      expect(links[0]?.state).toBe('unknown');
      if (links[0]?.state === 'unknown') {
        expect(links[0].reason).toContain('journalVersion 2');
        expect(links[0].reason).toContain('correlation.workId');
        // The reason names the ACTUAL run — no generic vagueness.
        expect(links[0].reason).toContain(report.runId);
      }
    },
    journalEnclosure(1),
  );
});
