// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
//
// Split provenance: test/kernel/journal-lifecycle.test.ts was split into
// journal-lifecycle.{append-failure,body-entry,fixture-cleanup,ladder,lock-publication,quarantine}.test.ts
// plus journal-lifecycle.helpers.ts (pure move).

import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import type { JournalEvent, Plan } from '../../src/kernel/types.js';
import {
  awaitStage,
  deferred,
  directory,
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

test(
  'fold corruption releases the lease before rejecting and distinct plans can hold separate leases',
  async () => {
    const dir = await directory();
    await writeFile(join(dir, 'journal-stop--1--a.ndjson'), '{corrupt}\n');
    await expect(
      runPlan(
        plan,
        { concurrency: 1, stopOnError: false, journalDir: dir },
        registry(async () => ({ status: 'ok', value: 1 })),
      ),
    ).rejects.toThrow();
    const owner = await acquirePlanLock(dir, plan.id, 'next');
    try {
      const otherPlan = await acquirePlanLock(dir, 'other-plan', 'parallel');
      await otherPlan.release();
      await owner.assertHeld();
    } finally {
      await owner.release();
    }
  },
  journalEnclosure(3),
);

test(
  'atomic publication exclusion prevents a late reclaimer while a plain owner dispatches',
  async () => {
    const dir = await directory();
    const seed = await acquirePlanLock(dir, plan.id, 'seed');
    await seed.release();
    const publicationPaused = deferred();
    const publish = deferred();
    const bodyStarted = deferred();
    const finishBody = deferred();
    hooks.beforePublication = async () => {
      publicationPaused.resolve();
      await publish.promise;
    };
    const oneJob: Plan = { id: plan.id, jobs: plan.jobs.slice(0, 1) };
    const calls: string[] = [];
    const running = runPlan(
      oneJob,
      { concurrency: 1, stopOnError: false, journalDir: dir },
      registry(async (id) => {
        calls.push(id);
        bodyStarted.resolve();
        await finishBody.promise;
        return { status: 'ok', value: id };
      }),
    );
    try {
      // Eligibility has been decided and the complete replacement is ready,
      // but the owning publisher has not renamed it yet (its succession
      // claim is made): its live guard lease refuses the late reclaimer.
      await awaitStage(publicationPaused.promise, running, 'publication pause');
      await expect(acquirePlanLock(dir, plan.id, 'late-reclaimer')).rejects.toThrow(
        'acquisition in progress',
      );
      expect(calls).toEqual([]);
      publish.resolve();
      await awaitStage(bodyStarted.promise, running, 'body entry');
      await expect(
        runPlan(
          oneJob,
          { concurrency: 1, stopOnError: false, journalDir: dir },
          registry(async (id) => {
            calls.push(`duplicate-${id}`);
            return { status: 'ok', value: id };
          }),
        ),
      ).rejects.toThrow('plan locked');
      expect(calls).toEqual(['a']);
    } finally {
      publish.resolve();
      finishBody.resolve();
      await running;
    }
  },
  journalEnclosure(4),
);
