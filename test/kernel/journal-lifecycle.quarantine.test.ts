// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
//
// Split provenance: test/kernel/journal-lifecycle.test.ts was split into
// journal-lifecycle.{append-failure,body-entry,fixture-cleanup,ladder,lock-publication,quarantine}.test.ts
// plus journal-lifecycle.helpers.ts (pure move).

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { createGovernor } from '../../src/kernel/governor.js';
import type { JournalEvent, Plan } from '../../src/kernel/types.js';
import {
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

test(
  'lost nonce leaves write-ahead unresolved, loss-charged and quarantined until explicit release',
  async () => {
    const dir = await directory();
    const calls: string[] = [];
    const governor = createGovernor({ maxUsd: 10 });
    const rivalNonce = randomUUID();
    const lockPath = join(dir, `${plan.id}.lock.json`);
    const dependentPlan: Plan = {
      id: plan.id,
      jobs: [
        { id: 'a', op: 'work', input: { id: 'a' } },
        { id: 'dependent', op: 'work', input: { id: 'dependent' }, dependsOn: ['a'] },
      ],
    };
    const view = registry(async (id) => {
      calls.push(id);
      return { status: 'ok', value: id };
    });
    hooks.after = async (event) => {
      if (event.type !== 'reservation-opened') return;
      const record = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
      const replacement = `${lockPath}.replacement`;
      await writeFile(
        replacement,
        JSON.stringify({ ...record, nonce: rivalNonce, runId: 'rival' }),
      );
      await rename(replacement, lockPath);
    };
    await expect(
      runPlan(dependentPlan, { concurrency: 2, stopOnError: false, journalDir: dir }, view, {
        governor,
        allowAdvisory: true,
      }),
    ).rejects.toThrow('lock-lost');
    expect(calls).toEqual([]);
    expect(governor.outstandingCount).toBe(0);
    expect(governor.inFlight).toBe(0);
    expect(governor.usdSpent).toBe(0); // local capacity is abandoned; durable loss charges on fold
    expect((await events(dir)).filter((event) => event.type === 'reservation-settled')).toEqual([]);
    expect((await events(dir)).filter((event) => event.type === 'reservation-opened')).toEqual([
      expect.objectContaining({ jobId: 'a', usd: 5 }),
    ]);
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ nonce: rivalNonce });
    expect(JSON.parse(await readFile(lockPath, 'utf8'))).not.toHaveProperty('released');
    hooks.after = undefined;
    // Simulate the rival's explicit release, without rewriting journal facts.
    const rival = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    await writeFile(lockPath, JSON.stringify({ ...rival, released: true }));
    const resumed = createGovernor({ maxUsd: 10 });
    const report = await runPlan(
      dependentPlan,
      { concurrency: 2, stopOnError: false, journalDir: dir, resume: true },
      view,
      { governor: resumed, allowAdvisory: true },
    );
    expect(calls).toEqual([]);
    expect(resumed.usdSpent).toBe(5);
    expect(report.jobs[0]?.result.status).toBe('needs-human');
    expect(report.jobs[1]?.result).toMatchObject({ status: 'failed' });
    expect(report.counts.blocked).toBe(2);
    expect(
      (await events(dir)).some((event) => event.type === 'job-quarantined' && event.jobId === 'a'),
    ).toBe(true);
    const released = createGovernor({ maxUsd: 10 });
    const releasedReport = await runPlan(
      dependentPlan,
      { concurrency: 2, stopOnError: false, journalDir: dir, resume: true },
      view,
      { governor: released, allowAdvisory: true, releaseQuarantine: ['a'] },
    );
    expect(calls).toEqual(['a', 'dependent']);
    expect(released.usdSpent).toBe(5);
    expect(releasedReport.counts.done).toBe(2);
    expect(
      (await events(dir)).some(
        (event) => event.type === 'quarantine-released' && event.jobId === 'a',
      ),
    ).toBe(true);
  },
  journalEnclosure(3),
);
