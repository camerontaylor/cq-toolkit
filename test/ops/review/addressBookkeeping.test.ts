import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { makeAddressBookkeepingReceipt } from '../../../src/ops/review/internal/addressBookkeeping.js';
import { DEV_LEDGER_VERSION, devLedgerPath } from '../../../src/ops/dev/record.js';
import { makeTestRepo } from '../dev/repo.js';

const hash = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
async function fixture() {
  const repo = await makeTestRepo();
  const root = await realpath(repo.root);
  const head = repo.git('rev-parse', 'HEAD').trim();
  const branch = 'feature/x';
  const path = join(root, '.git/cq-review-address/test/bookkeeping.json');
  const ledger = devLedgerPath(root, branch);
  const history = join(root, '.cq/review', encodeURIComponent(branch), '1.json');
  const ledgerText =
    JSON.stringify({
      version: DEV_LEDGER_VERSION,
      branch,
      records: [
        {
          kind: 'disposition',
          findingId: 'f',
          action: 'fixed',
          why: 'verified locally',
          head,
          at: '2026-10-24T00:00:00Z',
        },
      ],
    }) + '\n';
  const historyText =
    JSON.stringify({ schemaVersion: 1, branch, head, sources: [], findings: [] }) + '\n';
  await mkdir(dirname(path), { recursive: true });
  await mkdir(dirname(ledger), { recursive: true });
  await mkdir(dirname(history), { recursive: true });
  let beforeGit: ((args: string[]) => Promise<void>) | undefined;
  const make = (fingerprints = new Map<string, string>()) => ({
    fingerprints,
    receipt: makeAddressBookkeepingReceipt({
      path,
      identity: 'test-identity',
      fingerprints,
      git: async (cwd, args) => {
        await beforeGit?.(args);
        return repo.git('-C', cwd, ...args).trim();
      },
    }),
  });
  const original = make();
  await original.receipt.prepare(root);
  await writeFile(ledger, ledgerText);
  await writeFile(history, historyText);
  original.fingerprints.set(ledger, hash(ledgerText));
  original.fingerprints.set(history, hash(historyText));
  await original.receipt.persist();
  return {
    repo,
    root,
    branch,
    head,
    path,
    ledger,
    ledgerText,
    history,
    historyText,
    make,
    original,
    setBeforeGit: (action: (args: string[]) => Promise<void>) => {
      beforeGit = action;
    },
  };
}

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

test.each([
  'corrupt',
  'wrong-root',
  'wrong-branch',
  'wrong-identity',
  'stale-head',
  'duplicate-path',
  'escape',
  'unknown-path',
  'changed-ledger',
  'changed-history',
  'missing-leaf',
  'symlink-leaf',
  'malformed-ledger',
  'malformed-history',
  'ledger-branch',
  'history-branch',
  'ledger-head',
  'history-head',
  'receipt-symlink',
] as const)('private receipt refuses %s without adopting or rewriting bytes', async (mode) => {
  const f = await fixture();
  try {
    const raw = JSON.parse(await readFile(f.path, 'utf8')) as {
      files: Array<{ path: string; sha256: string }>;
      root: string;
      branch: string;
      identity: string;
      head: string;
    };
    const updateLeaf = async (path: string, text: string) => {
      await writeFile(path, text);
      raw.files.find((row: { path: string }) => row.path === relative(f.root, path))!.sha256 =
        hash(text);
    };
    if (mode === 'wrong-root') raw.root = dirname(f.root);
    if (mode === 'wrong-branch') raw.branch = 'different';
    if (mode === 'wrong-identity') raw.identity = 'other-pr-or-actor';
    if (mode === 'stale-head') raw.head = 'f'.repeat(40);
    if (mode === 'duplicate-path') raw.files.push(raw.files[0]!);
    if (mode === 'escape') raw.files[0]!.path = '../caller.json';
    if (mode === 'unknown-path') raw.files[0]!.path = '.cq/private.json';
    if (mode === 'changed-ledger') await writeFile(f.ledger, f.ledgerText + '\n');
    if (mode === 'changed-history') await writeFile(f.history, f.historyText + '\n');
    if (mode === 'missing-leaf') await unlink(f.history);
    if (mode === 'symlink-leaf') {
      await unlink(f.history);
      await symlink(f.ledger, f.history);
    }
    if (mode === 'malformed-ledger') await updateLeaf(f.ledger, '{bad');
    if (mode === 'malformed-history') await updateLeaf(f.history, '{bad');
    if (mode === 'ledger-branch' || mode === 'ledger-head') {
      const ledger = JSON.parse(f.ledgerText) as {
        branch: string;
        records: Array<{ head: string }>;
      };
      if (mode === 'ledger-branch') ledger.branch = 'different';
      else ledger.records[0]!.head = 'f'.repeat(40);
      await updateLeaf(f.ledger, JSON.stringify(ledger));
    }
    if (mode === 'history-branch' || mode === 'history-head') {
      const history = JSON.parse(f.historyText) as { branch: string; head: string };
      if (mode === 'history-branch') history.branch = 'different';
      else history.head = 'f'.repeat(40);
      await updateLeaf(f.history, JSON.stringify(history));
    }
    await writeFile(f.path, mode === 'corrupt' ? '{bad' : JSON.stringify(raw));
    if (mode === 'receipt-symlink') {
      const outside = join(dirname(f.path), 'caller-receipt.json');
      await writeFile(outside, await readFile(f.path));
      await unlink(f.path);
      await symlink(outside, f.path);
    }
    const before = await readFile(f.path, 'utf8');
    const fresh = f.make();
    await expect(fresh.receipt.prepare(f.root)).rejects.toThrow();
    expect(fresh.fingerprints.size).toBe(0);
    expect(await readFile(f.path, 'utf8')).toBe(before);
  } finally {
    await f.repo.cleanup();
  }
});

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
