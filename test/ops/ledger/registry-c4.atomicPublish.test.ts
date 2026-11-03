// Split provenance: test/ops/ledger/registry-c4.test.ts was split into the
// registry-c4.*.test.ts siblings in this directory; shared fixtures live in
// registry-c4.helpers.ts. This file carries the atomic publish (temp + rename,
// never a bare write).
import { chmod, lstat, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { parseLedger } from '../../../src/adapters/store/ledgerStore.js';
import { entryNamed, freshScratch, removeScratch } from './registry-c4.helpers.js';

afterEach(removeScratch);

describe('pathLedgerStore.save is an atomic publish (temp + rename, never a bare write)', () => {
  test('a successful save (create AND rewrite) leaves no leftover temp files', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    await record({ root: scratchDir, storePath, signature: 'sig-a' }); // a rewrite, not just a create
    expect(await readdir(scratchDir)).toEqual(['ledger.json']);
  });

  test('a pre-planted symlink at the ledger path is replaced, never followed', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    // The sentinel holds VALID ledger content so the record's read (which
    // legitimately follows the symlink, like any file read) reaches the
    // save — the load-bearing assertion is that the PUBLISH does not write
    // through the link: a bare writeFileSync would clobber the sentinel's
    // bytes; temp+rename leaves them exactly as written.
    const sentinelBytes = '{\n  "version": 1,\n  "entries": []\n}\n';
    const sentinelPath = join(scratchDir, 'sentinel.txt');
    await writeFile(sentinelPath, sentinelBytes, 'utf8');
    await symlink(sentinelPath, storePath);
    const record = await entryNamed('ledger.record').importer();
    await expect(record({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    // The sentinel the symlink pointed at is untouched…
    expect(await readFile(sentinelPath, 'utf8')).toBe(sentinelBytes);
    // …and the ledger path is now a REGULAR file holding the record.
    const stat = await lstat(storePath);
    expect(stat.isFile()).toBe(true);
    expect(stat.isSymbolicLink()).toBe(false);
    expect(parseLedger(await readFile(storePath, 'utf8')).entries).toEqual([
      { signature: 'sig-a', count: 1 },
    ]);
  });

  test('a NEW ledger is created 0600 and an update PRESERVES the ledger mode (the inode swap never widens permissions)', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    // The first publish is a fresh create: restrictive by default — 0600,
    // not the 0666&umask (typically 0644) a bare writeFileSync temp gets.
    expect((await stat(storePath)).mode & 0o777).toBe(0o600);
    // An operator tightens it further still (a group-readable 0640 proof:
    // any non-default mode works); the next record swaps the inode via
    // temp+rename and must carry the mode ACROSS the swap.
    await chmod(storePath, 0o640);
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    expect((await stat(storePath)).mode & 0o777).toBe(0o640);
    expect(parseLedger(await readFile(storePath, 'utf8')).entries).toEqual([
      { signature: 'sig-a', count: 2 },
    ]);
  });

  // Root bypasses directory permission bits, so the chmod-0000 precondition
  // cannot be produced under UID 0 — skip there (PR #95 review, Codex P2;
  // same posture as the EACCES test in test/cli/machine-mode-pins.test.ts).
  test.skipIf(process.getuid?.() === 0)(
    'an unreadable target metadata PROPAGATES from the mode probe — never a silent 0600 replacement (non-ENOENT lstat faults)',
    async () => {
      const scratchDir = await freshScratch();
      const root = join(scratchDir, 'ws');
      const stateDir = join(root, 'state');
      await mkdir(stateDir, { recursive: true });
      const storePath = join(stateDir, 'ledger.json');
      const record = await entryNamed('ledger.record').importer();
      await record({ root, storePath, signature: 'sig-a' });
      await chmod(storePath, 0o640);
      const before = await readFile(storePath, 'utf8');
      // Deny search on the containing dir: lstat of the target now fails
      // EACCES. The publish must fail with THAT fault (the message names the
      // lstat), not swallow it and swap the 0640 ledger for a 0600
      // replacement (PR #93 review, CodeRabbit Minor).
      await chmod(stateDir, 0o000);
      const { pathLedgerStore } = await import('../../../src/adapters/store/ledgerStore.js');
      const store = pathLedgerStore(root, storePath);
      try {
        expect(() =>
          store.save({ version: 1, entries: [{ signature: 'sig-b', count: 1 }] }),
        ).toThrow(/lstat/);
      } finally {
        await chmod(stateDir, 0o755);
      }
      // The refused publish changed nothing: same bytes, same mode.
      expect(await readFile(storePath, 'utf8')).toBe(before);
      expect((await stat(storePath)).mode & 0o777).toBe(0o640);
    },
  );
});
