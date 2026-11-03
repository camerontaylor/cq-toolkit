// Split provenance: test/ops/review/addressBookkeeping.test.ts was split into the
// addressBookkeeping.*.test.ts siblings in this directory; shared fixtures live in
// addressBookkeeping.helpers.ts.
import { readFile, symlink, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { expect, test } from 'vitest';
import { fixture, hash } from './addressBookkeeping.helpers.js';

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
