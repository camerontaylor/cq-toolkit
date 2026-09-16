// Sweep lane (WS-D, goal D1) — evidence for the git-mutation mutex
// (src/ops/sweep/gitMutex.ts, UC §1 row 32 / R2 D2). REAL filesystem
// throughout (mkdtemp tmpdirs; proper-lockfile itself is never mocked):
//   1. MUTUAL EXCLUSION: concurrent fake runs on one lockPath serialize —
//      overlapping critical sections fail the test outright.
//   2. RELEASE ON THROW: a throwing fn releases best-effort; the next
//      acquire succeeds.
//   3. A HELD (live) lock is awaited within the retry budget — no steal.
//   4. A STALE lock (artifact mtime older than staleMs) is stolen: the
//      crashed-holder wedge class can never wedge a run forever. The stale
//      artifact is planted directly (mkdir + backdated utimes) because a
//      live proper-lockfile plant refreshes its own mtime (the update
//      timer is clamped to fire at ≥1000ms) and would race the backdate.
//   5. An un-stealable contended lock past the retry budget REJECTS,
//      naming the lockPath and the waiter budget — never a silent proceed.
//   6. Config preconditions throw at construction (programmer errors).
//   7. A compromised lock (this holder's lock stolen mid-section) surfaces
//      as a rejection on the release path — never a silently-reported ok.
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lock } from 'proper-lockfile';
import { afterEach, describe, expect, test } from 'vitest';
import { makeGitMutex } from '../../../src/ops/sweep/gitMutex.js';
import type { GitMutexEvent } from '../../../src/ops/sweep/gitMutex.js';

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

let dir = '';
/** Fresh tmpdir per test — the lock files here are real fs state. */
function newDir(): string {
  dir = mkdtempSync(join(tmpdir(), 'git-mutex-'));
  return dir;
}

afterEach(() => {
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
  dir = '';
});

describe('gitMutex mutual exclusion (UC §1 row 32)', () => {
  test('two concurrent fake runs serialize: overlapping critical sections fail the test', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    const mutex = makeGitMutex({ lockPath, retries: 50, retryBaseMs: 10 });
    let inside = 0;
    let overlapped = false;
    let maxInside = 0;
    await Promise.all(
      Array.from({ length: 6 }, () =>
        mutex.withLock(async () => {
          inside += 1;
          if (inside > 1) overlapped = true; // the mutual-exclusion assertion itself
          maxInside = Math.max(maxInside, inside);
          await sleep(15);
          inside -= 1;
        }),
      ),
    );
    expect(overlapped).toBe(false);
    expect(maxInside).toBe(1);
  });

  test('two separate mutex instances on one lockPath still serialize (cross-instance, like cross-process)', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    const a = makeGitMutex({ lockPath, retries: 50, retryBaseMs: 10 });
    const b = makeGitMutex({ lockPath, retries: 50, retryBaseMs: 10 });
    const order: string[] = [];
    await Promise.all([
      a.withLock(async () => {
        order.push('a-in');
        await sleep(20);
        order.push('a-out');
      }),
      b.withLock(async () => {
        order.push('b-in');
        await sleep(20);
        order.push('b-out');
      }),
    ]);
    expect(order).toEqual(['a-in', 'a-out', 'b-in', 'b-out']);
  });
});

describe('gitMutex release discipline', () => {
  test('a throwing fn still releases: its fault propagates and the next acquire succeeds', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    const mutex = makeGitMutex({ lockPath, retries: 5, retryBaseMs: 10 });
    await expect(
      mutex.withLock(() => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A leaked lock would burn the retries and reject here.
    await expect(mutex.withLock(() => 'second')).resolves.toBe('second');
  });

  test('sync fns are fine: the value is awaited and returned', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    const mutex = makeGitMutex({ lockPath });
    await expect(mutex.withLock(() => 42)).resolves.toBe(42);
  });

  test('a throwing onEvent is swallowed by contract: fn runs, the lock releases, nothing surfaces', async () => {
    // Observer isolation (Codex round-1): the events are diagnostics — an
    // 'acquired' hook that throws mid-critical-section must never skip fn
    // or the release, and the throw never surfaces to the withLock caller.
    const lockPath = join(newDir(), 'git-mutex.lock');
    const events: string[] = [];
    const mutex = makeGitMutex({
      lockPath,
      retries: 20,
      retryBaseMs: 10,
      onEvent: (event) => {
        events.push(event.type);
        if (event.type === 'acquired') throw new Error('observer exploded');
      },
    });
    await expect(mutex.withLock(() => 'ran')).resolves.toBe('ran');
    expect(events).toEqual(['acquired', 'released']); // acquired fired (and threw); release STILL ran
    // The lock is genuinely free: the next acquire is immediate.
    await expect(mutex.withLock(() => 'again')).resolves.toBe('again');
  });
});

describe('gitMutex staleness (the UC row 32 wedge recovery)', () => {
  test('a live held lock is awaited within the retry budget — no steal', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    const holderMutex = makeGitMutex({ lockPath, retries: 50, retryBaseMs: 10 });
    const events: GitMutexEvent[] = [];
    const contender = makeGitMutex({
      lockPath,
      retries: 50,
      retryBaseMs: 10,
      onEvent: (event) => events.push(event),
    });
    const timeline: string[] = [];
    const [held, quick] = await Promise.all([
      holderMutex.withLock(async () => {
        timeline.push('holder-start');
        await sleep(120);
        timeline.push('holder-end');
        return 'held';
      }),
      contender.withLock(() => {
        timeline.push('contender-run');
        return 'quick';
      }),
    ]);
    expect(held).toBe('held');
    expect(quick).toBe('quick');
    // The contender ran only AFTER the holder let go, without a steal.
    expect(timeline.indexOf('holder-end')).toBeLessThan(timeline.indexOf('contender-run'));
    expect(events).toEqual([
      { type: 'acquired', lockPath, steal: false },
      { type: 'released', lockPath },
    ]);
  });

  test('a stale lock (old-mtime artifact) is stolen after staleMs', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    // Plant the artifact DIRECTLY in proper-lockfile's mkdir-strategy
    // layout, backdated past the stale window — a live plant would refresh
    // its own mtime and race this test (see file header).
    const artifact = `${lockPath}.lock`;
    mkdirSync(artifact);
    const backdated = new Date(Date.now() - 60_000);
    utimesSync(artifact, backdated, backdated);
    const events: GitMutexEvent[] = [];
    const mutex = makeGitMutex({
      lockPath,
      staleMs: 2_000,
      retries: 5,
      retryBaseMs: 10,
      onEvent: (event) => events.push(event),
    });
    await expect(mutex.withLock(() => 'recovered')).resolves.toBe('recovered');
    const recovered = events.find((event) => event.type === 'stale-recovered');
    expect(recovered?.type).toBe('stale-recovered');
    if (recovered?.type === 'stale-recovered') {
      expect(recovered.ageMs).toBeGreaterThan(30_000);
    }
    expect(events.some((event) => event.type === 'acquired' && event.steal)).toBe(true);
    // The theft consumed the wedge: a normal release happened after.
    expect(events.some((event) => event.type === 'released')).toBe(true);
  });

  test('an un-stealable contended lock past the retry budget rejects, naming lockPath and the waiter budget', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    // A REAL live holder via proper-lockfile itself: default options keep
    // the artifact fresh (mtime refresh clamped to ≥1000ms), so within the
    // test's lifetime it can never be classified stale.
    const holder = await lock(lockPath, { realpath: false });
    try {
      const mutex = makeGitMutex({ lockPath, retries: 2, retryBaseMs: 10 });
      const error: unknown = await mutex
        .withLock(() => 'never')
        .then(
          () => {
            throw new Error('expected the contended acquire to reject');
          },
          (acquireError: unknown) => acquireError,
        );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(lockPath);
      expect((error as Error).message).toMatch(/waiter budget/);
      expect((error as Error).message).toMatch(/2 retries/);
    } finally {
      await holder();
    }
    // Once the holder lets go, the mutex acquires normally again.
    await expect(
      makeGitMutex({ lockPath, retries: 5, retryBaseMs: 10 }).withLock(() => 'after'),
    ).resolves.toBe('after');
  });
});

describe('gitMutex config preconditions', () => {
  test('malformed config throws RangeError at construction — programmer errors, not runtime faults', () => {
    expect(() => makeGitMutex({ lockPath: '' })).toThrow(RangeError);
    expect(() => makeGitMutex({ lockPath: join(newDir(), 'm.lock'), staleMs: 1_999 })).toThrow(
      /staleMs/,
    );
    expect(() => makeGitMutex({ lockPath: join(newDir(), 'm.lock'), retries: -1 })).toThrow(
      /retries/,
    );
    expect(() => makeGitMutex({ lockPath: join(newDir(), 'm.lock'), retryBaseMs: 0 })).toThrow(
      /retryBaseMs/,
    );
  });
});

describe('gitMutex compromise surfacing', () => {
  test('a lock stolen mid-section surfaces as a rejection on the holder — never a silent ok', async () => {
    const lockPath = join(newDir(), 'git-mutex.lock');
    // staleMs 2000 puts the holder's mtime-refresh timer at its 1000ms
    // floor: it fires while this test is still inside the section.
    const victim = makeGitMutex({ lockPath, staleMs: 2_000 });
    const thief = makeGitMutex({ lockPath, staleMs: 2_000, retries: 5, retryBaseMs: 10 });
    const section = victim.withLock(async () => {
      await sleep(60);
      // The thief steals the (freshly backdated) artifact while the
      // victim's section is still running.
      const artifact = `${lockPath}.lock`;
      const backdated = new Date(Date.now() - 60_000);
      utimesSync(artifact, backdated, backdated);
      await thief.withLock(() => 'stolen');
      await sleep(1600); // past the victim's refresh timer (~1000ms)
      return 'victim-done';
    });
    await expect(section).rejects.toThrow(/release of/);
  });
});
