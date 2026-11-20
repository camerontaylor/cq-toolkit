// Manual review of any repository: the runner clones an unconfigured
// repository once, on demand, under its state (review_transport.provision),
// reusing the primary origin's transport; it never joins the `repos` list.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  createReviewEffects,
  manualClonePath,
  manualCloneUrl,
} from '../../../src/adapters/crq/reviewEffects.js';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';

const PRIMARY = 'camerontaylor/cq-toolkit';
const pools: GitPool[] = [];

afterEach(() => {
  for (const pool of pools.splice(0)) pool.killAll();
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
  }).trim();
}

function config(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

async function fixture(repos: (remotes: string) => unknown[] = () => []) {
  const root = await mkdtemp(join(tmpdir(), 'crq-manual-clone-'));
  const remotes = join(root, 'remotes');
  for (const slug of [PRIMARY, 'other/repo']) {
    const path = join(remotes, slug);
    await mkdir(path, { recursive: true });
    git(path, 'init', '-q', '--initial-branch=main');
    git(
      path,
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.test',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      slug,
    );
  }
  const clone = join(root, 'clone');
  execFileSync('git', ['clone', '-q', join(remotes, PRIMARY), clone]);
  const pool = new GitPool();
  pools.push(pool);
  const { effects } = createReviewEffects({
    root,
    repo: PRIMARY,
    config: config({ clone, repos: repos(remotes) }),
    pool,
  });
  return { root, remotes, effects };
}

describe('manual review clones', () => {
  test('the clone path is identity-keyed and refuses malformed slugs', () => {
    expect(manualClonePath('/s', 'CameronTaylor/Agents')).toBe(
      '/s/review-repos/camerontaylor/agents',
    );
    for (const slug of ['', 'agents', 'a/b/c', '../x', 'a/..', '-a/b']) {
      expect(manualClonePath('/s', slug)).toBeNull();
    }
  });

  test('the clone URL reuses the primary origin transport', () => {
    expect(
      manualCloneUrl(
        'git@github.com:CameronTaylor/cq-toolkit.git',
        PRIMARY,
        'camerontaylor/agents',
      ),
    ).toBe('git@github.com:camerontaylor/agents.git');
    expect(manualCloneUrl('/elsewhere', PRIMARY, 'a/b')).toBe('https://github.com/a/b.git');
  });

  test('an unconfigured repository is cloned once under the runner state', async () => {
    const { root, effects } = await fixture();
    expect(await effects.provisionRepo('other/repo')).toBe(true);
    const clone = join(root, 'state', 'review-repos', 'other', 'repo');
    expect((await stat(join(clone, '.git'))).isDirectory()).toBe(true);
    expect(git(clone, 'log', '-1', '--format=%s', 'origin/main')).toBe('other/repo');
    expect(await readdir(join(root, 'state', 'review-repos', 'other'))).toEqual(['repo']);
    // Reuse: a second provision finds the clone and does not clone again.
    expect(await effects.provisionRepo('Other/Repo')).toBe(true);
    expect(await effects.hasCommit('other/repo', git(clone, 'rev-parse', 'origin/main'))).toBe(
      true,
    );
  });

  test('a repository that cannot be cloned is unavailable and leaves no partial', async () => {
    const { root, effects } = await fixture();
    expect(await effects.provisionRepo('missing/repo')).toBe(false);
    expect(await readdir(join(root, 'state', 'review-repos', 'missing'))).toEqual([]);
  });

  test('the primary and configured repositories need no manual clone', async () => {
    const { root, effects } = await fixture((remotes) => [
      { repo: 'configured/repo', clone: join(remotes, 'other/repo') },
    ]);
    expect(await effects.provisionRepo(PRIMARY)).toBe(true);
    expect(await effects.provisionRepo('configured/repo')).toBe(true);
    await expect(stat(join(root, 'state', 'review-repos'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });
});
