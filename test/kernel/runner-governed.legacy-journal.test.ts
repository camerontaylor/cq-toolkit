// Split from runner-governed.test.ts (owner-mandated file-size split).
// Governed journal v2 + resume — v1 history: unaccounted-dispatch refusal + legacyJournal=reset, the
// reset-makes-charged-0 seed rule, and cap raise refusal/record.
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ACQUISITION_STEP_MS,
  journalEnclosure,
  refusalOf,
  runPlan,
  settleFixtureWork,
  entry,
  viewWith,
  okOp,
  countingOp,
} from './runner-governed.helpers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceOptInRefusedError } from '../../src/kernel/errors.js';
import { createGovernor } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { type Plan } from '../../src/kernel/types.js';

describe('governed journal v2 + resume', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-runner-governed-'));
  });

  afterEach(async () => {
    await settleFixtureWork();
    await rm(dir, { recursive: true, force: true });
  }, ACQUISITION_STEP_MS + 5_000);

  test(
    'governed over unaccounted v1 dispatches refuses; legacyJournal=reset honours and records the reset (sticky)',
    async () => {
      const plan: Plan = {
        id: 'plan-gov-v1',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const log = openRunLog(dir);
      const v1RunId = 'plan-gov-v1--legacy--aa';
      await log.append(v1RunId, {
        type: 'run-started',
        runId: v1RunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'plan-gov-v1',
      });
      await log.append(v1RunId, {
        type: 'job-started',
        runId: v1RunId,
        at: '2026-01-01T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      const calls: string[] = [];

      // Refusal names the count and the runs, whether or not resume is set.
      // Typed: GovernanceOptInRefusedError (ADR-0003 §2.9), pinned beside the
      // message contract.
      const v1Refusal = await refusalOf(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls))),
          { governor: createGovernor({}), allowAdvisory: true },
        ),
      );
      expect(v1Refusal).toBeInstanceOf(GovernanceOptInRefusedError);
      expect((v1Refusal as Error).message).toBe(
        'runPlan: governed resume over v1 journals with unaccounted dispatches (1 jobs in plan-gov-v1--legacy--aa); v1 journals carry no spend. Pass --opt-in budget.legacyJournal=reset.',
      );
      await expect(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir },
          viewWith(entry('fake', countingOp(calls))),
          { governor: createGovernor({}), allowAdvisory: true },
        ),
      ).rejects.toThrow(/unaccounted dispatches/);
      expect(calls).toEqual([]);

      // With the opt-in the reset is HONOURED (it was needed) and recorded.
      const report1 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        {
          governor: createGovernor({}),
          optIn: ['budget.legacyJournal=reset'],
          allowAdvisory: true,
        },
      );
      expect(calls).toEqual(['j1']); // j1 re-dispatched (the v1 start never finished)
      const events1 = await log.read(report1.runId);
      expect(events1[0]).toMatchObject({
        type: 'run-started',
        journalVersion: 2,
        seq: 1,
        governance: {
          attended: false,
          legacyJournal: { mode: 'reset', v1RunIds: ['plan-gov-v1--legacy--aa'] },
        },
      });

      // STICKY: a second governed resume does not refuse (the reset is in the
      // folded governance record). Note the reset re-dispatch also journalled
      // a finish for j1, so this resume replays it — zero invocations.
      const calls2: string[] = [];
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls2))),
        { governor: createGovernor({}), allowAdvisory: true },
      );
      expect(calls2).toEqual([]);
      expect(report2.counts.done).toBe(1);

      // A NEW v1 file with dispatches is unaccounted again → refuses.
      const v1RunId2 = 'plan-gov-v1--legacy2--bb';
      await log.append(v1RunId2, {
        type: 'run-started',
        runId: v1RunId2,
        at: '2026-01-02T00:00:00.000Z',
        planId: 'plan-gov-v1',
      });
      await log.append(v1RunId2, {
        type: 'job-started',
        runId: v1RunId2,
        at: '2026-01-02T00:00:00.000Z',
        jobId: 'j2',
        op: 'fake',
        attempt: 1,
      });
      await expect(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls2))),
          { governor: createGovernor({}), allowAdvisory: true },
        ),
      ).rejects.toThrow(/unaccounted dispatches \(1 jobs in plan-gov-v1--legacy2--bb\)/);
    },
    journalEnclosure(5),
  );

  test(
    'an honoured reset excludes a v1 finish\u2019s usage from the ledger seed — reset means charged 0 (annex §4)',
    async () => {
      // A versionless journal whose job-finished carries usage (the frozen v1
      // schema permits the field; v1 writers never emitted it). The reset
      // charges those dispatches 0, so the usage must not seed the ledger:
      // neither the DD-9 unpriced fold nor the token/USD seed caps may see it.
      const plan: Plan = {
        id: 'plan-gov-v1spend',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const log = openRunLog(dir);
      const v1RunId = 'plan-gov-v1spend--legacy--cc';
      await log.append(v1RunId, {
        type: 'run-started',
        runId: v1RunId,
        at: '2026-01-03T00:00:00.000Z',
        planId: 'plan-gov-v1spend',
      });
      await log.append(v1RunId, {
        type: 'job-started',
        runId: v1RunId,
        at: '2026-01-03T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(v1RunId, {
        type: 'job-finished',
        runId: v1RunId,
        at: '2026-01-03T00:01:00.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: 'h1',
        result: { status: 'failed', error: 'seeded legacy failure' },
        usage: { input: 100, output: 100, cacheRead: 0, cacheWrite: 0 },
      });

      // A TIGHT maxTokens (the seeded usage alone would exceed it) proves the
      // exclusion: the run admits and completes instead of tripping at seed.
      const governor = createGovernor({ maxUsd: 1, maxTokens: 150 });
      const calls: string[] = [];
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor, optIn: ['budget.legacyJournal=reset'], allowAdvisory: true },
      );
      expect(report.counts.done).toBe(1);
      expect(governor.tripped).toBe(false);
      expect(governor.usage).toBeUndefined(); // the v1 usage never entered the ledger
      expect(governor.usdSpent).toBe(0);
      // The reset is recorded for stickiness.
      const events = await log.read(report.runId);
      expect(events[0]).toMatchObject({
        type: 'run-started',
        journalVersion: 2,
        governance: {
          capUsd: 1,
          capTokens: 150,
          attended: false,
          legacyJournal: { mode: 'reset', v1RunIds: ['plan-gov-v1spend--legacy--cc'] },
        },
      });
    },
    journalEnclosure(1),
  );

  test(
    'a cap raise over the ledger refuses without budget.raiseCap; honoured, it is recorded',
    async () => {
      const plan: Plan = {
        id: 'plan-gov-raise',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('fake', okOp)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      const runsBefore = await openRunLog(dir).runs();

      // Raising 5 → 10 without the opt-in refuses BEFORE anything is written.
      // Typed: GovernanceOptInRefusedError (ADR-0003 §2.9).
      const calls: string[] = [];
      const raiseRefusal = await refusalOf(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls))),
          { governor: createGovernor({ maxUsd: 10 }), allowAdvisory: true },
        ),
      );
      expect(raiseRefusal).toBeInstanceOf(GovernanceOptInRefusedError);
      expect((raiseRefusal as Error).message).toBe('runPlan: cap raised from 5 to 10');
      expect(calls).toEqual([]);
      expect(await openRunLog(dir).runs()).toEqual(runsBefore); // no seq claim, no run file

      // With budget.raiseCap the run proceeds and records the transition.
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        {
          governor: createGovernor({ maxUsd: 10 }),
          optIn: ['budget.raiseCap'],
          allowAdvisory: true,
        },
      );
      const events = await openRunLog(dir).read(report.runId);
      expect(events[0]).toMatchObject({
        type: 'run-started',
        journalVersion: 2,
        seq: 2,
        governance: { capUsd: 10, attended: false, raiseCap: { from: 5, to: 10 } },
      });
    },
    journalEnclosure(3),
  );
});
