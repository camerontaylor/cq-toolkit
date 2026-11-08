import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir, userInfo } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { makeGhRunner, type GhFn } from '../../../src/adapters/forge-github/gh.js';
import { leasedPush, resolvePushDestination } from '../../../src/adapters/git/leasedPush.js';

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
  expect(
    (await leasedPush(f.run, f.checkout, { url: f.remote }, 'topic', f.expected, f.tip)).code,
  ).toBe(0);
  await f.local('commit', '--allow-empty', '-m', 'second');
  expect(
    (
      await leasedPush(
        f.run,
        f.checkout,
        { url: f.remote },
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
        { url: f.remote },
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
  expect(
    (await leasedPush(uncertain, f.checkout, { url: f.remote }, 'topic', f.expected, f.tip)).code,
  ).toBe(0);
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
        { url: f.remote },
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
  expect(
    (await leasedPush(f.run, f.checkout, { url: f.remote }, 'topic', f.expected, f.tip)).code,
  ).toBe(0);
  expect(await f.git('ls-remote', '--refs', f.remote, 'refs/heads/topic')).toBe(
    `${f.tip}\trefs/heads/topic`,
  );
});
test('empty expectation creates an absent destination and refuses a raced creation', async () => {
  const f = await fixture();
  expect((await leasedPush(f.run, f.checkout, { url: f.base }, 'topic', '', f.tip)).code).toBe(0);
  await f.local('commit', '--allow-empty', '-m', 'later');
  const tip = await f.local('rev-parse', 'HEAD');
  expect((await leasedPush(f.run, f.checkout, { url: f.base }, 'topic', '', tip)).code).not.toBe(0);
});

test('divergent pushurl cannot reconcile a rejected push against the fetch repository', async () => {
  const f = await fixture();
  await f.local('push', f.base, `${f.tip}:refs/heads/topic`);
  await f.local('config', 'remote.origin.pushurl', f.remote);
  const result = await leasedPush(
    f.run,
    f.checkout,
    await resolvePushDestination(f.run, f.checkout, 'origin'),
    'topic',
    f.tip,
    f.tip,
  );
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
  expect(
    (
      await leasedPush(
        uncertain,
        f.checkout,
        await resolvePushDestination(f.run, f.checkout, 'origin'),
        'topic',
        f.expected,
        f.tip,
      )
    ).code,
  ).toBe(0);
  expect(await f.git('ls-remote', '--refs', f.remote, 'refs/heads/topic')).toBe(
    `${f.tip}\trefs/heads/topic`,
  );
  expect(await f.git('ls-remote', f.base)).toBe('');
});

test('a single-component relative pushurl stays concrete across resolve and leasedPush', async () => {
  const f = await fixture();
  const remote = join(f.checkout, 'push.git');
  await f.git('init', '--bare', remote);
  await f.local('config', 'remote.origin.pushurl', 'push.git');
  const destination = await resolvePushDestination(f.run, f.checkout, 'origin');
  expect(destination.url).toBe('push.git');
  expect((await leasedPush(f.run, f.checkout, destination, 'topic', '', f.tip)).code).toBe(0);
  expect(await f.git('ls-remote', '--refs', remote, 'refs/heads/topic')).toBe(
    `${f.tip}\trefs/heads/topic`,
  );
});
test('multiple configured pushurls refuse resolution rather than publishing to a subset', async () => {
  const f = await fixture();
  await f.local('config', '--add', 'remote.origin.pushurl', f.remote);
  await f.local('config', '--add', 'remote.origin.pushurl', f.base);
  await expect(resolvePushDestination(f.run, f.checkout, 'origin')).rejects.toThrow(
    'exactly one push destination',
  );
  expect(await f.git('ls-remote', '--refs', f.remote, 'refs/heads/topic')).toBe(
    `${f.expected}\trefs/heads/topic`,
  );
  expect(await f.git('ls-remote', f.base)).toBe('');
});

test('home-relative pushurl uses Git expansion with a temporary HOME', async () => {
  const f = await fixture();
  const home = await mkdtemp(join(tmpdir(), 'leased-push-home-'));
  roots.push(home);
  const remote = join(home, 'home.git');
  await f.git('init', '--bare', remote);
  await f.local('config', 'remote.origin.pushurl', '~/home.git');
  const run = makeGhRunner({ bin: 'git', env: { HOME: home } });
  const plain = await run(['-C', f.checkout, 'push', 'origin', `${f.expected}:refs/heads/topic`]);
  expect(plain.code, plain.stderr).toBe(0);
  const destination = await resolvePushDestination(run, f.checkout, 'origin');
  expect(destination.url).toBe('~/home.git');
  expect((await leasedPush(run, f.checkout, destination, 'topic', f.expected, f.tip)).code).toBe(0);
  expect(await f.git('ls-remote', '--refs', remote, 'refs/heads/topic')).toBe(
    `${f.tip}\trefs/heads/topic`,
  );
});
test.for(['file', 'parent-relative', 'named-home', 'scp'] as const)(
  'Git pushurl shape %s is preserved',
  async (shape, context) => {
    const f = await fixture();
    let remote = f.base;
    let url = `file://${remote}`;
    if (shape === 'parent-relative') url = '../base.git';
    if (shape === 'named-home') {
      let directory: string;
      try {
        directory = await mkdtemp(join(homedir(), '.cq-pushurl-check-'));
      } catch (error) {
        if (['EACCES', 'EPERM', 'EROFS'].includes((error as NodeJS.ErrnoException).code ?? ''))
          return context.skip('~user publication needs a writable real home directory');
        throw error;
      }
      roots.push(directory);
      remote = join(directory, 'push.git');
      await f.git('init', '--bare', remote);
      url = `~${userInfo().username}/${directory.split('/').at(-1)}/push.git`;
    }
    if (shape === 'scp') url = 'git@example.invalid:owner/repository.git';
    await f.local('config', 'remote.origin.pushurl', url);
    const destination = await resolvePushDestination(f.run, f.checkout, 'origin');
    expect(destination.url).toBe(url);
    // --get-url exercises Git's URL parsing without contacting an SSH host.
    expect(await f.local('ls-remote', '--get-url', destination.url)).toBe(url);
    if (shape !== 'scp') {
      expect((await leasedPush(f.run, f.checkout, destination, 'topic', '', f.tip)).code).toBe(0);
      expect(await f.git('ls-remote', '--refs', remote, 'refs/heads/topic')).toBe(
        `${f.tip}\trefs/heads/topic`,
      );
    }
  },
);
