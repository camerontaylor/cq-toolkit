// Split provenance: test/kernel/journal-lock.test.ts was split by subject; this
// file holds lock artifact shapes and names: a foreign-host released tombstone
// reclaimed (and re-published whole on release), plus the plan-id name-length
// bound on publication, succession and release. Sibling subjects:
// journal-lock.exclusion.test.ts, journal-lock.claims.test.ts,
// journal-lock.publication-faults.test.ts, journal-lock.guard.test.ts,
// journal-lock.compromise.test.ts, journal-lock.corruption.test.ts,
// journal-lock.recovery.test.ts; shared fixtures live in journal-lock.helpers.ts.
import { randomUUID } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { acquirePlanLock } from '../../src/kernel/journal.js';
import { CHILD_STEP_MS, directory, lockHarness, record } from './journal-lock.helpers.js';

lockHarness();

// Enclosure: one acquisition reclaiming a moved journal's tombstone.
test(
  'foreign-host released tombstone is reclaimable and release publishes a whole tombstone',
  async () => {
    const dir = await directory();
    const path = join(dir, 'locked.lock.json');
    await writeFile(
      path,
      JSON.stringify({
        nonce: randomUUID(),
        socketPath: '/tmp/no-such-cq-j.sock',
        pid: 2147483647,
        host: 'foreign-host',
        bootId: 'old-boot',
        runId: 'foreign',
        released: true,
      }),
    );
    const lease = await acquirePlanLock(dir, 'locked', 'contender');
    const held = await record(dir);
    expect(held).toMatchObject({ runId: 'contender' });
    expect(held).not.toHaveProperty('released');
    await lease.release();
    expect(await record(dir)).toEqual({ ...held, released: true });
    expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  },
  CHILD_STEP_MS + 5_000,
);

test('a plan id at the 195-char bound completes publication, succession and release', async () => {
  const dir = await directory();
  const planId = `p${'x'.repeat(194)}`;
  const first = await acquirePlanLock(dir, planId, 'first');
  await first.release();
  // Reclamation takes a claim; release writes the longest artifact, the
  // tombstone temporary (exactly 255 bytes here).
  const second = await acquirePlanLock(dir, planId, 'second');
  try {
    await second.assertHeld();
  } finally {
    await second.release();
  }
  expect(
    JSON.parse(await readFile(join(dir, `${planId}.lock.json`), 'utf8')) as Record<string, unknown>,
  ).toMatchObject({ runId: 'second', released: true });
  expect((await readdir(dir)).filter((name) => name.endsWith('.claim'))).toHaveLength(1);
});

test('a plan id past the bound refuses before creating any artifact', async () => {
  const dir = await directory();
  await expect(acquirePlanLock(dir, `p${'x'.repeat(195)}`, 'too-long')).rejects.toThrow(
    'allow at most 195',
  );
  expect(await readdir(dir)).toEqual([]);
});
