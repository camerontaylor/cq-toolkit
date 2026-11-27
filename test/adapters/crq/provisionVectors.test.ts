/**
 * Replays `apps/crq-python/fixtures/crq-provision/cases.json`, emitted by
 * `provision_vectors.py` from the PRODUCTION `review_transport.provision`,
 * against `createReviewEffects(...).provisionRepo`. Every scenario runs in
 * throwaway local repositories (remotes are directories, the primary clone is a
 * bare `git init` whose origin names one of them, HOME is a throwaway
 * directory): no network, no gh, no credential. Where Python lets an exception
 * escape, the effect throws a `PyError` of the same class.
 */
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import { createReviewEffects } from '../../../src/adapters/crq/reviewEffects.js';
import { parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import type { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';

interface Spec {
  name: string;
  repo: string;
  remotes: string[];
  repos: { repo: string; clone: string }[];
  origin: string | null;
  origin_prefix_hex: string;
  rewrite: boolean;
  pre: [string, 'dir' | 'file'][];
}
interface Expected {
  error: string | null;
  value?: boolean;
  tree: string[];
  clone?: { subject?: string; remote?: string };
}
const cases = (
  JSON.parse(
    await readFile(
      new URL('../../../apps/crq-python/fixtures/crq-provision/cases.json', import.meta.url),
      'utf8',
    ),
  ) as { cases: { name: string; scenario: Spec; expected: Expected }[] }
).cases;

const PRIMARY = 'org/primary';
const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
};
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' }).toString().trim();

function className(error: unknown): string {
  if (error instanceof PyError) return error.kind;
  return `unmapped:${error instanceof Error ? error.message : String(error)}`;
}

/** `_listing`: every path under the state root; Git internals collapse into their repository. */
async function listing(state: string): Promise<string[]> {
  let info;
  try {
    info = await stat(state);
  } catch {
    return ['state:absent'];
  }
  if (!info.isDirectory()) return ['state:file'];
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const rel = relative(state, path).split(sep);
      if (rel.slice(0, -1).includes('.git')) continue;
      out.push(rel.join('/') + (entry.isDirectory() ? '/' : ''));
      if (entry.isDirectory()) await walk(path);
    }
  };
  await walk(state);
  // Python sorts the `Path` objects (component-wise), not the joined strings.
  return out.sort((a, b) => {
    const left = a.split('/').filter(Boolean);
    const right = b.split('/').filter(Boolean);
    for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
      if (left[i]! !== right[i]!) return left[i]! < right[i]! ? -1 : 1;
    }
    return left.length - right.length;
  });
}

let root: string;
const pools: GitPool[] = [];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'provision-'));
});
afterEach(async () => {
  for (const pool of pools.splice(0)) pool.killAll();
  await rm(root, { recursive: true, force: true });
});

const sub = (text: string): string => text.split(root).join('/T');
const unsub = (text: string): string => text.split('/T').join(root);

describe('provision against the Python oracle', () => {
  it('replays every case', () => expect(cases.length).toBeGreaterThan(45));
  for (const { name, scenario: spec, expected } of cases) {
    it(name, async () => {
      for (const slug of spec.remotes) {
        const path = join(root, 'remotes', slug);
        await mkdir(path, { recursive: true });
        git(path, 'init', '-q', '-b', 'main');
        git(path, 'commit', '-q', '--allow-empty', '-m', slug);
      }
      const home = join(root, 'home');
      await mkdir(home);
      if (spec.rewrite) {
        await writeFile(
          join(home, '.gitconfig'),
          `[url "${root}/remotes/"]\n\tinsteadOf = https://github.com/\n`,
        );
      }
      const primary = join(root, 'primary');
      await mkdir(primary);
      git(primary, 'init', '-q', '-b', 'main');
      if (spec.origin !== null) {
        appendFileSync(
          join(primary, '.git', 'config'),
          Buffer.concat([
            Buffer.from('[remote "origin"]\n\turl = '),
            Buffer.from(spec.origin_prefix_hex, 'hex'),
            Buffer.from(unsub(spec.origin)),
            Buffer.from('\n'),
          ]),
        );
      }
      for (const [rel, kind] of spec.pre) {
        const path = join(root, rel);
        if (kind === 'dir') await mkdir(path, { recursive: true });
        else {
          await mkdir(dirname(path), { recursive: true });
          await writeFile(path, 'x');
        }
      }
      const config = parseJsonValue(
        JSON.stringify({
          clone: primary,
          repos: spec.repos.map((entry) => ({ repo: entry.repo, clone: unsub(entry.clone) })),
        }),
        { duplicates: 'error' },
      ) as JsonObject;
      const pool = new GitPool();
      pools.push(pool);
      const { effects } = createReviewEffects({ root, repo: PRIMARY, config, pool });

      const saved = { HOME: process.env.HOME, XDG: process.env.XDG_CONFIG_HOME };
      process.env.HOME = home;
      delete process.env.XDG_CONFIG_HOME;
      let value: boolean | undefined;
      let error: string | null = null;
      try {
        value = await effects.provisionRepo(spec.repo);
      } catch (caught) {
        error = className(caught);
      } finally {
        if (saved.HOME === undefined) delete process.env.HOME;
        else process.env.HOME = saved.HOME;
        if (saved.XDG !== undefined) process.env.XDG_CONFIG_HOME = saved.XDG;
      }

      expect(error).toBe(expected.error);
      if (expected.error === null) expect(value).toBe(expected.value);
      const state = join(root, 'state');
      expect((await listing(state)).map(sub)).toEqual(expected.tree);
      if (expected.clone !== undefined && Object.keys(expected.clone).length > 0) {
        const [owner, name] = spec.repo.toLowerCase().split('/') as [string, string];
        const clone = join(state, 'review-repos', owner, name);
        expect({
          subject: git(clone, 'log', '-1', '--format=%s', 'origin/main'),
          remote: sub(git(clone, 'config', '--get', 'remote.origin.url')),
        }).toEqual(expected.clone);
      }
    });
  }
});
