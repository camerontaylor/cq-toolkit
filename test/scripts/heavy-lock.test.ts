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
  judgeHolder,
  readOwner,
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
  const leaderAt = new Date(LEADER_START).toISOString();
  /**
   * A dead owner whose child group 555 is alive (until `exitsAfterSleeps`
   * polls, when given), with `extra` recorded and the leader's actual start
   * time `leaderStartMs`. Virtual clock: the wait costs no real time.
   */
  const orphan = async (
    extra: object,
    leaderStartMs: number | null,
    { startedAt = new Date().toISOString(), maxWaitMs = 0, exitsAfterSleeps = Infinity } = {},
  ) => {
    holderRecord(99, 'tok-dead', startedAt);
    const record = JSON.parse(fs.readFileSync(join(lock, 'owner.json'), 'utf8')) as object;
    fs.writeFileSync(
      join(lock, 'owner.json'),
      JSON.stringify({ ...record, childPgid: 555, ...extra }),
    );
    const c = clock(Date.now());
    let sleeps = 0;
    const killed: number[] = [];
    const lines: string[] = [];
    const got = await acquireLock({
      path: lock,
      maxWaitMs,
      info,
      deps: {
        now: c.now,
        sleep: async (ms) => {
          sleeps += 1;
          await c.sleep(ms);
        },
        isAlive: () => false,
        groupAlive: (pgid) => pgid === 555 && killed.length === 0 && sleeps < exitsAfterSleeps,
        killGroup: (pgid) => void killed.push(pgid),
        processStartMs: (pid) => (pid === 555 ? leaderStartMs : null),
        token: () => 'tok-h',
        log: (l) => lines.push(l),
      },
    });
    return { got, killed, log: lines.join('\n') };
  };

  it('kills an orphaned child group whose leader identity matches, then reclaims', async () => {
    const { got, killed, log } = await orphan({ childStartedAt: leaderAt }, LEADER_START);
    expect(killed).toEqual([555]);
    expect(log).toContain('killed orphaned child group 555');
    expect(got.acquired).toBe(true);
  });

  it.each([
    // The pgid was reused: its leader started after the record was written.
    ['reused', { childStartedAt: leaderAt }, LEADER_START + 60_000, 'its leader was reused'],
    // The leader exited while its workers remain in the group (or ps failed).
    ['gone', { childStartedAt: leaderAt }, null, 'its leader is gone or unreadable'],
    // A record from before childStartedAt existed carries no identity at all.
    ['legacy', {}, LEADER_START, 'the record has no leader start time'],
  ])(
    'keeps the lock busy, never killing, while an unverifiable group (%s) runs',
    async (_case, extra, leaderStartMs, why) => {
      const { got, killed, log } = await orphan(extra, leaderStartMs, { maxWaitMs: 60_000 });
      expect(killed).toEqual([]);
      expect(got).toMatchObject({ acquired: false, holder: { token: 'tok-dead' } });
      expect(readOwner(lock)?.token).toBe('tok-dead');
      expect(log).toContain(`child group 555 still runs and cannot be verified (${why})`);
      expect(log).not.toContain('reclaimed');
    },
  );

  it('acquires once an unverifiable group has exited by itself', async () => {
    const { got, killed, log } = await orphan({}, null, {
      maxWaitMs: 60_000,
      exitsAfterSleeps: 2,
    });
    expect(killed).toEqual([]);
    expect(got.acquired).toBe(true);
    expect(log).toContain('reclaimed a stale lock (owner pid 99 is gone)');
  });

  it('reclaims around an unverifiable group at MAX_HOLD_MS, loudly and without killing', async () => {
    const old = new Date(Date.now() - MAX_HOLD_MS - 1_000).toISOString();
    const { got, killed, log } = await orphan({ childStartedAt: leaderAt }, null, {
      startedAt: old,
    });
    expect(killed).toEqual([]);
    expect(got.acquired).toBe(true);
    expect(log).toContain('heavy-lock: WARNING: child group 555 still runs and cannot be verified');
    expect(log).toContain('reclaiming WITHOUT killing it');
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
    // Cleared once that group is gone (the build, before vitest starts).
    got.annotate({ childPgid: null });
    expect(readOwner(lock)).not.toHaveProperty('childPgid');
    expect(readOwner(lock)).not.toHaveProperty('childStartedAt');
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

describe('judgeHolder', () => {
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
  const deps = {
    now,
    isAlive: () => true,
    groupAlive: () => false,
    processStartMs: () => null,
  };
  const reason = (...args: Parameters<typeof judgeHolder>) => judgeHolder(...args).reason;

  it('keeps a live, recent owner', () => {
    expect(reason(owner(fresh), now, deps)).toBeNull();
  });

  it('gives a missing record MISSING_OWNER_MS to appear', () => {
    expect(reason(null, now - MISSING_OWNER_MS, deps)).toBeNull();
    expect(reason(null, now - MISSING_OWNER_MS - 1, deps)).toBe('no owner record');
  });

  it('treats a dead pid or an over-long hold as stale', () => {
    expect(reason(owner(fresh), now, { ...deps, isAlive: () => false })).toContain('is gone');
    const old = new Date(now - MAX_HOLD_MS - 1).toISOString();
    expect(reason(owner(old), now, deps)).toContain('MAX_HOLD_MS');
  });

  it('kills only a verified orphan group, and waits on an unverifiable one', () => {
    const leader = now - 5_000;
    const withGroup = {
      ...owner(fresh),
      childPgid: 9,
      childStartedAt: new Date(leader).toISOString(),
    };
    const dead = { ...deps, isAlive: () => false, groupAlive: (pgid: number) => pgid === 9 };
    expect(judgeHolder(withGroup, now, { ...dead, processStartMs: () => leader })).toEqual({
      reason: 'owner pid 1 is gone; orphaned child group 9',
      kill: 9,
    });
    const busy = judgeHolder(withGroup, now, { ...dead, processStartMs: () => null });
    expect(busy.reason).toBeNull();
    expect(busy.kill).toBeUndefined();
    expect(busy.note).toContain('never killed, the lock stays busy');
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
