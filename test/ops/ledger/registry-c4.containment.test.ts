// Split provenance: test/ops/ledger/registry-c4.test.ts was split into the
// registry-c4.*.test.ts siblings in this directory; shared fixtures live in
// registry-c4.helpers.ts. This file carries the store containment surface
// (root → strict descendant), including the symlink escapes.
import { mkdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { makeLedgerRecord } from '../../../src/ops/ledger/ledger.js';
import { parseLedger } from '../../../src/adapters/store/ledgerStore.js';
import { entryNamed, freshScratch, removeScratch } from './registry-c4.helpers.js';

afterEach(removeScratch);

describe('pathLedgerStore containment (the trust surface is checked at the seam)', () => {
  test('a storePath inside an existing root is accepted (the happy containment row)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const storePath = join(root, 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
  });

  test('a storePath outside the root (a sibling) is refused and nothing is written', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const storePath = join(scratchDir, 'outside.json'); // a sibling of the root
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve inside root');
    }
    // The refused target was never created.
    await expect(stat(storePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a storePath equal to the root is refused (strict descendant, never the root itself)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath: root, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve inside root');
    }
  });

  test('a nonexistent root refuses the store (root must resolve)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'missing');
    const storePath = join(root, 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('root does not resolve');
    }
    // Containment refuses BEFORE any mkdir: the root was never created.
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a root reached THROUGH a symlinked ancestor accepts contained targets (realpath normalizes, never refuses)', async () => {
    const scratchDir = await freshScratch();
    // tmpdir-style layout: the root is itself a symlink to a real dir, the
    // way /var/... aliases /private/var/... on stock macOS.
    const realDir = join(scratchDir, 'real-ws');
    await mkdir(realDir);
    const root = join(scratchDir, 'link-to-ws');
    await symlink(realDir, root);
    const storePath = join(root, 'ledgers', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    // The ledger materialized under the root's REAL location, and a second
    // record through the symlinked root increments the SAME ledger.
    await expect(op({ root, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 2, escalated: false },
    });
    expect(
      parseLedger(await readFile(join(realDir, 'ledgers', 'ledger.json'), 'utf8')).entries,
    ).toEqual([{ signature: 'sig-a', count: 2 }]);
  });

  test('an intermediate symlink UNDER the root pointing outside is refused before any write (stage A: link exists at store creation)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'escape'));
    const storePath = join(root, 'escape', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve inside root');
    }
    // The escape was refused: nothing landed outside the root.
    await expect(stat(join(outside, 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('an intermediate symlink planted AFTER store creation is refused by the stage-B re-verify (naming the escape)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const target = join(root, 'sub', 'ledger.json');
    // Stage A passes on the clean path; the escape appears before the save.
    const { pathLedgerStore } = await import('../../../src/adapters/store/ledgerStore.js');
    const store = pathLedgerStore(root, target);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'sub'));
    const record = makeLedgerRecord(() => store);
    const result = await record({ root, storePath: target, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('strict descendant');
      expect(result.error).toContain('intermediate symlink');
    }
    // Nothing was written through the link.
    await expect(stat(join(outside, 'ledger.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a DANGLING intermediate symlink fails the record without writing anywhere', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    await symlink(join(scratchDir, 'outside'), join(root, 'escape')); // target never exists
    const storePath = join(root, 'escape', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    const result = await op({ root, storePath, signature: 'sig-a' });
    expect(result.status).toBe('failed');
    await expect(stat(join(scratchDir, 'outside'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  test('a ledger FILE behind an escaping intermediate symlink is refused on read (the load-side twin)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'real.json'), '{\n  "version": 1,\n  "entries": []\n}\n', 'utf8');
    await symlink(join(outside, 'real.json'), join(root, 'ledger.json'));
    const query = await entryNamed('ledger.query').importer();
    const result = await query({ root, storePath: join(root, 'ledger.json') });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('strict descendant');
      expect(result.error).toContain('refusing to read');
    }
  });

  test('a query over a DANGLING intermediate symlink is a containment fault, never an ok empty view (PR #78 review: ENOENT ≠ missing file)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    // The escape target never exists, so realpath of the target ENOENTs —
    // the load must NOT read that as "missing in-root ledger" and hand
    // dispatch an empty (all-suppression-dropped) view.
    await symlink(join(scratchDir, 'outside'), join(root, 'escape'));
    const query = await entryNamed('ledger.query').importer();
    const result = await query({ root, storePath: join(root, 'escape', 'ledger.json') });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve');
    }
  });

  test('a direct-store load through an escaping symlink whose file is ABSENT through the link fails, never the empty ledger', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const target = join(root, 'sub', 'ledger.json');
    // Store created on the clean path (stage A passes on missing segments);
    // the escape is planted AFTER creation, pointing at an existing outside
    // dir where the ledger file itself does NOT exist — realpath of the
    // target ENOENTs through the escape, which must surface as a
    // containment fault, not an empty in-root ledger.
    const { pathLedgerStore } = await import('../../../src/adapters/store/ledgerStore.js');
    const store = pathLedgerStore(root, target);
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'sub'));
    expect(() => store.load()).toThrow(/does not resolve inside root.*refusing to read/s);
  });

  test('a query over a dangling symlink with FURTHER absent segments below it is a fault, never an ok empty view (nested ENOENT)', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    // escape dangles AND another component is missing below it: the
    // immediate parent lstat-ENOENTs, so the one-level parent check would
    // read "absent parent ⇒ empty ledger" — the ancestor walk must instead
    // stop AT the dangling link and refuse (PR #93 review, Codex P2 +
    // CodeRabbit Major).
    await symlink(join(scratchDir, 'outside'), join(root, 'escape'));
    const query = await entryNamed('ledger.query').importer();
    const result = await query({ root, storePath: join(root, 'escape', 'missing', 'ledger.json') });
    expect(result.status).toBe('failed');
    if (result.status === 'failed') {
      expect(result.error).toContain('does not resolve');
    }
  });

  test('a direct-store load through an escaping symlink with FURTHER absent segments below it fails, never the empty ledger', async () => {
    const scratchDir = await freshScratch();
    const root = join(scratchDir, 'ws');
    await mkdir(root);
    const target = join(root, 'escape', 'sub', 'ledger.json');
    const { pathLedgerStore } = await import('../../../src/adapters/store/ledgerStore.js');
    const store = pathLedgerStore(root, target);
    // The escape points at an EXISTING outside dir, but both 'sub' and the
    // ledger are absent THROUGH the link — the ancestor walk stops at the
    // link, resolves it outside the root, and refuses.
    const outside = join(scratchDir, 'outside');
    await mkdir(outside);
    await symlink(outside, join(root, 'escape'));
    expect(() => store.load()).toThrow(/does not resolve inside root.*refusing to read/s);
  });
});
