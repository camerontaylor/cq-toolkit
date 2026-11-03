// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds succession claims: racing reclaimers, a stale judgment walking the
// claim chain, a claimant that died between claim and publication, and a
// superseded claimant whose process lives on. Sibling subjects:
// journal-lock.exclusion.test.ts, journal-lock.publication-faults.test.ts,
// journal-lock.guard.test.ts, journal-lock.compromise.test.ts,
// journal-lock.corruption.test.ts, journal-lock.artifacts.test.ts,
// journal-lock.recovery.test.ts; shared fixtures live in journal-lock.helpers.ts.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import { expect, test, vi } from 'vitest';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import {
  CHILD_STEP_MS,
  directory,
  gateNextClaim,
  lockHarness,
  record,
  start,
} from './journal-lock.helpers.js';

// Event gates only: the guard library and the filesystem run for real; the
// hooks observe its options and pause at named publication points.
const hooks = vi.hoisted(() => ({
  guardAcquired: undefined as ((options: LockOptions) => void) | undefined,
  beforeClaim: undefined as ((temporary: string, claim: string) => Promise<void>) | undefined,
  beforePublish: undefined as ((temporary: string, path: string) => Promise<void>) | undefined,
  beforeRename: undefined as ((from: string, to: string) => Promise<void>) | undefined,
  afterPublication: undefined as (() => void) | undefined,
}));
vi.mock('proper-lockfile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('proper-lockfile')>();
  return {
    ...actual,
    async lock(file: string, options?: LockOptions) {
      const release = await actual.lock(file, options);
      hooks.guardAcquired?.(options ?? {});
      return release;
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async link(...args: Parameters<typeof actual.link>) {
      // A succession claim: eligibility has been decided, nothing published.
      if (
        typeof args[0] === 'string' &&
        typeof args[1] === 'string' &&
        args[1].endsWith('.claim')
      ) {
        await hooks.beforeClaim?.(args[0], args[1]);
      }
      // An exclusive first publication of the canonical record.
      if (
        typeof args[0] === 'string' &&
        typeof args[1] === 'string' &&
        args[1].endsWith('.lock.json')
      ) {
        await hooks.beforePublish?.(args[0], args[1]);
      }
      await actual.link(...args);
    },
    async rename(...args: Parameters<typeof actual.rename>) {
      if (typeof args[0] === 'string' && typeof args[1] === 'string') {
        await hooks.beforeRename?.(args[0], args[1]);
      }
      await actual.rename(...args);
    },
    async open(...args: Parameters<typeof actual.open>) {
      const handle = await actual.open(...args);
      // The post-publication owner handle: the record is canonical.
      if (typeof args[0] === 'string' && args[0].endsWith('.lock.json') && args[1] === 'r+') {
        hooks.afterPublication?.();
      }
      return handle;
    },
  };
});

lockHarness(hooks);

// Enclosure: seed plus two independently booted reclaimers (parallel, conservatively summed).
test(
  'racing reclaimers fence by nonce and stale release cannot clobber the winner',
  async () => {
    const dir = await directory();
    const seed = await acquirePlanLock(dir, 'locked', 'seed');
    await seed.release();
    const contenders = [
      start(dir, 'one', { J_TEST_RACE: 'yes' }),
      start(dir, 'two', { J_TEST_RACE: 'yes' }),
    ];
    expect(await Promise.all(contenders.map((worker) => worker.next()))).toEqual([
      { status: 'waiting' },
      { status: 'waiting' },
    ]);
    for (const worker of contenders) worker.child.stdin.write('go\n');
    const acquired = await Promise.all(contenders.map((worker) => worker.next()));
    const seqs = acquired
      .filter((message) => message.status === 'acquired')
      .map((message) => message.seq);
    expect(seqs).toHaveLength(1); // exclusion, not merely eventual nonce convergence
    expect(new Set(seqs).size).toBe(seqs.length);
    const winner = await record(dir);
    const statuses = await Promise.all(
      contenders.map(async (worker, index) => {
        if (acquired[index]?.status !== 'acquired') return 'refused';
        worker.child.stdin.write('check\n');
        return (await worker.next()).status;
      }),
    );
    expect(statuses.filter((status) => status === 'held')).toHaveLength(1);
    for (const [index, worker] of contenders.entries()) {
      if (statuses[index] !== 'lost') continue;
      worker.child.stdin.write('release\n');
      expect((await worker.next()).status).toBe('released');
      expect((await record(dir)).nonce).toBe(winner.nonce);
      expect(await record(dir)).not.toHaveProperty('released');
    }
    for (const [index, worker] of contenders.entries()) {
      if (statuses[index] !== 'held') continue;
      worker.child.stdin.write('release\n');
      expect((await worker.next()).status).toBe('released');
    }
  },
  3 * CHILD_STEP_MS,
);

test('a stale judgment walks the succession past a released claimant instead of replacing blindly', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await record(dir);
  const gate = gateNextClaim(hooks);
  const late = acquirePlanLock(dir, 'locked', 'late');
  void late.catch(() => undefined); // observed below
  try {
    await gate.judged;
    // While the late acquirer's judgment of the seed is stale, another run
    // claimed the seed, owned the plan, and released. Built as data: no
    // guard ageing or second process, so no refresh timer is raced.
    const between = {
      nonce: randomUUID(),
      socketPath: '/tmp/no-such-cq-j.sock',
      pid: process.pid, // alive: only its released tombstone permits succession
      host: prior.host,
      bootId: prior.bootId,
      runId: 'between',
    };
    await writeFile(`${path}.${String(prior.nonce)}.claim`, JSON.stringify(between));
    await writeFile(path, JSON.stringify({ ...between, released: true }));
    gate.resume();
    // The seed's claim names 'between', whose canonical record is its
    // released tombstone: the late acquirer succeeds IT, by its own claim.
    const lease = await late;
    try {
      await lease.assertHeld();
      expect(await record(dir)).toMatchObject({ runId: 'late' });
      expect(JSON.parse(await readFile(`${path}.${between.nonce}.claim`, 'utf8'))).toMatchObject({
        runId: 'late',
      });
    } finally {
      await lease.release();
    }
  } finally {
    gate.resume();
    await late.catch(() => undefined);
  }
});

test('a claimant that died between claim and publication is succeeded, not wedged', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await record(dir);
  // A crashed reclaimer: its claim on the seed exists, its record was never
  // published, and its pid/socket are dead on this host.
  const crashed = {
    nonce: randomUUID(),
    socketPath: '/tmp/no-such-cq-j.sock',
    pid: 2147483647,
    host: prior.host,
    bootId: prior.bootId,
    runId: 'crashed',
  };
  await writeFile(`${path}.${String(prior.nonce)}.claim`, JSON.stringify(crashed));
  const lease = await acquirePlanLock(dir, 'locked', 'recovered');
  try {
    await lease.assertHeld();
    expect(await record(dir)).toMatchObject({ runId: 'recovered' });
    expect(JSON.parse(await readFile(`${path}.${crashed.nonce}.claim`, 'utf8'))).toMatchObject({
      runId: 'recovered',
    });
  } finally {
    await lease.release();
  }
});

test('a stale judgment follows a successor claim past a superseded claimant whose process lives on', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await record(dir);
  const gate = gateNextClaim(hooks);
  const late = acquirePlanLock(dir, 'locked', 'late');
  void late.catch(() => undefined); // observed below
  try {
    await gate.judged;
    // While the late judgment is stale, the chain advanced two steps:
    // 'superseded' claimed the seed and was itself claimed by 'successor',
    // whose released tombstone is canonical. Both pids are alive (ours), so
    // a probe of 'superseded' would refuse; its successor claim proves it can
    // never own again.
    const owner = (runId: string): Record<string, unknown> & { nonce: string } => ({
      nonce: randomUUID(),
      socketPath: '/tmp/no-such-cq-j.sock',
      pid: process.pid,
      host: prior.host,
      bootId: prior.bootId,
      runId,
    });
    const superseded = owner('superseded');
    const successor = owner('successor');
    await writeFile(`${path}.${String(prior.nonce)}.claim`, JSON.stringify(superseded));
    await writeFile(`${path}.${superseded.nonce}.claim`, JSON.stringify(successor));
    await writeFile(path, JSON.stringify({ ...successor, released: true }));
    gate.resume();
    const lease = await late;
    try {
      await lease.assertHeld();
      expect(await record(dir)).toMatchObject({ runId: 'late' });
      expect(JSON.parse(await readFile(`${path}.${successor.nonce}.claim`, 'utf8'))).toMatchObject({
        runId: 'late',
      });
      expect(JSON.parse(await readFile(`${path}.${String(prior.nonce)}.claim`, 'utf8'))).toEqual(
        superseded,
      );
    } finally {
      await lease.release();
    }
  } finally {
    gate.resume();
    await late.catch(() => undefined);
  }
});
