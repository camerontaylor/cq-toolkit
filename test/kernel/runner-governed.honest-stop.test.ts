// Split from runner-governed.test.ts (owner-mandated file-size split).
// honest-stop attribution through the governed runner (#15-4/#15-6):
// dispatch-quota re-marks, silent trips, fabricated queued: verdicts,
// and transitive BLOCKED re-marks over memoized causality.
// Pure move: shared fixtures live in runner-governed.helpers.ts.

import { describe, expect, test } from 'vitest';
import {
  runPlan,
  entry,
  viewWith,
  independentPlan,
  countingOp,
  rowStatuses,
  type AdmittedEvent,
  type ShortCircuitEvent,
} from './runner-governed.helpers.js';
import { currentJobContext, createGovernor } from '../../src/kernel/governor.js';
import { type OpResult, type Plan } from '../../src/kernel/types.js';

// ---------------------------------------------------------------------------
// 3b. Honest-stop attribution — the cases the deleted withBudgetStop helper
//     owned, re-homed against the runner-owned honest-stop pass (W2.2 C)
// ---------------------------------------------------------------------------

describe('honest-stop attribution through the governed runner (#15-4/#15-6)', () => {
  test('a dispatch-quota stop re-marks queued rows budget-exhausted (#15-4a)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ runDispatchQuota: 2 });
    const plan: Plan = {
      id: 'plan-quota-stop',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } }, // refused: dispatch-quota
        { id: 'j4', op: 'fake', input: { jobId: 'j4' }, dependsOn: ['j2'] }, // wave 2 — never dispatched → queued
      ],
    };
    // j3's refusal is a non-ok terminal → stopOnError halts dispatching; j4
    // never dispatched (its dep j2 is done) → queued, then re-marked by the
    // honest-stop pass: a quota stop is budget-family even though `tripped`
    // stays false (an attempt-cap is per-job and must NOT trigger this).
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(governor.tripped).toBe(false); // a quota stop is NOT a USD/token trip
    const refusals = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
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

  test('a trip that gated NOTHING stays silent: zero re-marked rows → no stoppedEarly claim (#15-4b)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 0.5 });
    // j1's cost trips the cap mid-run; j2 (same wave, admitted at its pool
    // slot) is killed budget-while-queued — both rows are real terminal
    // verdicts; nothing was ever queued or blocked.
    const spendy2 = countingOp(calls, 0.6);
    const report = await runPlan(
      independentPlan('plan-trip-no-gate', 2, 'spendy'),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('spendy', spendy2)),
      { governor, allowAdvisory: true },
    );
    expect(governor.tripped).toBe(true);
    expect(rowStatuses(report)).toEqual(['ok', 'budget-exhausted']);
    // I9 honesty: no row was re-marked → no stoppedEarly claim. The report
    // still carries the ledger's derived cost rollup the governor OBSERVED.
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
    expect(report.costUSD).toBe(0.6); // only j1's evidence ever folded
    expect(report.counts['budget-exhausted']).toBe(1);
  });

  test('a fabricated queued: detail from an ADMITTED op is NOT rewritten (#15-6)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // The op RAN (the governor admitted it) and returned an indeterminate
    // verdict claiming the runner's never-dispatched marker — executed code
    // fabricating `queued: …`. The honest-stop pass re-marks only rows it
    // never dispatched (its own admission records), so the lie keeps the
    // op's real verdict.
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ costUSD: 2.0 }); // trips the 1.0 cap mid-run
      return { status: 'indeterminate', detail: 'queued: (fabricated by the op itself)' };
    };
    const report = await runPlan(
      independentPlan('plan-queued-fabricated', 1, 'lying'),
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying', lyingOp)),
      { governor, allowAdvisory: true },
    );
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => event.jobKey)).toEqual(['j1']); // the governor ADMITTED this job
    expect(governor.tripped).toBe(true);
    expect(rowStatuses(report)).toEqual(['indeterminate']);
    // The row keeps its REAL verdict — and with nothing re-marked there is
    // no stoppedEarly claim either.
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: (fabricated by the op itself)',
    });
    expect(report.stoppedEarly).toBe(false);
  });

  test('a fabricated queued: row does not condemn its DEPENDENTS either (#15-6, review round 3)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // The ADMITTED op fabricates `queued: …` AND has a dependent: the
    // budgetCaused walk reads the row too, so a lying row must not get the
    // dependent re-marked budget-exhausted.
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ costUSD: 2.0 }); // trips the 1.0 cap mid-run
      return { status: 'indeterminate', detail: 'queued: (fabricated by the op itself)' };
    };
    const plan: Plan = {
      id: 'plan-queued-fabricated-dep',
      jobs: [
        { id: 'f1', op: 'lying', input: { jobId: 'f1' } },
        { id: 'd1', op: 'fake', input: { jobId: 'd1' }, dependsOn: ['f1'] },
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying', lyingOp), entry('fake', countingOp([]))),
      { governor, allowAdvisory: true },
    );
    expect(governor.tripped).toBe(true);
    // f1 indeterminate → the runner counts it failed; d1 is blocked by it.
    expect(rowStatuses(report)).toEqual(['indeterminate', 'failed']);
    // The fabricated row keeps its verdict…
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: (fabricated by the op itself)',
    });
    // …and the dependent is NOT re-marked budget-exhausted off the lie: it
    // stays honestly blocked on an unresolved row.
    expect(report.jobs[1]?.result).toMatchObject({
      status: 'failed',
      error: /blocked: dependency 'f1'/,
    });
    expect(report.stoppedEarly).toBe(false); // nothing was re-marked
  });

  test('a diamond of BLOCKED rows over a refused dispatch re-marks transitively (memoized causality)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ runDispatchQuota: 2 });
    // j1, j2 spend the quota; j3 is REFUSED (a real budget-exhausted row);
    // j4/j5 are BLOCKED on j3; the diamond root j6 is blocked on BOTH
    // branches — the causality walk must reuse each branch's memoized
    // verdict to re-mark the root (the old visited-marker bug kept roots
    // dishonestly blocked).
    const plan: Plan = {
      id: 'plan-quota-diamond',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } }, // refused: dispatch-quota
        { id: 'j4', op: 'fake', input: { jobId: 'j4' }, dependsOn: ['j3'] }, // blocked on the refusal
        { id: 'j5', op: 'fake', input: { jobId: 'j5' }, dependsOn: ['j3'] }, // blocked on the refusal
        { id: 'j6', op: 'fake', input: { jobId: 'j6' }, dependsOn: ['j4', 'j5'] }, // the diamond root
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual(['j1', 'j2']); // the quota gated everything after j2
    expect(governor.tripped).toBe(false); // quota refusal, not a USD/token trip
    expect(rowStatuses(report)).toEqual([
      'ok',
      'ok',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
      'budget-exhausted',
    ]);
    expect(report.jobs[3]?.result).toEqual({ status: 'budget-exhausted' }); // blocked → re-marked
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

  test('a BLOCKED row over an ok dep and a refused dep re-marks budget-exhausted (successful deps do not veto causality)', async () => {
    const calls: string[] = [];
    const governor = createGovernor({ runDispatchQuota: 2 });
    // j1, j2 spend the quota; j3 is REFUSED (a real budget-exhausted row);
    // j4 depends on the OK j1 AND the refused j3 — j3 alone blocked it (a
    // succeeded dep blocks nothing), so the causality walk must ignore the
    // successful dep instead of letting it veto the re-mark.
    const plan: Plan = {
      id: 'plan-quota-mixed-deps',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } }, // refused: dispatch-quota
        { id: 'j4', op: 'fake', input: { jobId: 'j4' }, dependsOn: ['j1', 'j3'] }, // blocked by j3 only
      ],
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('fake', countingOp(calls))),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual(['j1', 'j2']); // the quota gated everything after j2
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted', 'budget-exhausted']);
    expect(report.jobs[3]?.result).toEqual({ status: 'budget-exhausted' }); // blocked → re-marked
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
});
