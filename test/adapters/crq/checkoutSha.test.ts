// `client_health.checkout_sha`: HEAD read from Git metadata with no `git` process.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkoutSha } from '../../../src/adapters/crq/checkoutSha.js';

const SHA = '0123456789abcdef0123456789abcdef01234567';
const OTHER = 'fedcba9876543210fedcba9876543210fedcba98';

const cleanups: string[] = [];
afterEach(async () => {
  for (const dir of cleanups.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function repo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'crq-sha-'));
  cleanups.push(dir);
  await mkdir(join(dir, '.git', 'refs', 'heads'), { recursive: true });
  return dir;
}

describe('checkoutSha', () => {
  it('reads a detached HEAD', async () => {
    const dir = await repo();
    await writeFile(join(dir, '.git', 'HEAD'), `${SHA}\n`);
    expect(checkoutSha(dir)).toBe(SHA);
  });

  it('follows a symbolic ref to a loose ref file', async () => {
    const dir = await repo();
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(join(dir, '.git', 'refs', 'heads', 'main'), `${SHA}\n`);
    expect(checkoutSha(dir)).toBe(SHA);
  });

  it('falls back to packed-refs when the loose ref is absent', async () => {
    const dir = await repo();
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await writeFile(
      join(dir, '.git', 'packed-refs'),
      `# pack-refs\n${OTHER} refs/heads/other\n${SHA} refs/heads/main\n^${OTHER}\n`,
    );
    expect(checkoutSha(dir)).toBe(SHA);
  });

  it('resolves a linked worktree through its gitdir pointer and commondir', async () => {
    const common = await repo();
    await writeFile(join(common, '.git', 'refs', 'heads', 'feat'), `${SHA}\n`);
    const gitdir = join(common, '.git', 'worktrees', 'wt');
    await mkdir(gitdir, { recursive: true });
    await writeFile(join(gitdir, 'HEAD'), 'ref: refs/heads/feat\n');
    await writeFile(join(gitdir, 'commondir'), '../..\n');
    const worktree = await mkdtemp(join(tmpdir(), 'crq-sha-wt-'));
    cleanups.push(worktree);
    await writeFile(join(worktree, '.git'), `gitdir: ${gitdir}\n`);
    expect(checkoutSha(worktree)).toBe(SHA);
  });

  it('follows a relative gitdir pointer from the checkout root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'crq-sha-rel-'));
    cleanups.push(base);
    await mkdir(join(base, 'meta'), { recursive: true });
    await writeFile(join(base, 'meta', 'HEAD'), `${SHA}\n`);
    await mkdir(join(base, 'checkout'), { recursive: true });
    await writeFile(join(base, 'checkout', '.git'), 'gitdir: ../meta\n');
    expect(checkoutSha(join(base, 'checkout'))).toBe(SHA);
  });

  it('works through a symlinked checkout root', async () => {
    const dir = await repo();
    await writeFile(join(dir, '.git', 'HEAD'), `${SHA}\n`);
    const link = `${dir}-link`;
    cleanups.push(link);
    await symlink(dir, link);
    expect(checkoutSha(link)).toBe(SHA);
  });

  it('is null for anything that is not 40 lowercase hex digits', async () => {
    const dir = await repo();
    for (const bad of [SHA.toUpperCase(), SHA.slice(1), `${SHA}0`, 'not-a-sha', '']) {
      await writeFile(join(dir, '.git', 'HEAD'), `${bad}\n`);
      expect(checkoutSha(dir)).toBeNull();
    }
  });

  it('is null when the ref cannot be resolved or Git metadata is absent', async () => {
    const dir = await repo();
    await writeFile(join(dir, '.git', 'HEAD'), 'ref: refs/heads/missing\n');
    expect(checkoutSha(dir)).toBeNull();
    const empty = await mkdtemp(join(tmpdir(), 'crq-sha-none-'));
    cleanups.push(empty);
    expect(checkoutSha(empty)).toBeNull();
    expect(checkoutSha(join(empty, 'absent'))).toBeNull();
  });

  it('is null for undecodable metadata', async () => {
    const dir = await repo();
    await writeFile(join(dir, '.git', 'HEAD'), Buffer.from([0xff, 0xfe, 0x41]));
    expect(checkoutSha(dir)).toBeNull();
  });
});
