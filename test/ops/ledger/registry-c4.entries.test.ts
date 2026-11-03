// Split provenance: test/ops/ledger/registry-c4.test.ts was split into the
// registry-c4.*.test.ts siblings in this directory; shared fixtures live in
// registry-c4.helpers.ts. This file carries the lane entry list and the C4
// importers' end-to-end resolution over the real pathLedgerStore.
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { registry } from '../../../src/ops/ledger/registry.js';
import { parseLedger, serializeLedger } from '../../../src/adapters/store/ledgerStore.js';
import { entryNamed, freshScratch, removeScratch } from './registry-c4.helpers.js';

afterEach(removeScratch);

describe('ledger registry: the two C4 entries', () => {
  test('the registry names the lane ops', () => {
    expect(registry.map((entry) => entry.name)).toEqual(['ledger.record', 'ledger.query']);
  });
});

describe('the C4 importers resolve end-to-end (real pathLedgerStore over a mkdtemp root)', () => {
  test('ledger.record: record → suppress → escalate inside the root, including the mkdir -p parent', async () => {
    const scratchDir = await freshScratch();
    // A missing parent directory inside the root: the save must create it.
    const storePath = join(scratchDir, 'state', 'nested', 'ledger.json');
    const op = await entryNamed('ledger.record').importer();
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 2, escalated: false },
    });
    await expect(op({ root: scratchDir, storePath, signature: 'sig-a' })).resolves.toEqual({
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
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    const query = await entryNamed('ledger.query').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-z' });
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    await record({ root: scratchDir, storePath, signature: 'sig-a' });
    await expect(query({ root: scratchDir, storePath })).resolves.toEqual({
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

  test('the store is input-driven: two paths inside one root keep independent counts', async () => {
    const scratchDir = await freshScratch();
    const op = await entryNamed('ledger.record').importer();
    const firstPath = join(scratchDir, 'one.json');
    const secondPath = join(scratchDir, 'two.json');
    await op({ root: scratchDir, storePath: firstPath, signature: 'sig-a' });
    await op({ root: scratchDir, storePath: firstPath, signature: 'sig-a' });
    await expect(
      op({ root: scratchDir, storePath: secondPath, signature: 'sig-a' }),
    ).resolves.toEqual({
      status: 'ok',
      value: { signature: 'sig-a', count: 1, escalated: false },
    });
  });

  test('a corrupt committed file is failed for record AND query (a LedgerFormatError from parseLedger, mapped by the ops)', async () => {
    const scratchDir = await freshScratch();
    const storePath = join(scratchDir, 'ledger.json');
    const record = await entryNamed('ledger.record').importer();
    await record({ root: scratchDir, storePath, signature: 'sig-b' });
    const corrupted = (await readFile(storePath, 'utf8')).replace('"count": 1', '"count": 0');
    await writeFile(storePath, corrupted, 'utf8');
    const recorded = await record({ root: scratchDir, storePath, signature: 'sig-b' });
    expect(recorded.status).toBe('failed');
    if (recorded.status === 'failed') {
      expect(recorded.error).toContain('ledger: schema violation');
    }
    const query = await entryNamed('ledger.query').importer();
    const queried = await query({ root: scratchDir, storePath });
    expect(queried.status).toBe('failed');
    if (queried.status === 'failed') {
      expect(queried.error).toContain('ledger: schema violation');
    }
  });
});
