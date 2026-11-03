// Split from runner-governed.test.ts (owner-mandated file-size split).
// W2.3 reserve-then-settle — release edge cases: full-charge crash window over the cap trips at
// seed, abort-on-trip slot holding, the dispatch-closed guard, and the
// capless-over-capped C_prev inheritance.
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ACQUISITION_STEP_MS,
  cleanupActions,
  journalEnclosure,
  runPlan,
  settleFixtureWork,
  entry,
  viewWith,
  independentPlan,
  okOp,
  countingOp,
  spendOnce,
  rowStatuses,
} from './runner-governed.helpers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import {
  type JournalEvent,
  type OpResult,
  type Plan,
  type RunReport,
} from '../../src/kernel/types.js';

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
    'A12b: a full-charge crash window over the cap trips the resumed run at seed — before any dispatch',
    async () => {
      const log = openRunLog(w3dir);
      const plan: Plan = {
        id: 'w23-crashcap',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const crashRunId = 'w23-crashcap--r1--aa';
      await log.append(crashRunId, {
        type: 'run-started',
        runId: crashRunId,
        at: '2026-01-01T00:00:00.000Z',
        planId: 'w23-crashcap',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 1, attended: false },
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
        usd: 1.5,
        class: 'advisory',
      });

      const calls: string[] = [];
      const governor = createGovernor({ maxUsd: 1 });
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir, resume: true },
        viewWith(entry('fake', countingOp(calls))),
        { governor, allowAdvisory: true },
      );
      expect(calls).toEqual([]); // the seeded overrun trips BEFORE any dispatch
      expect(governor.tripped).toBe(true);
      expect(governor.tripKind).toBe('exhausted');
      // The row is QUARANTINED (needs-human), not re-marked: the quarantine
      // pass runs before the waves and the honest-stop walk never touches
      // quarantined rows — a quarantine verdict outranks the budget re-mark,
      // and both facts (the job-quarantined event and the trip) are on the
      // journal for the operator.
      expect(rowStatuses(report)).toEqual(['needs-human']);
      expect(report.stoppedEarly).toBe(false);
    },
    journalEnclosure(1),
  );

  test(
    'abort-on-trip: a budget trip aborts the IN-FLIGHT dispatch; its reservation settles and the slot is held until then',
    async () => {
      const calls: string[] = [];
      let observedAbort = false;
      const slowOp = async (raw: unknown): Promise<OpResult<unknown>> => {
        const jobId = (raw as { jobId: string }).jobId;
        calls.push(jobId);
        const ctx = currentJobContext();
        await new Promise<void>((resolve) => {
          ctx?.signal.addEventListener('abort', () => {
            observedAbort = true;
            resolve();
          });
        });
        // Post-abort evidence: the dispatch was mid-flight when the trip landed.
        ctx?.reportResult({
          usage: { input: 5, output: 5, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.2,
        });
        return { status: 'ok', value: jobId };
      };
      const governor = createGovernor({ maxUsd: 1 });
      const plan: Plan = {
        id: 'w23-abort',
        jobs: [
          { id: 'j1', op: 'slow', input: { jobId: 'j1' } },
          { id: 'j2', op: 'spendy', input: { jobId: 'j2' } },
        ],
      };
      const report = await runPlan(
        plan,
        { concurrency: 2, stopOnError: false, journalDir: w3dir },
        viewWith(entry('slow', slowOp), entry('spendy', spendOnce(calls, 1.5))),
        { governor, allowAdvisory: true },
      );
      // j2's observed spend (1.5) crossed the cap → exhausted; j1 was aborted
      // in-flight and kept its real post-abort verdict.
      expect(observedAbort).toBe(true);
      expect(governor.tripped).toBe(true);
      expect(governor.tripKind).toBe('exhausted');
      // Every row kept its real post-abort verdict and nothing was gated (both
      // jobs ran; there was nothing left undispatched), so no early-stop claim
      // is honest here (I9, both directions).
      expect(report.stoppedEarly).toBe(false);
      // Both dispatches settled: the journal carries exactly two
      // reservation-settled events, and the run-level ledger moved by their
      // charges (j2 1.5 via fold + breach-safe settle; j1 0.2 observed).
      const events = await openRunLog(w3dir).read(report.runId);
      const settles = events.filter(
        (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
          event.type === 'reservation-settled',
      );
      expect(settles).toHaveLength(2);
      const j2 = settles.find((event) => event.jobId === 'j2');
      expect(j2).toMatchObject({ charged: 1.5, basis: 'observed' }); // the fold was the evidence
      const j1 = settles.find((event) => event.jobId === 'j1');
      expect(j1).toMatchObject({ charged: 0.2, basis: 'observed' });
      // The trip EVIDENCE event lands before run-finished.
      expect(events[events.length - 1]?.type).toBe('run-finished');
      expect(events[events.length - 2]).toMatchObject({
        type: 'budget-tripped',
        tripKind: 'exhausted',
      });
    },
    journalEnclosure(1),
  );

  test(
    'dispatch-closed guard: late evidence from a killed op is dropped (usdSpent equals the journal charged)',
    async () => {
      // A local virtual clock (the governor suite owns the shared one): the
      // kill rungs must fire deterministically for the detached-promise test.
      let nowMs = 1_000_000;
      const timers: Array<{ at: number; fn: () => void }> = [];
      const clock = {
        now: () => nowMs,
        setTimeout(fn: () => void, ms: number) {
          const timer = { at: nowMs + ms, fn };
          timers.push(timer);
          return timer;
        },
        clearTimeout(handle: unknown) {
          const index = timers.indexOf(handle as { at: number; fn: () => void });
          if (index >= 0) timers.splice(index, 1);
        },
        advance(ms: number) {
          const target = nowMs + ms;
          for (;;) {
            const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0];
            if (due === undefined) break;
            nowMs = due.at;
            timers.splice(timers.indexOf(due), 1);
            due.fn();
          }
          nowMs = target;
        },
      };
      const pump = async (promise: Promise<unknown>): Promise<void> => {
        let settled = false;
        void promise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        for (let i = 0; i < 1000 && !settled; i++) {
          clock.advance(10);
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
        if (!settled) throw new Error('pump: run did not settle');
      };
      let bodyEntered!: () => void;
      const ready = new Promise<void>((resolve) => {
        bodyEntered = resolve;
      });
      cleanupActions.add(() => clock.advance(10_000));
      const calls: string[] = [];
      let held: ReturnType<typeof currentJobContext>;
      let runReport: RunReport | undefined;
      const hangThenReport = async (raw: unknown): Promise<OpResult<unknown>> => {
        const jobId = (raw as { jobId: string }).jobId;
        calls.push(jobId);
        held = currentJobContext();
        bodyEntered();
        await new Promise<never>(() => {}); // hangs — killed at the final rung
        return okOp(raw); // unreachable
      };
      const governor = createGovernor(
        { maxUsd: 5, perJobWallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
        clock,
      );
      const plan: Plan = {
        id: 'w23-late',
        jobs: [{ id: 'j1', op: 'hang', input: { jobId: 'j1' } }],
      };
      const running = runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('hang', hangThenReport)),
        { governor, allowAdvisory: true },
      ).then((report) => {
        runReport = report;
      });
      await Promise.race([
        ready,
        running.then(() => {
          throw new Error('fixture: run settled before body entry');
        }),
      ]);
      await pump(running);
      // The kill settled the dispatch: basis 'full', charged = the whole
      // reservation (the fair share C/concurrency = 5/1).
      const report = runReport as RunReport;
      expect(report.jobs[0]?.result.status).toBe('budget-exhausted');
      const events = await openRunLog(w3dir).read(report.runId);
      const settles = events.filter(
        (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
          event.type === 'reservation-settled',
      );
      expect(settles).toHaveLength(1);
      const journalCharged = settles[0]?.charged ?? 0;
      expect(journalCharged).toBeGreaterThan(0);
      expect(governor.usdSpent).toBeCloseTo(journalCharged);
      // LATE evidence from the detached promise: DROPPED — the ledger does not
      // move past the journal, and no usage event lands.
      const eventsBefore = governor.events.length;
      held?.reportResult({
        usage: { input: 99, output: 99, cacheRead: 0, cacheWrite: 0 },
        costUSD: 9,
      });
      expect(governor.usdSpent).toBeCloseTo(journalCharged);
      expect(governor.events.length).toBe(eventsBefore);
    },
    journalEnclosure(1),
  );

  test(
    'a capless governed run over capped history inherits C_prev conservatively and journals the inheritance',
    async () => {
      // Run 1: capped at 5, spends 3.
      const calls1: string[] = [];
      await runPlan(
        independentPlan('w23-inherit', 1),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', spendOnce(calls1, 3))),
        { governor: createGovernor({ maxUsd: 5 }), allowAdvisory: true },
      );
      // Run 2: governed but UNCAPPED — inherits C_prev 5 and journals it.
      const calls2: string[] = [];
      const governor2 = createGovernor({});
      const report2 = await runPlan(
        independentPlan('w23-inherit', 1),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', spendOnce(calls2, 1))),
        { governor: governor2, allowAdvisory: true },
      );
      const events2 = await openRunLog(w3dir).read(report2.runId);
      const started2 = events2[0] as Extract<JournalEvent, { type: 'run-started' }>;
      expect(started2.governance?.inheritedCapUsd).toBe(5);
      expect(started2.governance?.capUsd).toBeUndefined();
      // The inherited cap BOUND the reservations: 5 − 3 seeded = 2 capacity.
      const opens = events2.filter(
        (event): event is Extract<JournalEvent, { type: 'reservation-opened' }> =>
          event.type === 'reservation-opened',
      );
      expect(opens[0]).toMatchObject({ usd: 2, proposedUsd: 5 }); // share C/concurrency = 5/1, shrunk to capacity 2
      expect(governor2.usdSpent).toBeCloseTo(4); // 3 seeded + 1 this run
      // Run 3: a cap RAISE over C_prev still refuses — the inheritance did not move C.
      const calls3: string[] = [];
      await expect(
        runPlan(
          independentPlan('w23-inherit', 1),
          { concurrency: 1, stopOnError: false, journalDir: w3dir },
          viewWith(entry('fake', countingOp(calls3))),
          { governor: createGovernor({ maxUsd: 6 }), allowAdvisory: true },
        ),
      ).rejects.toThrow('runPlan: cap raised from 5 to 6');
    },
    journalEnclosure(3),
  );
});
