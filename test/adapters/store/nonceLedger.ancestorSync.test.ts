import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

const opened: string[] = [];
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: ((path: unknown, flags: unknown, ...rest: unknown[]) => {
      if (flags === 'r' && typeof path === 'string') opened.push(path);
      return (real.openSync as (...args: unknown[]) => number)(path, flags, ...rest);
    }) as typeof real.openSync,
  };
});

const { makeFileNonceLedger } = await import('../../../src/adapters/store/nonceLedger.js');

afterEach(() => {
  opened.length = 0;
});

describe('nonce ledger ancestor durability', () => {
  test('syncs every ancestor entry even when the directories already existed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cq-ancestors-')));
    // Created up front, as another process would: no directory is new to the ledger.
    const dir = join(root, 'new', 'nonces');
    mkdirSync(dir, { recursive: true });
    const ledger = makeFileNonceLedger(join(dir, 'approvals.ndjson'));
    expect(await ledger.consume('f'.repeat(32))).toBe('consumed');
    const synced = new Set(opened);
    // The file's directory, then each ancestor whose entry holds the next level down.
    for (let current = dir; current !== dirname(current); current = dirname(current)) {
      expect(synced.has(current), `${current} was not synced`).toBe(true);
    }
    expect(synced.has(dirname(join(root, 'new')))).toBe(true);
  });
});
