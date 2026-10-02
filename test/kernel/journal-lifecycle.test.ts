// W2.4: no wave outlives its lease, and an emit failure stops dispatch.
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { createGovernor, currentJobContext } from '../../src/kernel/governor.js';
import { acquirePlanLock, openRunLog } from '../../src/kernel/journal.js';
import { makeManifest } from '../../src/kernel/manifest.js';
import { runPlan, type OpRegistryView } from '../../src/kernel/runner.js';
import type { JournalEvent, Op, OpRegistryEntry, OpResult, Plan } from '../../src/kernel/types.js';

const hooks = vi.hoisted(() => ({
  before: undefined as ((event: JournalEvent) => Promise<void>) | undefined,
  after: undefined as ((event: JournalEvent) => Promise<void>) | undefined,
}));
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

const directories: string[] = [];
afterEach(async () => {
  hooks.before = undefined;
  hooks.after = undefined;
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function directory(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-j-lifecycle-'));
  directories.push(dir);
  return dir;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const plan: Plan = {
  id: 'journal-stop',
  jobs: ['a', 'b', 'c'].map((id) => ({ id, op: 'work', input: { id } })),
};
function registry(op: (id: string) => Promise<OpResult<unknown>>): OpRegistryView {
  const candidate: OpRegistryEntry<never, never> = {
    name: 'work',
    inputSchema: z.object({ id: z.string() }) as unknown as z.ZodType<never>,
    importer: () =>
      Promise.resolve(((raw: { id: string }) => op(raw.id)) as unknown as Op<never, never>),
  };
  return { get: () => candidate };
}
async function events(dir: string): Promise<JournalEvent[]> {
  const log = openRunLog(dir);
  return (await Promise.all((await log.runs()).map((id) => log.read(id)))).flat();
}

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
      await failureSeen.promise;
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
);

test('failed durable reservation append stops queued work and frees reservation and held slot', async () => {
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
});

test('lost nonce after durable write-ahead prevents invocation and settles full without clobbering rival', async () => {
  const dir = await directory();
  const calls: string[] = [];
  const governor = createGovernor({ maxUsd: 10 });
  const rivalNonce = randomUUID();
  const lockPath = join(dir, `${plan.id}.lock.json`);
  hooks.after = async (event) => {
    if (event.type !== 'reservation-opened') return;
    const record = JSON.parse(await readFile(lockPath, 'utf8')) as Record<string, unknown>;
    const replacement = `${lockPath}.replacement`;
    await writeFile(replacement, JSON.stringify({ ...record, nonce: rivalNonce, runId: 'rival' }));
    await rename(replacement, lockPath);
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
  ).rejects.toThrow('lock-lost');
  expect(calls).toEqual([]);
  expect(governor.outstandingCount).toBe(0);
  expect(governor.inFlight).toBe(0);
  expect(governor.usdSpent).toBe(10);
  expect((await events(dir)).filter((event) => event.type === 'reservation-settled')).toEqual([
    expect.objectContaining({ basis: 'full', charged: 10 }),
  ]);
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).toMatchObject({ nonce: rivalNonce });
  expect(JSON.parse(await readFile(lockPath, 'utf8'))).not.toHaveProperty('released');
});

test('settlement append failure aborts and drains its admitted sibling with full settlement', async () => {
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
});

test('fold corruption releases the lease before rejecting and distinct plans can hold separate leases', async () => {
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
});
