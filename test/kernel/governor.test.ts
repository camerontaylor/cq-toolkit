// T1.3 slice 2 — tests for the budget governor (src/kernel/governor.ts).
//
// THE ws-a acceptance checks, in goal order:
//   1. THE KILL-LADDER CHECK: a fake op that IGNORES the abort signal is
//      killed through the full escalation ladder — each rung asserted rung by
//      rung (names, order, exact delays via the injected virtual clock), the
//      final kill producing OpResult budget-exhausted, with a late
//      post-kill rejection provably swallowed (no unhandled rejection).
//   2. USD cap trips mid-run: remaining jobs get budget-exhausted rows,
//      RunReport.stoppedEarly === true + earlyStopReason === 'budget'
//      (via the documented withBudgetStop composition), done rows keep real
//      results; queued-marker rows are re-marked too (stopOnError variant).
//   3. Dual caps: the in-flight ceiling holds as a high-water mark even at
//      higher RunOptions.concurrency (and the pool binds in the min()'s other
//      direction); runDispatchQuota refuses with the refusal recorded.
//   4. Attempt caps: bounded re-dispatch end-to-end (rescue decision drives a
//      resumed run; the governor refuses the third dispatch) and the frozen
//      JobStartedJournalEvent.attempt field driving the cap after seeding.
//   5. Resume after a budget stop: a killed job with NO terminal event IS
//      re-dispatched on resume; a terminal budget-exhausted row is NOT
//      re-dispatched under a seeded, still-tripped governor (documented
//      semantics); reports stay honest.
//   6. Journal evidence: a killed run leaves job-started with attempt, a
//      budget-exhausted finish, and run-finished; statusOf folds sensibly.
//
// Determinism: EVERY timer flows through the injected virtual Clock — no
// real-time waits anywhere (a setImmediate pump yields event-loop turns for
// the runner's fs/microtask work; assertions on delays are exact). Temp
// journal dirs: mkdtemp under os.tmpdir, removed in afterEach.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { z } from 'zod';
import * as toolkit from '../../src/index.js';
import { openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import {
  BudgetGovernor,
  currentJobContext,
  governRegistry,
  governorConfig,
  runLadder,
  withBudgetStop,
} from '../../src/kernel/governor.js';
import { decideRescue, rescueInputFromJournal } from '../../src/kernel/rescue.js';
import { runPlan } from '../../src/kernel/runner.js';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type {
  GovernorEvent,
  JobGovernance,
  LadderRungMarker,
} from '../../src/kernel/governor.js';
import type {
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunReport,
} from '../../src/kernel/types.js';

/** Narrowed governor-event views for filter predicates. */
type LadderRungEvent = Extract<GovernorEvent, { kind: 'ladder-rung' }>;
type CompletedEvent = Extract<GovernorEvent, { kind: 'completed' }>;

// ---------------------------------------------------------------------------
// Virtual clock + pump — the injected-time toolkit (no real waits anywhere)
// ---------------------------------------------------------------------------

interface VirtualClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  /** Fire every timer due within the next `ms` of virtual time, in due order. */
  advance(ms: number): void;
}

function virtualClock(startMs = 1_000_000): VirtualClock {
  let nowMs = startMs;
  let seq = 0;
  const timers: Array<{ at: number; fn: () => void }> = [];
  return {
    now: () => nowMs,
    setTimeout(fn: () => void, ms: number) {
      const timer = { at: nowMs + ms, fn: fn, id: ++seq };
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
        nowMs = due.at; // timers fire at their exact due time, not at step granularity
        timers.splice(timers.indexOf(due), 1);
        due.fn();
      }
      nowMs = target;
    },
  };
}

/** One macrotask turn — lets the runner's real fs work and microtasks progress. */
const tick = (): Promise<void> => new Promise<void>((resolve) => { setImmediate(resolve); });

/**
 * Advance the virtual clock in steps until `promise` settles (runs need
 * event-loop turns between advances for journal writes). Burns `maxAdvance`
 * of virtual time max, then fails LOUDLY — a hanging run is a test failure,
 * never a suite hang.
 */
async function pumped<T>(promise: Promise<T>, clock: VirtualClock, maxAdvance = 600_000): Promise<T> {
  let settled = false;
  void promise.then(
    () => { settled = true; },
    () => { settled = true; },
  );
  let advanced = 0;
  while (!settled) {
    clock.advance(10);
    advanced += 10;
    if (advanced > maxAdvance) {
      throw new Error(`pump: run did not settle after advancing ${maxAdvance}ms of virtual time`);
    }
    await tick();
  }
  return promise;
}

/** Poll a condition across macrotask turns (deterministic, no real time). */
async function waitFor(condition: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 10_000 && !condition(); i++) {
    await tick();
  }
  expect(condition(), `waitFor: ${what}`).toBe(true);
}

// ---------------------------------------------------------------------------
// Fakes — same shape as runner.test.ts, plus hanging/gated/spending variants
// ---------------------------------------------------------------------------

// Non-strict on purpose: replay tests add keys to an input to change its hash.
const jobInputSchema = z.object({ jobId: z.string() });

function entry(
  name: string,
  op: (raw: unknown) => Promise<OpResult<unknown>>,
): OpRegistryEntry<never, never> {
  return {
    name: name,
    inputSchema: jobInputSchema as unknown as z.ZodType<never>,
    importer: () => Promise.resolve(op as unknown as Op<never, never>),
  };
}

function viewWith(...entries: OpRegistryEntry<never, never>[]): OpRegistryView {
  const map = new Map(
    entries.map((candidate): [string, OpRegistryEntry<never, never>] => [candidate.name, candidate]),
  );
  return { get: (name) => map.get(name) };
}

function independentPlan(id: string, n: number, op = 'fake'): Plan {
  return {
    id: id,
    jobs: Array.from({ length: n }, (_, i) => {
      const jobId = `j${i + 1}`;
      return { id: jobId, op: op, input: { jobId: jobId } };
    }),
  };
}

const okOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const jobId = (raw as { jobId: string }).jobId;
  return { status: 'ok', value: jobId };
};

/** A spendy op: injects usage + cost through the governed job context (the observer hook). */
const SPENDY_USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const spendyOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const ctx = currentJobContext();
  if (ctx !== undefined) {
    ctx.reportUsage(SPENDY_USAGE);
    ctx.reportCost(0.6);
  }
  return okOp(raw);
};

function rowStatuses(report: RunReport): string[] {
  return report.jobs.map((row) => row.result.status);
}

// ---------------------------------------------------------------------------
// 1. THE KILL-LADDER CHECK — runLadder as a standalone unit
// ---------------------------------------------------------------------------

describe('runLadder — THE kill-ladder check (ws-a item 1)', () => {
  test('a signal-ignoring op is killed rung by rung: names, order, exact delays, port delivery', async () => {
    const clock = virtualClock();
    const markers: LadderRungMarker[] = [];
    const hardCancels: string[] = [];
    const kills: string[] = [];
    let signalObserved = false;

    const task = async (ctx: JobGovernance): Promise<never> => {
      // IGNORES the abort signal for settling purposes (listens but never
      // returns early) — only the final rung may end this op.
      ctx.signal.addEventListener('abort', () => { signalObserved = true; });
      ctx.setCancelPort({
        hardCancel: () => { hardCancels.push('hard'); },
        kill: () => { kills.push('kill'); },
      });
      return new Promise<never>(() => {}); // never settles on its own
    };

    const outcomePromise = runLadder(
      task,
      { wallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
      { op: 'fake', jobKey: 'j1', attempt: 1 },
      { clock: clock, onRung: (marker) => { markers.push(marker); } },
    );
    await tick(); // the task starts on a microtask — let it register signal listener + port

    // Rung 1 fires at exactly wallClockMs.
    clock.advance(100);
    expect(markers.map((marker) => marker.rung)).toEqual(['signal']);
    expect(signalObserved).toBe(true); // the signal FIRED even though the op ignores it

    // Rung 2 (second, harder cancel) after abortGraceMs.
    clock.advance(10);
    expect(markers.map((marker) => marker.rung)).toEqual(['signal', 'timeout']);
    expect(hardCancels).toEqual(['hard']);

    // Rung 3 (SIGKILL-equivalent) after killGraceMs — the op dies HERE.
    clock.advance(20);
    const outcome = await outcomePromise;
    expect(outcome.outcome).toBe('killed');
    expect(markers.map((marker) => marker.rung)).toEqual(['signal', 'timeout', 'kill']);
    expect(markers.map((marker) => [marker.delayMs, marker.sinceStartMs, marker.delivered])).toEqual([
      [100, 100, true],
      [10, 110, true],
      [20, 130, true],
    ]);
    expect(markers.map((marker) => marker.atMs)).toEqual([1_000_100, 1_000_110, 1_000_130]);
    expect(kills).toEqual(['kill']); // the kill primitive was delivered
    expect(outcome.markers).toHaveLength(3);
    expect(outcome.elapsedMs).toBe(130);
  });

  test('a rejection AFTER the kill is swallowed by the detachment — no unhandled rejection', async () => {
    const clock = virtualClock();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const task = async (ctx: JobGovernance): Promise<never> => {
        ctx.signal.addEventListener('abort', () => {}); // ignored
        // Explodes LONG after the ladder has already killed and detached it.
        return new Promise<never>((_, reject) => {
          clock.setTimeout(() => reject(new Error('late explosion')), 10_000);
        });
      };
      const outcomePromise = runLadder(
        task,
        { wallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
        { op: 'fake', jobKey: 'j1', attempt: 1 },
        { clock: clock },
      );
      await tick(); // let the task start (and schedule its late explosion)
      clock.advance(130); // signal, timeout, kill
      const outcome = await outcomePromise;
      expect(outcome.outcome).toBe('killed');
      clock.advance(10_000 - 130); // the late explosion fires NOW, post-detachment
      await tick();
      await tick();
      expect(unhandled).toEqual([]); // the detachment suppressed it
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  test('a task that settles early disarms every pending rung', async () => {
    const clock = virtualClock();
    const markers: LadderRungMarker[] = [];
    const task = async (): Promise<string> => {
      await tick();
      return 'done';
    };
    const outcome = await runLadder(
      task,
      { wallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
      { op: 'fake', jobKey: 'j1', attempt: 1 },
      { clock: clock, onRung: (marker) => { markers.push(marker); } },
    );
    clock.advance(1_000); // well past the wall clock: nothing may fire
    expect(outcome).toMatchObject({ outcome: 'completed', value: 'done' });
    expect(markers).toEqual([]); // zero rungs — the task beat the ladder
    expect(outcome.markers).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 1b. THE KILL-LADDER CHECK through the governed registry + runPlan
// ---------------------------------------------------------------------------

describe('governRegistry — the ladder through runPlan (ws-a item 1)', () => {
  test('a hanging op that ignores the signal is killed at the final rung; the run completes', async () => {
    const clock = virtualClock();
    const calls: string[] = [];
    const hangOp = async (raw: unknown): Promise<OpResult<unknown>> => {
      const jobId = (raw as { jobId: string }).jobId;
      calls.push(jobId);
      const ctx = currentJobContext();
      if (ctx !== undefined) ctx.signal.addEventListener('abort', () => {}); // IGNORED, no port
      return new Promise<never>(() => {}); // hangs forever — only the ladder may end it
    };
    const governor = new BudgetGovernor(
      governorConfig(
        { concurrency: 1, stopOnError: false },
        { perJobWallClockMs: 100 },
        { abortGraceMs: 10, killGraceMs: 20 },
      ),
      clock,
    );
    const plan = independentPlan('plan-ladder', 3);
    plan.jobs[0] = { id: 'j1', op: 'hang', input: { jobId: 'j1' } };
    plan.jobs[1] = { id: 'j2', op: 'ok', input: { jobId: 'j2' } };
    plan.jobs[2] = { id: 'j3', op: 'ok', input: { jobId: 'j3' } };
    const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
      const jobId = (raw as { jobId: string }).jobId;
      calls.push(jobId);
      return okOp(raw);
    };
    const registry = viewWith(entry('hang', hangOp), entry('ok', countingOk));

    const report = await pumped(
      runPlan(plan, { concurrency: 1, stopOnError: false }, governRegistry(registry, governor)),
      clock,
    );

    // The signal-ignoring op was killed at the final rung and the honest
    // verdict is budget-exhausted; the rest of the run completed normally.
    expect(calls).toEqual(['j1', 'j2', 'j3']); // the slot freed at the kill
    expect(report.jobs[0]?.result).toEqual({ status: 'budget-exhausted' });
    expect(report.jobs[1]?.result).toEqual({ status: 'ok', value: 'j2' });
    expect(report.jobs[2]?.result).toEqual({ status: 'ok', value: 'j3' });

    // THE RUNG ASSERTION: what fired, in what order, with what delays. The op
    // registered no port, so rungs 2–3 record delivered:false — fired, with
    // nothing to deliver.
    const rungs = governor.events.filter((event): event is LadderRungEvent => event.kind === 'ladder-rung');
    expect(rungs.map((event) => [event.rung, event.delayMs, event.sinceStartMs, event.delivered])).toEqual([
      ['signal', 100, 100, true],
      ['timeout', 10, 110, false],
      ['kill', 20, 130, false],
    ]);
    const completions = governor.events.filter((event): event is CompletedEvent => event.kind === 'completed');
    expect(completions.map((event) => event.status)).toEqual(['budget-exhausted', 'ok', 'ok']);
  });
});

// ---------------------------------------------------------------------------
// 2. USD cap — honest stop (I9)
// ---------------------------------------------------------------------------

describe('USD cap trips mid-run (ws-a item 3)', () => {
  test('remaining jobs get budget-exhausted rows; the report says budget; done rows keep real results', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 2, stopOnError: false, maxUsd: 1.0 }, {}),
    );
    const plan = independentPlan('plan-usd', 5, 'spendy');
    const registry = viewWith(entry('spendy', spendyOp));

    const raw = await runPlan(plan, { concurrency: 2, stopOnError: false, maxUsd: 1.0 }, governRegistry(registry, governor));
    // Runner-side the run reached a terminal state for every job (the
    // governor short-circuited post-trip dispatches), so the raw report is
    // silent; honest-stop marking is the governor's voice:
    expect(raw.stoppedEarly).toBe(false);
    const report = withBudgetStop(raw, plan, governor);

    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget'); // the frozen reason's ONLY value
    // a and b were admitted pre-trip and keep their real results; c/d/e never ran.
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'j1' });
    expect(report.jobs[1]?.result).toEqual({ status: 'ok', value: 'j2' });
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted', 'budget-exhausted', 'budget-exhausted']);
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

  test('stopOnError + trip: the blocked-on-budget row is transitively re-marked budget-exhausted', async () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    const plan: Plan = {
      id: 'plan-usd-stop',
      jobs: [
        { id: 'a', op: 'spendy', input: { jobId: 'a' } },
        { id: 'b', op: 'spendy', input: { jobId: 'b' }, dependsOn: ['a'] }, // trips during b
        { id: 'c', op: 'ok', input: { jobId: 'c' }, dependsOn: ['b'] }, // refused post-trip -> stop fires
        { id: 'd', op: 'ok', input: { jobId: 'd' }, dependsOn: ['c'] }, // blocked on budget-exhausted c
      ],
    };
    const registry = viewWith(entry('spendy', spendyOp), entry('ok', okOp));
    const raw = await runPlan(plan, { concurrency: 1, stopOnError: true, maxUsd: 1.0 }, governRegistry(registry, governor));
    // Raw: d never started and its dependency c is budget-exhausted — the
    // runner's sweep honestly calls that blocked (its sweep predates the
    // governor and cannot attribute).
    expect(rowStatuses(raw)).toEqual(['ok', 'ok', 'budget-exhausted', 'failed']);
    expect((raw.jobs[3]?.result as { error: string }).error).toMatch(/blocked: dependency 'c'/);

    // The governor's voice: withBudgetStop re-marks the row whose ENTIRE
    // dependency obstruction is transitively budget-caused.
    const report = withBudgetStop(raw, plan, governor);
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
    await new Promise<void>((resolve) => { releases.set(jobId, resolve); });
    inFlight -= 1;
    return { status: 'ok', value: jobId };
  };

  /** Release gated ops as they enter, until all `total` have entered. */
  const drain = async (total: number): Promise<void> => {
    while (entered.length < total) {
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
      governRegistry(viewWith(entry('fake', gatedOp)), governor),
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
      governRegistry(viewWith(entry('fake', gatedOp)), governor),
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
      governRegistry(viewWith(entry('fake', countingOk)), governor),
    );
    expect(calls).toHaveLength(4); // the quota, exactly
    expect(governor.dispatchCount).toBe(4);
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'ok', 'ok', 'budget-exhausted', 'budget-exhausted']);
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
  test('bounded re-dispatch end-to-end: two attempts, the rescue decision, no third dispatch', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-attempt-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = { id: 'plan-attempt', jobs: [{ id: 'j1', op: 'flaky', input: { jobId: 'j1' } }] };
      const calls: string[] = [];
      const flaky = async (raw: unknown): Promise<OpResult<unknown>> => {
        calls.push((raw as { jobId: string }).jobId);
        return { status: 'failed', error: 'flake' };
      };
      // The policy row under test: retry, 2 attempts TOTAL.
      const row = {
        id: 'retry-2',
        on: 'failed' as const,
        action: { kind: 'retry' as const, maxAttempts: 2 },
      };

      // --- Attempt 1 ---
      const run1 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        governRegistry(viewWith(entry('flaky', flaky)), new BudgetGovernor({ maxAttemptsPerJob: 2 })),
      );
      expect(calls).toEqual(['j1']);
      const events1 = await log.read(run1.runId);
      expect(events1.filter((event) => event.type === 'job-started')).toMatchObject([{ attempt: 1 }]);
      // The rescue lane licenses exactly one more attempt...
      const decision1 = decideRescue(rescueInputFromJournal(events1, 'j1', 'flaky'), { rows: [row] });
      expect(decision1).toEqual({ kind: 'retry', attempt: 2, rowId: 'retry-2' });

      // ...whose EXECUTION is a resumed run under a governor seeded from run 1.
      const governor2 = new BudgetGovernor({ maxAttemptsPerJob: 2 });
      governor2.seedFromJournal(events1);
      expect(governor2.attemptsFor('j1')).toBe(1);
      const run2 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        governRegistry(viewWith(entry('flaky', flaky)), governor2),
      );
      expect(calls).toEqual(['j1', 'j1']); // attempt 2 happened
      expect(governor2.events.filter((event) => event.kind === 'admitted').map((event) => event.attempt)).toEqual([2]);
      const events2 = await log.read(run2.runId);
      // (The T1.2 runner writes attempt: 1 per run — true ordinals in the
      // journal are the recorded T1.4 handoff; the governor's ordinals and
      // the evidence fold below are what the cap keys on today.)

      // Over the ACCUMULATED evidence the policy is at cap → terminate...
      const decision2 = decideRescue(
        rescueInputFromJournal([...events1, ...events2], 'j1', 'flaky'),
        { rows: [row] },
        { maxAttemptsPerJob: 2 },
      );
      expect(decision2).toEqual({
        kind: 'terminate',
        reason: 'attempt-cap',
        rowId: 'retry-2',
        cap: 'row-max-attempts',
      });

      // ...and the third dispatch is refused by the governor: no op call.
      const governor3 = new BudgetGovernor({ maxAttemptsPerJob: 2 });
      governor3.seedFromJournal([...events1, ...events2]);
      expect(governor3.attemptsFor('j1')).toBe(2);
      const run3 = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
        governRegistry(viewWith(entry('flaky', flaky)), governor3),
      );
      expect(calls).toEqual(['j1', 'j1']); // UNCHANGED — no third dispatch
      expect(run3.jobs[0]?.result).toEqual({ status: 'budget-exhausted' });
      const refusals = governor3.events.filter((event) => event.kind === 'short-circuited');
      expect(refusals.map((event) => (event as { reason: string }).reason)).toEqual(['attempt-cap']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the frozen journal attempt field drives the cap after seeding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-attempt-field-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = { id: 'plan-field', jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }] };
      const manifest = makeManifest(plan);
      // A prior run whose journal carries TRUE ordinals (what the T1.4
      // runner will emit): attempts 1 and 2, definitively failed.
      await log.append('plan-field--prior--aa', { type: 'run-started', runId: 'plan-field--prior--aa', at: 't', planId: 'plan-field' });
      await log.append('plan-field--prior--aa', { type: 'job-started', runId: 'plan-field--prior--aa', at: 't', jobId: 'j1', op: 'fake', attempt: 1 });
      await log.append('plan-field--prior--aa', { type: 'job-started', runId: 'plan-field--prior--aa', at: 't', jobId: 'j1', op: 'fake', attempt: 2 });
      await log.append('plan-field--prior--aa', {
        type: 'job-finished',
        runId: 'plan-field--prior--aa',
        at: 't',
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
        governRegistry(viewWith(entry('fake', countingOk)), governor),
      );
      expect(calls).toEqual([]); // a third dispatch never runs the op
      expect(report.jobs[0]?.result).toEqual({ status: 'budget-exhausted' });
      const refusals = governor.events.filter((event) => event.kind === 'short-circuited');
      expect(refusals.map((event) => (event as { reason: string }).reason)).toEqual(['attempt-cap']);
      expect(governor.tripped).toBe(false); // an attempt cap is not a USD trip
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

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
    // Prior run: c1 done ok; c2 hard-killed mid-flight (started, NO finish).
    await log.append('plan-resume-kill--prior--aa', { type: 'run-started', runId: 'plan-resume-kill--prior--aa', at: 't', planId: 'plan-resume-kill' });
    await log.append('plan-resume-kill--prior--aa', { type: 'job-started', runId: 'plan-resume-kill--prior--aa', at: 't', jobId: 'c1', op: 'fake', attempt: 1 });
    await log.append('plan-resume-kill--prior--aa', {
      type: 'job-finished',
      runId: 'plan-resume-kill--prior--aa',
      at: 't',
      jobId: 'c1',
      opId: 'fake',
      inputsHash: manifest.jobs[0]?.inputsHash ?? '',
      result: { status: 'ok', value: 'c1' },
    });
    await log.append('plan-resume-kill--prior--aa', { type: 'job-started', runId: 'plan-resume-kill--prior--aa', at: 't', jobId: 'c2', op: 'fake', attempt: 1 });

    const calls: string[] = [];
    const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      return okOp(raw);
    };
    const governor = new BudgetGovernor({});
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      governRegistry(viewWith(entry('fake', countingOk)), governor),
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
    // Prior run: c1 done ok; c2 killed by the governor (terminal
    // budget-exhausted record, usage journaled).
    await log.append('plan-resume-budget--prior--aa', { type: 'run-started', runId: 'plan-resume-budget--prior--aa', at: 't', planId: 'plan-resume-budget' });
    await log.append('plan-resume-budget--prior--aa', { type: 'job-started', runId: 'plan-resume-budget--prior--aa', at: 't', jobId: 'c1', op: 'fake', attempt: 1 });
    await log.append('plan-resume-budget--prior--aa', {
      type: 'job-finished',
      runId: 'plan-resume-budget--prior--aa',
      at: 't',
      jobId: 'c1',
      opId: 'fake',
      inputsHash: manifest.jobs[0]?.inputsHash ?? '',
      result: { status: 'ok', value: 'c1' },
    });
    await log.append('plan-resume-budget--prior--aa', { type: 'job-started', runId: 'plan-resume-budget--prior--aa', at: 't', jobId: 'c2', op: 'fake', attempt: 1 });
    await log.append('plan-resume-budget--prior--aa', {
      type: 'job-finished',
      runId: 'plan-resume-budget--prior--aa',
      at: 't',
      jobId: 'c2',
      opId: 'fake',
      inputsHash: manifest.jobs[1]?.inputsHash ?? '',
      result: { status: 'budget-exhausted' },
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
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
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(events, { usdOf: () => 1.5 });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/seeded usd rollup/);

    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      governRegistry(viewWith(entry('fake', countingOk)), governor),
    );
    const report = withBudgetStop(raw, plan, governor);
    expect(calls).toEqual([]); // zero op invocations — nothing was re-dispatched
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'c1' }); // attested
    expect(report.jobs[1]?.result).toEqual({ status: 'budget-exhausted' }); // re-marked
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(report.counts['budget-exhausted']).toBe(1);
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
      const governor = new BudgetGovernor(
        governorConfig(
          { concurrency: 1, stopOnError: false },
          { perJobWallClockMs: 100 },
          { abortGraceMs: 10, killGraceMs: 20 },
        ),
        clock,
      );
      const hangOp = async (): Promise<OpResult<unknown>> => {
        const ctx = currentJobContext();
        if (ctx !== undefined) ctx.signal.addEventListener('abort', () => {}); // ignored
        return new Promise<never>(() => {}); // hangs forever — only the ladder may end it
      };
      const plan = independentPlan('plan-evidence', 2);
      plan.jobs[0] = { id: 'j1', op: 'hang', input: { jobId: 'j1' } };
      plan.jobs[1] = { id: 'j2', op: 'ok', input: { jobId: 'j2' } };
      const report = await pumped(
        runPlan(
          plan,
          { concurrency: 1, stopOnError: false, journalDir: dir },
          governRegistry(viewWith(entry('hang', hangOp), entry('ok', okOp)), governor),
        ),
        clock,
      );

      const events = await openRunLog(dir).read(report.runId);
      expect(events[0]).toMatchObject({ type: 'run-started', planId: 'plan-evidence' });
      const started = events.filter((event) => event.type === 'job-started');
      expect(started[0]).toMatchObject({ type: 'job-started', jobId: 'j1', op: 'hang', attempt: 1, runId: report.runId });
      const finished = events.filter((event) => event.type === 'job-finished');
      expect(finished[0]).toMatchObject({ jobId: 'j1', result: { status: 'budget-exhausted' } });
      // The runner-side run-finished stays stoppedEarly:false — the honest-
      // stop flags are the governor's voice via withBudgetStop (T1.4 folds
      // them into the runner).
      expect(events[events.length - 1]).toMatchObject({ type: 'run-finished', stoppedEarly: false });

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

// ---------------------------------------------------------------------------
// Barrel — the public surface is re-exported (re-export only, no logic)
// ---------------------------------------------------------------------------

describe('src/index.ts barrel', () => {
  test('re-exports the governor + rescue public surface', () => {
    expect(typeof toolkit.governRegistry).toBe('function');
    expect(typeof toolkit.withBudgetStop).toBe('function');
    expect(typeof toolkit.runLadder).toBe('function');
    expect(typeof toolkit.governorConfig).toBe('function');
    expect(typeof toolkit.realClock.now()).toBe('number');
    expect(toolkit.DEFAULT_ABORT_GRACE_MS).toBe(2_000);
    expect(toolkit.DEFAULT_KILL_GRACE_MS).toBe(5_000);
    expect(typeof toolkit.decideRescue).toBe('function');
    expect(typeof toolkit.attemptsFromJournal).toBe('function');
    expect(typeof toolkit.rescueInputFromJournal).toBe('function');
    expect(toolkit.CONSERVATIVE_RESCUE_POLICY).toEqual({ rows: [] });
  });
});
