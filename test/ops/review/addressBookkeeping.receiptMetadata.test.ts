// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; shared fixtures live in
// addressBookkeeping.helpers.ts.
import { lstat, mkdir, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expect, test } from 'vitest';
import { makeAddressBookkeepingReceipt } from '../../../src/ops/review/internal/addressBookkeeping.js';
import { DEV_LEDGER_VERSION, devLedgerPath } from '../../../src/ops/dev/record.js';
import { makeTestRepo } from '../dev/repo.js';
import { fixture, hash } from './addressBookkeeping.helpers.js';

test.each(['sha1', 'sha256'] as const)(
  'private receipt preserves exact metadata bytes (%s)',
  async (format) => {
    // Receipt object IDs accept both supported Git object formats.
    const f = await fixture();
    try {
      if (format === 'sha256') {
        // A real SHA-256 repo is exercised below, rather than accepting a padded SHA-1 id.
        const repo = await makeTestRepo({ objectFormat: 'sha256' });
        try {
          const root = await realpath(repo.root);
          const head = repo.git('rev-parse', 'HEAD').trim();
          expect(head).toHaveLength(64);
          const path = join(root, '.git/bookkeeping.json');
          const fingerprints = new Map<string, string>();
          const make = () =>
            makeAddressBookkeepingReceipt({
              path,
              identity: 'sha256',
              fingerprints,
              git: async (cwd, args) => repo.git('-C', cwd, ...args).trim(),
            });
          const receipt = make();
          await receipt.prepare(root);
          const ledger = devLedgerPath(root, 'feature/x');
          await mkdir(dirname(ledger), { recursive: true });
          const text =
            JSON.stringify({ version: DEV_LEDGER_VERSION, branch: 'feature/x', records: [] }) +
            '\n';
          await writeFile(ledger, text);
          fingerprints.set(ledger, hash(text));
          await receipt.persist();
          fingerprints.clear();
          await make().prepare(root);
          expect(fingerprints.get(ledger)).toBe(hash(text));
        } finally {
          await repo.cleanup();
        }
      } else {
        const fresh = f.make();
        const alias = join(f.root, '.git/root-alias');
        await symlink(f.root, alias, 'dir');
        await fresh.receipt.prepare(alias);
        expect([...fresh.fingerprints]).toEqual([...f.original.fingerprints]);
        expect(await readFile(f.ledger, 'utf8')).toBe(f.ledgerText);
        expect(await readFile(f.history, 'utf8')).toBe(f.historyText);
        expect((await lstat(f.path)).mode & 0o777).toBe(0o600);
        expect(await readdir(dirname(f.path))).toEqual(['bookkeeping.json']);
      }
    } finally {
      await f.repo.cleanup();
    }
  },
);
