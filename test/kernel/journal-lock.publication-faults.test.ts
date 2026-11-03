// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds publication faults: NFS retransmitted claim and publication links
// reporting EEXIST, a publication rename that fails (claim abandoned), and a
// rename that reports failure after it published. Sibling subjects:
// journal-lock.exclusion.test.ts, journal-lock.claims.test.ts,
// journal-lock.guard.test.ts, journal-lock.compromise.test.ts,
// journal-lock.corruption.test.ts, journal-lock.artifacts.test.ts,
// journal-lock.recovery.test.ts; shared fixtures live in journal-lock.helpers.ts.
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import { expect, test, vi } from 'vitest';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import { directory, lockHarness, record } from './journal-lock.helpers.js';

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

test('a retransmitted claim link reporting EEXIST for our own claim publishes, not refuses', async () => {
  const dir = await directory();
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  // NFS: the claim link succeeded, its reply was lost, and the retransmit
  // reports EEXIST. The claim already holds our own (synced) record.
  hooks.beforeClaim = async (temporary, claim) => {
    hooks.beforeClaim = undefined;
    await writeFile(claim, await readFile(temporary));
  };
  const lease = await acquirePlanLock(dir, 'locked', 'retransmit');
  try {
    await lease.assertHeld();
    const held = await record(dir);
    expect(held).toMatchObject({ runId: 'retransmit' });
    const claims = (await readdir(dir)).filter((name) => name.endsWith('.claim'));
    expect(claims).toHaveLength(1);
    expect(JSON.parse(await readFile(join(dir, claims[0] ?? ''), 'utf8'))).toEqual(held);
  } finally {
    await lease.release();
  }
});

test('a retransmitted publication link reporting EEXIST for our own record publishes, not refuses', async () => {
  const dir = await directory();
  // NFS: the first link published our record, its reply was lost, and the
  // retransmit reports EEXIST. The canonical record is already ours.
  hooks.beforePublish = async (temporary, path) => {
    hooks.beforePublish = undefined;
    await writeFile(path, await readFile(temporary));
  };
  const lease = await acquirePlanLock(dir, 'locked', 'retransmit');
  try {
    await lease.assertHeld();
    expect(await record(dir)).toMatchObject({ runId: 'retransmit' });
    expect((await readdir(dir)).filter((name) => name.endsWith('.claim'))).toEqual([]);
  } finally {
    await lease.release();
  }
  expect(await record(dir)).toMatchObject({ runId: 'retransmit', released: true });
});

/** Fault the next publication rename onto the canonical record only. */
function faultNextPublication(fault: (from: string, to: string) => Promise<void>): void {
  hooks.beforeRename = async (from, to) => {
    if (!to.endsWith('.lock.json')) return;
    hooks.beforeRename = undefined;
    await fault(from, to);
  };
}

test('a claimant whose publication rename fails abandons its claim, so a same-process retry succeeds it', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await record(dir);
  const priorBytes = await readFile(path, 'utf8');
  faultNextPublication(() =>
    Promise.reject(Object.assign(new Error('injected rename fault'), { code: 'EIO' })),
  );
  await expect(acquirePlanLock(dir, 'locked', 'faulted')).rejects.toMatchObject({ code: 'EIO' });
  expect(await readFile(path, 'utf8')).toBe(priorBytes);
  const claim = `${path}.${String(prior.nonce)}.claim`;
  const abandoned = JSON.parse(await readFile(claim, 'utf8')) as Record<string, unknown>;
  // Still this live process's claim, marked released by its claimant: it
  // never published and never will.
  expect(abandoned).toMatchObject({ runId: 'faulted', pid: process.pid, released: true });
  expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  const lease = await acquirePlanLock(dir, 'locked', 'retry');
  try {
    await lease.assertHeld();
    expect(await record(dir)).toMatchObject({ runId: 'retry' });
    expect(
      JSON.parse(await readFile(`${path}.${String(abandoned.nonce)}.claim`, 'utf8')),
    ).toMatchObject({ runId: 'retry' });
    expect(JSON.parse(await readFile(claim, 'utf8'))).toEqual(abandoned);
  } finally {
    await lease.release();
  }
});

test('a publication rename reporting failure after it published us succeeds, not abandons', async () => {
  const dir = await directory();
  const path = join(dir, 'locked.lock.json');
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const prior = await record(dir);
  // NFS: the rename published our record, and its retransmit reports ENOENT.
  faultNextPublication(async (from, to) => {
    await rename(from, to);
    throw Object.assign(new Error('retransmitted rename'), { code: 'ENOENT' });
  });
  const lease = await acquirePlanLock(dir, 'locked', 'landed');
  try {
    await lease.assertHeld();
    expect(await record(dir)).toMatchObject({ runId: 'landed' });
    // We own the plan: the claim on the seed stays live.
    expect(
      JSON.parse(await readFile(`${path}.${String(prior.nonce)}.claim`, 'utf8')),
    ).not.toHaveProperty('released');
  } finally {
    await lease.release();
  }
});
