// Limit propagation: the fix-run wall-clock ladder (opts.limits → the
// governor) and the propagated accounted spend (onSpend, review-debt #186).
import { describe, expect, test, vi } from 'vitest';
import { currentJobContext } from '../../src/kernel/governor.js';
import {
  actionableThread,
  completeWorker,
  defaultWorld,
  fixLine,
  NEW_SHA,
  runLoop,
} from './review-loop.helpers.js';

// ---------------------------------------------------------------------------
// The fix-run wall-clock ladder (CodeRabbit KyE, review-debt #137)
// ---------------------------------------------------------------------------

describe('the fix-run wall-clock ladder (opts.limits → the governor)', () => {
  test('run cancellation releases a same-file waiter without dispatching it', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/a.ts', 4, 102),
    ];
    const parent = new AbortController();
    let started!: () => void;
    const first = new Promise<void>((resolve) => {
      started = resolve;
    });
    const calls: string[] = [];
    const running = runLoop(world, {
      engineConcurrency: 2,
      signal: parent.signal,
      driverRun: async () => {
        const context = currentJobContext()!;
        calls.push(context.info.jobKey);
        started();
        await new Promise<void>((resolve) => {
          if (context.signal.aborted) resolve();
          else context.signal.addEventListener('abort', () => resolve(), { once: true });
        });
        return completeWorker(fixLine(false, 'Cancelled.', []));
      },
    });
    await first;
    parent.abort();
    await running;
    expect(calls).toEqual(['fix-1']);
  });
  test('a detached first worker cannot hold the run or admit a same-file successor', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/a.ts', 4, 102),
    ];
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let finishFirst!: () => void;
    const finish = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const calls: string[] = [];
    try {
      const running = runLoop(world, {
        engineConcurrency: 2,
        limits: { perJobWallClockMs: 20 },
        driverRun: async () => {
          const id = currentJobContext()!.info.jobKey;
          calls.push(id);
          if (id === 'fix-1') {
            firstStarted();
            await finish;
          }
          return completeWorker(fixLine(false, 'No change needed.', []));
        },
      });
      const settled = expect(running).rejects.toThrow('checkout actual writer drain unresolved');
      await started;
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toEqual(['fix-1']);
      await settled;
      expect(calls).toEqual(['fix-1']);
    } finally {
      finishFirst();
      vi.useRealTimers();
    }
  });
  test('a failed first worker releases its same-file successor', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/a.ts', 4, 102),
    ];
    const calls: string[] = [];
    const { outcome } = await runLoop(world, {
      engineConcurrency: 2,
      driverRun: async () => {
        const id = currentJobContext()!.info.jobKey;
        calls.push(id);
        if (id === 'fix-1') throw new Error('fixture worker failure');
        return completeWorker(fixLine(false, 'No change needed.', []));
      },
    });
    expect(calls).toEqual(['fix-1', 'fix-2']);
    expect(outcome.fixReport?.jobs[0]?.result.status).not.toBe('ok');
    expect(outcome.fixReport?.jobs[1]?.result.status).toBe('ok');
  });
  test('a budget trip releases waiting jobs without dispatch or extra spend', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/a.ts', 4, 102),
    ];
    const calls: string[] = [];
    const { outcome } = await runLoop(world, {
      engineConcurrency: 2,
      runOptions: { maxUsd: 0.05 },
      driverRun: async () => {
        calls.push(currentJobContext()!.info.jobKey);
        return completeWorker(fixLine(false, 'No change needed.', []), { costUSD: 0.1 });
      },
    });
    expect(calls).toEqual(['fix-1']);
    expect(outcome.fixReport?.costUSD).toBeCloseTo(0.1);
    expect(outcome.fixReport?.jobs[1]?.result.status).toBe('budget-exhausted');
  });
  test('same-file wait does not consume the second job ladder and disjoint work starts', async () => {
    // ADVERSARIAL SCHEDULE (the main-CI flake, fix-3/fix-1 ordering): fix-1's
    // driver parks on a test gate before its body starts — the honest model
    // of a fixer subprocess spawning late — while fix-3, a DISJOINT file
    // with no lease ahead of it, is admitted and settles first. The old
    // assertion demanded driver ENTRY order ['fix-1','fix-3']; under any
    // concurrent schedule the disjoint worker may enter first (the flake:
    // ['fix-3','fix-1'] vs ['fix-1','fix-3'], seen on main and PRs). Entry
    // order is NOT the contract — the causal assertions below are.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/a.ts', 4, 102),
      actionableThread('T3', 'src/b.ts', 5, 103),
    ];
    const started: string[] = [];
    const aborted: string[] = [];
    let releaseFix1!: () => void;
    const admitFix1 = new Promise<void>((resolve) => {
      releaseFix1 = resolve;
    });
    let thirdEntered!: () => void;
    const third = new Promise<void>((resolve) => {
      thirdEntered = resolve;
    });
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => {
      secondStarted = resolve;
    });
    try {
      const running = runLoop(world, {
        engineConcurrency: 2,
        limits: { perJobWallClockMs: 200 },
        driverRun: async () => {
          const context = currentJobContext()!;
          const id = context.info.jobKey;
          // fix-1 parks INSIDE its job context before its body starts; the
          // ladder is armed, but virtual time moves only when this test
          // advances it, so no rung can fire while parked.
          if (id === 'fix-1') await admitFix1;
          started.push(id);
          context.signal.addEventListener('abort', () => aborted.push(id), { once: true });
          if (id === 'fix-3') thirdEntered();
          if (id === 'fix-2') secondStarted();
          await new Promise<void>((resolve) => setTimeout(resolve, id === 'fix-2' ? 150 : 50));
          return completeWorker(fixLine(false, 'No change needed.', []));
        },
      });
      // fix-3 enters while fix-1 is parked and fix-2 is lease-held.
      await third;
      expect(started).toEqual(['fix-3']);
      await vi.advanceTimersByTimeAsync(50);
      // fix-3 SETTLED ok; the same-file successor (fix-2) must still be
      // parked behind fix-1's file lease, and no rung has fired on anyone.
      expect(started).toEqual(['fix-3']);
      expect(aborted).toEqual([]);
      releaseFix1();
      await vi.advanceTimersByTimeAsync(50);
      await vi.advanceTimersByTimeAsync(0);
      await second;
      await vi.advanceTimersByTimeAsync(150);
      const { outcome } = await running;
      // ENTRY ORDER IS NOT THE CONTRACT — the causal structure is: the
      // same-file successor started only after its predecessor entered and
      // settled; the disjoint worker needed neither; the waiter's wall-clock
      // ladder was not consumed by the wait; every row still ended ok.
      expect([...new Set(started)].sort()).toEqual(['fix-1', 'fix-2', 'fix-3']);
      expect(started.indexOf('fix-2')).toBeGreaterThan(started.indexOf('fix-1'));
      expect(started.indexOf('fix-3')).toBeLessThan(started.indexOf('fix-1'));
      expect(aborted).toEqual([]);
      expect(outcome.fixReport?.jobs).toHaveLength(3);
      expect(outcome.fixReport?.jobs.every((row) => row.result.status === 'ok')).toBe(true);
    } finally {
      releaseFix1();
      vi.useRealTimers();
    }
  });
  test('limits.perJobWallClockMs=20 trips a fixer wedged past it: the governed run records the failure honestly', async () => {
    // The driver waits 200 virtual ms and COOPERATES with the rung-1 signal (a real
    // subprocess fixer is escalated at the later rungs; in-process, the
    // signal firing inside the job context is the honest trip evidence).
    // UNARMED (the pre-fix governor built `governorConfig(runOptions, {})`)
    // no signal ever fires: the sleep completes and the job ends ok — so a
    // pass here proves the LIMITS half actually reached the governor.
    let tripped = false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let markDriverStarted!: () => void;
    const driverStarted = new Promise<void>((resolve) => {
      markDriverStarted = resolve;
    });
    try {
      const running = runLoop(defaultWorld(), {
        limits: { perJobWallClockMs: 20 },
        driverRun: async () => {
          const signal = currentJobContext()?.signal;
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(resolve, 200);
            markDriverStarted();
            signal?.addEventListener('abort', () => {
              tripped = true;
              clearTimeout(timer);
              reject(new Error('wall-clock: the fixer hit the rung-1 signal'));
            });
          });
          return completeWorker(fixLine(true, 'unreachable while the ladder is armed', [NEW_SHA]));
        },
      });

      await driverStarted;
      await vi.advanceTimersByTimeAsync(200);
      const { outcome } = await running;

      // The rung-1 signal fired INSIDE the job context, well before the wedge
      // would have ended on its own — the ladder was armed through opts.limits.
      expect(tripped).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      // The report shows the trip HONESTLY: the op maps a crashed driver to
      // indeterminate (no verdict on whether work ran), the row carries the
      // wall-clock cause, and the loop degrades to needs-human — never a
      // fabricated green.
      expect(outcome.status).toBe('needs-human');
      const row = outcome.fixReport?.jobs[0];
      expect(row?.result.status).toBe('indeterminate');
      expect(row?.result.status === 'indeterminate' && row.result.detail).toContain(
        'driver crashed: wall-clock: the fixer hit the rung-1 signal',
      );
      expect(outcome.reasons).toContain(
        'fix job fix-1 ended indeterminate: fixReviewItem: driver crashed: wall-clock: the fixer hit the rung-1 signal',
      );
      expect(outcome.actionsPosted).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// Propagated accounted spend (review-debt #186)
// ---------------------------------------------------------------------------

describe('review-loop propagated spend (onSpend)', () => {
  test('the governed fix run reports its accounted spend (governor usdSpent) through opts.onSpend', async () => {
    const spent: number[] = [];
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [
        completeWorker(fixLine(true, 'Guarded the abort path.', [NEW_SHA]), { costUSD: 0.07 }),
      ],
      onSpend: (usd) => spent.push(usd),
    });
    expect(outcome.status).toBe('ok');
    // The fix op streams the driver's costUSD through the job context, so the
    // governor's USD rollup (which the governed runner annotates onto
    // fixReport.costUSD) is what the sweep receives — no dispatch-log proxy.
    expect(spent.length).toBeGreaterThan(0);
    expect(spent[spent.length - 1]).toBeCloseTo(0.07);
    expect(outcome.fixReport?.costUSD).toBeCloseTo(0.07);
  });

  test("a THROWING onSpend observer never masks the fix run's outcome (#186 review r2)", async () => {
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort path.', [NEW_SHA]))],
      onSpend: () => {
        throw new Error('observer boom');
      },
    });
    // The observer is advisory: its throw is swallowed, and the loop's own
    // outcome (and any original throw) propagates untouched.
    expect(outcome.status).toBe('ok');
    expect(outcome.fixReport?.counts.done).toBe(1);
  });
});
