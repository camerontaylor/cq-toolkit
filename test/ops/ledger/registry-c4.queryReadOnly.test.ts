// Split provenance: test/ops/ledger/registry-c4.test.ts was split into the
// registry-c4.*.test.ts siblings in this directory; shared fixtures live in
// registry-c4.helpers.ts. This file carries the read-only pin: a query over a
// real path creates nothing.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { entryNamed, freshScratch, removeScratch } from './registry-c4.helpers.js';

afterEach(removeScratch);

describe('ledger.query is fs-READ-ONLY (the read-only pin)', () => {
  /** The full directory tree as sorted, typed entries — the byte-identity snapshot. */
  async function treeSnapshot(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    return entries
      .map(
        (entry) =>
          `${entry.parentPath}/${entry.name}:${entry.isDirectory() ? 'd' : entry.isSymbolicLink() ? 'l' : 'f'}`,
      )
      .sort();
  }

  test('queries over a real path create NOTHING: the directory tree is identical before and after', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-a' });

    const before = await treeSnapshot(scratchDir);
    expect(before).toContain(`${scratchDir}/ledger.json:f`); // the snapshot sees the real tree
    const ledgerBytes = await readFile(storePath, 'utf8');

    const query = await entryNamed('ledger.query').importer();
    await expect(query({ root: scratchDir, storePath })).resolves.toEqual({
      status: 'ok',
      value: {
        entries: [{ signature: 'sig-a', count: 1 }],
        knownNoise: [],
        needsHuman: [],
      },
    });
    // A query over a MISSING path (parent included) must not mkdir either —
    // including NESTED missing segments: clean absence under an in-root
    // ancestor stays the empty ledger (the contrast case for the
    // dangling-symlink queries, which must fault).
    await expect(
      query({ root: scratchDir, storePath: join(scratchDir, 'missing', 'ledger.json') }),
    ).resolves.toEqual({
      status: 'ok',
      value: { entries: [], knownNoise: [], needsHuman: [] },
    });
    await expect(
      query({ root: scratchDir, storePath: join(scratchDir, 'missing', 'deeper', 'ledger.json') }),
    ).resolves.toEqual({
      status: 'ok',
      value: { entries: [], knownNoise: [], needsHuman: [] },
    });

    // No files, dirs, or lock dirs appeared: the tree is byte-identical.
    expect(await treeSnapshot(scratchDir)).toEqual(before);
    // A rewrite of ledger.json would pass the tree snapshot: compare the bytes too.
    expect(await readFile(storePath, 'utf8')).toBe(ledgerBytes);
  });
});
