// Split from runner-governed.test.ts (owner-mandated file-size split).
// Governed journal v2 + resume — fold continuity: a v3 header joining the sequenced era, spend-seeded
// resume trips, and the seq-ordered fold beating reversed `at` stamps.
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
  independentPlan,
  okOp,
  countingOp,
  jobStarts,
} from './runner-governed.helpers.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GovernanceOptInRefusedError } from '../../src/kernel/errors.js';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { type JournalEvent, type OpResult, type Plan } from '../../src/kernel/types.js';

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
    'a v3 header in history joins the sequenced era: ungoverned refusal and seq continuity (ADR-0008 T02)',
    async () => {
      // History carries a v3-header run (operator-written evidence — the
      // kernel writer is v1/v2 until T04): the resume fold must classify it
      // as SEQUENCED, not v1. Concretely: governed v3 history refuses an
      // ungoverned run (refusal a), and the v3 seq counts toward
      // maxPriorSeq so the next run claims seq 2 (not 1).
      const started: Extract<JournalEvent, { type: 'run-started' }> = {
        type: 'run-started',
        runId: 'plan-gov-v3--k--a',
        at: '2026-01-03T04:05:06.789Z',
        planId: 'plan-gov-v3',
        journalVersion: 3,
        seq: 1,
        governance: {
          capUsd: 5,
          attended: false,
          // Discriminator for the seedRuns v1 tag (review P2-A): the reset
          // names THIS run, so the exclusion filter (runner seed fold) has
          // something to get wrong — if the v3 run were misfiled as v1, a
          // legacyJournal=reset resume would silently drop its spend seed.
          legacyJournal: { mode: 'reset', v1RunIds: ['plan-gov-v3--k--a'] },
        },
        provenance: {
          cqVersion: '0.2.0',
          producerVersion: '0.2.0',
          repoId: null,
          cqJsonHash: `sha256:${'b'.repeat(64)}`,
          baseSha: 'a'.repeat(40),
          runPrefix: 'plan-gov-v3',
          startedAt: '2026-01-03T04:05:06.789Z',
          endedAt: null,
          journalLink: 'runs/plan-gov-v3--k--a.ndjson',
          reportLink: 'reports/plan-gov-v3--k--a.json',
          witnesses: {
            base: 'a'.repeat(40),
            admitted: null,
            execution: null,
            reviewed: null,
            accepted: null,
          },
        },
        correlation: {
          workId: '3f2b8c1e-1111-4222-8333-444455556666',
          parentWorkId: null,
          branch: 'feat/demo',
          commitSha: null,
          sessionId: null,
          agentId: null,
        },
        availability: {},
      };
      // Dispatch + spend evidence for the seedRuns v1 tag (runner :779): a
      // misfiled v1 tag would silently drop this run's spend from the seed.
      // (The v1-DISPATCH gate at :757 needs a header WITHOUT a legacyJournal
      // reset naming the run — the self-naming reset here filters it out of
      // unaccountedV1, so refusal (b) cannot fire. The plan-gov-v3b fixture
      // below covers that gate.)
      const dispatched: Array<Record<string, unknown>> = [
        {
          type: 'job-started',
          runId: 'plan-gov-v3--k--a',
          at: '2026-01-03T04:05:07.000Z',
          jobId: 'j1',
          op: 'fake',
          attempt: 1,
        },
        {
          type: 'job-finished',
          runId: 'plan-gov-v3--k--a',
          at: '2026-01-03T04:05:08.000Z',
          jobId: 'j1',
          opId: 'op-j1',
          inputsHash: 'hash-j1',
          result: { status: 'ok', value: 'j1' },
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          costUSD: 3,
        },
      ];
      // The kernel writer stays v1/v2 (dual reader first), so the v3 history
      // is written RAW — operator-written evidence, read by the widened reader.
      await writeFile(
        join(dir, 'plan-gov-v3--k--a.ndjson'),
        [started, ...dispatched].map((event) => `${JSON.stringify(event)}\n`).join(''),
        'utf8',
      );

      // Refusal (a): governed v3 history + ungoverned request → refuse.
      const calls: string[] = [];
      const refusal = await refusalOf(
        runPlan(
          independentPlan('plan-gov-v3', 1),
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls))),
        ),
      );
      expect(refusal).toBeInstanceOf(GovernanceOptInRefusedError);
      expect((refusal as Error).message).toBe(
        'runPlan: plan plan-gov-v3 has governed history; run governed or pass --opt-in budget.ungovernedOverGoverned',
      );
      expect(calls).toEqual([]);

      // Refusal (c) rides the same classification: raising the cap over v3
      // history refuses without the opt-in.
      const raiseRefusal = await refusalOf(
        runPlan(
          independentPlan('plan-gov-v3', 1),
          { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
          viewWith(entry('fake', countingOp(calls))),
          { governor: createGovernor({ maxUsd: 10 }), allowAdvisory: true },
        ),
      );
      expect(raiseRefusal).toBeInstanceOf(GovernanceOptInRefusedError);
      expect((raiseRefusal as Error).message).toBe('runPlan: cap raised from 5 to 10');

      // The v3 seq counts: the next run claims seq 2, not 1. And the v3
      // dispatch evidence is classified SEQUENCED (not v1): the resume does
      // NOT hit the 'governed resume over v1 journals' refusal, and the
      // prior 3 USD spend is seeded — a resume under a 2 USD cap trips at
      // seed, before any dispatch.
      const seededCalls: string[] = [];
      const seededGovernor = createGovernor({ maxUsd: 2 });
      const seededReport = await runPlan(
        independentPlan('plan-gov-v3', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(seededCalls))),
        { governor: seededGovernor, allowAdvisory: true },
      );
      expect(seededCalls).toEqual([]); // the seeded 3 USD overrun trips at seed
      expect(seededGovernor.tripped).toBe(true);
      expect(seededGovernor.tripKind).toBe('exhausted');
      expect(seededReport.counts).toMatchObject({
        queued: 0,
        running: 0,
        blocked: 0,
        done: 0,
        failed: 0,
        'budget-exhausted': 1,
      });
      // And the reset discriminator: a legacyJournal=reset resume must NOT
      // be able to wash out the v3 spend — the v3 run is not v1, so its
      // spend stays in the seed even though the header's reset names it.
      // (The ledger now holds the 3 + the tripped run's 2-cap history; a
      // reset resume under 2 USD trips at seed exactly as before.)
      const resetCalls: string[] = [];
      const resetGovernor = createGovernor({ maxUsd: 2 });
      const resetReport = await runPlan(
        independentPlan('plan-gov-v3', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(resetCalls))),
        {
          governor: resetGovernor,
          optIn: ['budget.legacyJournal=reset'],
          allowAdvisory: true,
        },
      );
      expect(resetCalls).toEqual([]); // the v3 spend survives the reset
      expect(resetGovernor.tripped).toBe(true);
      expect(resetReport.counts).toMatchObject({
        queued: 0,
        running: 0,
        blocked: 0,
        done: 0,
        failed: 0,
        'budget-exhausted': 1,
      });
      const report = await runPlan(
        independentPlan('plan-gov-v3', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        {
          governor: createGovernor({ maxUsd: 5 }),
          // The seed-trip run above journaled its capUsd 2 header, so the
          // ledger's latest cap is 2; restoring 5 is an intentional raise.
          optIn: ['budget.raiseCap'],
          allowAdvisory: true,
        },
      );
      expect(calls).toEqual(['j1']);
      const events = await openRunLog(dir).read(report.runId);
      // seq 4: the seed-trip run consumed seq 2 and the reset run seq 3
      // (maxPriorSeq counts the v3 header's seq 1, proving v3 seq continuity).
      expect(events[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 4 });

      // The v1-DISPATCH gate (runner :757) — a plan whose governed v3 history
      // has NO legacyJournal reset: a v1-misfiled v3 run with dispatches
      // would hit refusal (b) ('governed resume over v1 journals'), so the
      // clean resolve below kills that revert.
      const v3bStarted: Extract<JournalEvent, { type: 'run-started' }> = {
        type: 'run-started',
        runId: 'plan-gov-v3b--k--a',
        at: '2026-01-03T04:05:06.789Z',
        planId: 'plan-gov-v3b',
        journalVersion: 3,
        seq: 1,
        governance: { capUsd: 5, attended: false },
        provenance: {
          cqVersion: '0.2.0',
          producerVersion: '0.2.0',
          repoId: null,
          cqJsonHash: `sha256:${'b'.repeat(64)}`,
          baseSha: 'a'.repeat(40),
          runPrefix: 'plan-gov-v3b',
          startedAt: '2026-01-03T04:05:06.789Z',
          endedAt: null,
          journalLink: 'runs/plan-gov-v3b--k--a.ndjson',
          reportLink: 'reports/plan-gov-v3b--k--a.json',
          witnesses: {
            base: 'a'.repeat(40),
            admitted: null,
            execution: null,
            reviewed: null,
            accepted: null,
          },
        },
        correlation: {
          workId: '5f2b8c1e-1111-4222-8333-444455556666',
          parentWorkId: null,
          branch: 'feat/demo',
          commitSha: null,
          sessionId: null,
          agentId: null,
        },
        availability: {},
      };
      await writeFile(
        join(dir, 'plan-gov-v3b--k--a.ndjson'),
        [
          v3bStarted,
          {
            type: 'job-started',
            runId: 'plan-gov-v3b--k--a',
            at: '2026-01-03T04:05:07.000Z',
            jobId: 'j1',
            op: 'fake',
            attempt: 1,
          },
          {
            type: 'job-finished',
            runId: 'plan-gov-v3b--k--a',
            at: '2026-01-03T04:05:08.000Z',
            jobId: 'j1',
            opId: 'op-j1',
            inputsHash: 'hash-j1',
            result: { status: 'ok', value: 'j1' },
            costUSD: 1,
          },
        ]
          .map((event) => `${JSON.stringify(event)}\n`)
          .join(''),
        'utf8',
      );
      const v3bCalls: string[] = [];
      const v3bReport = await runPlan(
        independentPlan('plan-gov-v3b', 1),
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(v3bCalls))),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      // The gate did NOT misfile the v3 run as v1: no refusal — the op ran.
      expect(v3bCalls).toEqual(['j1']);
      expect(v3bReport.counts).toMatchObject({ done: 1, failed: 0, 'budget-exhausted': 0 });
    },
    journalEnclosure(3),
  );

  test(
    'a resume seeds the ledger spend: 3 spent + 2.5 more trips the 5 cap mid-run',
    async () => {
      const calls: string[] = [];
      let behave: 'spend3-fail' | 'spend2.5-ok' = 'spend3-fail';
      const ledgerOp = async (raw: unknown): Promise<OpResult<unknown>> => {
        const jobId = (raw as { jobId: string }).jobId;
        calls.push(jobId);
        if (behave === 'spend3-fail') {
          currentJobContext()?.reportResult({ costUSD: 3 });
          return { status: 'failed', error: 'flake after spend' };
        }
        currentJobContext()?.reportResult({ costUSD: 2.5 });
        return okOp(raw);
      };
      const plan: Plan = {
        id: 'plan-gov-ledger',
        jobs: [
          { id: 'j1', op: 'ledger', input: { jobId: 'j1' } },
          { id: 'j2', op: 'ledger', input: { jobId: 'j2' }, dependsOn: ['j1'] },
        ],
      };
      // Run 1: j1 spends 3 (under the 5 cap) and FAILS; j2 blocked for real.
      await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('ledger', ledgerOp)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      // Run 2 (resume): the seed carries the 3; j1's fresh 2.5 pushes the
      // rollup to 5.5 — the cap trips mid-run, and queued j2 is re-marked.
      behave = 'spend2.5-ok';
      const report2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('ledger', ledgerOp)),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      expect(calls).toEqual(['j1', 'j1']); // j1 re-ran (its last finish was failed)…
      expect(calls).not.toContain('j2'); // …j2 never dispatched
      expect(report2.jobs[0]?.result).toEqual({ status: 'ok', value: 'j1' }); // real verdict kept
      expect(report2.jobs[1]?.result).toEqual({ status: 'budget-exhausted' });
      expect(report2.stoppedEarly).toBe(true);
      expect(report2.earlyStopReason).toBe('budget');
      expect(report2.costUSD).toBe(5.5); // the ledger: seeded 3 + live 2.5
    },
    journalEnclosure(2),
  );

  test(
    'the resume fold follows seq, not a reversed fake-clock `at`',
    async () => {
      const plan: Plan = {
        id: 'plan-gov-seqfold',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const hash = makeManifest(plan).jobs[0]?.inputsHash ?? '';
      const log = openRunLog(dir);
      // seq 1 started LATE by its own `at` and finished j1 ok.
      const run1 = 'plan-gov-seqfold--late--aa';
      await log.append(run1, {
        type: 'run-started',
        runId: run1,
        at: '2026-01-02T00:00:00.000Z',
        planId: 'plan-gov-seqfold',
        journalVersion: 2,
        seq: 1,
        governance: { attended: false },
      });
      await log.append(run1, {
        type: 'job-started',
        runId: run1,
        at: '2026-01-02T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(run1, {
        type: 'job-finished',
        runId: run1,
        at: '2026-01-02T00:00:01.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: hash,
        result: { status: 'ok', value: 'j1' },
      });
      // seq 2 started EARLY by `at` and re-attempted j1 to a FAILED finish.
      const run2 = 'plan-gov-seqfold--early--bb';
      await log.append(run2, {
        type: 'run-started',
        runId: run2,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'plan-gov-seqfold',
        journalVersion: 2,
        seq: 2,
        governance: { attended: false },
      });
      await log.append(run2, {
        type: 'job-started',
        runId: run2,
        at: '2026-01-01T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 2,
      });
      await log.append(run2, {
        type: 'job-finished',
        runId: run2,
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: hash,
        result: { status: 'failed', error: 'seq-2 attempt blew up' },
      });

      // A by-`at` fold would let the seq-1 ok win (zero dispatch); the
      // seq-ordered fold correctly takes seq 2's failed finish as the last
      // word and re-dispatches — as attempt 3 (two prior starts seeded).
      const calls: string[] = [];
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor: createGovernor({}), allowAdvisory: true },
      );
      expect(calls).toEqual(['j1']);
      const events = await log.read(report.runId);
      expect(events[0]).toMatchObject({ type: 'run-started', journalVersion: 2, seq: 3 });
      expect(jobStarts(events).map((event) => event.attempt)).toEqual([3]);
      expect(report.counts.done).toBe(1);
    },
    journalEnclosure(1),
  );
});
