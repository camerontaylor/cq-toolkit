// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds guard-lease compromise (lock-lost): before publication, after
// publication (rollback to a released tombstone), and inside runPlan before any
// history is read or journaled. Sibling subjects:
// journal-lock.exclusion.test.ts, journal-lock.claims.test.ts,
// journal-lock.publication-faults.test.ts, journal-lock.guard.test.ts,
// journal-lock.corruption.test.ts, journal-lock.artifacts.test.ts,
// journal-lock.recovery.test.ts; shared fixtures live in journal-lock.helpers.ts.
import { readdir } from 'node:fs/promises';
import type { LockOptions } from 'proper-lockfile';
import { expect, test, vi } from 'vitest';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import { runPlan } from '../../src/kernel/runner.js';
import {
  compromisedError,
  directory,
  lockHarness,
  record,
  workRegistry,
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

test('a guard lease compromised before publication refuses as lock-lost and publishes nothing', async () => {
  const dir = await directory();
  hooks.guardAcquired = (options) => {
    // The handler records; it must never throw into the library's timer.
    expect(() => options.onCompromised?.(compromisedError())).not.toThrow();
  };
  await expect(acquirePlanLock(dir, 'locked', 'compromised')).rejects.toMatchObject({
    message: expect.stringContaining('lock-lost while acquiring') as unknown,
    cause: { code: 'ECOMPROMISED' },
  });
  expect(await readdir(dir)).toEqual([]);
});

test('a guard lease compromised after publication rolls back to our released tombstone', async () => {
  const dir = await directory();
  let compromise: (() => void) | undefined;
  hooks.guardAcquired = (options) => {
    compromise = () => options.onCompromised?.(compromisedError());
  };
  hooks.afterPublication = () => compromise?.();
  await expect(acquirePlanLock(dir, 'locked', 'compromised')).rejects.toThrow(
    'lock-lost while acquiring',
  );
  expect(await record(dir)).toMatchObject({ runId: 'compromised', released: true });
  expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  hooks.guardAcquired = undefined;
  hooks.afterPublication = undefined;
  // A tombstone is reclaimable: the loss wedges nothing.
  const next = await acquirePlanLock(dir, 'locked', 'next');
  await next.release();
});

test('runPlan treats a compromised guard lease as lease loss before reading or journaling history', async () => {
  const dir = await directory();
  hooks.guardAcquired = (options) => options.onCompromised?.(compromisedError());
  const calls: string[] = [];
  await expect(
    runPlan(
      { id: 'locked', jobs: [{ id: 'a', op: 'work', input: { id: 'a' } }] },
      { concurrency: 1, stopOnError: false, journalDir: dir },
      workRegistry(calls),
    ),
  ).rejects.toThrow('lock-lost');
  expect(calls).toEqual([]);
  // No run file, seq claim, lock record, temporary, or guard directory.
  expect(await readdir(dir)).toEqual([]);
});
