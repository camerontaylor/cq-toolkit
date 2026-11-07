// Split from runner-governed.test.ts (owner-mandated file-size split).
// W2.3 reserve-then-settle — reservation settlement: write-ahead order, settle basis (full / zero),
// FIFO capacity waits, and the A12c advisory gate + escapes.
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
  ACQUISITION_STEP_MS,
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
  type ShortCircuitEvent,
  type FinishedEvent,
} from './runner-governed.helpers.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { type JournalEvent, type OpResult, type Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// W2.3 — reserve-then-settle (the plan's §6 W2.3 row + adversarial rows
// A12b/A12c). The write-ahead reservation journal, the unresolved-reservation
// quarantine, the ADVISORY gate, abort-on-trip, and the cap inheritance.
// ---------------------------------------------------------------------------

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
    'journal order pins write-ahead: reservation-opened (durable) before the dispatch, settled before the finish',
    async () => {
      const calls: string[] = [];
      const report = await runPlan(
        independentPlan('w23-order', 1),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', spendOnce(calls, 0.1))),
        { governor: createGovernor({ maxUsd: 1 }), allowAdvisory: true },
      );
      expect(report.counts.done).toBe(1);
      const events = await openRunLog(w3dir).read(report.runId);
      const types = events.map((event) => event.type);
      expect(types).toEqual([
        'run-started',
        'job-started',
        'reservation-opened',
        'reservation-settled',
        'job-finished',
        'run-finished',
      ]);
      const opened = events.find(
        (event): event is Extract<JournalEvent, { type: 'reservation-opened' }> =>
          event.type === 'reservation-opened',
      );
      expect(opened).toMatchObject({
        jobId: 'j1',
        attempt: 1,
        reservationId: `${report.runId}:j1:1:1`,
        usd: 1, // the fair share C/concurrency = 1/1
        class: 'advisory',
      });
      const settled = events.find(
        (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
          event.type === 'reservation-settled',
      );
      expect(settled).toMatchObject({ charged: 0.1, basis: 'observed', priced: true });
      const finished = events.find(
        (event): event is FinishedEvent => event.type === 'job-finished',
      );
      expect(finished).toMatchObject({ charged: 0.1, costUSD: 0.1 });
    },
    journalEnclosure(1),
  );

  test(
    'an op that REJECTS settles basis full (the failed verdict cannot say the dispatch never started)',
    async () => {
      // executeOp never rejects: a throwing op becomes a `failed` OpResult, so
      // the ladder reports 'completed' and the settle basis alone would read
      // 'observed' and charge zero for a dispatch that had already started
      // billable work. The dispatch signals the post-invocation failure out
      // of band.
      const throwAfterDispatch = async (): Promise<OpResult<unknown>> => {
        // Billable work started, then the op died before reporting anything.
        throw new Error('op died mid-dispatch');
      };
      const governor = createGovernor({ maxUsd: 1 });
      const report = await runPlan(
        independentPlan('w23-threw', 1),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', throwAfterDispatch)),
        { governor, allowAdvisory: true },
      );
      expect(report.jobs[0]?.result.status).toBe('failed');
      const events = await openRunLog(w3dir).read(report.runId);
      const settled = events.find(
        (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
          event.type === 'reservation-settled',
      );
      // charged = the whole reservation (fair share C/concurrency = 1/1), not
      // the zero the definitive-verdict reading would have produced.
      expect(settled).toMatchObject({ charged: 1, basis: 'full' });
      expect(governor.usdSpent).toBeCloseTo(1);
    },
    journalEnclosure(1),
  );

  test(
    'an op that RESOLVES to a contract violation also settles basis full',
    async () => {
      // The successful-but-invalid sibling of the rejecting case: the body ran
      // (and may have spent), then resolved to something executeOp refuses —
      // here a value that is not an OpResult at all. Same unknown-spend
      // exposure, same out-of-band signal; a verdict-only reading would settle
      // 'observed' zero.
      const resolvesToGarbage = (): Promise<OpResult<unknown>> =>
        Promise.resolve({ not: 'an OpResult' } as unknown as OpResult<unknown>);
      const governor = createGovernor({ maxUsd: 1 });
      const report = await runPlan(
        independentPlan('w23-contract', 1),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', resolvesToGarbage)),
        { governor, allowAdvisory: true },
      );
      expect(report.jobs[0]?.result.status).toBe('failed');
      const events = await openRunLog(w3dir).read(report.runId);
      const settled = events.find(
        (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
          event.type === 'reservation-settled',
      );
      expect(settled).toMatchObject({ charged: 1, basis: 'full' });
      expect(governor.usdSpent).toBeCloseTo(1);
    },
    journalEnclosure(1),
  );

  test(
    'a PRE-dispatch failure still settles observed zero (the full basis is not over-wide)',
    async () => {
      // The other side of the same boundary: nothing was dispatched, so the
      // reservation must settle at zero. An unknown op never reaches the op
      // body — the pre-dispatch reading must survive the new signal.
      const governor = createGovernor({ maxUsd: 1 });
      const report = await runPlan(
        independentPlan('w23-pre-dispatch', 1, 'nosuchop'),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', okOp)),
        { governor, allowAdvisory: true },
      );
      expect(report.jobs[0]?.result.status).toBe('failed');
      const events = await openRunLog(w3dir).read(report.runId);
      const settled = events.find(
        (event): event is Extract<JournalEvent, { type: 'reservation-settled' }> =>
          event.type === 'reservation-settled',
      );
      expect(settled).toMatchObject({ charged: 0, basis: 'observed' });
      expect(governor.usdSpent).toBeCloseTo(0);
    },
    journalEnclosure(1),
  );

  test(
    'capacity waits FIFO behind outstanding reservations, then admits (settled + outstanding + proposed ≤ cap)',
    async () => {
      // The park is CONSTRUCTED, not hoped for. cap 1.0, concurrency 4 → the
      // fair-share proposal is 0.25, so j1–j4 fill C exactly (4 × 0.25 = 1.0)
      // and j5's 0.25 proposal has nowhere to come from until a settle frees
      // room. Every op is GATED and released by this test in a known order, so
      // the wait is deterministic rather than a race:
      //   - j1–j4 hold their reservations (O = 1.0) until released;
      //   - releasing j1 frees its p-limit slot, so j5's dispatch starts and
      //     reaches `reserve` while j3 and j4 still hold theirs: free capacity
      //     is 1.0 − 0.1 − 0.75 = 0.15 < the 0.25 proposal → j5 WAITS;
      //   - only j2's settle (free 0.30 ≥ 0.25) wakes the head.
      // The middle assertion is the proof: a runner that granted j5 straight
      // after j1's settle would leave O at 0.90, not 0.75.
      const releases = new Map<string, () => void>();
      const entered: string[] = [];
      // A WALL-CLOCK wait, not the file's setImmediate `waitFor`: every
      // dispatch here writes durable journal events (fdatasync), and a tight
      // setImmediate loop can outrun the threadpool on a loaded runner — the
      // first wait then fails with jobs still starting (observed on CI, not
      // locally). setTimeout yields to the poll phase, so the durable writes
      // land inside the bound.
      const waitUntil = async (condition: () => boolean, what: string): Promise<void> => {
        const deadline = Date.now() + 10_000;
        while (!condition() && Date.now() < deadline) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 1);
          });
        }
        expect(condition(), `waitUntil: ${what}`).toBe(true);
      };
      const gated = async (raw: unknown): Promise<OpResult<unknown>> => {
        const jobId = (raw as { jobId: string }).jobId;
        entered.push(jobId);
        await new Promise<void>((resolve) => {
          releases.set(jobId, resolve);
        });
        currentJobContext()?.reportResult({
          usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
          costUSD: 0.1,
        });
        return { status: 'ok', value: jobId };
      };
      const governor = createGovernor({ maxUsd: 1 });
      const runPromise = runPlan(
        independentPlan('w23-fifo', 5),
        { concurrency: 4, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', gated)),
        { governor, allowAdvisory: true },
      );
      await waitUntil(() => entered.length === 4, 'j1–j4 to hold their reservations');
      expect(governor.outstandingUsd).toBeCloseTo(1);
      releases.get('j1')?.();
      // j1's settle is journalled inside its own dispatch, BEFORE p-limit
      // releases the slot — so once the ledger shows the charge, j5's reserve
      // is either parked or has already been granted.
      await waitUntil(() => governor.usdSpent >= 0.1, 'j1 to settle');
      expect(governor.outstandingUsd).toBeCloseTo(0.75); // j5 NOT granted: it parked
      expect(entered).not.toContain('j5');
      // The second settle frees the room j5's proposal needs.
      releases.get('j2')?.();
      await waitUntil(() => entered.includes('j5'), 'j5 to be granted its reservation');
      releases.get('j5')?.();
      releases.get('j3')?.();
      releases.get('j4')?.();
      const report = await runPromise;
      expect(entered).toEqual(expect.arrayContaining(['j1', 'j2', 'j3', 'j4', 'j5']));
      expect(report.counts.done).toBe(5);
      expect(report.costUSD).toBeCloseTo(0.5); // the seeded-less ledger: Σ charged
      // The cap held through the wait: settled + outstanding never exceeded C.
      expect(governor.outstandingUsd).toBeCloseTo(0);
    },
    journalEnclosure(1),
  );

  test(
    'A12c: an unattended governed run refuses every ADVISORY dispatch without the escape',
    async () => {
      const calls: string[] = [];
      const governor = createGovernor({ maxUsd: 5 });
      const report = await runPlan(
        independentPlan('w23-a12c', 2),
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor }, // no attended, no allowAdvisory — the v1.1 default
      );
      expect(calls).toEqual([]); // nothing dispatched
      expect(rowStatuses(report)).toEqual(['budget-exhausted', 'budget-exhausted']);
      const events = await openRunLog(w3dir).read(report.runId);
      expect(events.filter((event) => event.type === 'reservation-refused')).toHaveLength(2);
      expect(events.filter((event) => event.type === 'job-started')).toHaveLength(0);
      const started = events[0] as Extract<JournalEvent, { type: 'run-started' }>;
      expect(started.governance).toMatchObject({ attended: false, capUsd: 5 });
      expect(started.governance?.allowAdvisory).toBeUndefined();
      // The refusal rows are terminal budget evidence; nothing was gated into
      // a stop claim (I9, both directions like the admission refusals).
      expect(report.stoppedEarly).toBe(false);
      const shorts = governor.events.filter(
        (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
      );
      expect(shorts.map((event) => event.reason)).toEqual(['advisory-lane', 'advisory-lane']);
    },
    journalEnclosure(1),
  );

  test(
    'A12c: allowAdvisory and attended are the two named escapes, and the journal records WHO set the escape (r1 M4)',
    async () => {
      for (const escape of [
        { allowAdvisory: true, allowAdvisoryProvenance: 'product' as const },
        { allowAdvisory: true, allowAdvisoryProvenance: 'operator' as const },
        { attended: true },
      ] as const) {
        const w3dirEscape = await mkdtemp(join(tmpdir(), 'w23-escape-'));
        try {
          const calls: string[] = [];
          const report = await runPlan(
            independentPlan('w23-escape', 1),
            { concurrency: 1, stopOnError: false, journalDir: w3dirEscape },
            viewWith(entry('fake', countingOp(calls))),
            { governor: createGovernor({}), ...escape },
          );
          expect(calls).toEqual(['j1']);
          expect(report.counts.done).toBe(1);
          const events = await openRunLog(w3dirEscape).read(report.runId);
          const started = events[0] as Extract<JournalEvent, { type: 'run-started' }>;
          if ('allowAdvisory' in escape) {
            expect(started.governance?.allowAdvisory).toBe(true);
            // The provenance rides the escape (ADR §2.3: allowAdvisory
            // admissions sit OUTSIDE C_max — the breach must be attributable).
            expect(started.governance?.allowAdvisoryProvenance).toBe(
              escape.allowAdvisoryProvenance,
            );
          } else {
            expect(started.governance?.attended).toBe(true);
            expect(started.governance?.allowAdvisory).toBeUndefined();
          }
        } finally {
          await rm(w3dirEscape, { recursive: true, force: true });
        }
      }
    },
    // Three escape variants, three journalled runPlan calls (one acquisition
    // each): budget one step per call.
    journalEnclosure(3),
  );

  test(
    'A12c: dependents of advisory-refused jobs re-mark budget-exhausted transitively, not fabricated failed',
    async () => {
      const calls: string[] = [];
      const governor = createGovernor({ maxUsd: 5 });
      const plan: Plan = {
        id: 'w23-a12c-chain',
        jobs: [
          { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
          { id: 'j2', op: 'fake', input: { jobId: 'j2' }, dependsOn: ['j1'] },
        ],
      };
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: w3dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor }, // unattended, no escape — both dispatches refuse
      );
      expect(calls).toEqual([]);
      // j1: the refusal row IS its terminal budget verdict. j2: blocked by j1,
      // and the CAUSE is the advisory refusal → re-marked budget-exhausted
      // (ADR §2.9), never a fabricated `failed` row.
      expect(rowStatuses(report)).toEqual(['budget-exhausted', 'budget-exhausted']);
      expect(report.counts['budget-exhausted']).toBe(2);
      expect(report.counts.blocked).toBe(0);
      // The stop gated j2's undispatched work — the honest-stop claim holds.
      expect(report.stoppedEarly).toBe(true);
      expect(report.earlyStopReason).toBe('budget');
    },
    journalEnclosure(1),
  );

  test(
    'comp 1: stopOnError halts on an advisory refusal WITHOUT re-marking the sibling or claiming a budget stop',
    async () => {
      const calls: string[] = [];
      const governor = createGovernor({ maxUsd: 5 });
      // Unattended, no escape: j1's dispatch is refused by the A12c gate. The
      // operator's stopOnError halts the run there — but a classification
      // refusal is a per-row terminal verdict, NOT a governor trip, so the
      // honest-stop pass must NOT re-mark j2 budget-exhausted (it stays
      // queued, re-runnable) and the run must NOT claim `earlyStopReason:
      // 'budget'` the journal has no budget-tripped fact for (the run spent
      // $0 and no bound fired).
      const report = await runPlan(
        independentPlan('w23-comp1', 2),
        { concurrency: 1, stopOnError: true, journalDir: w3dir },
        viewWith(entry('fake', countingOp(calls))),
        { governor }, // no attended, no allowAdvisory
      );
      expect(calls).toEqual([]); // nothing dispatched
      // j1: the refusal row is its terminal budget verdict. j2: queued.
      expect(rowStatuses(report)).toEqual(['budget-exhausted', 'indeterminate']);
      expect(report.jobs.find((row) => row.jobId === 'j2')?.result).toMatchObject({
        status: 'indeterminate',
      });
      // No budget stop claimed, no budget-tripped event journalled: the
      // report and the journal agree (I9).
      expect(report.stoppedEarly).toBe(false);
      expect(report.earlyStopReason).toBeUndefined();
      const events = await openRunLog(w3dir).read(report.runId);
      expect(events.some((event) => event.type === 'budget-tripped')).toBe(false);
      expect(events.filter((event) => event.type === 'reservation-refused')).toHaveLength(1);
      const finished = events.find(
        (event): event is Extract<JournalEvent, { type: 'run-finished' }> =>
          event.type === 'run-finished',
      );
      expect(finished).toMatchObject({ stoppedEarly: false });
      // The writer half of the line-count check (comp 2): the total matches,
      // run-finished included.
      expect(finished?.eventCount).toBe(events.length);
    },
    journalEnclosure(1),
  );
});
