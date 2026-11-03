// Split provenance: test/ops/ledger/registry-c4.test.ts was split into the
// registry-c4.*.test.ts siblings in this directory; shared fixtures live in
// registry-c4.helpers.ts. This file carries the lock contention contract
// (bounded backoff, live holders win, abandoned locks are recovered).
import { mkdir, readdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { entryNamed, freshScratch, removeScratch } from './registry-c4.helpers.js';

afterEach(removeScratch);

describe('pathLedgerStore.lock (contention contract: bounded backoff, live holders win, abandoned locks are recovered)', () => {
  test('8 parallel registry-bound records on one path ALL land (counts 1..8, none lost)', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => op({ root: scratchDir, storePath, signature: 'sig-a' })),
    );
    // Every record observed its OWN increment: the counts 1..8 each appear
    // exactly once (ok values at 1–2, the escalation reason above that).
    const observed = results
      .map((result) =>
        result.status === 'ok'
          ? (result.value as { count: number }).count
          : result.status === 'needs-human'
            ? Number(/count (\d+)/.exec(result.reason)?.[1])
            : Number.NaN,
      )
      .sort((a, b) => a - b);
    expect(observed).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const query = await entryNamed('ledger.query').importer();
    await expect(query({ root: scratchDir, storePath })).resolves.toEqual({
      status: 'ok',
      value: {
        entries: [{ signature: 'sig-a', count: 8 }],
        knownNoise: ['sig-a'],
        needsHuman: ['sig-a'],
      },
    });
  }, 20_000);

  test('an ABANDONED lock is stolen once staleness passes (crash recovery), and the record lands', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    await mkdir(`${storePath}.lock`); // left by a crashed holder — never mtime-updated again
    // Backdate the abandoned lock dir's mtime past the 30s stale window —
    // the deterministic stand-in for waiting out the window in wall-clock
    // time. The one-call recovery guarantee for a JUST-crashed holder is
    // arithmetic instead: the acquire backoff (retries: 11, factor: 2,
    // minTimeout: 25 → cumulative ≈ 51s) outlives the 30s stale window,
    // and the sync critical section the window must cover is bounded well
    // under it (PR #78 review, Codex P2 — a 5s window could expire a lock
    // whose holder was merely blocked in sync fs work).
    const staleAgo = new Date(Date.now() - 35_000);
    await utimes(`${storePath}.lock`, staleAgo, staleAgo);
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    // The stale lock was consumed: only the ledger remains.
    expect(await readdir(scratchDir)).toEqual(['ledger.json']);
  }, 20_000);

  test('a LIVE held lock is waited out, never stolen from (the record lands only after the holder releases)', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    // A genuinely live holder: proper-lockfile refreshes the lock's mtime
    // (update: 1000), so it never goes stale inside the record's 30s
    // window. The holder releases after 1.2s — well inside the record's
    // ≈51s cumulative backoff — so the record must WAIT for the release
    // and then proceed. Had it stolen the live lock instead, the external
    // release() below would reject (compromised lock) and fail the test.
    const { lock } = await import('proper-lockfile');
    const release = await lock(storePath, { realpath: false, update: 1000 });
    let releaseOutcome: 'pending' | 'fulfilled' | 'rejected' = 'pending';
    const released = new Promise<void>((resolve) => {
      setTimeout(() => {
        void release().then(
          () => {
            releaseOutcome = 'fulfilled';
            resolve();
          },
          () => {
            releaseOutcome = 'rejected';
            resolve();
          },
        );
      }, 1_200);
    });
    try {
      const op = await entryNamed('ledger.record').importer();
      await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
        status: 'ok',
        value: { signature: 'sig-a', count: 1, escalated: false },
      });
    } finally {
      await released;
    }
    expect(releaseOutcome).toBe('fulfilled'); // clean external release: nothing was stolen
    expect(await readdir(scratchDir)).toEqual(['ledger.json']);
  }, 20_000);
});
