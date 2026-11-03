// Governor tests (split from test/kernel/governor.test.ts — pure move): USD cap honest stop (ws-a item 3), dual caps (ws-a item 4), attempt caps (ws-a item 2).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { BudgetGovernor, createGovernor, governorConfig } from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import {
  entry,
  failOp,
  independentPlan,
  okOp,
  rowStatuses,
  spendyOp,
  tick,
  viewWith,
  waitFor,
} from './governor.helpers.js';
import type { OpResult, Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 2. USD cap — honest stop (I9)
// ---------------------------------------------------------------------------

describe('USD cap trips mid-run (ws-a item 3)', () => {
  test('remaining jobs get budget-exhausted refusal rows; done rows keep real results', async () => {
    const governor = createGovernor(
      governorConfig({ concurrency: 2, stopOnError: false, maxUsd: 1.0 }, {}),
    );
    const plan = independentPlan('plan-usd', 5, 'spendy');
    const registry = viewWith(entry('spendy', spendyOp));

    // The GOVERNED RUNNER owns the honest stop: its return IS the final
    // report (the deleted withBudgetStop post-pass is gone).
    const report = await runPlan(plan, { concurrency: 2, stopOnError: false }, registry, {
      governor,
      allowAdvisory: true,
    });

    // I9 honesty, both directions: the trip gated NO undispatched work —
    // every row kept its real verdict, nothing was re-marked — so the
    // report carries NO stoppedEarly claim.
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
    // a and b were admitted pre-trip and keep their real results; c/d/e were
    // refused post-trip and keep their real budget-exhausted verdicts.
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'j1' });
    expect(report.jobs[1]?.result).toEqual({ status: 'ok', value: 'j2' });
    expect(rowStatuses(report)).toEqual([
      'ok',
      'ok',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
    ]);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 3,
    });
    // The trip and its cause are recorded; injected usage rolled up too.
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/exceeded cap 1/);
    expect(governor.usdSpent).toBe(1.2);
    expect(governor.usage).toEqual({ input: 20, output: 10, cacheRead: 0, cacheWrite: 0 });
    const trip = governor.events.find((event) => event.kind === 'budget-tripped');
    expect(trip).toBeDefined();
  });

  test('stopOnError + trip: the queued-after-trip rows are transitively re-marked budget-exhausted', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const plan: Plan = {
      id: 'plan-usd-stop',
      jobs: [
        { id: 'a', op: 'spendy', input: { jobId: 'a' } },
        { id: 'b', op: 'spendy', input: { jobId: 'b' }, dependsOn: ['a'] }, // trips during b
        { id: 'c', op: 'ok', input: { jobId: 'c' }, dependsOn: ['b'] }, // never dispatched after the trip
        { id: 'd', op: 'ok', input: { jobId: 'd' }, dependsOn: ['c'] }, // gated behind c
      ],
    };
    const registry = viewWith(entry('spendy', spendyOp), entry('ok', okOp));
    // The runner's tripped gate stops dispatch BEFORE the next admission:
    // c never even admits (the old decorator path refused it at admission —
    // a real verdict row); it sits queued until the honest-stop pass
    // re-marks it, transitively with d.
    const report = await runPlan(plan, { concurrency: 1, stopOnError: true }, registry, {
      governor,
      allowAdvisory: true,
    });
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted', 'budget-exhausted']);
    expect(report.jobs[3]?.result).toEqual({ status: 'budget-exhausted' });
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 2,
    });
  });

  test('diamond dependency: a shared budget-caused obstruction re-marks the diamond root (I9)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // e → f → d → {b, c} → a: the SAME budget-caused obstruction sits under
    // BOTH branches below d, so the causality walk revisits its verdict —
    // exactly the shape where a visited-marker misread as "not budget-caused"
    // kept the root dishonest.
    const plan: Plan = {
      id: 'plan-diamond',
      jobs: [
        { id: 'e', op: 'spendy', input: { jobId: 'e' } },
        { id: 'f', op: 'spendy', input: { jobId: 'f' }, dependsOn: ['e'] }, // trips during f
        { id: 'd', op: 'ok', input: { jobId: 'd' }, dependsOn: ['f'] }, // never dispatched
        { id: 'b', op: 'ok', input: { jobId: 'b' }, dependsOn: ['d'] }, // gated behind d
        { id: 'c', op: 'ok', input: { jobId: 'c' }, dependsOn: ['d'] }, // gated behind d
        { id: 'a', op: 'ok', input: { jobId: 'a' }, dependsOn: ['b', 'c'] }, // the diamond root
      ],
    };
    const registry = viewWith(entry('spendy', spendyOp), entry('ok', okOp));
    const report = await runPlan(plan, { concurrency: 1, stopOnError: true }, registry, {
      governor,
      allowAdvisory: true,
    });
    // ALL of d, b, c AND the diamond root a are budget-caused — the memoized
    // verdict is reused for the second branch instead of dropping it.
    expect(rowStatuses(report)).toEqual([
      'ok',
      'ok',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
    ]);
    expect(report.jobs[5]?.result).toEqual({ status: 'budget-exhausted' }); // the root
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 4,
    });
  });

  test('counts: genuinely-blocked rows keep counts.blocked when the governor trips (review VB1B)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const plan: Plan = {
      id: 'plan-counts',
      jobs: [
        { id: 'f1', op: 'fail', input: { jobId: 'f1' } }, // REAL failure
        { id: 's1', op: 'spendy', input: { jobId: 's1' } },
        { id: 'f2', op: 'ok', input: { jobId: 'f2' }, dependsOn: ['f1'] }, // blocked for REAL
        { id: 's2', op: 'spendy', input: { jobId: 's2' }, dependsOn: ['s1'] }, // trips during s2
        { id: 's3', op: 'ok', input: { jobId: 's3' }, dependsOn: ['s2'] }, // never dispatched
        { id: 's4', op: 'ok', input: { jobId: 's4' }, dependsOn: ['s3'] }, // gated behind s3
      ],
    };
    const registry = viewWith(entry('fail', failOp), entry('spendy', spendyOp), entry('ok', okOp));
    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry, {
      governor,
      allowAdvisory: true,
    });
    // Only s3 and s4 move (queued → budget-exhausted). f2 keeps its real
    // verdict AND its blocked count — the honest-stop pass re-marks only
    // rows whose non-execution is transitively budget-caused, never a row
    // blocked by a genuine failure.
    expect(rowStatuses(report)).toEqual([
      'failed',
      'ok',
      'failed',
      'ok',
      'budget-exhausted',
      'budget-exhausted',
    ]);
    expect(report.jobs[2]?.result).toMatchObject({
      status: 'failed',
      error: /blocked: dependency 'f1'/,
    });
    expect(report.jobs[5]?.result).toEqual({ status: 'budget-exhausted' });
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 1,
      done: 2,
      failed: 1,
      'budget-exhausted': 2,
    });
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
  });
});

// ---------------------------------------------------------------------------
// 3. Dual caps — in-flight ceiling vs run dispatch quota
// ---------------------------------------------------------------------------

describe('dual caps (ws-a item 4)', () => {
  let entered: string[];
  let inFlight: number;
  let highWater: number;
  let releases: Map<string, () => void>;

  const gatedOp = async (raw: unknown): Promise<OpResult<unknown>> => {
    const jobId = (raw as { jobId: string }).jobId;
    entered.push(jobId);
    inFlight += 1;
    highWater = Math.max(highWater, inFlight);
    await new Promise<void>((resolve) => {
      releases.set(jobId, resolve);
    });
    inFlight -= 1;
    return { status: 'ok', value: jobId };
  };

  /** Release gated ops as they enter, until all `total` have entered (bounded — a regression fails loudly, never hangs). */
  const drain = async (total: number): Promise<void> => {
    let spins = 0;
    while (entered.length < total) {
      spins += 1;
      if (spins > 10_000) {
        throw new Error(`drain: gated ops did not progress (entered ${entered.length}/${total})`);
      }
      const pending = [...releases.values()];
      releases.clear();
      for (const release of pending) release();
      await tick();
    }
    const rest = [...releases.values()];
    releases.clear();
    for (const release of rest) release();
  };

  beforeEach(() => {
    entered = [];
    inFlight = 0;
    highWater = 0;
    releases = new Map();
  });

  test('in-flight ceiling queues: the high-water mark never exceeds Limits.inFlightCeiling', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 6, stopOnError: false }, { inFlightCeiling: 2 }),
    );
    const plan = independentPlan('plan-ceiling', 6);
    const run = runPlan(
      plan,
      { concurrency: 6, stopOnError: false },
      viewWith(entry('fake', gatedOp)),
      { governor, allowAdvisory: true },
    );
    await waitFor(() => entered.length === 2, 'ceiling to admit exactly 2');
    expect(highWater).toBe(2);
    expect(governor.inFlight).toBe(2);
    await Promise.all([drain(6), run]);
    expect(entered).toHaveLength(6);
    expect(highWater).toBe(2); // queueing, never failing: all 6 ran, 2 at a time
    expect(governor.inFlight).toBe(0);
    const report = await run;
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']);
  });

  test('the pool binds when concurrency is lower than the ceiling (effective min)', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 2, stopOnError: false }, { inFlightCeiling: 5 }),
    );
    const plan = independentPlan('plan-min', 4);
    const run = runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', gatedOp)),
      { governor, allowAdvisory: true },
    );
    await waitFor(() => entered.length === 2, 'the pool to admit exactly 2');
    expect(highWater).toBe(2);
    await Promise.all([drain(4), run]);
    expect(highWater).toBe(2); // RunOptions.concurrency is the binder
    const report = await run;
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  test('runDispatchQuota refuses further dispatches, with the refusal recorded', async () => {
    const governor = new BudgetGovernor({ runDispatchQuota: 4 });
    const calls: string[] = [];
    const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      return okOp(raw);
    };
    const plan = independentPlan('plan-quota', 6);
    const report = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOk)),
      { governor, allowAdvisory: true },
    );
    expect(calls).toHaveLength(4); // the quota, exactly
    expect(governor.dispatchCount).toBe(4);
    expect(rowStatuses(report)).toEqual([
      'ok',
      'ok',
      'ok',
      'ok',
      'budget-exhausted',
      'budget-exhausted',
    ]);
    const refusals = governor.events.filter((event) => event.kind === 'short-circuited');
    expect(refusals).toHaveLength(2);
    expect(refusals.map((event) => (event as { reason: string }).reason)).toEqual([
      'dispatch-quota',
      'dispatch-quota',
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. Attempt caps — bounded re-dispatch and the frozen attempt field
// ---------------------------------------------------------------------------

describe('attempt caps (ws-a item 2)', () => {
  test('bounded re-dispatch end-to-end: two attempts, no third dispatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-attempt-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-attempt',
        jobs: [{ id: 'j1', op: 'flaky', input: { jobId: 'j1' } }],
      };
      const calls: string[] = [];
      const flaky = async (raw: unknown): Promise<OpResult<unknown>> => {
        calls.push((raw as { jobId: string }).jobId);
        return { status: 'failed', error: 'flake' };
      };
      // --- Attempt 1 ---
      const run1 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('flaky', flaky)),
        { governor: createGovernor({ maxAttemptsPerJob: 2 }), allowAdvisory: true },
      );
      expect(calls).toEqual(['j1']);
      const events1 = await log.read(run1.runId);
      expect(events1.filter((event) => event.type === 'job-started')).toMatchObject([
        { attempt: 1 },
      ]);
      // The second attempt is a resumed run under a governor seeded from run 1.
      const governor2 = new BudgetGovernor({ maxAttemptsPerJob: 2 });
      governor2.seedFromJournal(events1);
      expect(governor2.attemptsFor('j1')).toBe(1);
      const run2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('flaky', flaky)),
        { governor: governor2, allowAdvisory: true },
      );
      expect(calls).toEqual(['j1', 'j1']); // attempt 2 happened
      expect(
        governor2.events.filter((event) => event.kind === 'admitted').map((event) => event.attempt),
      ).toEqual([2]);
      const events2 = await log.read(run2.runId);
      // The governed runner journals the TRUE ordinal: run 2's job-started
      // carries attempt 2 (the seeded fold's admission).
      expect(events2.filter((event) => event.type === 'job-started')).toMatchObject([
        { attempt: 2 },
      ]);

      // Over the ACCUMULATED evidence the cap is reached: the third dispatch is
      // refused by the governor, no op call.
      const governor3 = new BudgetGovernor({ maxAttemptsPerJob: 2 });
      governor3.seedFromJournal([...events1, ...events2]);
      expect(governor3.attemptsFor('j1')).toBe(2);
      const run3 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('flaky', flaky)),
        { governor: governor3, allowAdvisory: true },
      );
      expect(calls).toEqual(['j1', 'j1']); // UNCHANGED — no third dispatch
      expect(run3.jobs[0]?.result).toEqual({ status: 'budget-exhausted' });
      const refusals = governor3.events.filter((event) => event.kind === 'short-circuited');
      expect(refusals.map((event) => (event as { reason: string }).reason)).toEqual([
        'attempt-cap',
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the frozen journal attempt field drives the cap after seeding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-attempt-field-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-field',
        jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
      };
      const manifest = makeManifest(plan);
      // A prior GOVERNED run whose journal carries TRUE ordinals: attempts
      // 1 and 2, definitively failed. (v2: a governed resume over a v1
      // journal with dispatches would be refused — v1 carries no spend.)
      await log.append('plan-field--prior--aa', {
        type: 'run-started',
        runId: 'plan-field--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-field',
        journalVersion: 2,
        seq: 1,
        governance: { attended: false },
      });
      await log.append('plan-field--prior--aa', {
        type: 'job-started',
        runId: 'plan-field--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 1,
      });
      await log.append('plan-field--prior--aa', {
        type: 'job-started',
        runId: 'plan-field--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: 2,
      });
      await log.append('plan-field--prior--aa', {
        type: 'job-finished',
        runId: 'plan-field--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: manifest.jobs[0]?.inputsHash ?? '',
        result: { status: 'failed', error: 'flake' },
      });
      const events = await log.read('plan-field--prior--aa');

      const calls: string[] = [];
      const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
        calls.push((raw as { jobId: string }).jobId);
        return okOp(raw);
      };
      const governor = new BudgetGovernor({ maxAttemptsPerJob: 2 });
      governor.seedFromJournal(events);
      expect(governor.attemptsFor('j1')).toBe(2); // max(frozen 1, occurrence 2) — the fold

      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        viewWith(entry('fake', countingOk)),
        { governor, allowAdvisory: true },
      );
      expect(calls).toEqual([]); // a third dispatch never runs the op
      expect(report.jobs[0]?.result).toEqual({ status: 'budget-exhausted' });
      const refusals = governor.events.filter((event) => event.kind === 'short-circuited');
      expect(refusals.map((event) => (event as { reason: string }).reason)).toEqual([
        'attempt-cap',
      ]);
      expect(governor.tripped).toBe(false); // an attempt cap is not a USD trip
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
