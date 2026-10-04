// Host-wide single-flight lock (scripts/lib/heavy-lock.mjs): acquire,
// contention with a bounded wait, stale reclaim, the reclaim race, and the
// token-checked release. Pure: own temp dirs only; liveness, clock and sleep
// are injected (no process is signalled, no real waiting).
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_HOLD_MS,
  MISSING_OWNER_MS,
  acquireLock,
  readOwner,
  staleReason,
} from '../../scripts/lib/heavy-lock.mjs';

let dir: string;
let lock: string;
beforeEach(() => {
  dir = fs.mkdtempSync(join(tmpdir(), 'heavy-lock-'));
  lock = join(dir, 'lock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

const info = { cwd: '/repo', command: 'test:narrow x' };
/** A virtual clock whose sleep advances time instantly. */
const clock = (start = 1_000_000) => {
  let t = start;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
};
const holderRecord = (pid: number, token: string, startedAt = new Date().toISOString()) => {
  fs.mkdirSync(lock);
  fs.writeFileSync(
    join(lock, 'owner.json'),
    JSON.stringify({ pid, token, host: 'h', cwd: '/other', command: 'held', startedAt }),
  );
};

describe('acquireLock', () => {
  it('acquires a free lock, records the owner, and releases it', async () => {
    const c = clock();
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: { ...c, pid: 4242, token: () => 'tok-a', log: () => {} },
    });
    expect(got.acquired).toBe(true);
    expect(readOwner(lock)).toMatchObject({ pid: 4242, token: 'tok-a', ...info });
    if (got.acquired) got.release();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('waits while a live owner holds it, reports, and times out without acquiring', async () => {
    holderRecord(99, 'tok-live');
    const c = clock(Date.now());
    const lines: string[] = [];
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 60_000,
      info,
      deps: { ...c, isAlive: () => true, token: () => 'tok-b', log: (l) => lines.push(l) },
    });
    expect(got).toMatchObject({ acquired: false, holder: { pid: 99, token: 'tok-live' } });
    expect(got.waitedMs).toBe(60_000);
    expect(lines.length).toBeGreaterThanOrEqual(2); // first contention + every 30s
    expect(lines[0]).toContain('held by pid 99');
    expect(readOwner(lock)?.token).toBe('tok-live');
  });

  it('acquires as soon as the holder releases', async () => {
    holderRecord(99, 'tok-live');
    let polls = 0;
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 60_000,
      info,
      deps: {
        now: Date.now,
        isAlive: () => true,
        log: () => {},
        token: () => 'tok-c',
        sleep: async () => {
          if (++polls === 3) fs.rmSync(lock, { recursive: true });
        },
      },
    });
    expect(got.acquired).toBe(true);
    expect(polls).toBe(3);
    expect(readOwner(lock)?.token).toBe('tok-c');
  });

  it('reclaims a lock whose owner pid is gone', async () => {
    holderRecord(99, 'tok-dead');
    const lines: string[] = [];
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: { isAlive: () => false, token: () => 'tok-d', log: (l) => lines.push(l) },
    });
    expect(got.acquired).toBe(true);
    expect(readOwner(lock)?.token).toBe('tok-d');
    expect(lines.join('\n')).toContain('owner pid 99 is gone');
    expect(fs.readdirSync(dir)).toEqual(['lock']); // the stale copy was removed
  });

  it('restores a lock that changed hands between the judgement and the rename', async () => {
    holderRecord(99, 'tok-dead');
    // Simulate a waiter that reclaimed and re-acquired first: the directory
    // our rename moves already belongs to a live owner.
    const racingFs = {
      ...fs,
      renameSync: (from: fs.PathLike, to: fs.PathLike) => {
        if (String(from) === lock && readOwner(lock)?.token === 'tok-dead') {
          fs.writeFileSync(
            join(lock, 'owner.json'),
            JSON.stringify({ pid: 7, token: 'tok-new', startedAt: new Date().toISOString() }),
          );
        }
        fs.renameSync(from, to);
      },
    } as typeof fs;
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: { fs: racingFs, isAlive: (pid) => pid === 7, token: () => 'tok-e', log: () => {} },
    });
    expect(got).toMatchObject({ acquired: false, holder: { pid: 7, token: 'tok-new' } });
    expect(readOwner(lock)?.token).toBe('tok-new');
  });

  it('releases only while the record still carries its own token', async () => {
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: { token: () => 'tok-f', log: () => {} },
    });
    if (!got.acquired) throw new Error('expected the lock');
    fs.writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 1, token: 'someone-else' }));
    got.release();
    expect(readOwner(lock)?.token).toBe('someone-else');
  });
});

describe('staleReason', () => {
  const now = 10_000_000;
  const owner = (startedAt: string) => ({
    pid: 1,
    token: 't',
    host: 'h',
    cwd: '/',
    command: 'c',
    startedAt,
  });
  const fresh = new Date(now).toISOString();

  it('keeps a live, recent owner', () => {
    expect(staleReason(owner(fresh), now, { now, isAlive: () => true })).toBeNull();
  });

  it('gives a missing record MISSING_OWNER_MS to appear', () => {
    expect(staleReason(null, now - MISSING_OWNER_MS, { now, isAlive: () => true })).toBeNull();
    expect(staleReason(null, now - MISSING_OWNER_MS - 1, { now, isAlive: () => true })).toBe(
      'no owner record',
    );
  });

  it('treats a dead pid or an over-long hold as stale', () => {
    expect(staleReason(owner(fresh), now, { now, isAlive: () => false })).toContain('is gone');
    const old = new Date(now - MAX_HOLD_MS - 1).toISOString();
    expect(staleReason(owner(old), now, { now, isAlive: () => true })).toContain('MAX_HOLD_MS');
  });

  it('reclaims an ownerless directory once it is old enough', async () => {
    fs.mkdirSync(lock);
    const past = (Date.now() - MISSING_OWNER_MS - 5_000) / 1000;
    fs.utimesSync(lock, past, past);
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: { token: () => 'tok-g', log: () => {} },
    });
    expect(got.acquired).toBe(true);
  });
});
