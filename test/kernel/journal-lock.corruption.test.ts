// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds corrupt or unreadable lock data: half-written record bytes, an
// unreadable canonical record met while walking claims, and a never-published
// claimant claim. Sibling subjects: journal-lock.exclusion.test.ts,
// journal-lock.claims.test.ts, journal-lock.publication-faults.test.ts,
// journal-lock.guard.test.ts, journal-lock.compromise.test.ts,
// journal-lock.artifacts.test.ts, journal-lock.recovery.test.ts; shared
// fixtures live in journal-lock.helpers.ts.
import { randomUUID } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LockOptions } from 'proper-lockfile';
import { expect, test, vi } from 'vitest';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import { directory, gateNextClaim, lockHarness, record } from './journal-lock.helpers.js';

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

test.each(['', '{"nonce":', '{"nonce":"invalid"}'])(
  'half-written or corrupt lock refuses without replacing bytes: %s',
  async (bytes) => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    await writeFile(path, bytes);
    await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow('half-written');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  },
);

test.each([
  { corruption: 'malformed JSON', bytes: '{"nonce":' },
  { corruption: 'a schema violation', bytes: JSON.stringify({ runId: 'not-a-record' }) },
])(
  'an unreadable canonical record ($corruption) met while walking claims refuses, never replaced',
  async ({ bytes }) => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    const seed = await acquirePlanLock(dir, 'locked', 'seed');
    await seed.release();
    const prior = await record(dir);
    const crashed = {
      nonce: randomUUID(),
      socketPath: '/tmp/no-such-cq-j.sock',
      pid: 2147483647,
      host: prior.host,
      bootId: prior.bootId,
      runId: 'crashed',
    };
    const gate = gateNextClaim(hooks);
    const walker = acquirePlanLock(dir, 'locked', 'walker');
    void walker.catch(() => undefined); // observed below
    try {
      await gate.judged;
      // After the judgment: a dead claimant holds the seed's claim (so the
      // walker must look at the canonical record), which is now corrupt.
      await writeFile(`${path}.${String(prior.nonce)}.claim`, JSON.stringify(crashed));
      await writeFile(path, bytes);
      gate.resume();
      await expect(walker).rejects.toThrow(`corrupt or unreadable plan lock '${path}'`);
      expect(await readFile(path, 'utf8')).toBe(bytes);
      const names = await readdir(dir);
      expect(names).not.toContain(`locked.lock.json.${crashed.nonce}.claim`);
      expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    } finally {
      gate.resume();
      await walker.catch(() => undefined);
    }
  },
);

test.each([
  { claimant: 'foreign-host', host: 'foreign-host', pid: 2147483647 },
  // Same host and alive (our own pid): a claimant whose rename faulted.
  { claimant: 'live-unpublished', host: undefined, pid: process.pid },
])(
  'a never-published $claimant claim refuses naming the claim file, and its removal unblocks',
  async ({ claimant, host, pid }) => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    const seed = await acquirePlanLock(dir, 'locked', 'seed');
    await seed.release();
    const prior = await record(dir);
    const priorBytes = await readFile(path, 'utf8');
    const claim = `${path}.${String(prior.nonce)}.claim`;
    // The claim on the seed exists, but the seed tombstone is still canonical.
    await writeFile(
      claim,
      JSON.stringify({
        nonce: randomUUID(),
        socketPath: '/tmp/no-such-cq-j.sock',
        pid,
        host: host ?? prior.host,
        bootId: prior.bootId,
        runId: claimant,
      }),
    );
    const refusal = acquirePlanLock(dir, 'locked', 'blocked');
    await expect(refusal).rejects.toThrow(`plan lock claim '${claim}' names run '${claimant}'`);
    await expect(refusal).rejects.toThrow('never published');
    await expect(refusal).rejects.toMatchObject({
      cause: { message: expect.stringContaining('plan locked') as unknown },
    });
    expect(await readFile(path, 'utf8')).toBe(priorBytes);
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    // The operator remedy the message names: remove the claim file.
    await unlink(claim);
    const lease = await acquirePlanLock(dir, 'locked', 'unblocked');
    try {
      await lease.assertHeld();
      expect(await record(dir)).toMatchObject({ runId: 'unblocked' });
    } finally {
      await lease.release();
    }
  },
);
