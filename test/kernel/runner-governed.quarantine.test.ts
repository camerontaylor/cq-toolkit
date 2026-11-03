// Split from runner-governed.test.ts (owner-mandated file-size split).
// W2.3 reserve-then-settle — A12b: the unresolved-reservation full charge + quarantine, quarantine
// re-attestation, releaseQuarantine re-runs (no refunds, no replay-skip).
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ACQUISITION_STEP_MS,
  journalEnclosure,
  runPlan,
  settleFixtureWork,
  entry,
  viewWith,
  okOp,
  countingOp,
  spendOnce,
  jobFinishes,
} from './runner-governed.helpers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGovernor } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { type JournalEvent, type Plan } from '../../src/kernel/types.js';

describe('W2.3 reserve-then-settle', () => {
  let w3dir: string;
  beforeEach(async () => {
    w3dir = await mkdtemp(join(tmpdir(), 'w23-reserve-'));
  });
  afterEach(async () => {
    await settleFixtureWork();
    await rm(w3dir, { recursive: true, force: true });
  }, ACQUISITION_STEP_MS + 5_000);

  test(
    'A12b: an unresolved reservation charges IN FULL and QUARANTINES the job (never re-run)',
    async () => {
      // Run 1 "crashes" mid-dispatch: run-started v2 (capped), job-started,
      // reservation-opened — no settle, no finish. The resumed run must charge
      // the full reservation and refuse to re-run the job.
      const log = openRunLog(w3dir);
      const plan: Plan = {
        id: 'w23-a12b',
        jobs: [
          { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
          { id: 'j2', op: 'fake', input: { jobId: 'j2' }, dependsOn: ['j1'] },
        ],
      };
      const crashRunId = 'w23-a12b--r1--aa';
      await log.append(crashRunId, {
        type: 'run-started',
        runId: crashRunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'w23-a12b',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 5, attended: false },
      });
      await log.append(crashRunId, {
        type: 'job-started',
        runId: crashRunId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(crashRunId, {
        type: 'reservation-opened',
        runId: crashRunId,
        at: '2026-01-01T00:00:01.500Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
        reservationId: `${crashRunId}:j1:1:1`,
        usd: 0.75,
        class: 'advisory',
      });

      const calls: string[] = [];
      const governor = createGovernor({ maxUsd: 5 });
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor, allowAdvisory: true },
      );
      // The seed charged the crash window IN FULL before anything ran.
      expect(governor.usdSpent).toBe(0.75);
      // j1: quarantined — needs-human, never dispatched.
      const j1 = report.jobs.find((row) => row.jobId === 'j1');
      expect(j1?.result.status).toBe('needs-human');
      if (j1?.result.status !== 'needs-human') throw new Error('expected needs-human');
      expect(j1.result.reason).toContain('quarantined');
      expect(calls).not.toContain('j1');
      // j2: blocked by its quarantined dependency.
      expect(report.jobs.find((row) => row.jobId === 'j2')?.result.status).toBe('failed');
      // Journal evidence: the quarantine stands, no dispatch happened for j1.
      const events = await openRunLog(w3dir).read(report.runId);
      const quarantined = events.find(
        (event): event is Extract<JournalEvent, { type: 'job-quarantined' }> =>
          event.type === 'job-quarantined',
      );
      expect(quarantined).toMatchObject({
        jobId: 'j1',
        reservationId: `${crashRunId}:j1:1:1`,
        chargedUsd: 0.75,
        reason: 'unresolved-reservation',
      });
      expect(events.some((event) => event.type === 'job-started' && event.jobId === 'j1')).toBe(
        false,
      );
    },
    journalEnclosure(1),
  );

  test(
    'A12b: the quarantine re-attests each run; releaseQuarantine re-runs the job but never refunds',
    async () => {
      const log = openRunLog(w3dir);
      const plan: Plan = {
        id: 'w23-release',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
      const crashRunId = 'w23-release--r1--aa';
      await log.append(crashRunId, {
        type: 'run-started',
        runId: crashRunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'w23-release',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 5, attended: false },
      });
      await log.append(crashRunId, {
        type: 'job-started',
        runId: crashRunId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(crashRunId, {
        type: 'reservation-opened',
        runId: crashRunId,
        at: '2026-01-01T00:00:01.500Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
        reservationId: `${crashRunId}:j1:1:1`,
        usd: 2,
        class: 'advisory',
      });

      // Run 2 (no release): re-attested — still quarantined, still charged 2.
      const calls2: string[] = [];
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
        viewWith(entry('fake', countingOp(calls2))),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      expect(report2.jobs[0]?.result.status).toBe('needs-human');
      expect(calls2).toEqual([]);
      const events2 = await openRunLog(w3dir).read(report2.runId);
      expect(events2.some((event) => event.type === 'job-quarantined')).toBe(true);

      // Run 3 (released): the job dispatches, the release is journalled with
      // provenance 'call', and the FULL charge stays in the ledger (the new
      // dispatch's own spend ADDS to it).
      const calls3: string[] = [];
      const governor3 = createGovernor({ maxUsd: 5 });
      const report3 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
        viewWith(entry('fake', spendOnce(calls3, 0.5))),
        { governor: governor3, allowAdvisory: true, releaseQuarantine: ['j1'] },
      );
      expect(calls3).toEqual(['j1']);
      expect(report3.jobs[0]?.result.status).toBe('ok');
      const events3 = await openRunLog(w3dir).read(report3.runId);
      expect(events3.some((event) => event.type === 'quarantine-released')).toBe(true);
      // Ledger: 2 (the never-refunded crash charge) + 0.5 (the new dispatch).
      expect(governor3.usdSpent).toBeCloseTo(2.5);
      void hash;

      // Run 4 (NO release passed): the journalled release from run 3 LIFTS the
      // standing quarantine — j1 runs (or replays) normally, needs-human never
      // returns. The run-1 charge stays in the ledger forever.
      const calls4: string[] = [];
      const governor4 = createGovernor({ maxUsd: 5 });
      const report4 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
        viewWith(entry('fake', countingOp(calls4))),
        { governor: governor4, allowAdvisory: true },
      );
      expect(report4.jobs[0]?.result.status).toBe('ok'); // replayed from run 3's verified ok
      expect(calls4).toEqual([]); // zero invocation — the replay skip, not a refusal
      expect(governor4.usdSpent).toBeCloseTo(2.5); // the crash charge + run 3's spend, still held
    },
    journalEnclosure(3),
  );

  test(
    'A12b: a released job RE-RUNS even when an older ok sits in the replay map (no replay-skip bypass)',
    async () => {
      // Codex P1 on the fix round: run 0 completes j1 ok (verified, journalled);
      // run 1 re-runs it and CRASHES after opening its reservation (its effects
      // are unknown); run 2 resumes WITH --release-quarantine. The release
      // contract says the job re-runs — an older matching ok must not let the
      // replay-skip mark it done without dispatching.
      const log = openRunLog(w3dir);
      const plan: Plan = {
        id: 'w23-release-replay',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
      // Run 0: j1 completes ok (priced).
      const okRunId = 'w23-release-replay--r0--aa';
      await log.append(okRunId, {
        type: 'run-started',
        runId: okRunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'w23-release-replay',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 5, attended: false },
      });
      await log.append(okRunId, {
        type: 'job-started',
        runId: okRunId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(okRunId, {
        type: 'job-finished',
        runId: okRunId,
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: hash,
        result: { status: 'ok', value: 'r0' },
        costUSD: 0.1,
      });
      // Run 1: re-dispatch crashes after opening its reservation (no settle,
      // no finish) — the A12b window over a job with an OLDER verified ok.
      const crashRunId = 'w23-release-replay--r1--bb';
      await log.append(crashRunId, {
        type: 'run-started',
        runId: crashRunId,
        at: '2026-01-01T00:01:00.000Z',
        planId: 'w23-release-replay',
        journalVersion: 2,
        seq: 2,
        governance: { capUsd: 5, attended: false },
      });
      await log.append(crashRunId, {
        type: 'job-started',
        runId: crashRunId,
        at: '2026-01-01T00:01:01.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 2,
      });
      await log.append(crashRunId, {
        type: 'reservation-opened',
        runId: crashRunId,
        at: '2026-01-01T00:01:01.500Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 2,
        reservationId: `${crashRunId}:j1:2:1`,
        usd: 1,
        class: 'advisory',
      });

      // Run 2: resume WITH the release — the job must RE-DISPATCH (a fresh
      // reservation, a real invocation), never replay-skip on run 0's ok.
      const calls: string[] = [];
      const governor = createGovernor({ maxUsd: 5 });
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
        viewWith(entry('fake', spendOnce(calls, 0.25))),
        { governor, allowAdvisory: true, releaseQuarantine: ['j1'] },
      );
      expect(calls).toEqual(['j1']); // the re-run HAPPENED — the bypass is closed
      expect(report.jobs[0]?.result.status).toBe('ok');
      const events = await openRunLog(w3dir).read(report.runId);
      expect(events.some((event) => event.type === 'quarantine-released')).toBe(true);
      // The re-dispatch opened its own write-ahead reservation.
      expect(events.some((event) => event.type === 'reservation-opened')).toBe(true);
      // Ledger: run 0's priced 0.1 + the never-refunded 1.0 crash charge +
      // the re-run's 0.25.
      expect(governor.usdSpent).toBeCloseTo(1.35);
    },
    journalEnclosure(1),
  );

  test(
    'A12b: a release run with NO replacement finish still re-runs the job on the next resume',
    async () => {
      // Verifier repro (fix r2): run 0 completes j1 ok; run 1 crashes in the
      // A12b window (reservation opened, no settle); run 2 resumes WITH the
      // release but a sibling's stopOnError halts the run BEFORE j1
      // re-dispatches — the journal carries quarantine-released and NO j1
      // finish. Run 3 must re-dispatch j1: the journalled release lifts the
      // quarantine, and run 0's PRE-release ok must not replay-skip it —
      // otherwise --release-quarantine is a silent permanent no-op across
      // runs and the report asserts an ok the run never produced.
      const log = openRunLog(w3dir);
      const plan: Plan = {
        id: 'w23-release-nofinish',
        // j2 first: with concurrency 1 its failure stops the run before j1.
        jobs: [
          { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
          { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        ],
      };
      const hash = makeManifest(plan).jobs.find((job) => job.id === 'j1')?.inputsHash ?? '';
      // Run 0: j1 completes ok (priced).
      const okRunId = 'w23-release-nofinish--r0--aa';
      await log.append(okRunId, {
        type: 'run-started',
        runId: okRunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'w23-release-nofinish',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 5, attended: false },
      });
      await log.append(okRunId, {
        type: 'job-started',
        runId: okRunId,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(okRunId, {
        type: 'job-finished',
        runId: okRunId,
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: hash,
        result: { status: 'ok', value: 'r0' },
        costUSD: 0.1,
      });
      // Run 1: re-dispatch crashes after opening its reservation (no settle,
      // no finish) — the A12b window over j1's OLDER verified ok.
      const crashRunId = 'w23-release-nofinish--r1--bb';
      await log.append(crashRunId, {
        type: 'run-started',
        runId: crashRunId,
        at: '2026-01-01T00:01:00.000Z',
        planId: 'w23-release-nofinish',
        journalVersion: 2,
        seq: 2,
        governance: { capUsd: 5, attended: false },
      });
      await log.append(crashRunId, {
        type: 'job-started',
        runId: crashRunId,
        at: '2026-01-01T00:01:01.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 2,
      });
      await log.append(crashRunId, {
        type: 'reservation-opened',
        runId: crashRunId,
        at: '2026-01-01T00:01:01.500Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 2,
        reservationId: `${crashRunId}:j1:2:1`,
        usd: 1,
        class: 'advisory',
      });

      // Run 2: resume WITH the release; sibling j2 fails first and
      // stopOnError halts the run before j1 re-dispatches.
      const calls2: string[] = [];
      const governor2 = createGovernor({ maxUsd: 5 });
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: true, journalDir: w3dir, resume: true },
        viewWith(
          entry('fake', async (raw) => {
            const jobId = (raw as { jobId: string }).jobId;
            calls2.push(jobId);
            return jobId === 'j2'
              ? { status: 'failed' as const, error: 'sibling failure' }
              : okOp(raw);
          }),
        ),
        { governor: governor2, allowAdvisory: true, releaseQuarantine: ['j1'] },
      );
      const events2 = await openRunLog(w3dir).read(report2.runId);
      expect(events2.some((event) => event.type === 'quarantine-released')).toBe(true);
      // The release run produced NO replacement finish for j1.
      expect(jobFinishes(events2).some((event) => event.jobId === 'j1')).toBe(false);
      expect(calls2).toEqual(['j2']); // j1 was never re-dispatched this run

      // Run 3: resume WITHOUT the release flag — the journalled release lifts
      // the quarantine, and the job must RE-DISPATCH, not replay-skip run 0's
      // stale pre-release ok.
      const calls3: string[] = [];
      const governor3 = createGovernor({ maxUsd: 5 });
      const report3 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
        viewWith(entry('fake', countingOp(calls3, 0.25))),
        { governor: governor3, allowAdvisory: true },
      );
      expect(governor3.quarantinedJobs.size).toBe(0); // lifted, not re-attested
      expect(calls3).toEqual(['j2', 'j1']); // j1 RE-DISPATCHED — bypass closed
      expect(report3.jobs.find((row) => row.jobId === 'j1')?.result.status).toBe('ok');
    },
    journalEnclosure(2),
  );
});
