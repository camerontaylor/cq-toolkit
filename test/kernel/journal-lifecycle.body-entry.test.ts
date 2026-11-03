// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
//
// Split provenance: test/kernel/journal-lifecycle.test.ts was split into
// journal-lifecycle.{append-failure,body-entry,fixture-cleanup,ladder,lock-publication,quarantine}.test.ts
// plus journal-lifecycle.helpers.ts (pure move).

import { randomUUID } from 'node:crypto';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor } from '../../src/kernel/governor.js';
import type { JournalEvent, Op, OpRegistryEntry, Plan } from '../../src/kernel/types.js';
import {
  awaitStage,
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

const invocationCases = (['plain', 'capped', 'uncapped'] as const).flatMap((mode) =>
  (['import', 'validation'] as const).flatMap((pause) =>
    (['emit-failure', 'lost-fence'] as const).map((cause) => ({ mode, pause, cause })),
  ),
);
test.each(invocationCases)(
  '$mode/$pause/$cause guards the body after awaited preparation',
  async ({ mode, pause, cause }) => {
    const dir = await directory();
    const parked = deferred();
    const resume = deferred();
    const stopSeen = deferred();
    const injected = new Error('sibling emit failed during preparation');
    const calls: string[] = [];
    const twoJobs: Plan = {
      id: plan.id,
      jobs: ['a', 'b'].map((id) => ({ id, op: id, input: { id } })),
    };
    const schema = z.object({ id: z.string() });
    const op =
      (id: string): Op<unknown, unknown> =>
      async () => {
        calls.push(id);
        if (id === 'a') await parked.promise;
        return { status: 'ok', value: id };
      };
    const candidate = (id: string): OpRegistryEntry<never, never> => ({
      name: id,
      inputSchema: (id === 'b' && pause === 'validation'
        ? schema.superRefine(async () => {
            parked.resolve();
            await resume.promise;
          })
        : schema) as unknown as z.ZodType<never>,
      importer: async () => {
        if (id === 'b' && pause === 'import') {
          parked.resolve();
          await resume.promise;
        }
        return op(id) as unknown as Op<never, never>;
      },
    });
    const entries = new Map(['a', 'b'].map((id) => [id, candidate(id)]));
    hooks.before = async (event) => {
      if (cause === 'emit-failure' && event.type === 'job-finished' && event.jobId === 'a') {
        stopSeen.resolve();
        throw injected;
      }
    };
    hooks.after = async (event) => {
      if (cause !== 'lost-fence' || event.type !== 'job-finished' || event.jobId !== 'a') return;
      const path = join(dir, `${plan.id}.lock.json`);
      const current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
      const replacement = `${path}.replacement`;
      await writeFile(
        replacement,
        JSON.stringify({ ...current, nonce: randomUUID(), runId: 'rival' }),
      );
      await rename(replacement, path);
      stopSeen.resolve();
    };
    const governor =
      mode === 'plain' ? undefined : createGovernor(mode === 'capped' ? { maxUsd: 10 } : {});
    // Attach rejection handling immediately; release the parked preparation
    // only after the sibling's failing emit has crossed its microtask turn.
    const running = runPlan(
      twoJobs,
      { concurrency: 2, stopOnError: false, journalDir: dir },
      { get: (name) => entries.get(name) },
      governor === undefined ? undefined : { governor, allowAdvisory: true },
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    try {
      await awaitStage(stopSeen.promise, running, 'sibling stop');
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      resume.resolve();
    }
    const error = await running;
    if (cause === 'emit-failure') expect(error).toBe(injected);
    else {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain('lock-lost');
    }
    expect(calls).toEqual(['a']);
    expect((await events(dir)).some((event) => event.type === 'run-finished')).toBe(false);
    if (governor !== undefined) {
      expect(governor.tripped).toBe(true);
      expect(governor.inFlight).toBe(0);
      expect(governor.outstandingCount).toBe(0);
    }
    if (mode === 'capped') {
      expect(
        (await events(dir)).filter(
          (event) => event.type === 'reservation-opened' && event.jobId === 'b',
        ),
      ).toHaveLength(1);
      expect(
        (await events(dir)).filter(
          (event) => event.type === 'reservation-settled' && event.jobId === 'b',
        ),
      ).toHaveLength(0);
    }
  },
  journalEnclosure(1),
);

test.each(['capped', 'uncapped'] as const)(
  '%s canceled importer refuses body entry and settles normally',
  async (mode) => {
    const dir = await directory();
    const parked = deferred();
    const resume = deferred();
    const abort = new AbortController();
    const calls: string[] = [];
    const governor = createGovernor(mode === 'capped' ? { maxUsd: 10 } : {});
    const entry: OpRegistryEntry<never, never> = {
      name: 'work',
      inputSchema: z.object({ id: z.string() }) as unknown as z.ZodType<never>,
      importer: async () => {
        parked.resolve();
        await resume.promise;
        return (async () => {
          calls.push('a');
          return { status: 'ok', value: 'a' };
        }) as unknown as Op<never, never>;
      },
    };
    const running = runPlan(
      { id: plan.id, jobs: [{ id: 'a', op: 'work', input: { id: 'a' } }] },
      { concurrency: 1, stopOnError: false, journalDir: dir },
      { get: () => entry },
      { governor, signal: abort.signal, allowAdvisory: true },
    );
    await awaitStage(parked.promise, running, 'importer parked');
    abort.abort();
    resume.resolve();
    const report = await running;
    expect(calls).toEqual([]);
    expect(report.jobs[0]?.result.status).toBe('indeterminate');
    expect(governor.tripKind).toBe('signal');
    expect(governor.inFlight).toBe(0);
    expect(governor.outstandingCount).toBe(0);
    const journal = await events(dir);
    expect(journal.some((event) => event.type === 'run-finished')).toBe(true);
    if (mode === 'capped') {
      expect(journal.filter((event) => event.type === 'reservation-settled')).toEqual([
        expect.objectContaining({ jobId: 'a', charged: 10, basis: 'full' }),
      ]);
    }
  },
  journalEnclosure(1),
);
