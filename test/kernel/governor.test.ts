import { match } from '../helpers/matchers.js';
// T1.3 slice 2 — tests for the budget governor (src/kernel/governor.ts).
//
// THE ws-a acceptance checks, in goal order:
//   1. THE KILL-LADDER CHECK: a fake op that IGNORES the abort signal is
//      killed through the full escalation ladder — each rung asserted rung by
//      rung (names, order, exact delays via the injected virtual clock), the
//      final kill producing OpResult budget-exhausted, with a late
//      post-kill rejection provably swallowed (no unhandled rejection).
//   2. USD cap trips mid-run: remaining work is stopped honestly (I9) by the
//      GOVERNED RUNNER itself — refusal rows stay real terminal verdicts,
//      done rows keep real results, queued/blocked rows whose non-execution
//      is transitively budget-caused re-mark budget-exhausted, and
//      stoppedEarly is claimed ONLY when the stop actually gated undispatched
//      work (I9 honesty, both directions), dispatch-quota stops included.
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
// T1.6b adds the DD-9 describe block: the api-equivalent budget — a parallel
// token rollup cap (maxTokens, independent of maxUsd), the USD cap tripping
// through MODELED cost on subscription-shaped lanes, and the unpriced
// fail-loud rule (real usage with no costUSD under a USD cap trips, never
// fails open).
//
// Composition (W2.2 slice C): every runPlan leg goes through the GOVERNED
// RUNNER — `runPlan(plan, opts, view, { governor })`; the deleted
// governRegistry/withBudgetStop/seedFromRunLog decorator seam has no tests
// here anymore (the runner-owned honest stop/admission/ledger is pinned in
// test/kernel/runner-governed.test.ts).
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
  createGovernor,
  currentJobContext,
  governorConfig,
  runLadder,
} from '../../src/kernel/governor.js';
import { decideRescue, rescueInputFromJournal } from '../../src/kernel/rescue.js';
import { runPlan } from '../../src/kernel/runner.js';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { GovernorEvent, JobGovernance, LadderRungMarker } from '../../src/kernel/governor.js';
import type {
  JournalEvent,
  Op,
  OpRegistryEntry,
  OpResult,
  Plan,
  RunReport,
  Usage,
} from '../../src/kernel/types.js';

/** Narrowed governor-event views for filter predicates. */
type LadderRungEvent = Extract<GovernorEvent, { kind: 'ladder-rung' }>;
type CompletedEvent = Extract<GovernorEvent, { kind: 'completed' }>;
type ShortCircuitEvent = Extract<GovernorEvent, { kind: 'short-circuited' }>;

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
const tick = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

/**
 * Advance the virtual clock in steps until `promise` settles (runs need
 * event-loop turns between advances for journal writes). Burns `maxAdvance`
 * of virtual time max, then fails LOUDLY — a hanging run is a test failure,
 * never a suite hang.
 */
async function pumped<T>(
  promise: Promise<T>,
  clock: VirtualClock,
  maxAdvance = 600_000,
): Promise<T> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
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
  schema: z.ZodType<unknown> = jobInputSchema,
): OpRegistryEntry<never, never> {
  return {
    name: name,
    inputSchema: schema as unknown as z.ZodType<never>,
    importer: () => Promise.resolve(op as unknown as Op<never, never>),
  };
}

function viewWith(...entries: OpRegistryEntry<never, never>[]): OpRegistryView {
  const map = new Map(
    entries.map((candidate): [string, OpRegistryEntry<never, never>] => [
      candidate.name,
      candidate,
    ]),
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

const failOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const jobId = (raw as { jobId: string }).jobId;
  return { status: 'failed', error: `real failure ${jobId}` };
};

/** A spendy op: injects usage + cost through the governed job context (reportResult — the ONE streaming channel). */
const SPENDY_USAGE = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
const spendyOp = async (raw: unknown): Promise<OpResult<unknown>> => {
  const ctx = currentJobContext();
  if (ctx !== undefined) {
    ctx.reportResult({ usage: SPENDY_USAGE, costUSD: 0.6 });
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
      ctx.signal.addEventListener('abort', () => {
        signalObserved = true;
      });
      ctx.setCancelPort({
        hardCancel: () => {
          hardCancels.push('hard');
        },
        kill: () => {
          kills.push('kill');
        },
      });
      return new Promise<never>(() => {}); // never settles on its own
    };

    const outcomePromise = runLadder(
      task,
      { wallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
      { op: 'fake', jobKey: 'j1', attempt: 1 },
      {
        clock: clock,
        onRung: (marker) => {
          markers.push(marker);
        },
      },
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
    expect(
      markers.map((marker) => [marker.delayMs, marker.sinceStartMs, marker.delivered]),
    ).toEqual([
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
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
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

  test('an ASYNC cancel-port rejection is recorded on the marker — never unhandled (review #15-5)', async () => {
    const clock = virtualClock();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const markers: LadderRungMarker[] = [];
      const task = async (ctx: JobGovernance): Promise<never> => {
        ctx.signal.addEventListener('abort', () => {}); // ignored
        // An `async () => void` port: the sync try/catch cannot see its
        // REJECTION — only a `.then(undefined, handler)` can record it.
        ctx.setCancelPort({
          hardCancel: async () => {
            throw new Error('async boom');
          },
        });
        return new Promise<never>(() => {});
      };
      const outcomePromise = runLadder(
        task,
        { wallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
        { op: 'fake', jobKey: 'j1', attempt: 1 },
        {
          clock: clock,
          onRung: (marker) => {
            markers.push(marker);
          },
        },
      );
      await tick(); // let the task register its async port
      clock.advance(110); // rung 1 (signal) + rung 2 (the async hardCancel REJECTS)
      await tick();
      await tick(); // the rejection handler has landed on the marker
      expect(unhandled).toEqual([]); // recorded on the marker, never unhandled
      expect(markers[1]?.rung).toBe('timeout');
      expect(markers[1]?.error).toMatch(/^async: /);
      expect(markers[1]?.error).toContain('async boom');
      clock.advance(20); // rung 3 — settle the ladder
      const outcome = await outcomePromise;
      expect(outcome.outcome).toBe('killed'); // the ladder still settled normally
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
      {
        clock: clock,
        onRung: (marker) => {
          markers.push(marker);
        },
      },
    );
    clock.advance(1_000); // well past the wall clock: nothing may fire
    expect(outcome).toMatchObject({ outcome: 'completed', value: 'done' });
    expect(markers).toEqual([]); // zero rungs — the task beat the ladder
    expect(outcome.markers).toEqual([]);
  });

  test('a THROWING cancel port cannot hang the ladder: rungs fire, errors noted, ladder settles', async () => {
    const clock = virtualClock();
    const markers: LadderRungMarker[] = [];
    const task = async (ctx: JobGovernance): Promise<never> => {
      ctx.signal.addEventListener('abort', () => {}); // ignored
      ctx.setCancelPort({
        hardCancel: () => {
          throw new Error('hard boom');
        },
        kill: () => {
          throw new Error('kill boom');
        },
      });
      return new Promise<never>(() => {});
    };
    const outcomePromise = runLadder(
      task,
      { wallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
      { op: 'fake', jobKey: 'j1', attempt: 1 },
      {
        clock: clock,
        onRung: (marker) => {
          markers.push(marker);
        },
      },
    );
    await tick(); // let the task register its hostile port
    clock.advance(130); // all three rungs come due
    const outcome = await outcomePromise;
    // The ladder settled (killed) despite BOTH port throws, in order, on time.
    expect(outcome.outcome).toBe('killed');
    expect(outcome.elapsedMs).toBe(130);
    expect(
      markers.map((marker) => [marker.rung, marker.delayMs, marker.delivered, marker.error]),
    ).toEqual([
      ['signal', 100, true, undefined],
      ['timeout', 10, false, 'hard boom'],
      ['kill', 20, false, 'kill boom'],
    ]);
  });

  test('a THROWING onRung observer cannot break the ladder (review R2)', async () => {
    const clock = virtualClock();
    const observed: string[] = [];
    const task = async (ctx: JobGovernance): Promise<never> => {
      ctx.signal.addEventListener('abort', () => {}); // ignored
      return new Promise<never>(() => {});
    };
    const outcomePromise = runLadder(
      task,
      { wallClockMs: 100, abortGraceMs: 10, killGraceMs: 20 },
      { op: 'fake', jobKey: 'j1', attempt: 1 },
      {
        clock: clock,
        onRung: (marker) => {
          observed.push(marker.rung);
          if (marker.rung === 'signal') throw new Error('observer boom');
        },
      },
    );
    await tick();
    clock.advance(130); // all three rungs come due
    const outcome = await outcomePromise;
    // The observer's throw changed nothing: the ladder fired every rung in
    // order, settled killed, and the marker stream stayed authoritative.
    expect(outcome.outcome).toBe('killed');
    expect(outcome.elapsedMs).toBe(130);
    expect(observed).toEqual(['signal', 'timeout', 'kill']);
    expect(outcome.markers).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 1b. THE KILL-LADDER CHECK through the GOVERNED RUNNER (ws-a item 1)
// ---------------------------------------------------------------------------

describe('the wall-clock ladder through the governed runner (ws-a item 1)', () => {
  test('recorded rung events retain late async cancellation errors', async () => {
    const clock = virtualClock();
    let rejectHard: (reason: Error) => void = () => {};
    let rejectKill: (reason: Error) => void = () => {};
    const hard = new Promise<void>((_resolve, reject) => {
      rejectHard = reject;
    });
    const kill = new Promise<void>((_resolve, reject) => {
      rejectKill = reject;
    });
    const hangOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.setCancelPort({
        hardCancel: () => hard,
        kill: () => kill,
      });
      return new Promise<never>(() => {});
    };
    const governor = createGovernor(
      governorConfig(
        { concurrency: 1, stopOnError: false },
        { perJobWallClockMs: 100 },
        { abortGraceMs: 10, killGraceMs: 20 },
      ),
      clock,
    );
    await pumped(
      runPlan(
        independentPlan('async-errors', 1, 'hang'),
        { concurrency: 1, stopOnError: false },
        viewWith(entry('hang', hangOp)),
        { governor, allowAdvisory: true },
      ),
      clock,
    );
    rejectHard(new Error('hard failure'));
    rejectKill(new Error('kill failure'));
    await tick();
    const rungs = governor.events.filter(
      (event): event is LadderRungEvent => event.kind === 'ladder-rung',
    );
    expect(rungs.map(({ rung, delivered, error }) => [rung, delivered, error])).toEqual([
      ['signal', true, undefined],
      ['timeout', true, 'async: hard failure'],
      ['kill', true, 'async: kill failure'],
    ]);
  });

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
    const governor = createGovernor(
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
      runPlan(plan, { concurrency: 1, stopOnError: false }, registry, {
        governor,
        allowAdvisory: true,
      }),
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
    const rungs = governor.events.filter(
      (event): event is LadderRungEvent => event.kind === 'ladder-rung',
    );
    expect(
      rungs.map((event) => [event.rung, event.delayMs, event.sinceStartMs, event.delivered]),
    ).toEqual([
      ['signal', 100, 100, true],
      ['timeout', 10, 110, false],
      ['kill', 20, 130, false],
    ]);
    const completions = governor.events.filter(
      (event): event is CompletedEvent => event.kind === 'completed',
    );
    expect(completions.map((event) => event.status)).toEqual(['budget-exhausted', 'ok', 'ok']);
  });
});

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
// 2b. DD-9 (T1.6b): parallel token rollup + api-equivalent USD
// ---------------------------------------------------------------------------

describe('DD-9 (T1.6b): parallel token rollup + api-equivalent USD', () => {
  /** Real usage, no cost — the subscription-routed lane's evidence shape (costUSD absent). */
  const UNPRICED_USAGE = { input: 80, output: 40, cacheRead: 0, cacheWrite: 0 }; // 120 tokens
  const usageOnlyOp = async (raw: unknown): Promise<OpResult<unknown>> => {
    const ctx = currentJobContext();
    if (ctx !== undefined) {
      ctx.reportResult({ usage: UNPRICED_USAGE });
    }
    return okOp(raw);
  };

  test('maxTokens is an independent cap: trip reason names the token rollup; admission refuses', async () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    // Boundary first: a fold AT the cap does not trip (same exceeds semantics as USD).
    governor.observeResult('j1', { usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(governor.tripped).toBe(false);

    // The over-cap fold trips on the TOKEN rollup — no maxUsd anywhere in this config.
    governor.observeResult('j2', { usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/token rollup 200 exceeded cap 100/);

    // A post-trip admission is refused as 'budget' (I9 — the governed
    // runner's dispatch never runs the op on a rejection).
    expect(governor.admit('j3')).toEqual({ decision: 'reject', reason: 'budget' });

    // Control: a governor whose fold stays UNDER the cap never trips.
    const control = new BudgetGovernor({ maxTokens: 100 });
    control.observeResult('c1', { usage: { input: 25, output: 25, cacheRead: 0, cacheWrite: 0 } });
    expect(control.tripped).toBe(false);
  });

  test('THE d02a107 acceptance check: usage without costUSD still stops the run at maxTokens (the subscription case)', async () => {
    const governor = createGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 150 }, {}),
    );
    const plan = independentPlan('plan-dd9-tokens', 3, 'usagey');
    const registry = viewWith(entry('usagey', usageOnlyOp));

    const report = await runPlan(plan, { concurrency: 1, stopOnError: false }, registry, {
      governor,
      allowAdvisory: true,
    });

    // The run did NOT continue past the cap: j1 folded 120 tokens (under),
    // j2's fold hit 240 (over) and tripped mid-run — j2 keeps its real
    // result; j3 (same wave, admitted before the trip landed) was killed by
    // the budget-while-queued check at its slot — a REAL budget-exhausted
    // verdict row. I9 honesty: every row is real evidence, nothing was
    // re-marked, so the report carries NO stoppedEarly claim.
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
    expect(report.jobs[0]?.result).toEqual({ status: 'ok', value: 'j1' });
    expect(report.jobs[1]?.result).toEqual({ status: 'ok', value: 'j2' });
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted']);
    expect(report.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 0,
      done: 2,
      failed: 0,
      'budget-exhausted': 1,
    });
    // The evidence trail: usage rolled up, and the budget-tripped event
    // carries the TOKEN reason (the governor's event journal).
    expect(governor.usage).toEqual({ input: 160, output: 80, cacheRead: 0, cacheWrite: 0 });
    expect(governor.usdSpent).toBe(0); // no cost was ever reported
    const trip = governor.events.find((event) => event.kind === 'budget-tripped');
    expect(trip).toBeDefined();
    expect((trip as { reason: string }).reason).toMatch(/token rollup 240 exceeded cap 150/);
  });

  test('maxUsd stays PRIMARY and trips on MODELED cost — the run that previously failed open', async () => {
    const governor = new BudgetGovernor({ maxUsd: 0.5 });
    // A subscription-routed result folded through the price map carries a
    // real usage figure and a MODELED costBasis:'modeled' costUSD — the USD
    // cap must bind through that modeled number.
    governor.observeResult('j1', { usage: UNPRICED_USAGE, costUSD: 0.6 });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/usd rollup 0\.6 exceeded cap 0\.5/);
    expect(governor.usdSpent).toBeCloseTo(0.6);
    expect(governor.usage).toEqual(UNPRICED_USAGE);
  });

  test('unpriced usage under a USD cap fails LOUD; without maxUsd the same fold is not a budget event; zero usage folds nothing', async () => {
    // Under a USD cap, real usage with NO costUSD (no price known for the
    // model) trips — a silently unlimited run is the failure DD-9 prevents.
    const loud = new BudgetGovernor({ maxUsd: 1 });
    loud.observeResult('j1', { usage: UNPRICED_USAGE });
    expect(loud.tripped).toBe(true);
    expect(loud.tripReason).toMatch(/unpriced usage under a USD cap/);
    expect(loud.tripReason).toMatch(/unpriced model/);

    // The same fold WITHOUT a USD cap is not a budget event — the usage
    // still rolls up (maxTokens would bind it), but nothing trips.
    const noUsdCap = new BudgetGovernor({});
    noUsdCap.observeResult('j1', { usage: UNPRICED_USAGE });
    expect(noUsdCap.tripped).toBe(false);
    expect(noUsdCap.usage).toEqual(UNPRICED_USAGE);

    // A zero-usage result folds NOTHING under a USD cap — nothing was
    // measured (I9), so there is no unpriced evidence to fail loud about.
    const zero = new BudgetGovernor({ maxUsd: 1 });
    zero.observeResult('j1', { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    expect(zero.tripped).toBe(false);
    expect(zero.usage).toBeUndefined();
  });

  test('independence cuts both ways: each trip reason names ITS cap, not the other', async () => {
    // Cost overage with tokens safely under: the USD (modeled) cap trips.
    const overCost = new BudgetGovernor({ maxTokens: 10_000, maxUsd: 0.5 });
    overCost.observeResult('j1', {
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.9,
    });
    expect(overCost.tripped).toBe(true);
    expect(overCost.tripReason).toMatch(/usd rollup 0\.9 exceeded cap 0\.5/);
    expect(overCost.tripReason).not.toMatch(/token rollup/);

    // Token overage with USD safely under: the token cap trips.
    const overTokens = new BudgetGovernor({ maxTokens: 10, maxUsd: 50 });
    overTokens.observeResult('j1', {
      usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 0 },
      costUSD: 0.1,
    });
    expect(overTokens.tripped).toBe(true);
    expect(overTokens.tripReason).toMatch(/token rollup 105 exceeded cap 10/);
    expect(overTokens.tripReason).not.toMatch(/usd rollup/);
  });

  test('the SEED path honors maxTokens: a journaled rollup already over the cap trips before the resumed run admits anything', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-dd9-seed-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-dd9-seed',
        jobs: [{ id: 'c1', op: 'usagey', input: { jobId: 'c1' } }],
      };
      const manifest = makeManifest(plan);
      // Prior run: c1 reached a terminal budget-exhausted record, usage
      // journaled (the same shape as the seeded-USD test).
      await log.append('plan-dd9-seed--prior--aa', {
        type: 'run-started',
        runId: 'plan-dd9-seed--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dd9-seed',
      });
      await log.append('plan-dd9-seed--prior--aa', {
        type: 'job-started',
        runId: 'plan-dd9-seed--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'usagey',
        attempt: 1,
      });
      await log.append('plan-dd9-seed--prior--aa', {
        type: 'job-finished',
        runId: 'plan-dd9-seed--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        opId: 'usagey',
        inputsHash: manifest.jobs[0]?.inputsHash ?? '',
        result: { status: 'budget-exhausted' },
        usage: UNPRICED_USAGE,
      });
      const events = await log.read('plan-dd9-seed--prior--aa');

      // The journaled usage alone overruns the token cap: the SEED trips —
      // before the resumed run admits or dispatches anything, even if no
      // further usage-reporting op ever folds.
      const governor = new BudgetGovernor({ maxTokens: 100 });
      governor.seedFromJournal(events);
      expect(governor.usage).toEqual(UNPRICED_USAGE);
      expect(governor.tripped).toBe(true);
      expect(governor.tripReason).toMatch(/seeded token rollup 120 exceeded cap 100/);
      expect(governor.admit('c1')).toEqual({ decision: 'reject', reason: 'budget' });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2b-bis. RD-B review round 2 — the token-side fail-open closed: a lying
// usage measurement fails loud (live + seed paths) or folds nothing
// (WorkerResult guard), and never poisons the rollup.
// ---------------------------------------------------------------------------

describe('token-side NaN fail-open closed (review round 2)', () => {
  const GOOD = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };

  test('(a) reportUsage with a NaN/negative field throws BEFORE the rollup; the cap stays enforceable', () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    governor.observeUsage('j1', GOOD);
    expect(() =>
      governor.observeUsage('j2', { input: 10, output: Number.NaN, cacheRead: 0, cacheWrite: 0 }),
    ).toThrowError(/usage\.output must be a finite number >= 0, got NaN/);
    expect(() =>
      governor.observeUsage('j2', {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        reasoning: Infinity,
      }),
    ).toThrowError(/usage\.reasoning must be a finite number >= 0, got Infinity/);
    expect(() =>
      governor.observeUsage('j2', { input: -5, output: 1, cacheRead: 0, cacheWrite: 0 }),
    ).toThrowError(/usage\.input must be a finite number >= 0, got -5/);
    // The poisoned folds never landed.
    expect(governor.usage).toEqual(GOOD);
    // The cap still binds: a real over-cap fold trips.
    governor.observeUsage('j3', { input: 90, output: 20, cacheRead: 0, cacheWrite: 0 });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/token rollup 125 exceeded cap 100/);
  });

  test('(b) a returned WorkerResult carrying NaN usage folds NOTHING — and the runner fails the lossy job loud', async () => {
    const governor = createGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 100 }, {}),
    );
    // The defensive WorkerResult guard rejects the lying measurement BEFORE
    // the completion-time fold: nothing folds, nothing throws post-record.
    // DOWNSTREAM, the runner (RD-C, post-rebase contract) independently
    // rejects the non-serializable (NaN-bearing) result as an honest per-job
    // failure — two fail-loud layers, neither poisons the rollup.
    const lyingOp = async (): Promise<OpResult<unknown>> => ({
      status: 'ok',
      value: {
        usage: { input: Number.NaN, output: 50, cacheRead: 0, cacheWrite: 0 },
        denials: [],
        stopReason: 'complete',
      },
    });
    const plan = independentPlan('plan-lying-worker', 1, 'lying');
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying', lyingOp)),
      { governor, allowAdvisory: true },
    );
    expect(report.jobs[0]?.result.status).toBe('failed');
    expect(report.jobs[0]?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/non-serializable result/),
    });
    expect(governor.usage).toBeUndefined(); // folded NOTHING
    expect(governor.tripped).toBe(false);

    // (b2, review 9-2) A lying COST — NaN or negative — must fold NOTHING
    // through the governed dispatch either: the completion-time guard
    // rejects the WHOLE result, so no assertValidUsd throw escapes after
    // the completed event, no usage folds, and no cost is claimed. (The
    // runner's serialization layer separately fails the lossy row — the
    // point here is the fold, which stays silent and empty.)
    for (const badCost of [Number.NaN, -0.5]) {
      const costGovernor = createGovernor(
        governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 100, maxUsd: 5 }, {}),
      );
      const costlyOp = async (): Promise<OpResult<unknown>> => ({
        status: 'ok' as const,
        value: {
          usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
          denials: [] as never[],
          stopReason: 'complete' as const,
          costUSD: badCost,
        },
      });
      await runPlan(
        independentPlan('plan-cost-lying', 1, 'costly'),
        { concurrency: 1, stopOnError: false },
        viewWith(entry('costly', costlyOp)),
        { governor: costGovernor, allowAdvisory: true },
      );
      expect(costGovernor.usage).toBeUndefined(); // the WHOLE lying result folded nothing
      expect(costGovernor.usdSpent).toBe(0); // no cost claimed
      expect(costGovernor.tripped).toBe(false); // zero evidence, not a trip
    }
  });

  test('(c) a seeded journal event with negative usage throws at seed time', () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    const events: JournalEvent[] = [
      {
        type: 'run-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-seed-lying',
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      },
      {
        type: 'job-finished',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        opId: 'fake',
        inputsHash: 'h1',
        result: { status: 'budget-exhausted' },
        usage: { input: -5, output: 3, cacheRead: 0, cacheWrite: 0 },
      },
    ];
    expect(() => governor.seedFromJournal(events)).toThrowError(
      /seeded usage\.input must be a finite number >= 0, got -5/,
    );
  });

  test('(d) valid folds are untouched: the cap trips exactly as before', () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    governor.observeUsage('j1', {
      input: 60,
      output: 40,
      cacheRead: 0,
      cacheWrite: 0,
      reasoning: 0,
    });
    governor.observeUsage('j2', { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/token rollup 200 exceeded cap 100/);
  });
});

// ---------------------------------------------------------------------------
// 2c. RD-B review debt — the production observeResult wiring (#14-1/#14-2),
// now the GOVERNED RUNNER's completion-time evidence fold (W2.2 slice C)
// ---------------------------------------------------------------------------

describe('the governed dispatch folds a returned WorkerResult through observeResult (#14-1/#14-2)', () => {
  const WORKER_USAGE = { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 };
  const workerValue = (extra?: {
    costUSD?: number;
    costBasis?: 'modeled' | 'billed';
  }): unknown => ({
    usage: WORKER_USAGE,
    denials: [],
    stopReason: 'complete',
    ...extra,
  });

  test('THE production path: a returned priced WorkerResult moves the budget', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const workerOp = async (): Promise<OpResult<unknown>> => ({
      status: 'ok',
      value: workerValue({ costUSD: 0.02, costBasis: 'modeled' }),
    });
    const plan = independentPlan('plan-worker-priced', 1, 'worker');
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('worker', workerOp)),
      { governor, allowAdvisory: true },
    );
    // The op never called reportUsage/reportCost — the RETURNED value is the
    // budget evidence, folded through the governed completed branch.
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0.02);
    expect(governor.tripped).toBe(false);
    expect(report.jobs[0]?.result).toEqual({
      status: 'ok',
      value: workerValue({ costUSD: 0.02, costBasis: 'modeled' }),
    });
  });

  test('returned UNPRICED usage under maxUsd trips the budget through the production path', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const unpricedWorkerOp = async (): Promise<OpResult<unknown>> => ({
      status: 'ok',
      value: workerValue(), // real usage, no costUSD — the unpriced-model shape
    });
    const plan = independentPlan('plan-worker-unpriced', 1, 'unpriced');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('unpriced', unpricedWorkerOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0);
    expect(governor.tripped).toBe(true); // fail loud, never fail open (DD-9)
    expect(governor.tripReason).toMatch(/unpriced usage under a USD cap/);
  });

  test('once-only: usage streamed through the job context is NOT double-counted by the returned WorkerResult', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const doubleEvidenceOp = async (): Promise<OpResult<unknown>> => {
      const ctx = currentJobContext();
      if (ctx !== undefined) {
        // reportResult is the ONE streaming channel: the op streams the
        // FULL fold (usage + cost) — streaming usage alone would be the
        // unpriced fail-loud shape (DD-9).
        ctx.reportResult({ usage: WORKER_USAGE, costUSD: 0.02 });
      }
      // …AND the same evidence returned in the WorkerResult: the rollup must
      // count it ONCE, not twice.
      return { status: 'ok', value: workerValue({ costUSD: 0.02, costBasis: 'modeled' }) };
    };
    const plan = independentPlan('plan-worker-once', 1, 'double');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('double', doubleEvidenceOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE); // once — not {input: 200, output: 100, …}
    expect(governor.usdSpent).toBe(0.02); // the cost folded (once)
  });

  test("reportResult streams a value-mapping op's driver evidence through the job context (#185)", async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    // The op maps the WorkerResult into its OWN value shape (review.fixItem /
    // resolveConflict), so the completion-time WorkerResult fold cannot see
    // it — it reports usage+cost in ONE fold through the job context.
    const mappedOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ usage: WORKER_USAGE, costUSD: 0.03 });
      return {
        status: 'ok',
        value: { changed: true, summary: 'fixed', commits: ['a'.repeat(40)] },
      };
    };
    const plan = independentPlan('plan-mapped-cost', 1, 'mapped');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('mapped', mappedOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0.03);
    expect(governor.tripped).toBe(false);
  });

  test('reportResult with UNPRICED usage under maxUsd still trips LOUD — DD-9 is not bypassed (#185)', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const mappedUnpricedOp = async (): Promise<OpResult<unknown>> => {
      currentJobContext()?.reportResult({ usage: WORKER_USAGE }); // no costUSD
      return { status: 'ok', value: { changed: false, summary: 'nothing' } };
    };
    const plan = independentPlan('plan-mapped-unpriced', 1, 'mapped-unpriced');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('mapped-unpriced', mappedUnpricedOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toEqual(WORKER_USAGE);
    expect(governor.usdSpent).toBe(0);
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/unpriced usage under a USD cap/);
  });

  test('a LYING reportResult measurement folds as ZERO evidence, never throws past the op (#185 review r1)', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5 }, {}),
    );
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      // NaN/negative measurements an op streamed through the job context
      // never passed the workerResultOfValue guard; observeResult sanitizes
      // them instead of letting assertValid* throw out of the op.
      currentJobContext()?.reportResult({
        usage: { input: Number.NaN, output: -1, cacheRead: 0, cacheWrite: 0 },
        costUSD: -3,
      });
      return { status: 'ok', value: { changed: false, summary: 'nothing' } };
    };
    const plan = independentPlan('plan-lying-report', 1, 'lying-report');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      viewWith(entry('lying-report', lyingOp)),
      { governor, allowAdvisory: true },
    );
    expect(governor.usage).toBeUndefined();
    expect(governor.usdSpent).toBe(0);
    expect(governor.tripped).toBe(false);
  });

  test('measurements the journal mirror would reject fold as ZERO evidence on BOTH channels (fractional/extra-keyed usage)', async () => {
    // journalDir ON: usage that passes a loose defensive predicate but not
    // the strict UsageSchema used to surface as a post-record job-finished
    // append throw — after the op had already completed. Both spend channels
    // must validate the PERSISTED shape (integer cardinalities, strict
    // keys): the STREAMED reportResult channel and the RETURNED WorkerResult
    // an unschemable measurement is zero evidence, never a late throw.
    const dir = await mkdtemp(join(tmpdir(), 'cq-governor-usage-mirror-'));
    try {
      const governor = new BudgetGovernor(
        governorConfig({ concurrency: 1, stopOnError: false, maxUsd: 5, journalDir: dir }, {}),
      );
      const mirrorLyingOp = async (raw: unknown): Promise<OpResult<unknown>> => {
        const jobId = (raw as { jobId: string }).jobId;
        if (jobId === 'j3') {
          // Returned-WorkerResult channel: workerResultOfValue passes a
          // fractional count (finite, non-negative) — the fold must still
          // not persist it raw.
          return {
            status: 'ok',
            value: {
              stopReason: 'complete',
              usage: { input: 2.5, output: 1, cacheRead: 0, cacheWrite: 0 },
              denials: [],
            },
          };
        }
        const usage =
          jobId === 'j1'
            ? { input: 1.5, output: 2, cacheRead: 0, cacheWrite: 0 } // fractional
            : { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, vendorPromptTokens: 9 }; // extra key
        currentJobContext()?.reportResult({ usage });
        return { status: 'ok', value: jobId };
      };
      const plan: Plan = {
        id: 'plan-usage-mirror',
        jobs: [
          { id: 'j1', op: 'mirror-lying', input: { jobId: 'j1' } },
          { id: 'j2', op: 'mirror-lying', input: { jobId: 'j2' } },
          { id: 'j3', op: 'mirror-lying', input: { jobId: 'j3' } },
        ],
      };
      const report = await runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        viewWith(entry('mirror-lying', mirrorLyingOp)),
        { governor, allowAdvisory: true },
      );
      expect(governor.usage).toBeUndefined(); // every measurement dropped
      expect(governor.usdSpent).toBe(0); // no cost folds off unschemable usage
      expect(report.jobs[0]?.usage).toBeUndefined();
      expect(report.jobs[1]?.usage).toBeUndefined();
      expect(report.jobs[2]?.usage).toBeUndefined();
      // The journal stays schema-clean: no job-finished line carries usage.
      const runLog = openRunLog(dir);
      const events = await runLog.read((await runLog.runs())[0]!);
      expect(
        events.every((event) => event.type !== 'job-finished' || event.usage === undefined),
      ).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// 2d. RD-B review debt — seed-time USD pricing (#14-5), cost validation
// (#15-1), and the reasoning-once token fold (#14-6)
// ---------------------------------------------------------------------------

describe('seedFromJournal USD pricing — fail loud at seed time (#14-5/#15-1)', () => {
  const SEED_USAGE = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
  const seededEvents = (finish?: { costUSD?: number }): JournalEvent[] => [
    { type: 'run-started', runId: 'r1', at: '2026-09-16T00:00:00.000Z', planId: 'plan-seed-usd' },
    {
      type: 'job-started',
      runId: 'r1',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      op: 'fake',
      attempt: 1,
    },
    {
      type: 'job-finished',
      runId: 'r1',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      opId: 'fake',
      inputsHash: 'h1',
      result: { status: 'budget-exhausted' },
      usage: SEED_USAGE,
      ...(finish?.costUSD !== undefined ? { costUSD: finish.costUSD } : {}),
    },
  ];

  test('seeded usage + maxUsd + NO costUSD anywhere in the fold trips LOUD before the resumed run admits anything', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(seededEvents());
    expect(governor.usage).toEqual(SEED_USAGE);
    expect(governor.tripped).toBe(true); // the seed alone trips — never fail open
    expect(governor.tripReason).toMatch(/prior usage/);
    expect(governor.tripReason).toMatch(/cannot be fully priced/);
    expect(governor.tripReason).toMatch(/USD cap 1 cannot bind/);
    expect(governor.tripReason).toMatch(/DD-9/);
    expect(governor.admit('c1')).toEqual({ decision: 'reject', reason: 'budget' });
  });

  test('a folded job-finished carrying costUSD prices the seed and does NOT trip', () => {
    // v2 governed journals carry costUSD on priced finishes — the seed is
    // priced from the LEDGER, not from a caller-supplied price map.
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(seededEvents({ costUSD: 0.1 }));
    expect(governor.usdSpent).toBe(0.1);
    expect(governor.tripped).toBe(false);
    expect(governor.admit('c1')).toEqual({ decision: 'admit', attempt: 2 });
  });

  test('a MIXED fold — one priced and one unpriced closing finish — trips exhausted (no finish prices another)', () => {
    // The unpriced dispatch's usage cannot enter the USD rollup, so maxUsd
    // would silently bind only the priced subset of the prior spend — DD-9
    // refuses exactly that (review cycle 1, runner-governed seam).
    const events: JournalEvent[] = [
      { type: 'run-started', runId: 'r1', at: '2026-09-16T00:00:00.000Z', planId: 'plan-seed-usd' },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c2',
        op: 'fake',
        attempt: 1,
      },
      {
        type: 'job-finished',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        opId: 'fake',
        inputsHash: 'h1',
        result: { status: 'ok', value: null },
        usage: SEED_USAGE,
        costUSD: 0.2,
      },
      {
        type: 'job-finished',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c2',
        opId: 'fake',
        inputsHash: 'h2',
        result: { status: 'ok', value: null },
        usage: SEED_USAGE, // real usage, NO costUSD — the unpriced-model shape
      },
    ];
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(events);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.tripReason).toMatch(/cannot be fully priced/);
    expect(governor.admit('c1')).toEqual({ decision: 'reject', reason: 'budget' });
  });

  test('a seeded costUSD of NaN throws at seed time (construction-time: fail loud and early)', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    expect(() => governor.seedFromJournal(seededEvents({ costUSD: Number.NaN }))).toThrowError(
      /seeded costUSD must be a finite number >= 0, got NaN/,
    );
    expect(governor.usdSpent).toBe(0); // the rollup was never poisoned
  });

  test('a seeded negative costUSD throws likewise', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    expect(() => governor.seedFromJournal(seededEvents({ costUSD: -1 }))).toThrowError(
      /seeded costUSD must be a finite number >= 0, got -1/,
    );
  });
});

describe('seedFromJournal dedupe closes a finish only against ITS OWN run\u2019s start (review r1)', () => {
  // Run R0 completed c1 (priced, counted). Run A started c1 and died before
  // its finish. Run B re-attested c1 finish-only (the replay re-attestation,
  // restating R0's already-counted spend). A jobId-only openStarts key let
  // B's orphan finish CLOSE A's open start — charging R0's spend a second
  // time and, when the re-attestation carried usage without costUSD,
  // tripping a spurious DD-9 `exhausted` at the next seed.
  const PRICED = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
  const runStart = (runId: string, at: string): JournalEvent => ({
    type: 'run-started',
    runId,
    at,
    planId: 'plan-seed-dedupe',
  });
  const started = (runId: string, at: string, attempt: number): JournalEvent => ({
    type: 'job-started',
    runId,
    at,
    jobId: 'c1',
    op: 'fake',
    attempt,
  });
  const finished = (runId: string, at: string, costUSD?: number): JournalEvent => ({
    type: 'job-finished',
    runId,
    at,
    jobId: 'c1',
    opId: 'fake',
    inputsHash: 'h1',
    result: { status: 'ok', value: 'c1' },
    usage: PRICED,
    ...(costUSD !== undefined ? { costUSD } : {}),
  });
  // Run R0: c1 completed ok, priced and counted. Run A: a start with no
  // finish (the crash). Run B: the finish-only re-attestation (no start of
  // its own), restating R0's already-counted spend.
  const base: JournalEvent[] = [
    runStart('r0', '2026-09-16T00:00:00.000Z'),
    started('r0', '2026-09-16T00:00:00.000Z', 1),
    finished('r0', '2026-09-16T00:00:01.000Z', 0.1),
    runStart('rA', '2026-09-16T00:01:00.000Z'),
    started('rA', '2026-09-16T00:01:00.000Z', 2),
    runStart('rB', '2026-09-16T00:02:00.000Z'),
    finished('rB', '2026-09-16T00:02:01.000Z', 0.1),
  ];

  test('a cross-run close is unreachable: the re-attested spend is charged ONCE (R0\u2019s finish)', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(base);
    expect(governor.usdSpent).toBe(0.1); // R0's finish only — B's restatement skipped
    expect(governor.usage).toEqual(PRICED);
    expect(governor.tripped).toBe(false);
    // Both prior starts (R0's and A's) still seed the attempt count.
    expect(governor.attemptsFor('c1')).toBe(2);
  });

  test('an UNPRICED re-attestation does not trip a spurious seed exhausted off a dead run\u2019s open start', () => {
    // Same shape, but B's re-attestation restates usage with no costUSD (the
    // v1-era finish shape). It closes nothing, so it prices nothing — the
    // unpriced rule fires only for CLOSING finishes.
    const events: JournalEvent[] = [
      ...base.slice(0, 5), // R0's priced pair + A's unfinishable start
      runStart('rB', '2026-09-16T00:02:00.000Z'),
      finished('rB', '2026-09-16T00:02:01.000Z'), // usage, no costUSD
    ];
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(events);
    expect(governor.usdSpent).toBe(0.1);
    expect(governor.tripped).toBe(false); // no spurious exhausted
  });
});

describe('observeCost rejects invalid USD before mutating the rollup (#15-1)', () => {
  test.each([NaN, Infinity, -0.01])('usd %p throws and leaves the rollup untouched', (bad) => {
    const governor = new BudgetGovernor({ maxUsd: 1 });
    governor.observeCost('j1', 0.25); // a valid fold first
    expect(() => governor.observeCost('j1', bad)).toThrowError(
      /observed cost must be a finite number >= 0/,
    );
    expect(governor.usdSpent).toBe(0.25); // not poisoned by the bad fold
  });
});

describe('totalTokensOf counts reasoning once, via output (#14-6)', () => {
  test('reasoning is NOT added on top of output: the token-cap fold', () => {
    const usage = { input: 10, output: 20, cacheRead: 5, cacheWrite: 0, reasoning: 8 };
    // Boundary: the fold is 35 (10+20+5+0) — NOT 43 (reasoning double-counted).
    const atCap = new BudgetGovernor({ maxTokens: 35 });
    atCap.observeUsage('j1', usage);
    expect(atCap.tripped).toBe(false); // 35 ≤ 35 — the same exceeds semantics
    const overCap = new BudgetGovernor({ maxTokens: 34 });
    overCap.observeUsage('j1', usage);
    expect(overCap.tripped).toBe(true);
    expect(overCap.tripReason).toMatch(/token rollup 35 exceeded cap 34/);
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
  test('bounded re-dispatch end-to-end: two attempts, the rescue decision, no third dispatch', async () => {
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
        viewWith(entry('flaky', flaky)),
        { governor: createGovernor({ maxAttemptsPerJob: 2 }), allowAdvisory: true },
      );
      expect(calls).toEqual(['j1']);
      const events1 = await log.read(run1.runId);
      expect(events1.filter((event) => event.type === 'job-started')).toMatchObject([
        { attempt: 1 },
      ]);
      // The rescue lane licenses exactly one more attempt...
      const decision1 = decideRescue(rescueInputFromJournal(events1, 'j1', 'flaky'), {
        rows: [row],
      });
      expect(decision1).toEqual({ kind: 'retry', attempt: 2, rowId: 'retry-2' });

      // ...whose EXECUTION is a resumed run under a governor seeded from run 1.
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

// ---------------------------------------------------------------------------
// Review round 1 — the seed keys attempts on the journal jobId (F4, W2.2):
// admission on the governed runner path is keyed on the real plan job id,
// so the seed must never fall back to the op name either.
// ---------------------------------------------------------------------------

describe('seedFromJournal keys attempts on the journal jobId — never the op name (W2.2)', () => {
  test('seedFromJournal keys attempts on the journal jobId — never the op name (W2.2)', () => {
    // Two journal jobs sharing op 'solo', one start each: each jobId seeds
    // its OWN prior-start count and the op NAME seeds nothing — admission on
    // the governed runner path is keyed on the real plan job id, so the old
    // op-name sum-seed (whose fallback key was the op name) is gone.
    const events: JournalEvent[] = [
      {
        type: 'run-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-seed-jobid',
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'x1',
        op: 'solo',
        attempt: 1,
      },
      {
        type: 'job-started',
        runId: 'r1',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'x2',
        op: 'solo',
        attempt: 1,
      },
    ];
    // Cap 2: one seeded start each — the next dispatch is attempt 2.
    const governor = new BudgetGovernor({ maxAttemptsPerJob: 2 });
    governor.seedFromJournal(events);
    expect(governor.attemptsFor('x1')).toBe(1); // one prior start each — seeded per jobId
    expect(governor.attemptsFor('x2')).toBe(1);
    expect(governor.attemptsFor('solo')).toBe(0); // the op name is not a seed key
    expect(governor.dispatchCount).toBe(2); // the dispatch quota seeds from all starts
    // Both jobs were genuinely dispatched once: each admits one more attempt.
    expect(governor.admit('x1')).toEqual({ decision: 'admit', attempt: 2 });
    expect(governor.admit('x2')).toEqual({ decision: 'admit', attempt: 2 });
  });
});

describe('seedFromJournal usage dedupe across multi-run journals (review F4)', () => {
  const USAGE = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
  const finishedWithUsage = (runId: string, jobId: string, inputsHash: string): JournalEvent => ({
    type: 'job-finished',
    runId: runId,
    at: '2026-09-16T00:00:00.000Z',
    jobId: jobId,
    opId: 'fake',
    inputsHash: inputsHash,
    result: { status: 'budget-exhausted' },
    usage: USAGE,
    costUSD: 0.4, // the v2 ledger rollup the governed runner writes
  });

  test('a re-attested (orphan) finish does NOT double-count usage or USD', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-seed-dedupe-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-dedupe',
        jobs: [{ id: 'c1', op: 'fake', input: { jobId: 'c1' } }],
      };
      const manifest = makeManifest(plan);
      const inputsHash = manifest.jobs[0]?.inputsHash ?? '';
      // Run 1: dispatched + finished with usage. Run 2 (chained resume): the
      // SAME dispatch's outcome re-attested — a finish with NO start.
      await log.append('plan-dedupe--r1--aa', {
        type: 'run-started',
        runId: 'plan-dedupe--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe',
      });
      await log.append('plan-dedupe--r1--aa', {
        type: 'job-started',
        runId: 'plan-dedupe--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(
        'plan-dedupe--r1--aa',
        finishedWithUsage('plan-dedupe--r1--aa', 'c1', inputsHash),
      );
      await log.append('plan-dedupe--r2--bb', {
        type: 'run-started',
        runId: 'plan-dedupe--r2--bb',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe',
      });
      await log.append(
        'plan-dedupe--r2--bb',
        finishedWithUsage('plan-dedupe--r2--bb', 'c1', inputsHash),
      );
      const events: JournalEvent[] = [
        ...(await log.read('plan-dedupe--r1--aa')),
        ...(await log.read('plan-dedupe--r2--bb')),
      ];

      const governor = new BudgetGovernor({ maxUsd: 1.0 });
      governor.seedFromJournal(events);
      expect(governor.usage).toEqual(USAGE); // once — not doubled by the re-attestation
      expect(governor.usdSpent).toBe(0.4); // the orphan's costUSD skipped with its usage
      expect(governor.tripped).toBe(false); // 0.4 ≤ 1.0: no phantom trip
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('two REAL dispatches (each start+finish) still count twice', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-seed-dedupe2-'));
    try {
      const log = openRunLog(dir);
      const plan: Plan = {
        id: 'plan-dedupe2',
        jobs: [{ id: 'c1', op: 'fake', input: { jobId: 'c1' } }],
      };
      const manifest = makeManifest(plan);
      const inputsHash = manifest.jobs[0]?.inputsHash ?? '';
      // Two runs, each a genuine dispatch of c1 (start + finish).
      await log.append('plan-dedupe2--r1--aa', {
        type: 'run-started',
        runId: 'plan-dedupe2--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe2',
      });
      await log.append('plan-dedupe2--r1--aa', {
        type: 'job-started',
        runId: 'plan-dedupe2--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 1,
      });
      await log.append(
        'plan-dedupe2--r1--aa',
        finishedWithUsage('plan-dedupe2--r1--aa', 'c1', inputsHash),
      );
      await log.append('plan-dedupe2--r2--bb', {
        type: 'run-started',
        runId: 'plan-dedupe2--r2--bb',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-dedupe2',
      });
      await log.append('plan-dedupe2--r2--bb', {
        type: 'job-started',
        runId: 'plan-dedupe2--r2--bb',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'c1',
        op: 'fake',
        attempt: 2,
      });
      await log.append(
        'plan-dedupe2--r2--bb',
        finishedWithUsage('plan-dedupe2--r2--bb', 'c1', inputsHash),
      );
      const events: JournalEvent[] = [
        ...(await log.read('plan-dedupe2--r1--aa')),
        ...(await log.read('plan-dedupe2--r2--bb')),
      ];

      const governor = new BudgetGovernor({ maxUsd: 1.0 });
      governor.seedFromJournal(events);
      expect(governor.usage).toEqual({ input: 14, output: 6, cacheRead: 2, cacheWrite: 4 }); // both dispatches counted
      expect(governor.usdSpent).toBe(0.8); // both ledger costUSD rolls counted
      expect(governor.tripped).toBe(false);
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
          viewWith(entry('hang', hangOp), entry('ok', okOp)),
          { governor, allowAdvisory: true },
        ),
        clock,
      );

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

// ---------------------------------------------------------------------------
// Barrel — the public surface is re-exported (re-export only, no logic)
// ---------------------------------------------------------------------------

describe('src/index.ts barrel', () => {
  test('re-exports the governor + rescue public surface', () => {
    expect(typeof toolkit.createGovernor).toBe('function');
    expect(typeof toolkit.runLadder).toBe('function');
    expect(typeof toolkit.governorConfig).toBe('function');
    expect(typeof toolkit.currentJobContext).toBe('function');
    expect(typeof toolkit.realClock.now()).toBe('number');
    // DD-1 spike result (docs/dd-1-abort-spike.md): 5000, ≈2.5× the measured
    // worst cooperative abort settle (~2.0 s, claude-agent lane); the value
    // is pinned to the doc by test/kernel/governor-config.test.ts.
    expect(toolkit.DEFAULT_ABORT_GRACE_MS).toBe(5_000);
    expect(toolkit.DEFAULT_KILL_GRACE_MS).toBe(5_000);
    expect(typeof toolkit.decideRescue).toBe('function');
    expect(typeof toolkit.attemptsFromJournal).toBe('function');
    expect(typeof toolkit.rescueInputFromJournal).toBe('function');
    expect(toolkit.CONSERVATIVE_RESCUE_POLICY).toEqual({ rows: [] });
    // The W2.3 journal-event schemas ride the barrel next to every
    // preexisting journal event schema — consumers name and validate the
    // new variants through the supported API, never unpublished internals
    // (Codex P2, the fix round).
    expect(toolkit.ReservationOpenedJournalEventSchema).toBeDefined();
    expect(toolkit.ReservationSettledJournalEventSchema).toBeDefined();
    expect(toolkit.ReservationRefusedJournalEventSchema).toBeDefined();
    expect(toolkit.JobQuarantinedJournalEventSchema).toBeDefined();
    expect(toolkit.QuarantineReleasedJournalEventSchema).toBeDefined();
    expect(toolkit.BudgetTrippedJournalEventSchema).toBeDefined();
  });

  test('public consumers can CONSTRUCT a governor from the barrel (review VB1B)', () => {
    // A type-only BudgetGovernor export would leave createGovernor /
    // governorConfig exported but unusable.
    expect(typeof toolkit.BudgetGovernor).toBe('function');
    expect(typeof toolkit.governorConfig).toBe('function');
    const governor = new toolkit.BudgetGovernor({}); // minimal valid config
    expect(governor.admit('k')).toEqual({ decision: 'admit', attempt: 1 });
    expect(governor.dispatchCount).toBe(1);
    expect(governor.tripped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// W2.3 — reserve-then-settle (ADR-0003 §2.2/§2.3): the capacity gate, the
// settle-side ledger, breach, cap inheritance, and the reservation-aware
// seed (A12b's unresolved-reservation charge + quarantine).
// ---------------------------------------------------------------------------

describe('W2.3 reserve-then-settle', () => {
  test('reserve WAITS FIFO while outstanding exist and shrinks only when nothing is (ADR §2.2 step 3, r1 H1)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    expect(first.outcome).toBe('reserved');
    if (first.outcome !== 'reserved') return;
    expect(first.reservation.usd).toBe(0.25);
    expect(first.reservation.proposedUsd).toBeUndefined();
    expect(governor.outstandingUsd).toBe(0.25);
    // Outstanding 0.25 → capacity 0.75; a 1.0 proposal with O > 0 must WAIT
    // FIFO (ADR §2.2 step 3), not shrink: a bookkeeping shrink to 0.75
    // would undersize `r` against the proposal, and the dispatch's real
    // charge would then breach `charged > r` — aborting healthy in-flight
    // work for a bookkeeping artifact.
    let second: Awaited<ReturnType<BudgetGovernor['reserve']>> | undefined;
    const pending = governor.reserve('j2', 1, 1.0, 'advisory').then((r) => {
      second = r;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(second).toBeUndefined();
    expect(governor.tripped).toBe(false);
    // Settling j1 at its full observed charge leaves O = 0: NOW the gate
    // shrinks (no settle can free capacity anymore) and grants the head at
    // `C − S = 0.75`, journalling the ask as proposedUsd. The invariant
    // S + O + r = 0.25 + 0.75 ≤ 1.0 holds, and a real charge of up to 0.75
    // can never breach.
    governor.observeCost('j1', 0.25);
    governor.settle(first.reservation, { basis: 'observed' });
    await pending;
    expect(second?.outcome).toBe('reserved');
    if (second?.outcome !== 'reserved') return;
    expect(second.reservation.usd).toBe(0.75);
    expect(second.reservation.proposedUsd).toBe(1.0);
    expect(governor.usdSpent).toBe(0.25);
    expect(governor.outstandingUsd).toBe(0.75);
  });

  test('a proposal within capacity grants in full; zero capacity with outstanding parks FIFO', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (first.outcome !== 'reserved') return;
    // Capacity 0.75 covers the proposal: full grant, no shrink, no park.
    const second = await governor.reserve('j2', 1, 0.75, 'advisory');
    expect(second.outcome).toBe('reserved');
    if (second.outcome !== 'reserved') return;
    expect(second.reservation.usd).toBe(0.75);
    expect(second.reservation.proposedUsd).toBeUndefined();
    expect(governor.outstandingUsd).toBe(1.0);
    // Capacity zero with an outstanding holder → the next reserve parks
    // FIFO; it does NOT trip and does not grant while capacity is zero.
    let third: Awaited<ReturnType<BudgetGovernor['reserve']>> | undefined;
    const pending = governor.reserve('j3', 1, 0.25, 'advisory').then((r) => {
      third = r;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(third).toBeUndefined();
    expect(governor.tripped).toBe(false);
    // Folding 0.3 of observed evidence against the second reservation, then
    // settling it, frees capacity → the FIFO head is woken and reserves what
    // is left (its 0.25 proposal fits under the freed 0.3). The fold moves
    // the ledger; the settle's remainder is 0.
    governor.observeCost('j2', 0.3);
    governor.settle(second.reservation, { basis: 'observed' });
    await pending;
    expect(third?.outcome).toBe('reserved');
    expect(governor.usdSpent).toBe(0.3);
    expect(governor.outstandingUsd).toBe(0.5);
    // Settling the first reservation with its own observed evidence.
    governor.observeCost('j1', 0.1);
    governor.settle(first.reservation, { basis: 'observed' });
    expect(governor.usdSpent).toBeCloseTo(0.4);
    expect(governor.outstandingUsd).toBeCloseTo(0.25);
  });

  test('a second grant for a job that already holds an open reservation throws (r1 L2)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (first.outcome !== 'reserved') return;
    // Unreachable from the runner (one dispatch per job per run; settle or
    // abandon deletes the openByJob entry before the job can be admitted
    // again) — if it ever fires, the state machine is corrupt and the throw
    // keeps the first reservation's fold attribution from being orphaned.
    await expect(governor.reserve('j1', 2, 0.1, 'advisory')).rejects.toThrow(
      /already holds an open reservation/,
    );
    // The first reservation is untouched by the refused overwrite.
    expect(governor.outstandingUsd).toBe(0.25);
  });

  test('settle carries the PRICE-PRESENCE fact: an observed costUSD — zero included — prices the dispatch (r1 H2)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (first.outcome !== 'reserved') return;
    // No cost evidence ever observed on the channel: priced false — the
    // journal will fold this settle as unpriced if it settles zero with
    // usage.
    let settled = governor.settle(first.reservation, { basis: 'observed' });
    expect(settled.priced).toBe(false);
    expect(settled.charged).toBe(0);
    // A legitimate ZERO price is still price evidence: the folded 0 rides
    // observeCost, the settle journals `priced: true`, and the resume fold's
    // DD-9 check (`charged === 0 && usage > 0 && !priced`) leaves it alone.
    const second = await governor.reserve('j2', 1, 0.25, 'advisory');
    if (second.outcome !== 'reserved') return;
    governor.observeCost('j2', 0);
    settled = governor.settle(second.reservation, { basis: 'observed' });
    expect(settled.charged).toBe(0);
    expect(settled.priced).toBe(true);
    // The governor's own observation stream carries the same fact.
    const events = governor.events.filter((event) => event.kind === 'reservation-settled');
    expect(
      events.map((event) => (event.kind === 'reservation-settled' ? event.priced : null)),
    ).toEqual([false, true]);
  });

  test('a full-charge settle frees nothing and the FIFO head then trips exhausted — no waiter hangs', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const spent = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (spent.outcome !== 'reserved') throw new Error('expected reservation');
    governor.observeCost('j1', 0.5);
    governor.settle(spent.reservation, { basis: 'observed' });
    expect(governor.usdSpent).toBe(0.5);
    // 0.5 left: take it as an outstanding reservation.
    const held = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (held.outcome !== 'reserved') throw new Error('expected reservation');
    // Capacity 0 with an outstanding holder → a third dispatch parks.
    const parked = governor.reserve('j3', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // Releasing the outstanding at FULL charge frees nothing (r − charged =
    // 0): the parked head must still be woken, re-evaluate, and — capacity
    // gone with nothing left outstanding — trip exhausted instead of
    // hanging forever.
    const settled = governor.settle(held.reservation, { basis: 'full' });
    expect(settled.charged).toBe(0.5);
    await expect(parked).resolves.toEqual({ outcome: 'tripped' });
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
  });

  test('FIFO holds: the head is granted first, a later waiter waits for a settle, and a newcomer never jumps the queue', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    // Two outstanding reservations consume the cap; two dispatches park.
    const first = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    const second = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    const w1 = governor.reserve('w1', 1, 0.25, 'advisory');
    const w2 = governor.reserve('w2', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));

    // Settle j1 at FULL charge: frees nothing, so the head (w1) is never
    // even woken — grant-from-head means a waiter is woken only WITH its
    // grant or with a trip (the cycle-1 "wake and re-park" design is
    // gone).
    governor.settle(first.reservation, { basis: 'full' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(governor.tripped).toBe(false);

    // Settle j2 UNDER its r: capacity frees. The head w1 is granted first
    // (0.25 fits the freed 0.3). w2 now faces capacity 0.05 with a 0.25
    // proposal and an outstanding holder — it WAITS FIFO for a settle (ADR
    // §2.2 step 3); it never shrinks below its proposal while O > 0.
    governor.observeCost('j2', 0.2);
    governor.settle(second.reservation, { basis: 'observed' });
    const w1r = await w1;
    if (w1r.outcome !== 'reserved') throw new Error('expected w1 reservation');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(governor.events.filter((event) => event.kind === 'reserved').length).toBe(3); // w2 still parked
    // Settling w1 under its own r frees the rest of the cap → w2 is
    // granted, still in FIFO order.
    governor.observeCost('w1', 0.05);
    governor.settle(w1r.reservation, { basis: 'observed' });
    const w2r = await w2;
    if (w2r.outcome !== 'reserved') throw new Error('expected w2 reservation');
    const order = governor.events
      .filter((event) => event.kind === 'reserved')
      .map((event) => (event.kind === 'reserved' ? event.jobKey : ''));
    expect(order).toEqual(['j1', 'j2', 'w1', 'w2']);
  });

  test('a newcomer parks behind parked waiters and waits for a settle when capacity cannot cover its proposal (no queue jumping)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    const second = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    const w1 = governor.reserve('w1', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));

    // j2 settles UNDER r: capacity frees and w1 (the head) is granted —
    // its continuation is now queued as a microtask. A NEWCOMER arriving
    // in this window must never take the room ahead of w1 (it cannot:
    // drainWaiters granted the head synchronously) and — its 0.1 proposal
    // exceeding the 0.05 left with O > 0 — must WAIT FIFO for a settle
    // rather than shrink (ADR §2.2 step 3).
    governor.observeCost('j2', 0.2);
    governor.settle(second.reservation, { basis: 'observed' });
    const w1r = await w1;
    if (w1r.outcome !== 'reserved') throw new Error('expected w1 reservation');
    const newcomer = governor.reserve('newcomer', 1, 0.1, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(governor.events.filter((event) => event.kind === 'reserved').length).toBe(3); // the newcomer is still parked — no shrink-while-outstanding
    // Settling w1 under its r frees room; the newcomer is admitted IN
    // ORDER, behind the head that was granted first.
    governor.observeCost('w1', 0.05);
    governor.settle(w1r.reservation, { basis: 'observed' });
    await newcomer;
    const order = governor.events
      .filter((event) => event.kind === 'reserved')
      .map((event) => (event.kind === 'reserved' ? event.jobKey : ''));
    expect(order).toEqual(['j1', 'j2', 'w1', 'newcomer']);
  });

  test('abandonReservation releases the hold with no charge and no settle — capacity returns to waiters', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const first = await governor.reserve('j1', 1, 0.5, 'advisory');
    if (first.outcome !== 'reserved') throw new Error('expected reservation');
    const second = await governor.reserve('j2', 1, 0.5, 'advisory');
    if (second.outcome !== 'reserved') throw new Error('expected reservation');
    const parked = governor.reserve('w1', 1, 0.25, 'advisory');
    await new Promise<void>((resolve) => setImmediate(resolve));
    // The write-ahead journal write failed: abandon the grant, no charge.
    // The returned capacity is granted to the FIFO head SYNCHRONOUSLY
    // inside the abandon (grant-from-head — no microtask window).
    governor.abandonReservation(second.reservation);
    expect(governor.usdSpent).toBe(0);
    expect(governor.outstandingUsd).toBe(0.75); // j1 0.5 + w1's fresh 0.25 grant
    // The parked waiter got the returned capacity.
    await parked;
    const last = governor.events.at(-1);
    expect(last).toMatchObject({ kind: 'reserved', jobKey: 'w1', usd: 0.25 });
    // Abandoning an unknown/settled reservation is a no-op.
    expect(() => governor.abandonReservation(second.reservation)).not.toThrow();
  });

  test('a zero cap admits nothing: the first reserve trips exhausted before any dispatch', async () => {
    const governor = createGovernor({ maxUsd: 0 });
    await expect(governor.reserve('j1', 1, 0, 'advisory')).resolves.toEqual({ outcome: 'tripped' });
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
  });

  test('charged over the reservation trips breach; the charge still lands in the ledger', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const open = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (open.outcome !== 'reserved') throw new Error('expected reservation');
    governor.observeCost('j1', 0.6);
    const settledRes = governor.settle(open.reservation, { basis: 'observed' });
    expect(settledRes.charged).toBe(0.6);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('breach');
    expect(governor.usdSpent).toBeCloseTo(0.6);
    expect(governor.events.at(-2)).toMatchObject({
      kind: 'reservation-settled',
      charged: 0.6,
      basis: 'observed',
    });
  });

  test('settle for an unknown reservation throws; a full-basis settle charges max(r, folded)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    const fake = {
      id: 'j1:1:99',
      jobKey: 'j1',
      attempt: 1,
      usd: 0.5,
      class: 'advisory' as const,
    };
    expect(() => governor.settle(fake, { basis: 'observed' })).toThrow(/unknown reservation/);
    const open = await governor.reserve('j1', 1, 0.25, 'advisory');
    if (open.outcome !== 'reserved') throw new Error('expected reservation');
    // The dispatch overshot its reservation before being killed: the full
    // basis charges the overshoot, not just r.
    governor.observeCost('j1', 0.4);
    const settled = governor.settle(open.reservation, { basis: 'full' });
    expect(settled.charged).toBe(0.4);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('breach');
    // Unknown status with NO evidence charges the full reservation r.
    const governor2 = createGovernor({ maxUsd: 1.0 });
    const open2 = await governor2.reserve('j9', 1, 0.5, 'advisory');
    if (open2.outcome !== 'reserved') throw new Error('expected reservation');
    const settled2 = governor2.settle(open2.reservation, { basis: 'full' });
    expect(settled2.charged).toBe(0.5);
    expect(governor2.usdSpent).toBe(0.5);
    expect(governor2.tripped).toBe(false);
  });

  test('reserve requires a cap — an uncapped run is reservation-less', async () => {
    const governor = createGovernor({});
    await expect(governor.reserve('j1', 1, 0.5, 'advisory')).rejects.toThrow(/requires a USD cap/);
  });

  test('a tripped governor refuses reserve immediately (no new reservations on a trip)', async () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    governor.trip('token-cap', 'test trip');
    await expect(governor.reserve('j1', 1, 0.5, 'advisory')).resolves.toEqual({
      outcome: 'tripped',
    });
  });

  test('inheritCapUsd gives a capless governor the predecessor cap and never overrides an explicit one', () => {
    const capless = createGovernor({});
    expect(capless.capUsd).toBeUndefined();
    expect(capless.inheritCapUsd(5)).toBe(true);
    expect(capless.capUsd).toBe(5);
    expect(capless.events.some((event) => event.kind === 'cap-inherited')).toBe(true);
    // The inherited cap binds reserve.
    expect(capless.outstandingUsd).toBe(0);
    // An explicit config cap is never overridden.
    const capped = createGovernor({ maxUsd: 2 });
    expect(capped.inheritCapUsd(5)).toBe(false);
    expect(capped.capUsd).toBe(2);
    // A re-inheritance of the same cap is idempotent.
    expect(capless.inheritCapUsd(5)).toBe(true);
  });

  test('the inherited cap binds the seeded-overrun trip: a capless resume over spend past C_prev trips', () => {
    const dir35 = null; // no journal needed — the seed API takes events
    void dir35;
    const governor = createGovernor({});
    governor.inheritCapUsd(1.0);
    governor.seedFromJournal([
      {
        type: 'run-started',
        runId: 'p--k--a',
        at: '2026-01-01T00:00:00.000Z',
        planId: 'p',
        journalVersion: 2,
        seq: 1,
        governance: { capUsd: 1.0, attended: false },
      },
      {
        type: 'job-started',
        runId: 'p--k--a',
        at: '2026-01-01T00:00:01.000Z',
        jobId: 'j1',
        op: 'op',
        attempt: 1,
      },
      {
        type: 'job-finished',
        runId: 'p--k--a',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 1.5,
      },
    ]);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.usdSpent).toBe(1.5);
  });
});

describe('W2.3 seed fold — reservation-era spend, A12b quarantine', () => {
  const STARTED = (runId: string, seq: number, capUsd?: number): JournalEvent => ({
    type: 'run-started',
    runId,
    at: '2026-01-01T00:00:00.000Z',
    planId: 'p',
    journalVersion: 2,
    seq,
    governance: { ...(capUsd !== undefined ? { capUsd } : {}), attended: false },
  });
  const JOB_STARTED = (runId: string, jobId: string, attempt: number): JournalEvent => ({
    type: 'job-started',
    runId,
    at: '2026-01-01T00:00:01.000Z',
    jobId,
    op: 'op',
    attempt,
  });
  const OPENED = (
    runId: string,
    jobId: string,
    attempt: number,
    reservationId: string,
    usd: number,
  ): JournalEvent => ({
    type: 'reservation-opened',
    runId,
    at: '2026-01-01T00:00:01.500Z',
    jobId,
    op: 'op',
    attempt,
    reservationId,
    usd,
    class: 'advisory',
  });
  const SETTLED = (
    runId: string,
    jobId: string,
    reservationId: string,
    charged: number,
    opts?: { priced?: boolean; usage?: Usage },
  ): JournalEvent => ({
    type: 'reservation-settled',
    runId,
    at: '2026-01-01T00:00:02.000Z',
    jobId,
    reservationId,
    charged,
    basis: 'observed',
    ...(opts?.priced !== undefined ? { priced: opts.priced } : {}),
    ...(opts?.usage !== undefined ? { usage: opts.usage } : {}),
  });

  test('reservation-era spend folds from settles (charges), not finish costUSD — no double-count', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
      SETTLED('p--a--1', 'j1', 'p--a--1:j1:1:1', 0.3),
      {
        type: 'job-finished',
        runId: 'p--a--1',
        at: '2026-01-01T00:00:03.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 0.3,
        charged: 0.3,
      },
    ]);
    // 0.3 once — the finish's restated costUSD is ignored for spend.
    expect(governor.usdSpent).toBe(0.3);
    expect(governor.quarantinedJobs.size).toBe(0);
    expect(governor.tripped).toBe(false);
  });

  test('a zero-priced lane (costUSD 0 OBSERVED) never trips the seed DD-9 — a settle without observed price does (r1 H2)', () => {
    const USAGE: Usage = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
    // The zero-priced/subscription lane: the dispatch observed a real
    // `costUSD: 0` (priced: true rides the settle), so `charged: 0` is a
    // LEGITIMATE zero price — the resumed run must dispatch, not hard-stop.
    const pricedFree = createGovernor({ maxUsd: 10 });
    pricedFree.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
      SETTLED('p--a--1', 'j1', 'p--a--1:j1:1:1', 0, { priced: true, usage: USAGE }),
    ]);
    expect(pricedFree.usdSpent).toBe(0);
    expect(pricedFree.tripped).toBe(false); // W2.2's rule would not have tripped this either
    // The SAME fold with NO observed price (priced absent/falsy) is
    // unpriced spend: the seed trips `exhausted` BEFORE the resumed run
    // admits anything (DD-9, fail loud).
    const unpriced = createGovernor({ maxUsd: 10 });
    unpriced.seedFromJournal([
      STARTED('p--a--2', 1, 10),
      JOB_STARTED('p--a--2', 'j1', 1),
      OPENED('p--a--2', 'j1', 1, 'p--a--2:j1:1:1', 0.5),
      SETTLED('p--a--2', 'j1', 'p--a--2:j1:1:1', 0, { usage: USAGE }),
    ]);
    expect(unpriced.tripped).toBe(true);
    expect(unpriced.tripKind).toBe('exhausted');
  });

  test('A12b: an unresolved reservation charges IN FULL and quarantines the job', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      // The crash window: opened, never settled, no finish.
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.75),
    ]);
    expect(governor.usdSpent).toBe(0.75);
    expect([...governor.quarantinedJobs.keys()]).toEqual(['j1']);
    expect(governor.quarantinedJobs.get('j1')).toEqual({
      reservationId: 'p--a--1:j1:1:1',
      usd: 0.75,
    });
    expect(governor.events.some((event) => event.kind === 'quarantined')).toBe(true);
  });

  test('A12b: the full charge of an unresolved reservation can trip the seeded cap', () => {
    const governor = createGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 1.0),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 1.5),
    ]);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
    expect(governor.usdSpent).toBe(1.5);
  });

  test('a W2.2-era run (no reservations) still seeds from job-finished costUSD', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--0', 1, 10),
      JOB_STARTED('p--a--0', 'j1', 1),
      {
        type: 'job-finished',
        runId: 'p--a--0',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 0.4,
      },
    ]);
    expect(governor.usdSpent).toBe(0.4);
    expect(governor.quarantinedJobs.size).toBe(0);
  });

  test('mixed-era history: each run spends by its own era (W2.2 finish + W2.3 settles)', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      // Run 1: W2.2-era governed (costUSD on the finish).
      STARTED('p--a--0', 1, 10),
      JOB_STARTED('p--a--0', 'j1', 1),
      {
        type: 'job-finished',
        runId: 'p--a--0',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 1 },
        costUSD: 0.4,
      },
      // Run 2: reservation-era (settled charge; the finish restates it).
      STARTED('p--a--1', 2, 10),
      JOB_STARTED('p--a--1', 'j2', 1),
      OPENED('p--a--1', 'j2', 1, 'p--a--1:j2:1:1', 0.5),
      SETTLED('p--a--1', 'j2', 'p--a--1:j2:1:1', 0.2),
      {
        type: 'job-finished',
        runId: 'p--a--1',
        at: '2026-01-01T00:00:05.000Z',
        jobId: 'j2',
        opId: 'op',
        inputsHash: 'h',
        result: { status: 'ok', value: 2 },
        costUSD: 0.2,
        charged: 0.2,
      },
    ]);
    expect(governor.usdSpent).toBeCloseTo(0.6);
    expect(governor.quarantinedJobs.size).toBe(0);
  });

  test('reservation-era corruption throws: a settle without an open, a finish over an unsettled reservation', () => {
    const orphanSettle = createGovernor({ maxUsd: 10 });
    expect(() =>
      orphanSettle.seedFromJournal([
        STARTED('p--a--1', 1, 10),
        SETTLED('p--a--1', 'j1', 'p--a--1:j1:1:1', 0.3),
      ]),
    ).toThrow(/no matching reservation-opened/);
    const finishOverOpen = createGovernor({ maxUsd: 10 });
    expect(() =>
      finishOverOpen.seedFromJournal([
        STARTED('p--a--1', 1, 10),
        JOB_STARTED('p--a--1', 'j1', 1),
        OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
        {
          type: 'job-finished',
          runId: 'p--a--1',
          at: '2026-01-01T00:00:03.000Z',
          jobId: 'j1',
          opId: 'op',
          inputsHash: 'h',
          result: { status: 'ok', value: 1 },
        },
      ]),
    ).toThrow(/unsettled/);
  });

  test('a reservation-era settle with usage and zero charge is unpriced spend (DD-9 trips at seed)', () => {
    const governor = createGovernor({ maxUsd: 10 });
    governor.seedFromJournal([
      STARTED('p--a--1', 1, 10),
      JOB_STARTED('p--a--1', 'j1', 1),
      OPENED('p--a--1', 'j1', 1, 'p--a--1:j1:1:1', 0.5),
      {
        type: 'reservation-settled',
        runId: 'p--a--1',
        at: '2026-01-01T00:00:02.000Z',
        jobId: 'j1',
        reservationId: 'p--a--1:j1:1:1',
        charged: 0,
        basis: 'observed',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      },
    ]);
    expect(governor.tripped).toBe(true);
    expect(governor.tripKind).toBe('exhausted');
  });

  test('attempt and dispatch seeds fold from job-started in BOTH eras', () => {
    const governor = createGovernor({ maxUsd: 10, runDispatchQuota: 5 });
    governor.seedFromJournal([
      // W2.2-era run: two starts of j1 and one of j2.
      STARTED('p--a--0', 1, 10),
      JOB_STARTED('p--a--0', 'j1', 1),
      JOB_STARTED('p--a--0', 'j1', 2),
      JOB_STARTED('p--a--0', 'j2', 1),
      // Reservation-era run: one start of j1 (crashed, quarantined).
      STARTED('p--a--1', 2, 10),
      JOB_STARTED('p--a--1', 'j1', 3),
      OPENED('p--a--1', 'j1', 3, 'p--a--1:j1:3:1', 0.5),
    ]);
    expect(governor.attemptsFor('j1')).toBe(3);
    expect(governor.attemptsFor('j2')).toBe(1);
    expect(governor.dispatchCount).toBe(4);
  });
});
