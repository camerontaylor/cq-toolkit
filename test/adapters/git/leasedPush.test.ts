import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { makeGhRunner, type GhFn } from '../../../src/adapters/forge-github/gh.js';
import { leasedPush } from '../../../src/adapters/git/leasedPush.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'leased-push-'));
  roots.push(root);
  const run = makeGhRunner({
    bin: 'git',
    env: {
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
  const git = async (...args: string[]) => {
    const result = await run(args);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout.trim();
  };
  const remote = join(root, 'head.git');
  const base = join(root, 'base.git');
  const checkout = join(root, 'checkout');
  await git('init', '--bare', remote);
  await git('init', '--bare', base);
  await git('init', checkout);
  const local = (...args: string[]) => git('-C', checkout, ...args);
  await local('commit', '--allow-empty', '-m', 'initial');
  const expected = await local('rev-parse', 'HEAD');
  await local('push', remote, 'HEAD:refs/heads/topic');
  await local('remote', 'add', 'origin', base);
  await local('commit', '--allow-empty', '-m', 'fix');
  const tip = await local('rev-parse', 'HEAD');
  return { run, git, local, remote, base, checkout, expected, tip };
}
test('fork publication uses the head repository and advances the second lease', async () => {
  const f = await fixture();
  expect((await leasedPush(f.run, f.checkout, f.remote, 'topic', f.expected, f.tip)).code).toBe(0);
  await f.local('commit', '--allow-empty', '-m', 'second');
  expect(
    (
      await leasedPush(
        f.run,
        f.checkout,
        f.remote,
        'topic',
        f.tip,
        await f.local('rev-parse', 'HEAD'),
      )
    ).code,
  ).toBe(0);
  expect(await f.git('ls-remote', f.base)).toBe('');
});
test('raced remote refuses stale work even when it would fast-forward', async () => {
  const f = await fixture();
  await f.local('push', f.remote, `${f.tip}:refs/heads/topic`);
  await f.local('commit', '--allow-empty', '-m', 'stale computation');
  expect(
    (
      await leasedPush(
        f.run,
        f.checkout,
        f.remote,
        'topic',
        f.expected,
        await f.local('rev-parse', 'HEAD'),
      )
    ).code,
  ).not.toBe(0);
  expect(await f.git('ls-remote', '--refs', f.remote, 'refs/heads/topic')).toBe(
    `${f.tip}\trefs/heads/topic`,
  );
});
test('lost acknowledgement reconciles before reporting success', async () => {
  const f = await fixture();
  const uncertain: GhFn = async (args) => {
    const result = await f.run(args);
    if (args.includes('push')) {
      expect(result.code).toBe(0);
      throw new Error('connection lost');
    }
    return result;
  };
  expect((await leasedPush(uncertain, f.checkout, f.remote, 'topic', f.expected, f.tip)).code).toBe(
    0,
  );
});
test('a lease never authorizes non-fast-forward publication', async () => {
  const f = await fixture();
  await f.local('checkout', '--orphan', 'unrelated');
  await f.local('commit', '--allow-empty', '-m', 'unrelated');
  expect(
    (
      await leasedPush(
        f.run,
        f.checkout,
        f.remote,
        'topic',
        f.expected,
        await f.local('rev-parse', 'HEAD'),
      )
    ).code,
  ).not.toBe(0);
});

test('publication pins the verified SHA even when HEAD has moved', async () => {
  const f = await fixture();
  await f.local('commit', '--allow-empty', '-m', 'unverified later work');
  expect((await leasedPush(f.run, f.checkout, f.remote, 'topic', f.expected, f.tip)).code).toBe(0);
  expect(await f.git('ls-remote', '--refs', f.remote, 'refs/heads/topic')).toBe(
    `${f.tip}\trefs/heads/topic`,
  );
});
test('empty expectation creates an absent destination and refuses a raced creation', async () => {
  const f = await fixture();
  expect((await leasedPush(f.run, f.checkout, f.base, 'topic', '', f.tip)).code).toBe(0);
  await f.local('commit', '--allow-empty', '-m', 'later');
  const tip = await f.local('rev-parse', 'HEAD');
  expect((await leasedPush(f.run, f.checkout, f.base, 'topic', '', tip)).code).not.toBe(0);
});

test('divergent pushurl cannot reconcile a rejected push against the fetch repository', async () => {
  const f = await fixture();
  await f.local('push', f.base, `${f.tip}:refs/heads/topic`);
  await f.local('config', 'remote.origin.pushurl', f.remote);
  const result = await leasedPush(f.run, f.checkout, 'origin', 'topic', f.tip, f.tip);
  expect(result.code).not.toBe(0);
  expect(await f.git('ls-remote', '--refs', f.remote, 'refs/heads/topic')).toBe(
    `${f.expected}\trefs/heads/topic`,
  );
});
test('lost acknowledgement reconciles against the pinned pushurl even if config changes', async () => {
  const f = await fixture();
  await f.local('config', 'remote.origin.pushurl', f.remote);
  const uncertain: GhFn = async (args) => {
    const result = await f.run(args);
    if (args.includes('push')) {
      expect(result.code).toBe(0);
      await f.local('config', 'remote.origin.pushurl', f.base);
      return { code: 124, stdout: '', stderr: 'lost acknowledgement' };
    }
    return result;
  };
  expect((await leasedPush(uncertain, f.checkout, 'origin', 'topic', f.expected, f.tip)).code).toBe(
    0,
  );
  expect(await f.git('ls-remote', '--refs', f.remote, 'refs/heads/topic')).toBe(
    `${f.tip}\trefs/heads/topic`,
  );
  expect(await f.git('ls-remote', f.base)).toBe('');
});
