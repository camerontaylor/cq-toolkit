// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; shared fixtures live in
// addressBookkeeping.helpers.ts.
import { writeFile } from 'node:fs/promises';
import { expect, test } from 'vitest';
import { parseDevLedger, serializeDevLedger } from '../../../src/ops/dev/record.js';
import { fixture, hash } from './addressBookkeeping.helpers.js';

test.each(['valid', 'bound-head', 'base', 'changed-bytes'] as const)(
  'vendor debt bookkeeping validates exact bytes and bound ancestry: %s',
  async (mode) => {
    const f = await fixture();
    try {
      const base = f.repo.git('merge-base', 'origin/main', 'HEAD').trim();
      const ledger = parseDevLedger(f.ledgerText);
      ledger.records.push({
        kind: 'vendor-debt',
        at: '2026-10-28T00:00:00Z',
        debt: {
          reference: {
            requestId: 'intent-1',
            binding: {
              kind: 'deferred-author',
              repo: 'owner/repo',
              producer: 'author',
              head: mode === 'bound-head' ? 'f'.repeat(40) : f.head,
              target: 'main',
              targetSelector: 'promoted-main',
            },
          },
          deferral: {
            id: 'intent-1',
            base: mode === 'base' ? 'f'.repeat(40) : base,
            dirtySha256: 'clean-tree',
          },
          originAttempt: {
            cycleId: 'c001-outage',
            head: f.head,
            base,
            target: 'main',
            scope: 'full',
            dirtySha256: 'clean-tree',
            failure: { source: 'vendor', category: 'vendor-unavailable', codes: ['con_err'] },
          },
          vendor: 'vendor-blocked-transient',
          vendorCompleted: false,
          queue: {
            state: 'awaiting-pr',
            pr: null,
            mergeSha: null,
            itemId: null,
            receiptId: null,
            consumed: false,
            reviewed: false,
            fixed: false,
          },
        },
      });
      const text = serializeDevLedger(ledger);
      await writeFile(f.ledger, text);
      f.original.fingerprints.set(f.ledger, hash(text));
      await f.original.receipt.persist();
      if (mode === 'changed-bytes') await writeFile(f.ledger, text + '\n');
      const fresh = f.make();
      if (mode === 'valid') {
        await fresh.receipt.prepare(f.root);
        expect(fresh.fingerprints.get(f.ledger)).toBe(hash(text));
        expect(ledger.records.at(-1)).toMatchObject({ debt: { vendorCompleted: false } });
      } else {
        await expect(fresh.receipt.prepare(f.root)).rejects.toThrow();
        expect(fresh.fingerprints.size).toBe(0);
      }
    } finally {
      await f.repo.cleanup();
    }
  },
);
