// Governor tests (split from test/kernel/governor.test.ts — pure move): resume after a budget-exhausted stop (ws-a item 5), journal evidence for a killed run (ws-a item 6).

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import {
  BudgetGovernor,
  createGovernor,
  currentJobContext,
  governorConfig,
} from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import {
  entry,
  independentPlan,
  okOp,
  pumpUntil,
  pumped,
  viewWith,
  virtualClock,
} from './governor.helpers.js';
import type { OpResult, Plan } from '../../src/kernel/types.js';
import type { ShortCircuitEvent } from './governor.helpers.js';

// ---------------------------------------------------------------------------
// 5. Resume after a budget-exhausted stop
// ---------------------------------------------------------------------------

describe('resume after a budget-exhausted stop (ws-a item 5)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'cq-gov-resume-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('a killed job with NO terminal event IS re-dispatched on resume; the done row attests', async () => {
    const log = openRunLog(dir);
    const plan: Plan = {
      id: 'plan-resume-kill',
      jobs: [
        { id: 'c1', op: 'fake', input: { jobId: 'c1' } },
        { id: 'c2', op: 'fake', input: { jobId: 'c2' }, dependsOn: ['c1'] },
      ],
    };
    const manifest = makeManifest(plan);
    // Prior GOVERNED run: c1 done ok; c2 hard-killed mid-flight (started,
    // NO finish). v2 records throughout — a governed resume over v1
    // dispatches would be refused (no spend to bind).
    await log.append('plan-resume-kill--prior--aa', {
      type: 'run-started',
      runId: 'plan-resume-kill--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-resume-kill',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false },
    });
    await log.append('plan-resume-kill--prior--aa', {
      type: 'job-started',
      runId: 'plan-resume-kill--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      op: 'fake',
      attempt: 1,
    });
    await log.append('plan-resume-kill--prior--aa', {
      type: 'job-finished',
      runId: 'plan-resume-kill--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      opId: 'fake',
      inputsHash: manifest.jobs[0]?.inputsHash ?? '',
      result: { status: 'ok', value: 'c1' },
    });
    await log.append('plan-resume-kill--prior--aa', {
      type: 'job-started',
      runId: 'plan-resume-kill--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      op: 'fake',
      attempt: 1,
    });

    const calls: string[] = [];
    const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      return okOp(raw);
    };
    const governor = createGovernor({});
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOk)),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual(['c2']); // the interrupted job re-dispatched (and completed)
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2, // c1 attested from evidence + c2 freshly done
      failed: 0,
      'budget-exhausted': 0,
    });
    // c1's skip was attestation-only (no dispatch in this run's journal).
    const events = await log.read(report.runId);
    const starts = events.filter((event) => event.type === 'job-started');
    expect(starts.map((event) => (event as { jobId: string }).jobId)).toEqual(['c2']);
  });

  test('terminal budget-exhausted rows are NOT re-dispatched when the seeded budget still trips', async () => {
    const log = openRunLog(dir);
    const plan: Plan = {
      id: 'plan-resume-budget',
      jobs: [
        { id: 'c1', op: 'fake', input: { jobId: 'c1' } },
        { id: 'c2', op: 'fake', input: { jobId: 'c2' }, dependsOn: ['c1'] },
      ],
    };
    const manifest = makeManifest(plan);
    // Prior GOVERNED run: c1 done ok; c2 killed by the governor (terminal
    // budget-exhausted record, usage + ledger costUSD journaled).
    await log.append('plan-resume-budget--prior--aa', {
      type: 'run-started',
      runId: 'plan-resume-budget--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-resume-budget',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false },
    });
    await log.append('plan-resume-budget--prior--aa', {
      type: 'job-started',
      runId: 'plan-resume-budget--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      op: 'fake',
      attempt: 1,
    });
    await log.append('plan-resume-budget--prior--aa', {
      type: 'job-finished',
      runId: 'plan-resume-budget--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      opId: 'fake',
      inputsHash: manifest.jobs[0]?.inputsHash ?? '',
      result: { status: 'ok', value: 'c1' },
    });
    await log.append('plan-resume-budget--prior--aa', {
      type: 'job-started',
      runId: 'plan-resume-budget--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      op: 'fake',
      attempt: 1,
    });
    await log.append('plan-resume-budget--prior--aa', {
      type: 'job-finished',
      runId: 'plan-resume-budget--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      opId: 'fake',
      inputsHash: manifest.jobs[1]?.inputsHash ?? '',
      result: { status: 'budget-exhausted' },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      costUSD: 1.5, // the ledger spend the seed must continue
    });
    const events = await log.read('plan-resume-budget--prior--aa');

    // Resume with the SAME budget continued (seeded, and the seed alone
    // overruns the cap): the terminal budget-exhausted row re-marks without
    // an op invocation — never auto-retried (documented semantics).
    const calls: string[] = [];
    const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      return okOp(raw);
    };
    const governor = createGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(events);
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/seeded usd rollup 1\.5 exceeded cap 1/);
    expect(governor.usdSpent).toBe(1.5);

    // A fresh governor must learn the prior spend through runPlan's resume
    // path itself, rather than inheriting the direct seed above.
    const runGovernor = createGovernor({ maxUsd: 1.0 });
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOk)),
      { governor: runGovernor, allowAdvisory: true },
    );
    expect(runGovernor.tripReason).toMatch(/seeded usd rollup 1\.5 exceeded cap 1/);
    expect(runGovernor.usdSpent).toBe(1.5);
    expect(calls).toEqual([]); // zero op invocations — nothing was re-dispatched
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'c1' }); // attested
    // c2 is never even ADMITTED: the runner's tripped gate stops dispatch
    // pre-admission, leaving it queued for the honest-stop pass to re-mark
    // (the seeded budget's verdict — never auto-retried by resume).
    expect(report.jobs[1]?.result).toEqual({ status: 'budget-exhausted' });
    // The stop is real: undispatched work (c2) was gated, so the claim is
    // honest (I9).
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts['budget-exhausted']).toBe(1);
  });

  test('seeding replays the dispatch count: runDispatchQuota carries across resume (review R2)', async () => {
    const log = openRunLog(dir);
    const plan: Plan = {
      id: 'plan-resume-quota',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const manifest = makeManifest(plan);
    // Prior GOVERNED run: THREE journaled dispatches of j1 (attempts 1-3,
    // all failed).
    await log.append('plan-resume-quota--prior--aa', {
      type: 'run-started',
      runId: 'plan-resume-quota--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-resume-quota',
      journalVersion: 2,
      seq: 1,
      governance: { attended: false },
    });
    for (const attempt of [1, 2, 3]) {
      await log.append('plan-resume-quota--prior--aa', {
        type: 'job-started',
        runId: 'plan-resume-quota--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'j1',
        op: 'fake',
        attempt: attempt,
      });
      await log.append('plan-resume-quota--prior--aa', {
        type: 'job-finished',
        runId: 'plan-resume-quota--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'j1',
        opId: 'fake',
        inputsHash: manifest.jobs[0]?.inputsHash ?? '',
        result: { status: 'failed', error: 'flake' },
      });
    }
    const events = await log.read('plan-resume-quota--prior--aa');

    const calls: string[] = [];
    const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      return okOp(raw);
    };
    // Unit half: seeding a governor from the folded events replays the
    // dispatch count — the quota is already spent.
    const seeded = new BudgetGovernor({ runDispatchQuota: 3 });
    seeded.seedFromJournal(events);
    expect(seeded.dispatchCount).toBe(3);

    // End-to-end half: a FRESH governor on the resumed run is seeded by the
    // runner's own fold (the deleted seedFromRunLog helper's job, now inside
    // runPlan) — the quota still carries across resume, so j1's re-dispatch
    // is refused without an op invocation.
    const governor = createGovernor({ runDispatchQuota: 3 });
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      viewWith(entry('fake', countingOk)),
      { governor, allowAdvisory: true },
    );
    expect(calls).toEqual([]); // zero further dispatches
    expect(report.jobs[0]?.result).toEqual({ status: 'budget-exhausted' });
    const refusals = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
    expect(governor.dispatchCount).toBe(3); // refusals do not consume quota
  });
});

// ---------------------------------------------------------------------------
// 6. Journal evidence
// ---------------------------------------------------------------------------

describe('journal evidence for a killed run (ws-a item 6)', () => {
  test('job-started with attempt, budget-exhausted finish, run-finished; statusOf folds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-journal-'));
    try {
      const clock = virtualClock();
      const governor = createGovernor(
        governorConfig(
          { concurrency: 1, stopOnError: false },
          { perJobWallClockMs: 100 },
          { abortGraceMs: 10, killGraceMs: 20 },
        ),
        clock,
      );
      let markHangEntered: () => void = () => {};
      const hangEntered = new Promise<void>((resolve) => {
        markHangEntered = resolve;
      });
      const hangOp = async (): Promise<OpResult<unknown>> => {
        markHangEntered();
        const ctx = currentJobContext();
        if (ctx !== undefined) ctx.signal.addEventListener('abort', () => {}); // ignored
        return new Promise<never>(() => {}); // hangs forever — only the ladder may end it
      };
      // j2's gate: the SAME race one dispatch later. Once j1's kill frees the
      // slot, j2's ladder arms a fresh 100ms wall-clock rung on this clock
      // while its own pre-entry path (job-started append, plan-lock fence) is
      // real I/O — CI-observed: under load the rung aborted j2 before entry
      // and the `indeterminate` refusal folded back to `running` in statusOf.
      let markOkEntered: () => void = () => {};
      const okEntered = new Promise<void>((resolve) => {
        markOkEntered = resolve;
      });
      const gatedOkOp = async (raw: unknown): Promise<OpResult<unknown>> => {
        markOkEntered();
        return okOp(raw);
      };
      const plan = independentPlan('plan-evidence', 2);
      plan.jobs[0] = { id: 'j1', op: 'hang', input: { jobId: 'j1' } };
      plan.jobs[1] = { id: 'j2', op: 'ok', input: { jobId: 'j2' } };
      const running = runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('hang', hangOp), entry('ok', gatedOkOp)),
        { governor, allowAdvisory: true },
      );
      // The pre-invocation fence does real I/O: hold the virtual clock until
      // the body is entered, or a slow host burns the 100ms job budget first
      // and the job ends as a never-ran cancel instead of a kill verdict.
      // Raced against the run like `okEntered` below: if the run settles
      // before j1's body is entered, its rejection surfaces here (an early
      // resolve falls through to pumpUntil's settled-before-gate throw)
      // instead of stranding until the framework timeout.
      await Promise.race([hangEntered, running]);
      // Then advance only until j1's kill verdict is recorded (in memory, so
      // always before j2's dispatch begins) and freeze again through j2's
      // pre-entry I/O — only then may time run.
      await pumpUntil(running, clock, () =>
        governor.events.some(
          (event) =>
            event.kind === 'completed' &&
            event.jobKey === 'j1' &&
            event.status === 'budget-exhausted',
        ),
      );
      // The entry gate alone can strand here: if the run settles in this
      // window (say j2's invocation fence fails), `okEntered` never resolves.
      // Race it against the run so the runner's own rejection surfaces — or
      // an early resolve falls through to the assertions below — instead of
      // the framework timeout eating the failure and the finally cleanup.
      await Promise.race([okEntered, running]);
      const report = await pumped(running, clock);

      const events = await openRunLog(dir).read(report.runId);
      expect(events[0]).toMatchObject({ type: 'run-started', planId: 'plan-evidence' });
      const started = events.filter((event) => event.type === 'job-started');
      expect(started[0]).toMatchObject({
        type: 'job-started',
        jobId: 'j1',
        op: 'hang',
        attempt: 1,
        runId: report.runId,
      });
      const finished = events.filter((event) => event.type === 'job-finished');
      expect(finished[0]).toMatchObject({ jobId: 'j1', result: { status: 'budget-exhausted' } });
      // The run-finished claim stays honest: the kill verdict is a real
      // terminal row and nothing undispatched was gated, so no early stop
      // is claimed.
      expect(events[events.length - 1]).toMatchObject({
        type: 'run-finished',
        stoppedEarly: false,
      });

      // The shared fold derives exactly the report's states, in first-appearance order.
      expect(await openRunLog(dir).statusOf(report.runId)).toEqual([
        { jobId: 'j1', state: 'budget-exhausted' },
        { jobId: 'j2', state: 'done' },
      ]);
      expect(report.counts).toEqual({
        queued: 0,
        running: 0,
        blocked: 0,
        done: 1,
        failed: 0,
        'budget-exhausted': 1,
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
