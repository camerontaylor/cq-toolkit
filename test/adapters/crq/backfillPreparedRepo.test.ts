import { describe, expect, it } from 'vitest';
import {
  gitChangedPaths,
  preparedBackfillRepo,
  type BackfillAsyncGit,
} from '../../../src/adapters/crq/backfillPreparedRepo.js';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import type { BackfillStore } from '../../../src/policy/crq/backfillCompletion.js';
import { JsonObject } from '../../../src/policy/crq/jsonValue.js';

const revs = { base: 'b'.repeat(40), head: 'a'.repeat(40), target: 'c'.repeat(40) };
const syncStore: BackfillStore = { put: () => 'unused' };
const store = { put: async () => ({ sha256: 'x', location: '/x' }), verify: async () => undefined };

function fakeGit(log: string[] = []): BackfillAsyncGit {
  return {
    entries: async (rev) => {
      log.push(`entries ${rev}`);
      return new Map([['f.ts', { blob: rev }]]);
    },
    changedIntervals: async () => new Map([['f.ts', new Set([1, 2])]]),
    changedPaths: async () => ['f.ts'],
    retain: async (_s, r) => {
      log.push(`retain ${[...r].join(',')}`);
      return { sha256: 'd'.repeat(64), location: '/d', kind: 'git-bundle' };
    },
    verifyReview: async (event) => {
      log.push(`verify ${event.get('id') as string}`);
      if (event.get('id') === 'bad') throw new Error('review tree mismatch');
    },
  };
}

describe('preparedBackfillRepo', () => {
  it('serves prepared facts synchronously, including the bundle reference', async () => {
    const { repo, prepare } = preparedBackfillRepo(fakeGit());
    await prepare(revs, store);
    expect(repo.entries(revs.head).get('f.ts')).toEqual({ blob: revs.head });
    expect([...repo.changedIntervals(revs.base, revs.head).get('f.ts')!]).toEqual([1, 2]);
    expect(repo.changedPaths(revs.base, revs.head)).toEqual(['f.ts']);
    const bundle = repo.retain(syncStore, [
      revs.target,
      revs.head,
      revs.base,
      revs.head,
    ]) as JsonObject;
    expect(bundle.entries).toEqual([
      ['sha256', 'd'.repeat(64)],
      ['location', '/d'],
      ['kind', 'git-bundle'],
    ]);
  });

  it('refuses a rev, diff or bundle that was not prepared', async () => {
    const { repo, prepare } = preparedBackfillRepo(fakeGit());
    expect(() => repo.entries(revs.head)).toThrow('was not prepared');
    await prepare(revs, store);
    expect(() => repo.entries('d'.repeat(40))).toThrow('was not prepared');
    expect(() => repo.changedIntervals(revs.head, revs.base)).toThrow('was not prepared');
    expect(() => repo.changedPaths(revs.head, revs.base)).toThrow('was not prepared');
    expect(() => repo.retain(syncStore, [revs.head])).toThrow('was not prepared');
  });

  it('records verifyReview and runs it once, failing before any write', async () => {
    const log: string[] = [];
    const { repo, prepare, verifyRecorded } = preparedBackfillRepo(fakeGit(log));
    await prepare(revs, store);
    repo.verifyReview(new JsonObject([['id', 'good']]));
    expect(log.some((l) => l.startsWith('verify'))).toBe(false);
    await verifyRecorded();
    await verifyRecorded();
    expect(log.filter((l) => l.startsWith('verify'))).toEqual(['verify good']);
    repo.verifyReview(new JsonObject([['id', 'bad']]));
    await expect(verifyRecorded()).rejects.toThrow('review tree mismatch');
  });
});

describe('gitChangedPaths', () => {
  const call = (code: number | null, out: string) =>
    (async (args) => ({
      args,
      code,
      stdout: new TextEncoder().encode(out),
      stderr: 'e',
    })) as RunGit;
  it('splits NUL-separated names and refuses a failed diff or bad UTF-8', async () => {
    expect(await gitChangedPaths(call(0, 'a.ts\0dir/b ü.ts\0'))('x', 'y')).toEqual([
      'a.ts',
      'dir/b ü.ts',
    ]);
    await expect(gitChangedPaths(call(128, ''))('x', 'y')).rejects.toThrow();
    const bad: RunGit = async (args) => ({
      args,
      code: 0,
      stdout: Uint8Array.of(0xff),
      stderr: '',
    });
    await expect(gitChangedPaths(bad)('x', 'y')).rejects.toThrow();
  });
});
