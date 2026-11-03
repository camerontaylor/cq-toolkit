// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds process exclusion (TMPDIR split, a paused owner's saturated socket
// backlog, a live same-host holder) and the foreign-host refusal class. Sibling
// subjects: journal-lock.claims.test.ts, journal-lock.publication-faults.test.ts,
// journal-lock.guard.test.ts, journal-lock.compromise.test.ts,
// journal-lock.corruption.test.ts, journal-lock.artifacts.test.ts,
// journal-lock.recovery.test.ts; shared fixtures live in journal-lock.helpers.ts.
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { PlanLockRefusedError } from '../../src/kernel/errors.js';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import { CHILD_STEP_MS, directory, lockHarness, record, start } from './journal-lock.helpers.js';

lockHarness();

// Owner child, contender child, then parent acquisition: three bounded steps.
// Enclosure: three acquisitions, two of them fresh child processes.
test(
  'different TMPDIR contenders use the recorded socket and cannot split one plan lock',
  async () => {
    const dir = await directory();
    const owner = start(dir, 'owner', { TMPDIR: '/tmp/owner-only' });
    expect((await owner.next()).status).toBe('acquired');
    await record(dir);
    const contender = start(dir, 'contender', { TMPDIR: '/tmp/contender-only' });
    const refusal = await contender.next();
    expect(refusal.status).toBe('refused');
    expect(refusal.error).toContain('plan locked');
    owner.child.stdin.write('release\n');
    expect((await owner.next()).status).toBe('released');
    await owner.exited;
    const next = await acquirePlanLock(dir, 'locked', 'next');
    await next.release();
  },
  3 * CHILD_STEP_MS,
);

// Enclosure: owner child then contender; includes the 1s socket probe within margin.
test(
  'SIGSTOP with a saturated socket backlog never permits stealing a live owner',
  async () => {
    const dir = await directory();
    const owner = start(dir, 'paused');
    expect((await owner.next()).status).toBe('acquired');
    const lock = await record(dir);
    owner.child.kill('SIGSTOP');
    // The listener uses backlog 16. Connections queue while the owner is paused;
    // both a full backlog and PID liveness must remain refusal evidence.
    const connections: Socket[] = [];
    await Promise.all(
      Array.from(
        { length: 64 },
        () =>
          new Promise<void>((resolve) => {
            const socket = createConnection(String(lock.socketPath));
            connections.push(socket);
            const done = () => {
              clearTimeout(timeout);
              resolve();
            };
            const timeout = setTimeout(done, 100);
            socket.once('connect', done);
            socket.once('error', done);
          }),
      ),
    );
    try {
      await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow('plan locked');
      expect((await record(dir)).nonce).toBe(lock.nonce);
    } finally {
      for (const socket of connections) socket.destroy();
      owner.child.kill('SIGCONT');
    }
    owner.child.stdin.write('release\n');
    expect((await owner.next()).status).toBe('released');
  },
  2 * CHILD_STEP_MS,
);

// The refusal CLASS (ADR-0003 §2.9): the CLI maps a lock refusal to exit 3
// by class (transient — never the permanent-usage 2), so the throw itself
// must carry PlanLockRefusedError on every refusal path, message unchanged.
test('a live same-host holder refuses with the typed lock-refusal error', async () => {
  const dir = await directory();
  const owner = await acquirePlanLock(dir, 'locked', 'owner');
  try {
    const refusal = await acquirePlanLock(dir, 'locked', 'contender').then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(PlanLockRefusedError);
    expect((refusal as Error).message).toBe("journal: plan locked by 'owner'");
    expect((await record(dir)).runId).toBe('owner'); // the record is untouched
  } finally {
    await owner.release();
  }
});

test('a foreign-host record refuses with the typed error, judged before any probe', async () => {
  const dir = await directory();
  // Built as data: a foreign host's liveness evidence is unverifiable from
  // here, so only its release tombstone is reclaimable — the host judgment
  // precedes the socket probe and no second host is needed.
  await writeFile(
    join(dir, 'locked.lock.json'),
    JSON.stringify({
      nonce: randomUUID(),
      socketPath: '/nonexistent/cq-j-lock.sock',
      pid: 1,
      host: 'some-other-host',
      bootId: 'boot-other',
      runId: 'foreign',
    }),
  );
  const refusal = await acquirePlanLock(dir, 'locked', 'contender').then(
    () => undefined,
    (error: unknown) => error,
  );
  expect(refusal).toBeInstanceOf(PlanLockRefusedError);
  expect((refusal as Error).message).toBe(
    "journal: plan locked by foreign host 'some-other-host' run 'foreign'",
  );
});

// Enclosure: one acquisition before the foreign-host refusal.
test(
  'foreign-host record refuses even with dead-looking PID/socket evidence',
  async () => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    const bytes = JSON.stringify({
      nonce: randomUUID(),
      socketPath: '/tmp/no-such-cq-j.sock',
      pid: 2147483647,
      host: 'foreign-host',
      bootId: 'old-boot',
      runId: 'foreign',
    });
    await writeFile(path, bytes);
    await expect(acquirePlanLock(dir, 'locked', 'contender')).rejects.toThrow('foreign host');
    expect(await readFile(path, 'utf8')).toBe(bytes);
  },
  CHILD_STEP_MS + 5_000,
);
