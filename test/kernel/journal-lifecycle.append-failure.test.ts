// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
//
// Split provenance: test/kernel/journal-lifecycle.test.ts was split into
// journal-lifecycle.{append-failure,body-entry,fixture-cleanup,ladder,lock-publication,quarantine}.test.ts
// plus journal-lifecycle.helpers.ts (pure move).

import { expect, test, vi } from 'vitest';
import { createGovernor, currentJobContext } from '../../src/kernel/governor.js';
import { acquirePlanLock, openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import type { JournalEvent } from '../../src/kernel/types.js';
import {
  awaitStage,
  deferred,
  directory,
  events,
  journalEnclosure,
  plan,
  registerJournalFixtureCleanup,
  registry,
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

test.each(['worker', 'replay-producer'] as const)(
  '%s append failure drains submitted jobs before releasing the plan lease',
  async (failureSite) => {
    const dir = await directory();
    const injected = new Error(`failed ${failureSite} append`);
    const siblingStarted = deferred();
    const releaseSibling = deferred();
    const failureSeen = deferred();
    const calls: string[] = [];
    if (failureSite === 'replay-producer') {
      const manifest = makeManifest(plan);
      const replayJob = manifest.jobs.find((job) => job.id === 'b');
      if (replayJob === undefined) throw new Error('missing replay fixture job');
      const log = openRunLog(dir);
      const runId = 'journal-stop--1--a';
      await log.append(runId, {
        type: 'run-started',
        runId,
        planId: plan.id,
        at: '2026-01-01T00:00:00Z',
      });
      await log.append(runId, {
        type: 'job-finished',
        runId,
        at: '2026-01-01T00:00:01Z',
        jobId: 'b',
        opId: 'work',
        inputsHash: replayJob.inputsHash,
        result: { status: 'ok', value: 'b' },
      });
    }
    const failedJob = failureSite === 'worker' ? 'a' : 'b';
    hooks.before = async (event) => {
      if (event.type === 'job-finished' && event.jobId === failedJob) {
        await siblingStarted.promise;
        failureSeen.resolve();
        throw injected;
      }
    };
    let settled = false;
    const running = runPlan(
      plan,
      { concurrency: 2, stopOnError: false, journalDir: dir, resume: true },
      registry(async (id) => {
        calls.push(id);
        if (id === (failureSite === 'worker' ? 'b' : 'a')) {
          siblingStarted.resolve();
          await releaseSibling.promise;
        }
        return { status: 'ok', value: id };
      }),
    ).then(
      (report) => {
        settled = true;
        return report;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    try {
      await awaitStage(failureSeen.promise, running, 'append failure');
      await expect(acquirePlanLock(dir, plan.id, 'contender')).rejects.toThrow('plan locked');
      expect(settled).toBe(false);
    } finally {
      releaseSibling.resolve();
    }
    expect(await running).toBe(injected);
    expect(calls).toEqual(failureSite === 'worker' ? ['a', 'b'] : ['a']);
    expect((await events(dir)).some((event) => event.type === 'run-finished')).toBe(false);
    const next = await acquirePlanLock(dir, plan.id, 'next');
    await next.release();
  },
  journalEnclosure(3),
);

test(
  'failed durable reservation append stops queued work and frees reservation and held slot',
  async () => {
    const dir = await directory();
    const injected = new Error('reservation append failed');
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 10 });
    hooks.before = async (event) => {
      if (event.type === 'reservation-opened') throw injected;
    };
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        registry(async (id) => {
          calls.push(id);
          return { status: 'ok', value: id };
        }),
        { governor, allowAdvisory: true },
      ),
    ).rejects.toBe(injected);
    expect(calls).toEqual([]);
    expect(governor.outstandingCount).toBe(0);
    expect(governor.inFlight).toBe(0);
    expect(governor.tripped).toBe(true);
    expect((await events(dir)).some((event) => event.type === 'run-finished')).toBe(false);
  },
  journalEnclosure(1),
);

test(
  'settlement append failure aborts and drains its admitted sibling with full settlement',
  async () => {
    const dir = await directory();
    const injected = new Error('settlement append failed');
    const siblingStarted = deferred();
    const governor = createGovernor({ maxUsd: 10 });
    const calls: string[] = [];
    let aborted = false;
    hooks.before = async (event) => {
      if (event.type === 'reservation-settled' && event.jobId === 'a') throw injected;
    };
    await expect(
      runPlan(
        plan,
        { concurrency: 2, stopOnError: false, journalDir: dir },
        registry(async (id) => {
          calls.push(id);
          if (id === 'a') {
            await siblingStarted.promise;
            return { status: 'ok', value: id };
          }
          const context = currentJobContext();
          if (context === undefined) throw new Error('missing governed job context');
          await new Promise<void>((resolve) => {
            context.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
            siblingStarted.resolve();
          });
          return {
            status: 'indeterminate',
            detail: 'journal failure cancelled the admitted sibling',
          };
        }),
        { governor, allowAdvisory: true },
      ),
    ).rejects.toBe(injected);
    expect(calls).toEqual(['a', 'b']);
    expect(aborted).toBe(true);
    expect(governor.outstandingCount).toBe(0);
    expect(governor.inFlight).toBe(0);
    expect((await events(dir)).filter((event) => event.type === 'reservation-settled')).toEqual([
      expect.objectContaining({ jobId: 'b', basis: 'full', charged: 5 }),
    ]);
  },
  journalEnclosure(1),
);
