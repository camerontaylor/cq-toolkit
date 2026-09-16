import { match } from '../helpers/matchers.js';
// T1.3 slice 2 — tests for the budget governor (src/kernel/governor.ts).
//
// THE ws-a acceptance checks, in goal order:
//   1. THE KILL-LADDER CHECK: a fake op that IGNORES the abort signal is
//      killed through the full escalation ladder — each rung asserted rung by
//      rung (names, order, exact delays via the injected virtual clock), the
//      final kill producing OpResult budget-exhausted, with a late
//      post-kill rejection provably swallowed (no unhandled rejection).
//   2. USD cap trips mid-run: remaining dispatches are refused as
//      budget-exhausted (real terminal verdicts), done rows keep real
//      results; withBudgetStop annotates ONLY a stop that actually gated
//      undispatched work (queued/blocked re-marks — the stopOnError
//      variant), dispatch-quota stops included, and NEVER claims
//      stoppedEarly when nothing was gated (I9 honesty, both directions).
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
// Determinism: EVERY timer flows through the injected virtual Clock — no
// real-time waits anywhere (a setImmediate pump yields event-loop turns for
// the runner's fs/microtask work; assertions on delays are exact). Temp
// journal dirs: mkdtemp under os.tmpdir, removed in afterEach.
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
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
  seedFromRunLog,
  withBudgetStop,
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
} from '../../src/kernel/types.js';

/** Narrowed governor-event views for filter predicates. */
type LadderRungEvent = Extract<GovernorEvent, { kind: 'ladder-rung' }>;
type CompletedEvent = Extract<GovernorEvent, { kind: 'completed' }>;
type ShortCircuitEvent = Extract<GovernorEvent, { kind: 'short-circuited' }>;
type AdmittedEvent = Extract<GovernorEvent, { kind: 'admitted' }>;

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
// 1b. THE KILL-LADDER CHECK through the governed registry + runPlan
// ---------------------------------------------------------------------------

describe('governRegistry — the ladder through runPlan (ws-a item 1)', () => {
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
    const governor = new BudgetGovernor(
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
        governRegistry(viewWith(entry('hang', hangOp)), governor),
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
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 2, stopOnError: false, maxUsd: 1.0 }, {}),
    );
    const plan = independentPlan('plan-usd', 5, 'spendy');
    const registry = viewWith(entry('spendy', spendyOp));

    const raw = await runPlan(
      plan,
      { concurrency: 2, stopOnError: false, maxUsd: 1.0 },
      governRegistry(registry, governor),
    );
    // Runner-side the run reached a terminal state for every job (the
    // governor short-circuited post-trip dispatches): each refusal IS a
    // real budget-exhausted verdict, and the raw report is silent.
    expect(raw.stoppedEarly).toBe(false);
    const report = withBudgetStop(raw, plan, governor);

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
    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, maxUsd: 1.0 },
      governRegistry(registry, governor),
    );
    // Raw: d never started and its dependency c is budget-exhausted — the
    // runner's sweep honestly calls that blocked (its sweep predates the
    // governor and cannot attribute).
    expect(rowStatuses(raw)).toEqual(['ok', 'ok', 'budget-exhausted', 'failed']);
    expect(raw.jobs[3]?.result).toMatchObject({
      error: match.stringMatching(/blocked: dependency 'c'/),
    });

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

  test('diamond dependency: a shared budget-caused obstruction re-marks the diamond root (I9)', async () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    // a → {b, c} → d: the SAME budget-caused obstruction d sits under BOTH
    // branches, so the causality walk revisits d — exactly the shape where a
    // visited-marker misread as "not budget-caused" kept the root dishonest.
    const plan: Plan = {
      id: 'plan-diamond',
      jobs: [
        { id: 'e', op: 'spendy', input: { jobId: 'e' } },
        { id: 'f', op: 'spendy', input: { jobId: 'f' }, dependsOn: ['e'] }, // trips during f
        { id: 'd', op: 'ok', input: { jobId: 'd' }, dependsOn: ['f'] }, // refused post-trip; stop fires
        { id: 'b', op: 'ok', input: { jobId: 'b' }, dependsOn: ['d'] }, // blocked on d
        { id: 'c', op: 'ok', input: { jobId: 'c' }, dependsOn: ['d'] }, // blocked on d (the diamond)
        { id: 'a', op: 'ok', input: { jobId: 'a' }, dependsOn: ['b', 'c'] }, // blocked on BOTH branches
      ],
    };
    const registry = viewWith(entry('spendy', spendyOp), entry('ok', okOp));
    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true, maxUsd: 1.0 },
      governRegistry(registry, governor),
    );
    expect(rowStatuses(raw)).toEqual([
      'ok',
      'ok',
      'budget-exhausted',
      'failed',
      'failed',
      'failed',
    ]);

    const report = withBudgetStop(raw, plan, governor);
    // ALL of d, b, c AND the diamond root a are budget-caused — the memoized
    // verdict for d is reused for the second branch instead of dropping it.
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
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    const plan: Plan = {
      id: 'plan-counts',
      jobs: [
        { id: 'f1', op: 'fail', input: { jobId: 'f1' } }, // REAL failure
        { id: 's1', op: 'spendy', input: { jobId: 's1' } },
        { id: 'f2', op: 'ok', input: { jobId: 'f2' }, dependsOn: ['f1'] }, // blocked for REAL
        { id: 's2', op: 'spendy', input: { jobId: 's2' }, dependsOn: ['s1'] }, // trips during s2
        { id: 's3', op: 'ok', input: { jobId: 's3' }, dependsOn: ['s2'] }, // refused post-trip
        { id: 's4', op: 'ok', input: { jobId: 's4' }, dependsOn: ['s3'] }, // blocked by BUDGET-caused s3
      ],
    };
    const registry = viewWith(entry('fail', failOp), entry('spendy', spendyOp), entry('ok', okOp));
    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, maxUsd: 1.0 },
      governRegistry(registry, governor),
    );
    // Raw: f2 blocked on the REAL f1 failure; s4 blocked on budget-exhausted s3.
    expect(raw.counts).toEqual({
      queued: 0,
      running: 0,
      blocked: 2,
      done: 2,
      failed: 1,
      'budget-exhausted': 1,
    });

    const report = withBudgetStop(raw, plan, governor);
    // Only s4 moves (blocked -> budget-exhausted). f2 keeps its real verdict
    // AND its blocked count — a full recompute would have migrated it into
    // counts.failed even though the budget never touched it.
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
      ctx.reportUsage(UNPRICED_USAGE);
    }
    return okOp(raw);
  };

  test('maxTokens is an independent cap: trip reason names the token rollup; admission refuses; governed dispatch is budget-exhausted', async () => {
    const governor = new BudgetGovernor({ maxTokens: 100 });
    // Boundary first: a fold AT the cap does not trip (same exceeds semantics as USD).
    governor.observeResult('j1', { usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(governor.tripped).toBe(false);

    // The over-cap fold trips on the TOKEN rollup — no maxUsd anywhere in this config.
    governor.observeResult('j2', { usage: { input: 60, output: 40, cacheRead: 0, cacheWrite: 0 } });
    expect(governor.tripped).toBe(true);
    expect(governor.tripReason).toMatch(/token rollup 200 exceeded cap 100/);

    // A post-trip admission is refused as 'budget', and the governOp-level
    // dispatch short-circuits to the frozen budget-exhausted verdict (I9).
    expect(governor.admit('j3')).toEqual({ decision: 'reject', reason: 'budget' });
    const governedEntry = governRegistry(viewWith(entry('fake', okOp)), governor).get('fake');
    if (governedEntry === undefined) throw new Error('governed entry missing');
    const governedOp = (await governedEntry.importer()) as (
      input: unknown,
    ) => Promise<OpResult<unknown>>;
    expect(await governedOp({ jobId: 'never-runs' })).toEqual({ status: 'budget-exhausted' });

    // Control: a governor whose fold stays UNDER the cap never trips.
    const control = new BudgetGovernor({ maxTokens: 100 });
    control.observeResult('c1', { usage: { input: 25, output: 25, cacheRead: 0, cacheWrite: 0 } });
    expect(control.tripped).toBe(false);
  });

  test('THE d02a107 acceptance check: usage without costUSD still stops the run at maxTokens (the subscription case)', async () => {
    const governor = new BudgetGovernor(
      governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 150 }, {}),
    );
    const plan = independentPlan('plan-dd9-tokens', 3, 'usagey');
    const registry = viewWith(entry('usagey', usageOnlyOp));

    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, maxTokens: 150 },
      governRegistry(registry, governor),
    );
    // Runner-side the run reached a terminal state for every job: j3's
    // post-trip dispatch was REFUSED, and that refusal is a real
    // budget-exhausted verdict — the raw report is silent.
    expect(raw.stoppedEarly).toBe(false);
    const report = withBudgetStop(raw, plan, governor);

    // The run did NOT continue past the cap: j1 folded 120 tokens (under),
    // j2's fold hit 240 (over) and tripped mid-run — j2 keeps its real
    // result, j3's dispatch was refused. I9 honesty: the trip gated no
    // undispatched work (every row is a real terminal verdict), so the
    // report carries NO stoppedEarly claim.
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
    expect(governor.usdSpent).toBe(0.6);
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
    const governor = new BudgetGovernor(
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
      { concurrency: 1, stopOnError: false, maxTokens: 100 },
      governRegistry(viewWith(entry('lying', lyingOp)), governor),
    );
    expect(report.jobs[0]?.result.status).toBe('failed');
    expect(report.jobs[0]?.result).toMatchObject({
      status: 'failed',
      error: match.stringMatching(/non-serializable result/),
    });
    expect(governor.usage).toBeUndefined(); // folded NOTHING
    expect(governor.tripped).toBe(false);

    // (b2, review 9-2) A lying COST — NaN or negative — must fold NOTHING
    // via the direct governed-op path too: the guard rejects the WHOLE
    // result, so the completed event is never followed by an
    // assertValidUsd post-record throw, no usage folds, and the row stays
    // 'ok' (the runner's serialization layer is not on this seam).
    for (const badCost of [Number.NaN, -0.5]) {
      const costGovernor = new BudgetGovernor(
        governorConfig({ concurrency: 1, stopOnError: false, maxTokens: 100, maxUsd: 5 }, {}),
      );
      const costlyEntry = governRegistry(
        viewWith(
          entry('costly', async () => ({
            status: 'ok' as const,
            value: {
              usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0 },
              denials: [] as never[],
              stopReason: 'complete' as const,
              costUSD: badCost,
            },
          })),
        ),
        costGovernor,
      ).get('costly');
      if (costlyEntry === undefined) throw new Error('governed entry missing');
      const costlyOp = (await costlyEntry.importer()) as (
        input: unknown,
      ) => Promise<OpResult<unknown>>;
      const verdict = await costlyOp({ jobId: 'cost-lying' });
      expect(verdict.status).toBe('ok'); // the verdict is untouched — no throw
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
// 2c. RD-B review debt — the production observeResult wiring (#14-1/#14-2)
// ---------------------------------------------------------------------------

describe('governOp folds a returned WorkerResult through observeResult (#14-1/#14-2)', () => {
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
      { concurrency: 1, stopOnError: false, maxUsd: 5 },
      governRegistry(viewWith(entry('worker', workerOp)), governor),
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
      { concurrency: 1, stopOnError: false, maxUsd: 5 },
      governRegistry(viewWith(entry('unpriced', unpricedWorkerOp)), governor),
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
        ctx.reportUsage(WORKER_USAGE); // streamed evidence…
      }
      // …AND the same usage returned in the WorkerResult: the rollup must
      // count it ONCE, not twice.
      return { status: 'ok', value: workerValue({ costUSD: 0.02, costBasis: 'modeled' }) };
    };
    const plan = independentPlan('plan-worker-once', 1, 'double');
    await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, maxUsd: 5 },
      governRegistry(viewWith(entry('double', doubleEvidenceOp)), governor),
    );
    expect(governor.usage).toEqual(WORKER_USAGE); // once — not {input: 200, output: 100, …}
    expect(governor.usdSpent).toBe(0.02); // the returned cost folded (once)
  });
});

// ---------------------------------------------------------------------------
// 2d. RD-B review debt — seed-time USD pricing (#14-5), cost validation
// (#15-1), and the reasoning-once token fold (#14-6)
// ---------------------------------------------------------------------------

describe('seedFromJournal USD pricing — fail loud at seed time (#14-5/#15-1)', () => {
  const SEED_USAGE = { input: 7, output: 3, cacheRead: 1, cacheWrite: 2 };
  const seededEvents = (): JournalEvent[] => [
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
    },
  ];

  test('seeded usage + maxUsd + NO usdOf trips LOUD before the resumed run admits anything', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(seededEvents());
    expect(governor.usage).toEqual(SEED_USAGE);
    expect(governor.tripped).toBe(true); // the seed alone trips — never fail open
    expect(governor.tripReason).toMatch(/prior usage/);
    expect(governor.tripReason).toMatch(/cannot be priced/);
    expect(governor.tripReason).toMatch(/maxUsd 1 cannot bind/);
    expect(governor.tripReason).toMatch(/DD-9/);
    expect(governor.admit('c1')).toEqual({ decision: 'reject', reason: 'budget' });
  });

  test('with usdOf the same seed prices the rollup and does NOT trip', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    governor.seedFromJournal(seededEvents(), { usdOf: () => 0.1 });
    expect(governor.usdSpent).toBe(0.1);
    expect(governor.tripped).toBe(false);
  });

  test('a usdOf deriving NaN throws at seed time (construction-time: fail loud and early)', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    expect(() => governor.seedFromJournal(seededEvents(), { usdOf: () => NaN })).toThrowError(
      /derived cost must be a finite number >= 0, got NaN/,
    );
    expect(governor.usdSpent).toBe(0); // the rollup was never poisoned
  });

  test('a usdOf deriving a negative usd throws likewise', () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    expect(() => governor.seedFromJournal(seededEvents(), { usdOf: () => -1 })).toThrowError(
      /derived cost must be a finite number >= 0, got -1/,
    );
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
// 2e. RD-B review debt — honest-stop annotation, both directions (#15-4/#15-6)
// ---------------------------------------------------------------------------

describe('withBudgetStop — honest annotation, both directions (#15-4/#15-6)', () => {
  test('a dispatch-quota stop annotates: queued rows re-mark budget-exhausted (#15-4a)', async () => {
    const governor = new BudgetGovernor({ runDispatchQuota: 2 });
    const plan: Plan = {
      id: 'plan-quota-stop',
      jobs: [
        { id: 'j1', op: 'fake', input: { jobId: 'j1' } },
        { id: 'j2', op: 'fake', input: { jobId: 'j2' } },
        { id: 'j3', op: 'fake', input: { jobId: 'j3' } }, // refused: dispatch-quota
        { id: 'j4', op: 'fake', input: { jobId: 'j4' }, dependsOn: ['j2'] }, // wave 2 — never dispatched → queued
      ],
    };
    const registry = viewWith(entry('fake', okOp));
    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: true },
      governRegistry(registry, governor),
    );
    // j3's refusal is a non-ok terminal → stopOnError halts dispatching; j4
    // never dispatched (its dep j2 is done) → the runner's queued marker.
    expect(governor.tripped).toBe(false); // a quota stop is NOT a USD/token trip…
    const refusals = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
    expect(rowStatuses(raw)).toEqual(['ok', 'ok', 'budget-exhausted', 'indeterminate']);
    expect(raw.jobs[3]?.result).toMatchObject({ detail: match.stringMatching(/^queued:/) });

    // …yet the run stopped for budget-family reasons: withBudgetStop
    // annotates and re-marks the queued row even though no trip fired.
    const report = withBudgetStop(raw, plan, governor);
    expect(report.stoppedEarly).toBe(true);
    expect(report.earlyStopReason).toBe('budget');
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted', 'budget-exhausted']);
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
    const governor = new BudgetGovernor({ maxUsd: 0.5 });
    const plan = independentPlan('plan-trip-no-gate', 2, 'spendy');
    const registry = viewWith(entry('spendy', spendyOp));
    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      governRegistry(registry, governor),
    );
    // j1's cost trips the cap mid-run; j2's dispatch is refused — both rows
    // are real terminal verdicts; nothing was ever queued or blocked.
    expect(governor.tripped).toBe(true);
    expect(rowStatuses(raw)).toEqual(['ok', 'budget-exhausted']);
    const report = withBudgetStop(raw, plan, governor);
    // I9 honesty: no row was re-marked → the report is returned UNTOUCHED.
    expect(report).toBe(raw);
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
  });

  test('a fabricated queued: detail from an ADMITTED op is NOT rewritten (#15-6)', async () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    // The op RAN (the governor admitted it) and returned an indeterminate
    // verdict claiming the runner's never-dispatched marker — executed code
    // fabricating `queued: …`.
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      const ctx = currentJobContext();
      if (ctx !== undefined) ctx.reportCost(2.0); // trips the 1.0 cap mid-run
      return { status: 'indeterminate', detail: 'queued: (fabricated by the op itself)' };
    };
    const plan = independentPlan('plan-queued-fabricated', 1, 'lying');
    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      governRegistry(viewWith(entry('lying', lyingOp)), governor),
    );
    const admissions = governor.events.filter(
      (event): event is AdmittedEvent => event.kind === 'admitted',
    );
    expect(admissions.map((event) => event.jobKey)).toEqual(['j1']); // the governor ADMITTED this job
    expect(governor.tripped).toBe(true);
    expect(rowStatuses(raw)).toEqual(['indeterminate']);

    const report = withBudgetStop(raw, plan, governor);
    // The row keeps its REAL verdict — the queued marker was written by
    // executed code, not the runner's stop sweep — and with nothing
    // re-marked there is no stoppedEarly claim either.
    expect(report.jobs[0]?.result).toEqual({
      status: 'indeterminate',
      detail: 'queued: (fabricated by the op itself)',
    });
    expect(report.stoppedEarly).toBe(false);
  });

  test('a fabricated queued: row does not condemn its DEPENDENTS either (#15-6, review round 3)', async () => {
    const governor = new BudgetGovernor({ maxUsd: 1.0 });
    // The ADMITTED op fabricates `queued: …` AND has a dependent: the
    // budgetCaused walk reads indeterminate rows too, so a lying row must
    // not get the dependent re-marked budget-exhausted (the predicate is
    // shared — re-mark pass and causality walk cannot drift).
    const lyingOp = async (): Promise<OpResult<unknown>> => {
      const ctx = currentJobContext();
      if (ctx !== undefined) ctx.reportCost(2.0); // trips the 1.0 cap mid-run
      return { status: 'indeterminate', detail: 'queued: (fabricated by the op itself)' };
    };
    const plan: Plan = {
      id: 'plan-queued-fabricated-dep',
      jobs: [
        { id: 'f1', op: 'lying', input: { jobId: 'f1' } },
        { id: 'd1', op: 'fake', input: { jobId: 'd1' }, dependsOn: ['f1'] },
      ],
    };
    const raw = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      governRegistry(viewWith(entry('lying', lyingOp), entry('fake', okOp)), governor),
    );
    expect(governor.tripped).toBe(true);
    // f1 indeterminate → the runner counts it failed; d1 is blocked by it.
    expect(rowStatuses(raw)).toEqual(['indeterminate', 'failed']);

    const report = withBudgetStop(raw, plan, governor);
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
        governRegistry(
          viewWith(entry('flaky', flaky)),
          new BudgetGovernor({ maxAttemptsPerJob: 2 }),
        ),
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
        governRegistry(viewWith(entry('flaky', flaky)), governor2),
      );
      expect(calls).toEqual(['j1', 'j1']); // attempt 2 happened
      expect(
        governor2.events.filter((event) => event.kind === 'admitted').map((event) => event.attempt),
      ).toEqual([2]);
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
      // A prior run whose journal carries TRUE ordinals (what the T1.4
      // runner will emit): attempts 1 and 2, definitively failed.
      await log.append('plan-field--prior--aa', {
        type: 'run-started',
        runId: 'plan-field--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-field',
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
        governRegistry(viewWith(entry('fake', countingOk)), governor),
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
// Review round 1 — the default job key must give the cap teeth (F3), and the
// seed must dedupe multi-run journals (F4)
// ---------------------------------------------------------------------------

describe('default job key — the cap exists without config (review F3)', () => {
  test('op-name fallback: per-job attempt cap trips without config.jobKey or input.jobId', async () => {
    const governor = new BudgetGovernor({ maxAttemptsPerJob: 2 });
    const calls: string[] = [];
    const numbered = async (raw: unknown): Promise<OpResult<unknown>> => {
      const n = (raw as { n: number }).n;
      calls.push(String(n));
      return { status: 'ok', value: n };
    };
    const schema = z.object({ n: z.number() });
    // Inputs carry NO jobId: the default key falls back to the OP NAME, so
    // each dispatch counts as another attempt of 'numbered'.
    const plan: Plan = {
      id: 'plan-fallback',
      jobs: [1, 2, 3].map((n) => ({ id: `n${n}`, op: 'numbered', input: { n } })),
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false },
      governRegistry(viewWith(entry('numbered', numbered, schema)), governor),
    );
    expect(calls).toEqual(['1', '2']); // the third dispatch never runs the op
    expect(governor.attemptsFor('numbered')).toBe(2);
    expect(rowStatuses(report)).toEqual(['ok', 'ok', 'budget-exhausted']);
    const refusals = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['attempt-cap']);
  });

  test('seedFromJournal aligns the op-name fallback key with journal attempts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-seed-align-'));
    try {
      const log = openRunLog(dir);
      // Prior run: job 'x' ran op 'solo' once (attempt 1) and failed.
      const plan: Plan = {
        id: 'plan-seed-align',
        jobs: [{ id: 'x', op: 'solo', input: { n: 0 } }],
      };
      const manifest = makeManifest(plan);
      await log.append('plan-seed-align--prior--aa', {
        type: 'run-started',
        runId: 'plan-seed-align--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-seed-align',
      });
      await log.append('plan-seed-align--prior--aa', {
        type: 'job-started',
        runId: 'plan-seed-align--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'x',
        op: 'solo',
        attempt: 1,
      });
      await log.append('plan-seed-align--prior--aa', {
        type: 'job-finished',
        runId: 'plan-seed-align--prior--aa',
        at: '2026-09-16T00:00:00.000Z',
        jobId: 'x',
        opId: 'solo',
        inputsHash: manifest.jobs[0]?.inputsHash ?? '',
        result: { status: 'failed', error: 'flake' },
      });
      const events = await log.read('plan-seed-align--prior--aa');

      const governor = new BudgetGovernor({ maxAttemptsPerJob: 2 });
      governor.seedFromJournal(events);
      expect(governor.attemptsFor('solo')).toBe(1); // the fallback key inherited the journal attempts

      // A fresh run whose inputs carry no jobId: the next dispatch is
      // attempt 2; the one after that is refused.
      const calls: string[] = [];
      const solo = async (raw: unknown): Promise<OpResult<unknown>> => {
        const n = (raw as { n: number }).n;
        calls.push(String(n));
        return { status: 'ok', value: n };
      };
      const schema = z.object({ n: z.number() });
      const plan2: Plan = {
        id: 'plan-seed-align-2',
        jobs: [
          { id: 'y1', op: 'solo', input: { n: 1 } },
          { id: 'y2', op: 'solo', input: { n: 2 } },
        ],
      };
      const report = await runPlan(
        plan2,
        { concurrency: 1, stopOnError: false },
        governRegistry(viewWith(entry('solo', solo, schema)), governor),
      );
      expect(calls).toEqual(['1']); // exactly one more dispatch
      const admissions = governor.events.filter(
        (event): event is AdmittedEvent => event.kind === 'admitted',
      );
      expect(admissions.map((event) => event.attempt)).toEqual([2]);
      expect(rowStatuses(report)).toEqual(['ok', 'budget-exhausted']);
      const refusals = governor.events.filter(
        (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
      );
      expect(refusals.map((event) => event.reason)).toEqual(['attempt-cap']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('op-name fallback seeds the SUM of a shared op.s dispatches, not the max (review R2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-seed-sum-'));
    try {
      const log = openRunLog(dir);
      // Two journal jobs sharing op 'solo', two attempts EACH = 4 dispatches.
      await log.append('p-sum--r1--aa', {
        type: 'run-started',
        runId: 'p-sum--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-sum',
      });
      for (const jobId of ['x1', 'x2']) {
        await log.append('p-sum--r1--aa', {
          type: 'job-started',
          runId: 'p-sum--r1--aa',
          at: '2026-09-16T00:00:00.000Z',
          jobId: jobId,
          op: 'solo',
          attempt: 1,
        });
        await log.append('p-sum--r1--aa', {
          type: 'job-started',
          runId: 'p-sum--r1--aa',
          at: '2026-09-16T00:00:00.000Z',
          jobId: jobId,
          op: 'solo',
          attempt: 2,
        });
        await log.append('p-sum--r1--aa', {
          type: 'job-finished',
          runId: 'p-sum--r1--aa',
          at: '2026-09-16T00:00:00.000Z',
          jobId: jobId,
          opId: 'solo',
          inputsHash: `hash-${jobId}`,
          result: { status: 'failed', error: 'flake' },
        });
      }
      const events = await log.read('p-sum--r1--aa');

      const governor = new BudgetGovernor({ maxAttemptsPerJob: 3 });
      governor.seedFromJournal(events);
      expect(governor.attemptsFor('solo')).toBe(4); // SUM (2+2), not max(2)

      // cap 3 < 4 seeded dispatches: a fresh no-jobId run of the same op
      // cannot dispatch AT ALL — the max would have admitted two.
      const calls: string[] = [];
      const solo = async (raw: unknown): Promise<OpResult<unknown>> => {
        calls.push(String((raw as { n: number }).n));
        return { status: 'ok', value: raw };
      };
      const schema = z.object({ n: z.number() });
      const plan2: Plan = {
        id: 'plan-sum-2',
        jobs: [
          { id: 'y1', op: 'solo', input: { n: 1 } },
          { id: 'y2', op: 'solo', input: { n: 2 } },
        ],
      };
      const report = await runPlan(
        plan2,
        { concurrency: 1, stopOnError: false },
        governRegistry(viewWith(entry('solo', solo, schema)), governor),
      );
      expect(calls).toEqual([]);
      expect(rowStatuses(report)).toEqual(['budget-exhausted', 'budget-exhausted']);
      const refusals = governor.events.filter(
        (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
      );
      expect(refusals.map((event) => event.reason)).toEqual(['attempt-cap', 'attempt-cap']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('the op ordinal CONTINUES from the seeded sum when the cap allows (review R2)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cq-gov-seed-sum2-'));
    try {
      const log = openRunLog(dir);
      await log.append('p-sum2--r1--aa', {
        type: 'run-started',
        runId: 'p-sum2--r1--aa',
        at: '2026-09-16T00:00:00.000Z',
        planId: 'plan-sum2',
      });
      for (const jobId of ['x1', 'x2']) {
        await log.append('p-sum2--r1--aa', {
          type: 'job-started',
          runId: 'p-sum2--r1--aa',
          at: '2026-09-16T00:00:00.000Z',
          jobId: jobId,
          op: 'solo',
          attempt: 1,
        });
        await log.append('p-sum2--r1--aa', {
          type: 'job-started',
          runId: 'p-sum2--r1--aa',
          at: '2026-09-16T00:00:00.000Z',
          jobId: jobId,
          op: 'solo',
          attempt: 2,
        });
        await log.append('p-sum2--r1--aa', {
          type: 'job-finished',
          runId: 'p-sum2--r1--aa',
          at: '2026-09-16T00:00:00.000Z',
          jobId: jobId,
          opId: 'solo',
          inputsHash: `hash-${jobId}`,
          result: { status: 'failed', error: 'flake' },
        });
      }
      const events = await log.read('p-sum2--r1--aa');

      const governor = new BudgetGovernor({ maxAttemptsPerJob: 5 });
      governor.seedFromJournal(events);
      // 4 seeded dispatches: the next admission IS attempt 5, the one after
      // is refused (5 >= 5) — the ordinal continues from the sum.
      const calls: string[] = [];
      const solo = async (raw: unknown): Promise<OpResult<unknown>> => {
        const n = (raw as { n: number }).n;
        calls.push(String(n));
        return { status: 'ok', value: n };
      };
      const schema = z.object({ n: z.number() });
      const plan2: Plan = {
        id: 'plan-sum2-2',
        jobs: [
          { id: 'y1', op: 'solo', input: { n: 1 } },
          { id: 'y2', op: 'solo', input: { n: 2 } },
        ],
      };
      const report = await runPlan(
        plan2,
        { concurrency: 1, stopOnError: false },
        governRegistry(viewWith(entry('solo', solo, schema)), governor),
      );
      expect(calls).toEqual(['1']);
      const admissions = governor.events.filter(
        (event): event is AdmittedEvent => event.kind === 'admitted',
      );
      expect(admissions.map((event) => event.attempt)).toEqual([5]);
      expect(rowStatuses(report)).toEqual(['ok', 'budget-exhausted']);
      const refusals = governor.events.filter(
        (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
      );
      expect(refusals.map((event) => event.reason)).toEqual(['attempt-cap']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
      governor.seedFromJournal(events, { usdOf: () => 0.4 });
      expect(governor.usage).toEqual(USAGE); // once — not doubled by the re-attestation
      expect(governor.usdSpent).toBe(0.4);
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
      governor.seedFromJournal(events, { usdOf: () => 0.4 });
      expect(governor.usage).toEqual({ input: 14, output: 6, cacheRead: 2, cacheWrite: 4 }); // both dispatches counted
      expect(governor.usdSpent).toBe(0.8);
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
    // Prior run: c1 done ok; c2 hard-killed mid-flight (started, NO finish).
    await log.append('plan-resume-kill--prior--aa', {
      type: 'run-started',
      runId: 'plan-resume-kill--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-resume-kill',
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
    await log.append('plan-resume-budget--prior--aa', {
      type: 'run-started',
      runId: 'plan-resume-budget--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-resume-budget',
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
    // c2's row is its REAL verdict — the seeded governor refused the
    // dispatch at admission (a short-circuit, not a re-mark).
    expect(report.jobs[1]?.result).toEqual({ status: 'budget-exhausted' });
    // I9 honesty: no row was re-marked (both verdicts are real evidence),
    // so the report carries NO stoppedEarly claim.
    expect(report.stoppedEarly).toBe(false);
    expect(report.earlyStopReason).toBeUndefined();
    expect(report.counts['budget-exhausted']).toBe(1);
  });

  test('seeding replays the dispatch count: runDispatchQuota carries across resume (review R2)', async () => {
    const log = openRunLog(dir);
    const plan: Plan = {
      id: 'plan-resume-quota',
      jobs: [{ id: 'j1', op: 'fake', input: { jobId: 'j1' } }],
    };
    const manifest = makeManifest(plan);
    // Prior run: THREE journaled dispatches of j1 (attempts 1-3, all failed).
    await log.append('plan-resume-quota--prior--aa', {
      type: 'run-started',
      runId: 'plan-resume-quota--prior--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-resume-quota',
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
    const governor = new BudgetGovernor({ runDispatchQuota: 3 });
    governor.seedFromJournal(events);
    expect(governor.dispatchCount).toBe(3); // the quota is already spent

    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      governRegistry(viewWith(entry('fake', countingOk)), governor),
    );
    expect(calls).toEqual([]); // zero further dispatches
    expect(report.jobs[0]?.result).toEqual({ status: 'budget-exhausted' });
    const refusals = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
    expect(governor.dispatchCount).toBe(3); // refusals do not consume quota
  });

  test('seedFromRunLog folds ALL of the chained runs — the latest run alone undercounts (review VB1B)', async () => {
    const log = openRunLog(dir);
    const plan: Plan = {
      id: 'plan-chained',
      jobs: [
        { id: 'c1', op: 'fake', input: { jobId: 'c1' } },
        { id: 'c2', op: 'fake', input: { jobId: 'c2' }, dependsOn: ['c1'] },
      ],
    };
    const manifest = makeManifest(plan);
    const hashOf = (index: number): string => manifest.jobs[index]?.inputsHash ?? '';
    const U1 = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 };
    const U2 = { input: 20, output: 10, cacheRead: 0, cacheWrite: 0 };

    // Run 1: real dispatches with usage — c1 ok, c2 killed (budget-exhausted).
    await log.append('plan-chained--r1--aa', {
      type: 'run-started',
      runId: 'plan-chained--r1--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-chained',
    });
    await log.append('plan-chained--r1--aa', {
      type: 'job-started',
      runId: 'plan-chained--r1--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      op: 'fake',
      attempt: 1,
    });
    await log.append('plan-chained--r1--aa', {
      type: 'job-finished',
      runId: 'plan-chained--r1--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      opId: 'fake',
      inputsHash: hashOf(0),
      result: { status: 'ok', value: 'c1' },
      usage: U1,
    });
    await log.append('plan-chained--r1--aa', {
      type: 'job-started',
      runId: 'plan-chained--r1--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      op: 'fake',
      attempt: 1,
    });
    await log.append('plan-chained--r1--aa', {
      type: 'job-finished',
      runId: 'plan-chained--r1--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      opId: 'fake',
      inputsHash: hashOf(1),
      result: { status: 'budget-exhausted' },
      usage: U2,
    });

    // Run 2 (resume): c1 re-ATTESTED (finish-only — usage must NOT double-
    // count), c2 really re-dispatched and killed again (usage counts again).
    await log.append('plan-chained--r2--bb', {
      type: 'run-started',
      runId: 'plan-chained--r2--bb',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-chained',
    });
    await log.append('plan-chained--r2--bb', {
      type: 'job-finished',
      runId: 'plan-chained--r2--bb',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c1',
      opId: 'fake',
      inputsHash: hashOf(0),
      result: { status: 'ok', value: 'c1' },
      usage: U1,
    });
    await log.append('plan-chained--r2--bb', {
      type: 'job-started',
      runId: 'plan-chained--r2--bb',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      op: 'fake',
      attempt: 1,
    });
    await log.append('plan-chained--r2--bb', {
      type: 'job-finished',
      runId: 'plan-chained--r2--bb',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      opId: 'fake',
      inputsHash: hashOf(1),
      result: { status: 'budget-exhausted' },
      usage: U2,
    });

    // Run 3 (resume): c2 re-dispatched once more (fails, no usage).
    await log.append('plan-chained--r3--cc', {
      type: 'run-started',
      runId: 'plan-chained--r3--cc',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'plan-chained',
    });
    await log.append('plan-chained--r3--cc', {
      type: 'job-started',
      runId: 'plan-chained--r3--cc',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      op: 'fake',
      attempt: 2,
    });
    await log.append('plan-chained--r3--cc', {
      type: 'job-finished',
      runId: 'plan-chained--r3--cc',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'c2',
      opId: 'fake',
      inputsHash: hashOf(1),
      result: { status: 'failed', error: 'flake' },
    });

    // The helper folds ALL THREE runs, oldest-first — not just the latest.
    const governor = await seedFromRunLog(log, 'plan-chained', { config: { runDispatchQuota: 3 } });
    expect(governor.dispatchCount).toBe(4); // 2 (run 1) + 1 (run 2) + 1 (run 3)
    expect(governor.usage).toEqual({ input: 50, output: 25, cacheRead: 0, cacheWrite: 0 }); // U1 once (deduped), U2 twice (two REAL dispatches)
    expect(governor.attemptsFor('c1')).toBe(1);
    expect(governor.attemptsFor('c2')).toBe(3);

    // A quota sized BETWEEN the run-1 dispatches (2) and the chain total (4)
    // refuses further dispatches on resume:
    const calls: string[] = [];
    const countingOk = async (raw: unknown): Promise<OpResult<unknown>> => {
      calls.push((raw as { jobId: string }).jobId);
      return okOp(raw);
    };
    const report = await runPlan(
      plan,
      { concurrency: 1, stopOnError: false, journalDir: dir, resume: true },
      governRegistry(viewWith(entry('fake', countingOk)), governor),
    );
    expect(calls).toEqual([]);
    // Resume-fold (issue #16): c1 has terminal-ok evidence from runs 1-2 with
    // a matching hash, so it REPLAYS — zero dispatch, no quota consumed,
    // nothing re-executed. c2's own re-dispatch is what the spent quota
    // refuses (short-circuited before the op runs).
    expect(rowStatuses(report)).toEqual(['ok', 'budget-exhausted']);
    expect(report.jobs[1]?.result).toEqual({ status: 'budget-exhausted' });
    const refusals = governor.events.filter(
      (event): event is ShortCircuitEvent => event.kind === 'short-circuited',
    );
    expect(refusals.map((event) => event.reason)).toEqual(['dispatch-quota']);
  });

  test('seedFromRunLog ignores a corrupt sibling-plan journal ("a" vs "a--b", shared filter)', async () => {
    // Review VB1C r1: the seed used a prefix-only candidate filter, so a
    // corrupt journal of plan 'a--b' threw /corrupt line/ into plan 'a''s
    // governed resume. It now shares the runner's candidateRunsForPlan.
    const log = openRunLog(dir);
    await log.append('a--r1--aa', {
      type: 'run-started',
      runId: 'a--r1--aa',
      at: '2026-09-16T00:00:00.000Z',
      planId: 'a',
    });
    await log.append('a--r1--aa', {
      type: 'job-started',
      runId: 'a--r1--aa',
      at: '2026-09-16T00:00:00.000Z',
      jobId: 'j1',
      op: 'fake',
      attempt: 1,
    });
    // A corrupt MIDDLE line in the sibling plan's file (prefix 'a--' matches).
    await appendFile(
      join(dir, 'a--b--k3y--c0ffee.ndjson'),
      `${JSON.stringify({ type: 'run-started', runId: 'a--b--k3y--c0ffee', at: '2026-09-16T00:00:00.000Z', planId: 'a--b' })}\n{"type":"job-started","runI\n`,
      'utf8',
    );
    const governor = await seedFromRunLog(log, 'a', { config: { runDispatchQuota: 3 } });
    expect(governor.dispatchCount).toBe(1); // only plan a's own dispatch was seeded
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
      expect(started[0]).toMatchObject({
        type: 'job-started',
        jobId: 'j1',
        op: 'hang',
        attempt: 1,
        runId: report.runId,
      });
      const finished = events.filter((event) => event.type === 'job-finished');
      expect(finished[0]).toMatchObject({ jobId: 'j1', result: { status: 'budget-exhausted' } });
      // The runner-side run-finished stays stoppedEarly:false — the honest-
      // stop flags are the governor's voice via withBudgetStop (T1.4 folds
      // them into the runner).
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
    expect(typeof toolkit.governRegistry).toBe('function');
    expect(typeof toolkit.withBudgetStop).toBe('function');
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
  });

  test('public consumers can CONSTRUCT a governor from the barrel (review VB1B)', () => {
    // A type-only BudgetGovernor export would leave governRegistry /
    // withBudgetStop / governorConfig exported but unusable.
    expect(typeof toolkit.BudgetGovernor).toBe('function');
    expect(typeof toolkit.seedFromRunLog).toBe('function');
    const governor = new toolkit.BudgetGovernor({}); // minimal valid config
    expect(governor.admit('k')).toEqual({ decision: 'admit', attempt: 1 });
    expect(governor.dispatchCount).toBe(1);
    expect(governor.tripped).toBe(false);
  });
});
