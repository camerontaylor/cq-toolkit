// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds the acquisition guard lease: an interrupted publication guard, a
// SIGSTOP/SIGKILLed holder across the stale bound, a stale guard taken over by a
// new owner, and a guard fault that is not contention. Sibling subjects:
// journal-lock.exclusion.test.ts, journal-lock.claims.test.ts,
// journal-lock.publication-faults.test.ts, journal-lock.compromise.test.ts,
// journal-lock.corruption.test.ts, journal-lock.artifacts.test.ts,
// journal-lock.recovery.test.ts; shared fixtures live in journal-lock.helpers.ts.
import { mkdir, readFile, readdir, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import { expect, test, vi } from 'vitest';
import { PlanLockRefusedError } from '../../src/kernel/errors.js';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import {
  CHILD_STEP_MS,
  GUARD,
  LEASE_EPOCH,
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

test('an interrupted publication guard refuses without unsafe automatic reclamation', async () => {
  const dir = await directory();
  const guard = join(dir, 'locked.lock.acquiring');
  await mkdir(guard);
  await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow(
    'acquisition in progress or interrupted',
  );
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
});

// Enclosure: seed and paused child each 25s; parent contention/recovery share remaining 25s.
test(
  'guard lease retains exclusion through SIGSTOP within its 30s stale bound; a SIGKILLed holder recovers once its lease is stale',
  async () => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    // Complete released prior state; no legacy acquiring directory exists.
    const seed = await acquirePlanLock(dir, 'locked', 'seed');
    await seed.release();
    const prior = await readFile(path, 'utf8');
    const held = start(dir, 'interrupted', { J_TEST_PAUSE_PUBLICATION: 'yes' });
    expect(await held.next()).toMatchObject({ status: 'publication-held' });
    await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow(
      'acquisition in progress',
    );
    expect(await readFile(path, 'utf8')).toBe(prior);
    held.child.kill('SIGKILL');
    await held.exited;
    // The trade against flock: death no longer releases the guard. Until
    // the dead holder's lease is stale, acquisition still refuses as busy.
    await expect(acquirePlanLock(dir, 'locked', 'too-soon')).rejects.toThrow(
      'acquisition in progress',
    );
    expect(await readFile(path, 'utf8')).toBe(prior);
    await utimes(join(dir, GUARD), LEASE_EPOCH, LEASE_EPOCH);
    const recovered = await acquirePlanLock(dir, 'locked', 'recovered');
    try {
      await recovered.assertHeld();
    } finally {
      await recovered.release();
    }
    expect((await record(dir)).runId).toBe('recovered');
    expect(await readdir(dir)).not.toContain(GUARD);
  },
  3 * CHILD_STEP_MS,
);

test('a stale guard lease taken over cannot let its displaced holder publish over the new owner', async () => {
  const dir = await directory();
  const seed = await acquirePlanLock(dir, 'locked', 'seed');
  await seed.release();
  const seedNonce = String((await record(dir)).nonce);
  const gate = gateNextClaim(hooks);
  const displaced = acquirePlanLock(dir, 'locked', 'displaced').then(
    () => 'acquired' as const,
    (error: unknown) => error,
  );
  let owner: Awaited<ReturnType<typeof acquirePlanLock>> | undefined;
  try {
    // The displaced holder judged the seed tombstone reclaimable and holds
    // the guard. Its lease goes stale (a stall past `stale`): a new owner
    // takes the guard over and claims the same tombstone first.
    await gate.judged;
    await utimes(join(dir, GUARD), LEASE_EPOCH, LEASE_EPOCH);
    owner = await acquirePlanLock(dir, 'locked', 'owner');
    const owned = await record(dir);
    expect(owned).toMatchObject({ runId: 'owner' });
    const ownedInode = await stat(join(dir, 'locked.lock.json'));
    gate.resume();
    // The seed's claim is taken by a live, unreleased owner: refuse, never
    // replace (the canonical record was never touched, inode included). The
    // refusal carries the typed class (ADR-0003 §2.9).
    const displacedOutcome = await displaced;
    expect(displacedOutcome).toBeInstanceOf(PlanLockRefusedError);
    expect((displacedOutcome as Error).message).toContain("plan locked by 'owner'");
    expect(await record(dir)).toEqual(owned);
    const after = await stat(join(dir, 'locked.lock.json'));
    expect({ dev: after.dev, ino: after.ino }).toEqual({
      dev: ownedInode.dev,
      ino: ownedInode.ino,
    });
    expect(
      JSON.parse(await readFile(join(dir, `locked.lock.json.${seedNonce}.claim`), 'utf8')),
    ).toEqual(owned);
    await owner.assertHeld();
    await owner.release();
    expect(await record(dir)).toEqual({ ...owned, released: true });
  } finally {
    gate.resume();
    await displaced;
    await owner?.release();
  }
  expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
});

test('a guard fault other than a held lease refuses without record publication', async () => {
  const dir = await directory();
  // A stale non-directory at the guard name: the library's stale removal
  // (rmdir) fails, which is a fault, not contention.
  await writeFile(join(dir, GUARD), '');
  await utimes(join(dir, GUARD), LEASE_EPOCH, LEASE_EPOCH);
  await expect(acquirePlanLock(dir, 'locked', 'refused')).rejects.toMatchObject({
    message: expect.stringContaining('publication guard') as unknown,
    cause: { code: 'ENOTDIR' },
  });
  await expect(readFile(join(dir, 'locked.lock.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(dir, GUARD), 'utf8')).toBe('');
});
