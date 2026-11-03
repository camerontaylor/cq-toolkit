// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
//
// Split provenance: test/kernel/journal-lifecycle.test.ts was split into
// journal-lifecycle.{append-failure,body-entry,fixture-cleanup,ladder,lock-publication,quarantine}.test.ts
// plus journal-lifecycle.helpers.ts (pure move).

import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import type { JournalEvent } from '../../src/kernel/types.js';
import {
  awaitStage,
  deferred,
  directory,
  journalEnclosure,
  plan,
  registerJournalFixtureCleanup,
  registry,
  runPlan,
  settleFixtureWork,
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

// Positive cleanup control: a writer paused in an op must finish its durable
// tail while the directory exists. This verifies fixture ordering, not the
// historical ENOENT's cause (the old trace did not identify that writer).
test(
  'fixture cleanup drains a paused writer before deleting its journal',
  async () => {
    const dir = await directory();
    const entered = deferred();
    const finish = deferred();
    let tailWritten = false;
    hooks.after = async (event) => {
      if (event.type === 'run-finished') {
        expect(await readFile(join(dir, `${event.runId}.ndjson`), 'utf8')).toContain(
          'run-finished',
        );
        tailWritten = true;
      }
    };
    const running = runPlan(
      { id: plan.id, jobs: [{ id: 'a', op: 'work', input: { id: 'a' } }] },
      { concurrency: 1, stopOnError: false, journalDir: dir },
      registry(async () => {
        entered.resolve();
        await finish.promise;
        return { status: 'ok', value: 'a' };
      }),
    );
    await awaitStage(entered.promise, running, 'cleanup control body entry');
    expect(tailWritten).toBe(false);
    await settleFixtureWork();
    await running;
    expect(tailWritten).toBe(true);
    await rm(dir, { recursive: true, force: true });
  },
  journalEnclosure(1),
);
