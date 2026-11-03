// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; shared fixtures live in
// addressBookkeeping.helpers.ts.
import { link, mkdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, hash, ownershipReceipt } from './addressBookkeeping.helpers.js';

test.each(['valid', 'changed', 'wrong-name', 'symlink', 'hardlink', 'unregistered'] as const)(
  'exact queue receipt ownership restoration: %s',
  async (mode) => {
    const f = await fixture();
    try {
      const bytes = ownershipReceipt();
      const id = hash(bytes);
      const folder = join(f.root, '.cq/queue-evidence');
      await mkdir(folder, { recursive: true });
      const path = join(folder, (mode === 'wrong-name' ? 'e'.repeat(64) : id) + '.json');
      await writeFile(path, bytes);
      if (mode === 'symlink') {
        await unlink(path);
        await symlink(f.history, path);
      }
      if (mode === 'hardlink') await link(path, join(folder, 'extra'));
      if (mode === 'unregistered') {
        const fresh = f.make();
        await fresh.receipt.prepare(f.root);
        expect(await fresh.receipt.ownedFiles()).not.toContain(path);
        expect(fresh.fingerprints.has(path)).toBe(false);
        return;
      }
      f.original.fingerprints.set(path, hash(bytes));
      if (mode === 'wrong-name' || mode === 'symlink' || mode === 'hardlink') {
        await expect(f.original.receipt.persist()).rejects.toThrow();
        return;
      }
      await f.original.receipt.persist();
      if (mode === 'changed') await writeFile(path, bytes + '\n');
      const fresh = f.make();
      if (mode === 'changed') {
        await expect(fresh.receipt.prepare(f.root)).rejects.toThrow();
        expect(fresh.fingerprints.size).toBe(0);
      } else {
        await fresh.receipt.prepare(f.root);
        expect(fresh.fingerprints.get(path)).toBe(id);
        expect(await fresh.receipt.ownedFiles()).toContain(path);
      }
    } finally {
      await f.repo.cleanup();
    }
  },
);
