// Limit propagation: the fix-run wall-clock ladder (opts.limits → the
// governor) and the propagated accounted spend (onSpend, review-debt #186).
import { describe, expect, test, vi } from 'vitest';
import { currentJobContext } from '../../src/kernel/governor.js';
import { completeWorker, defaultWorld, fixLine, NEW_SHA, runLoop } from './review-loop.helpers.js';

// ---------------------------------------------------------------------------
// The fix-run wall-clock ladder (CodeRabbit KyE, review-debt #137)
// ---------------------------------------------------------------------------

describe('the fix-run wall-clock ladder (opts.limits → the governor)', () => {
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
      await vi.advanceTimersByTimeAsync(20);
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
