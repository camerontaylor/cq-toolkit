// Ledger lane C4 — registry-slice test evidence: the two entries
// (ledger.record, ledger.query) validate the full input and only it —
// strict unknown-key rejection, because a smuggled field would cross the
// plain-JSON boundary the input-driven store binding depends on — and
// their importers resolve end-to-end through the REAL pathLedgerStore (the
// one place real fs is allowed here, mirroring C1's subprocessRunCheck
// precedent): a record→query round trip over a mkdtemp file, cleaned up
// per test.
import { lstat, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/ledger/registry.js';
import { LedgerQueryInputSchema, LedgerRecordInputSchema } from '../../../src/ops/ledger/registry.js';
import { parseLedger, serializeLedger } from '../../../src/ops/ledger/store.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';

let scratchDir = '';

afterEach(async () => {
  if (scratchDir !== '') {
    await rm(scratchDir, { recursive: true, force: true });
    scratchDir = '';
  }
});

function entryNamed(name: string): OpRegistryEntry {
  const entry = registry.find((candidate) => candidate.name === name);
  if (!entry) {
    throw new Error(`${name} missing from the ledger registry`);
  }
  return entry;
}

describe('ledger registry: the two C4 entries', () => {
  test('the registry names the lane ops', () => {
    expect(registry.map((entry) => entry.name)).toEqual(['ledger.record', 'ledger.query']);
  });
});

describe('LedgerRecordInputSchema / LedgerQueryInputSchema (full input, and only it)', () => {
  test('accepts the plain JSON a dispatcher sends (storePath-based, optional fields included)', () => {
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 'sig-a' }).success).toBe(true);
    expect(
      LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 'sig-a', component: 'c', note: 'n' })
        .success,
    ).toBe(true);
    expect(LedgerQueryInputSchema.safeParse({ storePath: 'l.json' }).success).toBe(true);
  });

  test('rejects smuggled unknown keys at every level (strict)', () => {
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's', memoize: true }).success).toBe(
      false,
    );
    expect(
      LedgerRecordInputSchema.safeParse({
        storePath: 'l.json',
        signature: 's',
        thresholds: { suppressAt: 1, escalateAt: 2, cache: true },
      }).success,
    ).toBe(false);
    expect(LedgerQueryInputSchema.safeParse({ storePath: 'l.json', store: {} }).success).toBe(false);
  });

  test('rejects missing/empty storePath and out-of-bounds signatures', () => {
    expect(LedgerRecordInputSchema.safeParse({ signature: 's' }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ storePath: '', signature: 's' }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: '' }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's'.repeat(501) }).success).toBe(
      false,
    );
    expect(LedgerQueryInputSchema.safeParse({}).success).toBe(false);
  });

  test('bounds component at 200 and note at 500 chars, mirroring the op-level validation', () => {
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's', component: 'c'.repeat(200) }).success).toBe(true);
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's', component: 'c'.repeat(201) }).success).toBe(false);
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's', note: 'n'.repeat(500) }).success).toBe(true);
    expect(LedgerRecordInputSchema.safeParse({ storePath: 'l.json', signature: 's', note: 'n'.repeat(501) }).success).toBe(false);
  });
});

describe('the C4 importers resolve end-to-end (real pathLedgerStore over a mkdtemp file)', () => {
  test('ledger.record: record → suppress → escalate against a real file, including the mkdir -p parent', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    // A missing parent directory: the save must create it.
    const storePath = join(scratchDir, 'state', 'nested', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    await expect(op({ storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 2, escalated: false },
    });
    await expect(op({ storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'needs-human',
      reason: 'error signature exceeded escalation threshold: sig-a (count 3 ≥ 3)',
    });
    // The committed bytes are the canonical format: parseable, sorted.
    expect(parseLedger(await readFile(storePath, 'utf8'))).toEqual({
      version: 1,
      entries: [{ signature: 'sig-a', count: 3 }],
    });
  });

  test('ledger.query: the importer-bound query reads the same file the record wrote', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    const query = await entryNamed('ledger.query').importer();
    await record({ storePath, signature: 'sig-z' });
    await record({ storePath, signature: 'sig-a' });
    await record({ storePath, signature: 'sig-a' });
    await expect(query({ storePath })).resolves.toEqual({
      status: 'ok',
      value: {
        entries: [
          { signature: 'sig-a', count: 2 },
          { signature: 'sig-z', count: 1 },
        ],
        knownNoise: ['sig-a'],
        needsHuman: [],
      },
    });
    // The persisted BYTES are canonical: byte-identical to their own
    // serialize∘parse fixpoint AND to the hand-built expected string.
    const content = await readFile(storePath, 'utf8');
    expect(content).toBe(serializeLedger(parseLedger(content)));
    expect(content).toBe(
      `{
  "version": 1,
  "entries": [
    {
      "signature": "sig-a",
      "count": 2
    },
    {
      "signature": "sig-z",
      "count": 1
    }
  ]
}
`,
    );
  });

  test('the store is input-driven: two paths keep independent counts', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const op = await entryNamed('ledger.record').importer();
    const firstPath = join(scratchDir, 'one.json');
    const secondPath = join(scratchDir, 'two.json');
    await op({ storePath: firstPath, signature: 'sig-a' });
    await op({ storePath: firstPath, signature: 'sig-a' });
    await expect(op({ storePath: secondPath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
  });

  test('a corrupt committed file is failed for record AND query (a LedgerFormatError from parseLedger, mapped by the ops)', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ storePath, signature: 'sig-b' });
    const corrupted = (await readFile(storePath, 'utf8')).replace('"count": 1', '"count": 0');
    await writeFile(storePath, corrupted, 'utf8');
    const recorded = await record({ storePath, signature: 'sig-b' });
    expect(recorded.status).toBe('failed');
    if (recorded.status === 'failed') {
      expect(recorded.error).toContain('ledger: schema violation');
    }
    const query = await entryNamed('ledger.query').importer();
    const queried = await query({ storePath });
    expect(queried.status).toBe('failed');
    if (queried.status === 'failed') {
      expect(queried.error).toContain('ledger: schema violation');
    }
  });
});

describe('pathLedgerStore.save is an atomic publish (temp + rename, never a bare write)', () => {
  test('a successful save (create AND rewrite) leaves no leftover temp files', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ storePath, signature: 'sig-a' });
    await record({ storePath, signature: 'sig-a' }); // a rewrite, not just a create
    expect(await readdir(scratchDir)).toEqual(['ledger.json']);
  });

  test('a pre-planted symlink at the ledger path is replaced, never followed', async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'ledger-'));
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
    await expect(record({ storePath, signature: 'sig-a' })).resolves.toEqual({
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
});
