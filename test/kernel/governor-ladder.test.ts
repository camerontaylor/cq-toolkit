// Governor tests (split from test/kernel/governor.test.ts — pure move): the runLadder kill-ladder (ws-a item 1), unit and through the governed runner.

import { describe, expect, test } from 'vitest';
import {
  createGovernor,
  currentJobContext,
  governorConfig,
  runLadder,
} from '../../src/kernel/governor.js';
import { runPlan } from '../../src/kernel/runner.js';
import {
  entry,
  independentPlan,
  okOp,
  pumped,
  tick,
  viewWith,
  virtualClock,
} from './governor.helpers.js';
import type { JobGovernance, LadderRungMarker } from '../../src/kernel/governor.js';
import type { OpResult } from '../../src/kernel/types.js';
import type { CompletedEvent, LadderRungEvent } from './governor.helpers.js';

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
