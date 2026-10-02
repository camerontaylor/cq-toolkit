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

const directories: string[] = [];
afterEach(async () => {
  hooks.before = undefined;
  hooks.after = undefined;
  hooks.beforePublication = undefined;
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

test('lost nonce leaves write-ahead unresolved, loss-charged and quarantined until explicit release', async () => {
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
    await writeFile(replacement, JSON.stringify({ ...record, nonce: rivalNonce, runId: 'rival' }));
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

test('atomic publication exclusion prevents a late reclaimer while a plain owner dispatches', async () => {
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
    // but the owning publisher has not renamed it yet.
    await publicationPaused.promise;
    await expect(acquirePlanLock(dir, plan.id, 'late-reclaimer')).rejects.toThrow(
      'acquisition in progress',
    );
    expect(calls).toEqual([]);
    publish.resolve();
    await bodyStarted.promise;
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
});

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
      await stopSeen.promise;
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
    await parked.promise;
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
);

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

test('closed ladder cannot invoke a resumed importer while a sibling holds the lease', async () => {
  const dir = await directory();
  const parked = deferred();
  const resume = deferred();
  const firstSettled = deferred();
  const siblingStarted = deferred();
  const finishSibling = deferred();
  const calls: string[] = [];
  const clock = ladderClock();
  const governor = createGovernor(
    { maxUsd: 10, perJobWallClockMs: 10, abortGraceMs: 1, killGraceMs: 1 },
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
    await parked.promise;
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
});
