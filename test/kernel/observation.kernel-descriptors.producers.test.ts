// T04 producer-realistic probes (kernel-run-descriptors): the gap reproduced
// from the ACTUAL producer, not fixtures. The runner's run-started writer
// emits v1 (ungoverned, no journalVersion) or v2 (governed, journalVersion 2
// + seq + governance/ungoverned); it never emits a v3 header today (types.ts:
// "the v3 header writer arrives with T04"). These probes run real runPlan
// invocations, read the real journal bytes back, pin the header facts that DO
// exist (runId/at/planId, and for v2 seq/governance), pin the facts that do
// NOT (correlation/provenance/availability), and show the current v3-only
// readKernelRunDescriptors returns no descriptor for either real run — the
// exact gap the T36 fold reports as "T04 kernel v3 descriptors unavailable".
//
// Determinism: no fixed clock needed — assertions are on structural fields,
// never timestamps. Temp dirs under os.tmpdir, removed afterwards. No
// network, no providers, no credentials — the op is an in-process fake.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { readKernelRunDescriptors } from '../../src/kernel/observation.js';
import { createGovernor } from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import type { RunStartedJournalEvent, RunStartedV3JournalEvent } from '../../src/kernel/types.js';
import {
  ACQUISITION_STEP_MS,
  entry,
  independentPlan,
  journalEnclosure,
  okOp,
  settleFixtureWork,
  viewWith,
} from './runner-governed.helpers.js';

describe('T04 producer probes: actual runPlan journal headers vs the descriptor reader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-t04-producers-'));
  });

  afterEach(async () => {
    await settleFixtureWork();
    await rm(dir, { recursive: true, force: true });
  }, ACQUISITION_STEP_MS + 5_000);

  test(
    'an actual UNGOVERNED run writes a v1 header the v3-only reader skips',
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
      // The CURRENT reader skips it: zero descriptors for a real run — the
      // kernelRuns gap, reproduced from producer bytes.
      expect(await readKernelRunDescriptors(dir, [report.runId])).toEqual([]);
    },
    journalEnclosure(1),
  );

  test(
    'an actual GOVERNED run writes a v2 header the v3-only reader skips',
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
      // And the v3-only schema must refuse the real bytes outright: a
      // descriptor reader cannot validate a real v2 header AS v3.
      const asV3 = { ...v2, journalVersion: 3 } as unknown as RunStartedV3JournalEvent;
      expect('correlation' in asV3).toBe(false);
      // The CURRENT reader skips the real run here too.
      expect(await readKernelRunDescriptors(dir, [report.runId])).toEqual([]);
    },
    journalEnclosure(1),
  );
});
