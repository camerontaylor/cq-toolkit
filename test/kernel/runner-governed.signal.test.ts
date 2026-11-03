// Split from runner-governed.test.ts (owner-mandated file-size split).
// governed run signal (ADR-0003 section 2.3): pre-aborted signals stop
// before dispatch; mid-run aborts keep the admitted job's verdict.
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { describe, expect, test } from 'vitest';
import {
  runPlan,
  entry,
  viewWith,
  independentPlan,
  okOp,
  countingOp,
  rowStatuses,
  type AdmittedEvent,
  type TrippedEvent,
} from './runner-governed.helpers.js';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import { type OpResult, type Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 4. Run signal — pre-aborted and mid-run
// ---------------------------------------------------------------------------

/** One macrotask turn — lets the runner's fs/microtask work progress. */
const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/** Poll a condition across macrotask turns (deterministic, no real time). */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 10_000 && !condition(); i++) {
    await tick();
  }
  expect(condition(), `waitFor: ${what}`).toBe(true);
}

describe('governed run signal (ADR-0003 §2.3)', () => {
  test('a PRE-aborted signal over a dependency CHAIN: both rows stay queued, none blocked, earlyStopReason signal (cycle 4)', async () => {
    // The sweep's undefined-dep rule ("never classified counts as not-ok")
    // is a PLAIN-path honesty rule: under a governed signal stop the dep did
    // not fail — the run was cancelled before it could dispatch — so the
    // dependent row is queued (re-runnable on resume), never blocked.
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    external.abort();
    const plan: Plan = {
      id: 'plan-signal-pre-chain',
      jobs: [
        { id: 'a', op: 'fake', input: { jobId: 'a' } },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    expect(calls).toEqual([]); // nothing dispatched
    expect(rowStatuses(report)).toEqual(['indeterminate', 'indeterminate']);
    expect(report.counts.queued).toBe(2);
    expect(report.counts.blocked).toBe(0);
    expect(report.counts['budget-exhausted']).toBe(0);
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
  });

  test('a PRE-aborted signal stops before any dispatch: rows stay queued, earlyStopReason signal', async () => {
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    external.abort();
    const report = await runPlan(
      independentPlan('plan-signal-pre', 2),
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    expect(calls).toEqual([]); // nothing dispatched
    // NO budget re-marking: a cancel is not a budget verdict — rows stay
    // honestly queued.
    expect(rowStatuses(report)).toEqual(['indeterminate', 'indeterminate']);
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    });
    expect(report.counts.queued).toBe(2);
    expect(report.counts['budget-exhausted']).toBe(0);
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    const trip = governor.events.find(
      (event): event is TrippedEvent => event.kind === 'budget-tripped',
    );
    expect(trip?.tripKind).toBe('signal');
  });

  test('a MID-RUN abort: the admitted job keeps its post-abort verdict, queued rows stay queued', async () => {
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    let entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      entered = true;
      // Cooperates with rung 1: resolves when the context signal aborts
      // (composed from the external run signal) and returns its own verdict.
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-mid',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 1, stopOnError: true },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => entered, 'the hang op to enter');
    external.abort();
    const report = await runPromise;
    // j1's op is not the counting fake (its entry is what ran); j2 (queued
    // in the pool behind j1) never dispatched, so calls stays empty.
    expect(calls).toEqual([]);
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'cancelled by run signal',
    });
    expect(report.jobs[1]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    });
    expect(report.counts.queued).toBe(1);
    expect(report.counts['budget-exhausted']).toBe(0); // no budget re-marking
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    // j2 was never even admitted (the stop flag gated it before admission).
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => event.jobKey)).toEqual(['j1']);
  });

  test('a trip while a dispatch WAITS FOR A SLOT: signal → indeterminate + cancelled-while-queued, never budget-exhausted (cycle 2)', async () => {
    // The slot-wait window: j2 is ADMITTED and parked on the in-flight slot
    // when the trip lands — the short-circuit must not claim a budget
    // exhaustion for a cancel (the TripKind taxonomy's rule), and the row
    // must stay re-runnable (indeterminate, not budget-exhausted).
    const calls: string[] = [];
    const governor = createGovernor({ inFlightCeiling: 1 });
    const external = new AbortController();
    let j1Entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      j1Entered = true;
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-slot',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => j1Entered, 'j1 to enter');
    external.abort(); // j2 is admitted, waiting on the single in-flight slot
    const report = await runPromise;
    expect(calls).toEqual([]); // j2 never ran
    expect(report.jobs[1]?.result).toMatchObject({ status: 'indeterminate' });
    expect(report.jobs[1]?.result.status).not.toBe('budget-exhausted');
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    const shortCircuits = governor.events.filter((event) => event.kind === 'short-circuited');
    expect(shortCircuits.map((event) => event.reason)).toContain('cancelled-while-queued');
  });

  test('a MID-RUN abort over an a→b→c chain never fabricates blocked rows: [done, queued, queued] (r1 major)', async () => {
    // cancelledRun is a PREDICATE, not a run-start snapshot: the signal lands
    // DURING wave 1 (while a runs), so at wave 3 the old snapshot (still
    // false) fell back to the plain rule and marked c BLOCKED on b's missing
    // entry — the cancel fabricating a failure. The predicate sees the trip
    // at c's own decision point; b and c stay queued (re-runnable on resume).
    const calls: string[] = [];
    const governor = createGovernor({});
    const external = new AbortController();
    let aEntered = false;
    const okAfterAbort = async (): Promise<OpResult<unknown>> => {
      aEntered = true;
      // The op observes the composed cancel and completes with a REAL ok
      // verdict — a keeps its outcome; only the undispatched tail is
      // cancelled.
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return okOp({ jobId: 'a' });
    };
    const plan: Plan = {
      id: 'plan-signal-mid-chain',
      jobs: [
        { id: 'a', op: 'hang', input: { jobId: 'a' } },
        { id: 'b', op: 'fake', input: { jobId: 'b' }, dependsOn: ['a'] },
        { id: 'c', op: 'fake', input: { jobId: 'c' }, dependsOn: ['b'] },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('hang', okAfterAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => aEntered, 'a to enter');
    external.abort(); // mid-run: b and c are still undispatched
    const report = await runPromise;
    expect(calls).toEqual([]); // b and c never ran
    expect(rowStatuses(report)).toEqual(['ok', 'indeterminate', 'indeterminate']);
    expect(report.jobs[1]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    });
    expect(report.counts).toEqual({
      queued: 2,
      running: 0,
      blocked: 0, // the point: no fabricated blocked rows
      done: 1,
      failed: 0,
      'budget-exhausted': 0,
    });
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
  });

  test('a slot-wait cancel over a chain: the cancelled-while-queued dep stays UNRESOLVED — its dependent is queued, never blocked (composition H1)', async () => {
    // The cycle-2 slot-wait shape extended to a chain: j2 parks on the single
    // in-flight slot, the trip lands, and j2's row is written `indeterminate`
    // (a cancel, not a verdict). stateFromResult maps indeterminate → failed,
    // so the old sweep read j3's dependency as DEFINITIVELY failed and
    // fabricated a blocked row; under a cancel that indeterminate is
    // unresolved — j3 stays queued, re-runnable on resume.
    const calls: string[] = [];
    const governor = createGovernor({ inFlightCeiling: 1 });
    const external = new AbortController();
    let j1Entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      j1Entered = true;
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-slot-chain',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' }, dependsOn: ['j2'] },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => j1Entered, 'j1 to enter');
    external.abort(); // j2 is admitted, waiting on the single in-flight slot
    const report = await runPromise;
    expect(calls).toEqual([]); // j2 and j3 never ran the op
    expect(report.jobs[1]?.result).toMatchObject({ status: 'indeterminate' }); // j2 cancelled-while-queued
    expect(report.jobs[2]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: run stopped before dispatch',
    }); // j3 NOT blocked
    expect(report.counts.blocked).toBe(0);
    expect(report.counts.queued).toBe(1);
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    const shortCircuits = governor.events.filter((event) => event.kind === 'short-circuited');
    expect(shortCircuits.map((event) => event.reason)).toContain('cancelled-while-queued');
  });

  test('a trip BEFORE a queued dispatch is ADMITTED: the row stays queued for the stop sweep, never budget-exhausted (cycle 3)', async () => {
    // The admission-gate window: with concurrency 1, j2's dispatch starts
    // only after j1 finishes — by then the cancel has tripped the governor,
    // and admit() answers reason 'budget' for every tripped kind. The cancel
    // is not a budget event: the gate must return without classifying, so
    // the row stays re-runnable on resume, never a budget refusal.
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 1 });
    const external = new AbortController();
    let j1Entered = false;
    const hangUntilAbort = async (): Promise<OpResult<unknown>> => {
      j1Entered = true;
      await new Promise<void>((resolve) => {
        currentJobContext()?.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      return { status: 'indeterminate', detail: 'cancelled by run signal' };
    };
    const plan: Plan = {
      id: 'plan-signal-admission',
      jobs: [
        { id: 'j1', op: 'hang', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
      ],
    };
    const runPromise = runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('hang', hangUntilAbort), entry('fake', countingOp(calls))),
      { governor, signal: external.signal, allowAdvisory: true },
    );
    await waitFor(() => j1Entered, 'j1 to enter');
    external.abort(); // j2 is submitted but not yet dispatched (concurrency 1)
    const report = await runPromise;
    expect(calls).toEqual([]); // j2 never ran
    expect(report.jobs[1]?.result).toMatchObject({ status: 'indeterminate' });
    expect(report.jobs[1]?.result.status).not.toBe('budget-exhausted');
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('signal');
    // The gate left NO j2 evidence: no admission, no short-circuit record,
    // no journalled refusal — the stop sweep owns the queued classification.
    expect(
      governor.events.some((event) => event.kind === 'short-circuited' && event.jobKey === 'j2'),
    ).toBe(false);
  });
});
