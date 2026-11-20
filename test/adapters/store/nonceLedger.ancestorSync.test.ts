import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';

// Directory fds opened read-only, then the paths whose fsync actually succeeded.
const openedDirs = new Map<number, string>();
const synced: string[] = [];
let failDirSync = false;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    openSync: ((path: unknown, flags: unknown, ...rest: unknown[]) => {
      const fd = (real.openSync as (...args: unknown[]) => number)(path, flags, ...rest);
      if (flags === 'r' && typeof path === 'string') openedDirs.set(fd, path);
      return fd;
    }) as typeof real.openSync,
    fsyncSync: ((fd: number) => {
      const path = openedDirs.get(fd);
      if (failDirSync && path !== undefined) {
        throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });
      }
      real.fsyncSync(fd);
      if (path !== undefined) synced.push(path);
    }) as typeof real.fsyncSync,
  };
});

const { makeFileNonceLedger } = await import('../../../src/adapters/store/nonceLedger.js');

afterEach(() => {
  openedDirs.clear();
  synced.length = 0;
  failDirSync = false;
});

describe('nonce ledger ancestor durability', () => {
  test('syncs every ancestor entry even when the directories already existed', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cq-ancestors-')));
    // Created up front, as another process would: no directory is new to the ledger.
    const dir = join(root, 'new', 'nonces');
    mkdirSync(dir, { recursive: true });
    const ledger = makeFileNonceLedger(join(dir, 'approvals.ndjson'));
    expect(await ledger.consume('f'.repeat(32))).toBe('consumed');
    const syncedSet = new Set(synced);
    // The file's directory, then each ancestor up to and including the filesystem
    // root, whose entry holds the next level down.
    for (let current = dir; ; current = dirname(current)) {
      expect(syncedSet.has(current), `${current} was not synced`).toBe(true);
      if (current === dirname(current)) break;
    }
  });

  test('a failed ancestor sync after the append is reported INDETERMINATE with its cause', async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'cq-ancestors-')));
    const dir = join(root, 'new', 'nonces');
    mkdirSync(dir, { recursive: true });
    const ledger = makeFileNonceLedger(join(dir, 'approvals.ndjson'));
    failDirSync = true;
    const failure = await ledger.consume('e'.repeat(32)).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/INDETERMINATE/);
    expect(((failure as Error).cause as Error).message).toMatch(/injected directory sync failure/);
  });
});
