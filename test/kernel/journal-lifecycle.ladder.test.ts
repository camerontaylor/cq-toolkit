// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
//
// Split provenance: test/kernel/journal-lifecycle.test.ts was split into
// journal-lifecycle.{append-failure,body-entry,fixture-cleanup,ladder,lock-publication,quarantine}.test.ts
// plus journal-lifecycle.helpers.ts (pure move).

import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor } from '../../src/kernel/governor.js';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import type { JournalEvent, Op, OpRegistryEntry } from '../../src/kernel/types.js';
import {
  awaitStage,
  cleanupActions,
  deferred,
  directory,
  events,
  journalEnclosure,
  plan,
  registerJournalFixtureCleanup,
  runPlan,
} from './journal-lifecycle.helpers.js';

const hooks = vi.hoisted(() => ({
  before: undefined as ((event: JournalEvent) => Promise<void>) | undefined,
  after: undefined as ((event: JournalEvent) => Promise<void>) | undefined,
  beforePublication: undefined as (() => Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async rename(...args: Parameters<typeof actual.rename>) {
      if (
        typeof args[0] === 'string' &&
        args[0].endsWith('.tmp') &&
        typeof args[1] === 'string' &&
        args[1].endsWith('.lock.json')
      ) {
        await hooks.beforePublication?.();
      }
      await actual.rename(...args);
    },
  };
});
vi.mock('../../src/kernel/journal.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/kernel/journal.js')>();
  return {
    ...actual,
    openRunLog(dir: string) {
      const log = actual.openRunLog(dir);
      return {
        ...log,
        async append(...args: Parameters<typeof log.append>) {
          await hooks.before?.(args[1]);
          await log.append(...args);
          await hooks.after?.(args[1]);
        },
      };
    },
  };
});
registerJournalFixtureCleanup(hooks);

// Advance only ladder time; deferred imports and durable append barriers
// determine the schedule independently of host timers.
function ladderClock() {
  let now = 0;
  let ordinal = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimeout(fn: () => void, ms: number): unknown {
      const id = ++ordinal;
      pending.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimeout(handle: unknown): void {
      pending.delete(handle as number);
    },
    advance(ms: number): void {
      const end = now + ms;
      for (;;) {
        const next = [...pending.entries()]
          .filter(([, timer]) => timer.at <= end)
          .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
        if (next === undefined) break;
        pending.delete(next[0]);
        now = next[1].at;
        next[1].fn();
      }
      now = end;
    },
  };
}

test(
  'closed ladder cannot invoke a resumed importer while a sibling holds the lease',
  async () => {
    const dir = await directory();
    const parked = deferred();
    const resume = deferred();
    const firstSettled = deferred();
    const siblingStarted = deferred();
    const finishSibling = deferred();
    const calls: string[] = [];
    const clock = ladderClock();
    cleanupActions.add(() => clock.advance(10_000));
    const governor = createGovernor(
      { maxUsd: 10, inFlightCeiling: 2, perJobWallClockMs: 10, abortGraceMs: 1, killGraceMs: 1 },
      clock,
    );
    hooks.before = async (event) => {
      if (event.type === 'job-started' && event.jobId === 'b') await firstSettled.promise;
    };
    hooks.after = async (event) => {
      if (event.type === 'reservation-settled' && event.jobId === 'a') firstSettled.resolve();
    };
    const entry = (id: string): OpRegistryEntry<never, never> => ({
      name: id,
      inputSchema: z.object({ id: z.string() }) as unknown as z.ZodType<never>,
      importer: async () => {
        if (id === 'a') {
          parked.resolve();
          await resume.promise;
        }
        return (async () => {
          calls.push(id);
          if (id === 'b') {
            siblingStarted.resolve();
            await finishSibling.promise;
          }
          return { status: 'ok', value: id };
        }) as unknown as Op<never, never>;
      },
    });
    const entries = new Map(['a', 'b'].map((id) => [id, entry(id)]));
    const running = runPlan(
      { id: plan.id, jobs: ['a', 'b'].map((id) => ({ id, op: id, input: { id } })) },
      { concurrency: 2, stopOnError: false, journalDir: dir },
      { get: (name) => entries.get(name) },
      { governor, allowAdvisory: true },
    );
    try {
      await awaitStage(parked.promise, running, 'importer parked');
      clock.advance(12);
      await siblingStarted.promise;
      expect(governor.inFlight).toBe(1);
      expect(governor.outstandingCount).toBe(1);
      resume.resolve();
      // Drain the detached import continuation while the sibling retains its
      // reservation/slot and the plan lease, rather than relying on lease loss.
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(calls).toEqual(['b']);
      await expect(acquirePlanLock(dir, plan.id, 'contender')).rejects.toThrow('plan locked');
      expect(governor.tripped).toBe(false);
    } finally {
      resume.resolve();
      finishSibling.resolve();
    }
    const report = await running;
    expect(report.jobs.find((job) => job.jobId === 'a')?.result.status).toBe('budget-exhausted');
    expect(report.jobs.find((job) => job.jobId === 'b')?.result.status).toBe('ok');
    expect(governor.inFlight).toBe(0);
    expect(governor.outstandingCount).toBe(0);
    expect((await events(dir)).filter((event) => event.type === 'reservation-settled')).toEqual([
      expect.objectContaining({ jobId: 'a', charged: 5, basis: 'full' }),
      expect.objectContaining({ jobId: 'b', charged: 0, basis: 'observed' }),
    ]);
  },
  journalEnclosure(2),
);
