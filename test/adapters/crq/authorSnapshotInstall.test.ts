// The v2 snapshot installer against a real clone: a clean snapshot is
// written and pinned atomically, while an identity mismatch and a denylisted
// blob are refused before anything lands in the clone's object store.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, test } from 'vitest';
import { installAuthorSnapshot } from '../../../src/adapters/crq/authorSnapshotInstall.js';
import { GitPool } from '../../../src/adapters/crq/gitExec.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const run = promisify(execFile);

function object(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value), { duplicates: 'error' });
  if (!(parsed instanceof JsonObject)) throw new Error('not an object');
  return parsed;
}

function sha1(header: string, data: Uint8Array): string {
  return createHash('sha1').update(header).update(data).digest('hex');
}

function commitBytes(base: string, tree: string): Uint8Array {
  return Buffer.from(
    `tree ${tree}\nparent ${base}\nauthor cq snapshot <snapshot@localhost> 0 +0000\ncommitter cq snapshot <snapshot@localhost> 0 +0000\n\ncq author snapshot v1\n`,
    'utf8',
  );
}

interface Fixture {
  readonly snapshot: JsonObject;
  readonly head: string;
  readonly blob: string;
}

function snapshotFor(base: string, content: string, corruptBlob = false): Fixture {
  const blob = Buffer.from(content, 'utf8');
  const blobOid = sha1(`blob ${String(blob.length)}\0`, blob);
  const entry = Buffer.concat([
    Buffer.from(`100644 hello.txt\0`, 'utf8'),
    Buffer.from(blobOid, 'hex'),
  ]);
  const treeOid = sha1(`tree ${String(entry.length)}\0`, entry);
  const commit = commitBytes(base, treeOid);
  const head = sha1(`commit ${String(commit.length)}\0`, commit);
  const objects = [
    {
      oid: blobOid,
      type: 'blob',
      data: (corruptBlob ? Buffer.from('evil\n') : blob).toString('base64'),
    },
    { oid: treeOid, type: 'tree', data: entry.toString('base64') },
    { oid: head, type: 'commit', data: Buffer.from(commit).toString('base64') },
  ].sort((left, right) => (left.oid < right.oid ? -1 : left.oid > right.oid ? 1 : 0));
  const digest = createHash('sha256');
  for (const value of objects) digest.update(`${value.oid}\0${value.type}\0${value.data}\n`);
  return {
    snapshot: object({
      v: 1,
      tree: treeOid,
      objects,
      sha256: digest.digest('hex'),
    }),
    head,
    blob: blobOid,
  };
}

function emptySnapshotFor(base: string): Fixture {
  const treeOid = sha1('tree 0\0', new Uint8Array(0));
  const commit = commitBytes(base, treeOid);
  const head = sha1(`commit ${String(commit.length)}\0`, commit);
  const objects = [
    { oid: treeOid, type: 'tree', data: '' },
    { oid: head, type: 'commit', data: Buffer.from(commit).toString('base64') },
  ].sort((left, right) => (left.oid < right.oid ? -1 : left.oid > right.oid ? 1 : 0));
  const digest = createHash('sha256');
  for (const value of objects) digest.update(`${value.oid}\0${value.type}\0${value.data}\n`);
  return {
    snapshot: object({ v: 1, tree: treeOid, objects, sha256: digest.digest('hex') }),
    head,
    blob: '',
  };
}

const PATTERNS = [
  'rules:',
  '  - id: test:token',
  '    description: test token',
  "    regex: 'SECRET_[A-Z]+'",
  "    sample: 'SECRET_TOKEN'",
  '  - id: class:key-material-env',
  '    description: universal env material',
  "    regex: 'NEVER_MATCH_[A-Z]+'",
  "    sample: 'NEVER_MATCH_TOKEN'",
  '  - id: class:portkey-config',
  '    description: primary-only vocabulary',
  "    regex: 'portkey'",
  "    sample: 'portkey'",
  'clean_probes:',
  "  - 'ordinary text'",
  '',
].join('\n');

async function publishPolicy(dir: string): Promise<void> {
  await mkdir(join(dir, 'policy/denylist'), { recursive: true });
  await writeFile(join(dir, 'policy/denylist/patterns.yml'), PATTERNS);
  await run('git', ['-C', dir, 'add', 'policy/denylist/patterns.yml']);
  await run('git', [
    '-C',
    dir,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '-m',
    'policy',
  ]);
  await run('git', ['-C', dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD']);
  // The policy must come from the authoritative ref, not this checkout.
  await rm(join(dir, 'policy/denylist/patterns.yml'), { force: true });
}

async function clone(): Promise<{ dir: string; base: string; pool: GitPool }> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-author-install-'));
  await run('git', ['init', '-q', dir]);
  await run('git', [
    '-C',
    dir,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'base',
  ]);
  const base = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
  await publishPolicy(dir);
  return { dir, base, pool: new GitPool() };
}

async function cloneWithFile(
  path: string,
  content: string,
): Promise<{ dir: string; base: string; pool: GitPool }> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-author-install-'));
  await run('git', ['init', '-q', dir]);
  await writeFile(join(dir, path), content);
  await run('git', ['-C', dir, 'add', path]);
  await run('git', [
    '-C',
    dir,
    '-c',
    'user.email=a@b',
    '-c',
    'user.name=a',
    'commit',
    '-q',
    '-m',
    'base',
  ]);
  const base = (await run('git', ['-C', dir, 'rev-parse', 'HEAD'])).stdout.trim();
  await publishPolicy(dir);
  return { dir, base, pool: new GitPool() };
}

function input(
  repo: { dir: string; base: string; pool: GitPool },
  fixture: Fixture,
  original = false,
): Parameters<typeof installAuthorSnapshot>[0] {
  return {
    pool: repo.pool,
    clone: repo.dir,
    snapshot: fixture.snapshot,
    binding: { base: repo.base, head: fixture.head },
    original,
  };
}

async function objectExists(dir: string, oid: string): Promise<boolean> {
  try {
    await run('git', ['-C', dir, 'cat-file', '-e', oid]);
    return true;
  } catch {
    return false;
  }
}

describe('installAuthorSnapshot', () => {
  test('installs and pins a clean snapshot', async () => {
    const repo = await clone();
    try {
      const fixture = snapshotFor(repo.base, 'hello\n');
      await installAuthorSnapshot(input(repo, fixture));
      expect(await objectExists(repo.dir, fixture.head)).toBe(true);
      const pinned = (
        await run('git', [
          '-C',
          repo.dir,
          'rev-parse',
          `refs/crq/author-snapshots/v1/${fixture.head}`,
        ])
      ).stdout.trim();
      expect(pinned).toBe(fixture.head);
      const tree = (
        await run('git', ['-C', repo.dir, 'ls-tree', '-r', '--name-only', fixture.head])
      ).stdout.trim();
      expect(tree).toBe('hello.txt');
    } finally {
      repo.pool.killAll();
    }
  });

  test('refuses an object whose declared oid does not match its bytes', async () => {
    const repo = await clone();
    try {
      const fixture = snapshotFor(repo.base, 'hello\n', true);
      await expect(installAuthorSnapshot(input(repo, fixture))).rejects.toThrow(
        'data does not hash to its oid',
      );
      expect(await objectExists(repo.dir, fixture.blob)).toBe(false);
      expect(await objectExists(repo.dir, fixture.head)).toBe(false);
    } finally {
      repo.pool.killAll();
    }
  });

  test('refuses a denylisted blob before writing objects to the clone', async () => {
    const repo = await clone();
    try {
      const fixture = snapshotFor(repo.base, 'SECRET_TOKEN\n');
      await expect(installAuthorSnapshot(input(repo, fixture))).rejects.toThrow(
        'snapshot secret scan refused',
      );
      expect(await objectExists(repo.dir, fixture.blob)).toBe(false);
      expect(await objectExists(repo.dir, fixture.head)).toBe(false);
    } finally {
      repo.pool.killAll();
    }
  });

  test('refuses a removed denylisted line', async () => {
    const repo = await cloneWithFile('.env', 'SECRET_TOKEN\n');
    try {
      const fixture = emptySnapshotFor(repo.base);
      await expect(installAuthorSnapshot(input(repo, fixture))).rejects.toThrow(
        'snapshot secret scan refused',
      );
      expect(await objectExists(repo.dir, fixture.head)).toBe(false);
    } finally {
      repo.pool.killAll();
    }
  });

  test('filters rules for a secondary repository scan class set', async () => {
    const repo = await clone();
    try {
      const fixture = snapshotFor(repo.base, 'portkey\n');
      await expect(
        installAuthorSnapshot({
          ...input(repo, fixture),
          scanClasses: ['class:missing'],
        }),
      ).rejects.toThrow('snapshot scan policy is missing required classes');
      await expect(installAuthorSnapshot(input(repo, fixture))).rejects.toThrow(
        'snapshot secret scan refused',
      );
      await expect(
        installAuthorSnapshot({
          ...input(repo, fixture),
          scanClasses: ['class:key-material-env'],
        }),
      ).resolves.toBeUndefined();
    } finally {
      repo.pool.killAll();
    }
  });

  test('refuses a snapshot whose head is not the synthetic commit', async () => {
    const repo = await clone();
    try {
      const fixture = snapshotFor(repo.base, 'hello\n');
      await expect(
        installAuthorSnapshot({
          ...input(repo, fixture),
          binding: { base: repo.base, head: 'f'.repeat(40) },
        }),
      ).rejects.toThrow('snapshot commit sha does not match the request head');
    } finally {
      repo.pool.killAll();
    }
  });
});
