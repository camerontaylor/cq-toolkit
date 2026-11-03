// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; shared fixtures live in
// addressBookkeeping.helpers.ts.
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { expect, test } from 'vitest';
import { fixture } from './addressBookkeeping.helpers.js';

test.each(['changed', 'removed', 'unexpected-new'] as const)(
  'receipt replacement refuses %s caller receipt',
  async (mode) => {
    const f = await fixture();
    try {
      let receipt = f.original.receipt;
      if (mode === 'unexpected-new') {
        await unlink(f.path);
        receipt = f.make().receipt;
        await receipt.prepare(f.root);
      }
      if (mode === 'removed') await unlink(f.path);
      else await writeFile(f.path, 'CALLER RECEIPT BYTES\n');
      await expect(receipt.persist()).rejects.toThrow(/receipt changed outside engine/);
      if (mode !== 'removed') expect(await readFile(f.path, 'utf8')).toBe('CALLER RECEIPT BYTES\n');
      expect((await readdir(dirname(f.path))).some((name) => name.endsWith('.tmp'))).toBe(false);
    } finally {
      await f.repo.cleanup();
    }
  },
);

test('receipt changed while constructing replacement is preserved and owned temp is cleaned', async () => {
  const f = await fixture();
  try {
    let changed = false;
    f.setBeforeGit(async (args) => {
      if (args[0] === 'symbolic-ref' && !changed) {
        changed = true;
        await writeFile(f.path, 'CALLER BYTES DURING RECEIPT WRITE\n');
      }
    });
    await expect(f.original.receipt.persist()).rejects.toThrow(/receipt changed outside engine/);
    expect(changed).toBe(true);
    expect(await readFile(f.path, 'utf8')).toBe('CALLER BYTES DURING RECEIPT WRITE\n');
    expect(await readdir(dirname(f.path))).toEqual(['bookkeeping.json']);
  } finally {
    await f.repo.cleanup();
  }
});
