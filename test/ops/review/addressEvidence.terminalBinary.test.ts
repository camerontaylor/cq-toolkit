import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';

const authority = vi.hoisted(() => ({ commonDir: '' }));
vi.mock('../../../src/ops/review/internal/addressRunLifecycle.js', () => ({
  validateAddressTerminalAuthority: async () => ({
    commonDir: authority.commonDir,
    terminal: false,
  }),
  trackAddressTerminalProcess: () => undefined,
}));

const {
  assertAddressTerminalRoot,
  checkpointAddressTerminalEvidence,
  noteAddressTerminalBookkeeping,
} = await import('../../../src/ops/review/internal/addressEvidence.js');

afterEach(() => vi.unstubAllEnvs());

test('a trusted Git binary found for one checkout is refused inside a different checkout', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-binary-')));
  try {
    authority.commonDir = join(base, 'common');
    const first = join(base, 'first');
    const second = join(base, 'second');
    for (const dir of [authority.commonDir, first, join(second, 'bin')]) {
      await mkdir(dir, { recursive: true });
    }
    // A checkout-controlled `git` is outside the first root but inside the second.
    const planted = join(second, 'bin', 'git');
    await writeFile(planted, '#!/bin/sh\nexit 0\n');
    await chmod(planted, 0o755);
    vi.stubEnv('PATH', join(second, 'bin'));
    const token = {};
    await noteAddressTerminalBookkeeping(token, first, new Map());
    await expect(checkpointAddressTerminalEvidence(token, second)).rejects.toThrow(
      /trusted Git executable inside checkout/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('preflight refuses a root once the cached session binary no longer matches its recorded identity', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-preflight-')));
  try {
    authority.commonDir = join(base, 'common');
    const root = join(base, 'root');
    const bin = join(base, 'bin');
    for (const dir of [authority.commonDir, root, bin]) await mkdir(dir, { recursive: true });
    const git = join(bin, 'git');
    await writeFile(git, '#!/bin/sh\nexit 0\n');
    await chmod(git, 0o755);
    vi.stubEnv('PATH', bin);
    const token = {};
    await expect(assertAddressTerminalRoot(token, root)).resolves.toBeUndefined();
    await rm(git);
    await writeFile(git, '#!/bin/sh\nexit 1\n');
    await chmod(git, 0o755);
    await expect(assertAddressTerminalRoot(token, root)).rejects.toThrow(
      /terminal Git binary changed/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
test('a root that holds the session binary is refused before a candidate can be created there', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'terminal-preflight-')));
  try {
    authority.commonDir = join(base, 'common');
    const first = join(base, 'first');
    const second = join(base, 'second');
    for (const dir of [authority.commonDir, first, join(second, 'bin')]) {
      await mkdir(dir, { recursive: true });
    }
    const planted = join(second, 'bin', 'git');
    await writeFile(planted, '#!/bin/sh\nexit 0\n');
    await chmod(planted, 0o755);
    vi.stubEnv('PATH', join(second, 'bin'));
    const token = {};
    await expect(assertAddressTerminalRoot(token, first)).resolves.toBeUndefined();
    await expect(assertAddressTerminalRoot(token, second)).rejects.toThrow(
      /trusted Git executable inside checkout/,
    );
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
