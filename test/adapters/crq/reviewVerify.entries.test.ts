import { describe, expect, test } from 'vitest';
import { repositoryEntries } from '../../../src/adapters/crq/reviewVerify.js';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';

const blob = (c: string) => c.repeat(40);
const record = (name: Uint8Array, id: string) =>
  Buffer.concat([Buffer.from(`100644 blob ${id}\t`), Buffer.from(name), Buffer.from([0])]);
const runGit =
  (...records: Buffer[]): RunGit =>
  async () =>
    ({ code: 0, stdout: Buffer.concat(records), stderr: '' }) as never;

describe('repositoryEntries path keys', () => {
  test('keeps an undecodable path under its byte-hex fallback key', async () => {
    const entries = await repositoryEntries(
      runGit(record(Uint8Array.from([0xff]), blob('a'))),
      'c'.repeat(40),
    );
    expect([...entries.keys()]).toEqual(['git-path-bytes:ff']);
  });

  test('refuses a literal path spelled like a byte-hex fallback key instead of colliding', async () => {
    await expect(
      repositoryEntries(
        runGit(
          record(Uint8Array.from([0xff]), blob('a')),
          record(Buffer.from('git-path-bytes:ff'), blob('b')),
        ),
        'c'.repeat(40),
      ),
    ).rejects.toThrow('ambiguous');
  });
});
