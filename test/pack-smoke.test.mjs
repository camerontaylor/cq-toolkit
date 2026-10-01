import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { main, parseArgs, sha256File } from '../scripts/smoke-packed-package.mjs';

const scratchDirs = [];

afterEach(async () => {
  await Promise.all(scratchDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('packed package smoke CLI inputs', () => {
  it('requires an exact tarball, digest, and semantic version', () => {
    expect(() => parseArgs([])).toThrow('Missing required argument: --tarball');
    expect(() => parseArgs(['--tarball', 'x.tgz', '--sha256', 'bad', '--version', '0.2.0'])).toThrow(
      '64 hexadecimal characters',
    );
    expect(() =>
      parseArgs(['--tarball', 'x.tgz', '--sha256', 'a'.repeat(64), '--version', '^0.2.0']),
    ).toThrow('exact semantic version');
  });

  it('hashes the exact tarball bytes', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'cq-pack-smoke-test-'));
    scratchDirs.push(directory);
    const file = path.join(directory, 'package.tgz');
    const bytes = Buffer.from('tarball bytes');
    await writeFile(file, bytes);
    expect(await sha256File(file)).toBe(createHash('sha256').update(bytes).digest('hex'));
    await expect(main(['--tarball', file, '--sha256', '0'.repeat(64), '--version', '0.2.0'])).rejects.toThrow(
      'Tarball SHA-256 mismatch',
    );
  });
});
