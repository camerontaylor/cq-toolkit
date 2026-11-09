// Split from runner-governed.test.ts (owner-mandated file-size split).
// governed basics: caps/governor arg refusals (W2.2 areas 1-1b),
// in-memory run + spend rollups, admission keyed on the plan job id,
// and trip -> honest stop (I9).
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { describe, expect, test } from 'vitest';
import {
  runPlan,
  entry,
  viewWith,
  independentPlan,
  okOp,
  failOp,
  countingOp,
  rowStatuses,
  type AdmittedEvent,
  type TrippedEvent,
} from './runner-governed.helpers.js';
import { currentJobContext, createGovernor, type Governance } from '../../src/kernel/governor.js';
import { type OpResult, type Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 1. Caps without governance
// ---------------------------------------------------------------------------

describe('caps require governance', () => {
  test('opts.maxUsd without a gov handle throws before anything runs', async () => {
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-capguard-usd', 2),
        { concurrency: 1, stopOnError: false, maxUsd: 1 },
        viewWith(entry('fake', countingOp(calls))),
      ),
    ).rejects.toThrow('runPlan: caps require governance');
    expect(calls).toEqual([]); // no op ever ran
  });

  test('opts.maxTokens without a gov handle throws likewise', async () => {
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-capguard-tokens', 2),
        { concurrency: 1, stopOnError: false, maxTokens: 100 },
        viewWith(entry('fake', countingOp(calls))),
      ),
    ).rejects.toThrow('runPlan: caps require governance');
    expect(calls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1b. Governance without a governor — the caps guard's mirror (review M4)
// ---------------------------------------------------------------------------

describe('governance requires a governor', () => {
  test('a { governor: undefined } Governance handle throws before anything runs', async () => {
    // Without this guard the handle degrades to a silent no-op run that still
    // journals a governed-looking v2 record (seq claimed, governance block) —
    // the exact dishonesty the caps guard exists to prevent for caps.
    const calls: string[] = [];
    await expect(
      runPlan(
        independentPlan('plan-gov-no-governor', 1),
        { concurrency: 1, stopOnError: false },
        viewWith(entry('fake', countingOp(calls))),
        { governor: undefined } as unknown as Governance,
      ),
    ).rejects.toThrow('runPlan: governance requires a governor');
    expect(calls).toEqual([]); // no op ran — no silent ungoverned dispatch
  });
});

// ---------------------------------------------------------------------------
// 2. Governed basics — job.id admission, spend rollups, honest silence
// ---------------------------------------------------------------------------

describe('governed run basics (no journal — in-memory)', () => {
  test('a scheduler cannot dispatch the same job twice', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 5 });
    await expect(
      runPlan(
        independentPlan('plan-schedule-once', 1),
        { concurrency: 1, stopOnError: false },
        viewWith(entry('fake', countingOp(calls))),
        {
          governor,
          allowAdvisory: true,
          scheduleJob: async (_id, run) => {
            await run();
            await run();
          },
        },
      ),
    ).rejects.toThrow('scheduled job already consumed');
    expect(calls).toEqual(['j1']);
  });
  test('a 3-job plan runs to completion; no spend → no costUSD, no early stop', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 5, maxTokens: 1000 });
    const report = await runPlan(
      independentPlan('plan-gov-basics', 3),
      { concurrency: 2, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual(['j1', 'j2', 'j3']); // every op executed
    expect(report.stoppedEarly).toBe(false);
    expect('earlyStopReason' in report).toBe(false);
    expect('costUSD' in report).toBe(false); // nothing reported — no fabricated 0
    expect('usage' in report).toBe(false);
    expect(report.counts.done).toBe(3);
    // Admission happened on the REAL plan job ids, once each, attempt 1.
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => [event.jobKey, event.attempt])).toEqual([
      ['j1', 1],
      ['j2', 1],
      ['j3', 1],
    ]);
  });

  test('a governed op that streams evidence gets per-job usage/costUSD rows and a run-level rollup', async () => {
    const calls: string[] = [];
    const USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
    const governor = createGovernor({ maxUsd: 5 });
    const spendy = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      currentJobContext()?.reportResult({ usage: USAGE, costUSD: 0.25 });
      return okOp(raw);
    };
    const report = await runPlan(
      independentPlan('plan-gov-spend', 2, 'spendy'),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('spendy', spendy)),
      { governor, allowAdvisory: true },
    );
    // Per-job rollups on the report rows…
    expect(report.jobs[0]?.usage).toEqual(USAGE);
    expect(report.jobs[0]?.costUSD).toBe(0.25);
    expect(report.jobs[1]?.usage).toEqual(USAGE);
    expect(report.jobs[1]?.costUSD).toBe(0.25);
    // …and the run-level ledger rollups.
    expect(report.usage).toEqual({ input: 20, output: 10, cacheRead: 0, cacheWrite: 0 });
    expect(report.costUSD).toBe(0.5);
    expect(governor.usdSpent).toBe(0.5);
  });
});

describe('admission is keyed on the plan job id (W2.2)', () => {
  test('two jobs sharing one op each get their own attempt under maxAttemptsPerJob: 1', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxAttemptsPerJob: 1 });
    const plan: Plan = {
      id: 'plan-gov-jobkey',
      jobs: [
        { id: 'job-a', op: 'shared', input: { jobId: 'job-a' } },
        { id: 'job-b', op: 'shared', input: { jobId: 'job-b' } },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('shared', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    // The op-name fallback would have refused the second job as "attempt 2
    // of 'shared'"; keyed on job ids both are first attempts.
    expect(calls).toEqual(['job-a', 'job-b']);
    expect(rowStatuses(report)).toEqual(['ok', 'ok']);
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => [event.jobKey, event.attempt])).toEqual([
      ['job-a', 1],
      ['job-b', 1],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. Trip → honest stop with transitive attribution
// ---------------------------------------------------------------------------

describe('governed trip → honest stop (I9)', () => {
  test('queued-after-trip re-marks budget-exhausted; a genuinely-failed dep keeps its verdict', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 1.0 });
    const spendy2 = countingOp(calls, 2.0); // trips the 1.0 cap mid-run
    const plan: Plan = {
      id: 'plan-gov-trip',
      jobs: [
        { id: 'a', op: 'fail', input: { jobId: 'a' } }, // REAL failure
        { id: 'c', op: 'spendy', input: { jobId: 'c' } }, // trips during c
        { id: 'b', op: 'ok', input: { jobId: 'b' }, dependsOn: ['a'] }, // blocked for REAL
        { id: 'd', op: 'ok', input: { jobId: 'd' }, dependsOn: ['c'] }, // queued after the trip
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fail', failOp), entry('spendy', spendy2), entry('ok', okOp)),
      { governor, allowAdvisory: true },
    );
    // a failed genuinely; b is blocked by that REAL failure (not budget);
    // c kept its ok verdict (the trip is evidence, not a rewrite); d never
    // dispatched and is transitively budget-caused → budget-exhausted.
    // Row order is dispatch order: [a, c] wave 1, [b, d] wave 2.
    expect(rowStatuses(report)).toEqual(['failed', 'ok', 'failed', 'budget-exhausted']);
    expect(report.jobs[2]?.result).toMatchObject({
      status: 'failed',
      error: "blocked: dependency 'a' did not succeed",
    });
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.costUSD).toBe(2.0); // the ledger's rollup
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 1, // b — blocked by the REAL a failure, never the budget
      done: 1,
      failed: 1, // a
      'budget-exhausted': 1, // d
    });
    const trip = governor.events.find(
      (event): event is TrippedEvent => event.kind === 'budget-tripped',
    );
    expect(trip?.tripKind).toBe('exhausted');
    expect(trip?.reason).toMatch(/usd rollup 2 exceeded cap 1/);
  });
});
