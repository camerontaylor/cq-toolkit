// Host-wide single-flight lock (scripts/lib/heavy-lock.mjs): acquire,
// contention with a bounded wait, stale and orphan reclaim (an orphan group
// is killed only when its leader's recorded identity verifies), the guarded
// reclaim race, and the token-checked release. Pure: own temp dirs only; liveness, clock and sleep
// are injected (no process is signalled, no real waiting).
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GUARD_STALE_MS,
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

  it('leaves a lock alone when it changed hands before the reclaim guard was taken', async () => {
    holderRecord(99, 'tok-dead');
    // Another waiter reclaims and re-acquires between our judgement and our
    // guard: the record under the guard is no longer the one judged stale.
    const racingFs = {
      ...fs,
      mkdirSync: (target: fs.PathLike) => {
        if (String(target) === `${lock}.reclaim`) {
          fs.writeFileSync(
            join(lock, 'owner.json'),
            JSON.stringify({ pid: 7, token: 'tok-new', startedAt: new Date().toISOString() }),
          );
        }
        fs.mkdirSync(target);
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
    expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
  });

  const LEADER_START = Date.parse('2026-10-08T01:02:03.000Z');
  /** A dead owner whose child group 555 is still alive, with `extra` recorded. */
  const orphan = async (extra: object, leaderStartMs: number | null) => {
    holderRecord(99, 'tok-dead');
    const record = JSON.parse(fs.readFileSync(join(lock, 'owner.json'), 'utf8')) as object;
    fs.writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ ...record, childPgid: 555, ...extra }),
    );
    const killed: number[] = [];
    const lines: string[] = [];
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: {
        isAlive: () => false,
        groupAlive: (pgid) => pgid === 555 && killed.length === 0,
        killGroup: (pgid) => void killed.push(pgid),
        processStartMs: (pid) => (pid === 555 ? leaderStartMs : null),
        token: () => 'tok-h',
        log: (l) => lines.push(l),
      },
    });
    return { got, killed, log: lines.join('\n') };
  };

  it('kills an orphaned child group whose leader identity matches, then reclaims', async () => {
    const childStartedAt = new Date(LEADER_START).toISOString();
    const { got, killed, log } = await orphan({ childStartedAt }, LEADER_START);
    expect(killed).toEqual([555]);
    expect(log).toContain('killed orphaned child group 555');
    expect(got.acquired).toBe(true);
  });

  it('never kills a group whose leader cannot be verified, but reclaims the lock', async () => {
    const childStartedAt = new Date(LEADER_START).toISOString();
    // The pgid was reused: its leader started after the record was written.
    const reused = await orphan({ childStartedAt }, LEADER_START + 60_000);
    expect(reused.killed).toEqual([]);
    expect(reused.log).toContain('not killing process group 555: its leader was reused');
    expect(reused.log).toContain('treating the lock as stale');
    expect(reused.got.acquired).toBe(true);
    fs.rmSync(lock, { recursive: true, force: true });

    // The leader is gone (only other group members remain), or unreadable.
    const gone = await orphan({ childStartedAt }, null);
    expect(gone.killed).toEqual([]);
    expect(gone.log).toContain('its leader is gone or unreadable');
    expect(gone.got.acquired).toBe(true);
    fs.rmSync(lock, { recursive: true, force: true });

    // A record from before childStartedAt existed carries no identity at all.
    const legacy = await orphan({}, LEADER_START);
    expect(legacy.killed).toEqual([]);
    expect(legacy.log).toContain('the record has no leader start time');
    expect(legacy.got.acquired).toBe(true);
  });

  it('waits while another reclaimer holds a fresh guard, and clears a stale one', async () => {
    holderRecord(99, 'tok-dead');
    fs.mkdirSync(`${lock}.reclaim`);
    const busy = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: { isAlive: () => false, token: () => 'tok-i', log: () => {} },
    });
    expect(busy.acquired).toBe(false);
    expect(readOwner(lock)?.token).toBe('tok-dead');

    const past = (Date.now() - GUARD_STALE_MS - 5_000) / 1000;
    fs.utimesSync(`${lock}.reclaim`, past, past);
    const c = clock(Date.now());
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 10_000,
      info,
      deps: { ...c, isAlive: () => false, token: () => 'tok-j', log: () => {} },
    });
    expect(got.acquired).toBe(true);
    expect(fs.existsSync(`${lock}.reclaim`)).toBe(false);
  });

  it('annotates its own record with the child group', async () => {
    const got = await acquireLock({
      path: lock,
      maxWaitMs: 0,
      info,
      deps: {
        token: () => 'tok-k',
        log: () => {},
        processStartMs: (pid) => (pid === 4321 ? Date.parse('2026-10-08T01:02:03.000Z') : null),
      },
    });
    if (!got.acquired) throw new Error('expected the lock');
    got.annotate({ childPgid: 4321 });
    expect(readOwner(lock)).toMatchObject({
      token: 'tok-k',
      childPgid: 4321,
      childStartedAt: '2026-10-08T01:02:03.000Z',
      ...info,
    });
    got.release();
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
    expect(
      staleReason(owner(fresh), now, { now, isAlive: () => true, groupAlive: () => false }),
    ).toBeNull();
  });

  it('gives a missing record MISSING_OWNER_MS to appear', () => {
    expect(
      staleReason(null, now - MISSING_OWNER_MS, {
        now,
        isAlive: () => true,
        groupAlive: () => false,
      }),
    ).toBeNull();
    expect(
      staleReason(null, now - MISSING_OWNER_MS - 1, {
        now,
        isAlive: () => true,
        groupAlive: () => false,
      }),
    ).toBe('no owner record');
  });

  it('treats a dead pid or an over-long hold as stale', () => {
    expect(
      staleReason(owner(fresh), now, { now, isAlive: () => false, groupAlive: () => false }),
    ).toContain('is gone');
    expect(
      staleReason({ ...owner(fresh), childPgid: 9 }, now, {
        now,
        isAlive: () => false,
        groupAlive: (pgid) => pgid === 9,
      }),
    ).toContain('orphaned child group');
    const old = new Date(now - MAX_HOLD_MS - 1).toISOString();
    expect(
      staleReason(owner(old), now, { now, isAlive: () => true, groupAlive: () => false }),
    ).toContain('MAX_HOLD_MS');
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
