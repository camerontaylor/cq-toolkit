// The subprocess effects adapter (real processes, temp dirs) and the op
// boundary: git hardening, ran-vs-spawn semantics, fail-closed file reads,
// the private review-log directory, and every public op mapping a spawn
// fault into the taxonomy instead of rejecting.
import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { makeDevCheck } from '../../../src/ops/dev/check.js';
import { makeDevDisposition } from '../../../src/ops/dev/disposition.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { makeDevReady } from '../../../src/ops/dev/ready.js';
import { makeDevReview } from '../../../src/ops/dev/review.js';
import type { PrEffects } from '../../../src/ops/pr/assemblePrs.js';
import { makePrOpen } from '../../../src/ops/pr/open.js';
import { makeFakeEffects, stubScanner } from './fakes.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cq-dev-effects-'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

test('git runs with the shared global hardening; a non-zero exit resolves, a missing binary rejects', async () => {
  const effects = makeSubprocessDevEffects(dir);
  const quote = await effects.runCommand('git', ['config', '--get', 'core.quotePath'], {
    timeoutMs: 10_000,
  });
  expect(quote.stdout.trim()).toBe('true');
  const missing = await effects.runCommand('git', ['rev-parse', '--verify', 'nope'], {
    timeoutMs: 10_000,
  });
  expect(missing.exitCode).not.toBe(0);
  await expect(effects.runCommand('cq-no-such-binary', [], { timeoutMs: 10_000 })).rejects.toThrow(
    /could not be spawned/,
  );
});

test('readWorktreeFile refuses symlinks, escapes and oversized files; reads the rest', async () => {
  const effects = makeSubprocessDevEffects(dir);
  await writeFile(join(dir, 'ok.txt'), 'hello\n');
  await writeFile(join(dir, 'big.txt'), 'x'.repeat(20));
  await symlink(join(dir, 'ok.txt'), join(dir, 'link'));
  expect(await effects.readWorktreeFile('ok.txt', 100)).toEqual({ ok: true, text: 'hello\n' });
  expect((await effects.readWorktreeFile('big.txt', 10)).ok).toBe(false);
  expect((await effects.readWorktreeFile('link', 100)).ok).toBe(false);
  expect((await effects.readWorktreeFile('../outside', 100)).ok).toBe(false);
});

test('the review log is private: 0600 in a 0700 dir; a permissive squatted dir is refused', async () => {
  vi.stubEnv('TMPDIR', dir);
  const effects = makeSubprocessDevEffects(dir);
  const path = await effects.writeReviewLog('feature/x', '1', 'raw diff\n');
  expect(path.startsWith(join(dir, 'cq-dev-review'))).toBe(true);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  await chmod(join(dir, 'cq-dev-review'), 0o755);
  await expect(effects.writeReviewLog('feature/x', '2', 'x')).rejects.toThrow(/group\/other/);
});

test('removeScratchDir removes only strict descendants of the temp root', async () => {
  vi.stubEnv('TMPDIR', dir);
  const effects = makeSubprocessDevEffects(dir);
  const scratch = await effects.makeScratchDir('t');
  await mkdir(join(scratch, 'inner'));
  await effects.removeScratchDir(scratch);
  await expect(stat(scratch)).rejects.toThrow();
  await expect(effects.removeScratchDir(dir)).rejects.toThrow(/outside the temp root/);
  await expect(effects.removeScratchDir('/etc')).rejects.toThrow(/outside the temp root/);
});

test('a spawn fault on the first read resolves through every public op as needs-human', async () => {
  const effects = makeFakeEffects();
  effects.runCommand = async () => {
    throw new Error('git could not be spawned — ENOENT');
  };
  const operations = [
    () => makeDevCheck(effects)({ repoRoot: '/missing' }),
    () => makeDevReady(effects)({ repoRoot: '/missing' }),
    () => makeDevReview({ effects, scanSecrets: stubScanner() })({ repoRoot: '/missing' }),
    () =>
      makeDevDisposition(effects)({
        repoRoot: '/missing',
        findingId: 'c001-aaaaaaaa#f1',
        action: 'fixed',
        why: 'addressed',
      }),
    () => makePrOpen(effects, {} as PrEffects)({ repoRoot: '/missing' }),
  ];
  for (const run of operations) {
    const result = await run();
    expect(result.status).toBe('needs-human');
    if (result.status === 'needs-human') expect(result.reason).toContain('ENOENT');
  }
});
