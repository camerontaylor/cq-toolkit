// Manual review of any repository: the runner clones an unconfigured
// repository once, on demand, under its state (review_transport.provision),
// reusing the primary origin's transport; it never joins the `repos` list.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
import { ledgerDigestOf } from '../../../src/policy/crq/ledger.js';

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
    expect(await readdir(join(root, 'state', 'review-repos', '.tmp'))).toEqual([]);
    // Reuse: a second provision finds the clone and does not clone again.
    expect(await effects.provisionRepo('Other/Repo')).toBe(true);
    expect(await effects.hasCommit('other/repo', git(clone, 'rev-parse', 'origin/main'))).toBe(
      true,
    );
  });

  test('a repository that cannot be cloned is unavailable and leaves no partial', async () => {
    const { root, effects } = await fixture();
    // Another repository whose name extends this one must survive the failure.
    const sibling = join(root, 'state', 'review-repos', 'missing', 'repo.partial');
    await mkdir(join(sibling, '.git'), { recursive: true });
    expect(await effects.provisionRepo('missing/repo')).toBe(false);
    expect(await readdir(join(root, 'state', 'review-repos', 'missing'))).toEqual(['repo.partial']);
    expect((await stat(join(sibling, '.git'))).isDirectory()).toBe(true);
    expect(await readdir(join(root, 'state', 'review-repos', '.tmp'))).toEqual([]);
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

describe('retained review records', () => {
  // A review record valid under the ledger schema, from the B1 `valid-review` vector.
  const BASE = {
    schema: 'cq.review-ledger/v1',
    event_type: 'review',
    source_key: 'camerontaylor/cq-toolkit:crq-runner-app:run-1',
    occurred_at: '2026-10-30T00:00:00Z',
    payload: {
      repo: 'camerontaylor/cq-toolkit',
      subject_id: 'subject',
      job_id: 'subject:0',
      attempt_id: 'subject:0:1',
      source: {
        repo: 'camerontaylor/cq-toolkit',
        producer: 'crq-runner-app',
        type: 'crq-run',
        id: 'run-1',
        authenticated: true,
      },
      base: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      head: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      head_tree: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      target_tree: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      policy_digest: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      scope_digest: 'c38ff74dbe52efc3cc353a69aaeec07f6315d2a02cf02c64c4809b0f89a53c78',
      paths: [
        {
          path: 'src/雪.ts',
          blob: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          mode: '100644',
          disposition: 'included',
          reason: 'verified',
          baseline: {},
        },
      ],
      requested_scope: [
        {
          path: 'src/雪.ts',
          blob: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          intervals: [[1, 2]],
        },
      ],
      input_scope: [
        {
          path: 'src/雪.ts',
          blob: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          intervals: [[1, 2]],
        },
      ],
      reviewed_scope: [
        {
          path: 'src/雪.ts',
          blob: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          intervals: [[1, 2]],
        },
      ],
      completion: {
        terminal: true,
        skipped: false,
        scope_verified: true,
        exit_code: 0,
        errors: [],
      },
      outcome: 'completed',
      artifacts: [
        {
          sha256: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
          location:
            '/fixtures/artifacts/cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
        },
      ],
      findings: [
        {
          id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
          severity: 'major',
          source_id: null,
          path: 'src/雪.ts',
          blob: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          intervals: [[1, 1]],
          title: '标题 😀',
          body: 'details \u0001 with control',
          status: 'untriaged',
          anchor_status: 'verified',
        },
      ],
    },
  } as Record<string, unknown>;

  function record(title: string): Buffer {
    const payload = structuredClone(BASE.payload) as { findings: Array<{ title: string }> };
    payload.findings[0]!.title = title;
    const body = { ...BASE, payload };
    const parsed = parseJsonValue(JSON.stringify(body));
    if (!(parsed instanceof JsonObject)) throw new Error('not an object');
    const id = ledgerDigestOf(parsed);
    return Buffer.from(JSON.stringify({ ...body, id }));
  }

  async function pendingDir(root: string): Promise<string> {
    const pending = join(root, 'state', 'record-outbox', 'pending');
    await mkdir(pending, { recursive: true });
    return pending;
  }

  test('corrupt files are skipped and the scan still reaches a later valid record', async () => {
    const { root, effects } = await fixture();
    const pending = await pendingDir(root);
    await writeFile(join(pending, 'a-truncated.json'), '{"event_type":"review","id":');
    await writeFile(join(pending, 'b-badutf8.json'), Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    await writeFile(join(pending, 'z-valid.json'), record('ok'));
    const records = await effects.retainedRecords();
    expect(records).toHaveLength(1);
    expect(records[0]!.get('event_type')).toBe('review');
  });

  test('a lone 0xff is refused like Python, not decoded to U+FFFD', async () => {
    const { root, effects } = await fixture();
    const pending = await pendingDir(root);
    // The record's content legitimately contains U+FFFD, so its id hashes the
    // replacement character. Replacing those three bytes (EF BF BD) with a single
    // 0xff makes the file invalid UTF-8; a lenient decoder maps it back to U+FFFD,
    // reproduces the hash and accepts it, while Python's strict decode refuses it.
    const valid = record('a\ufffdb');
    expect(await writeAndRead(pending, 'ok.json', valid)).toHaveLength(1);
    const corrupt = Buffer.concat([
      valid.subarray(0, valid.indexOf(Buffer.from([0xef, 0xbf, 0xbd]))),
      Buffer.from([0xff]),
      valid.subarray(valid.indexOf(Buffer.from([0xef, 0xbf, 0xbd])) + 3),
    ]);
    await rm(join(pending, 'ok.json'));
    await writeFile(join(pending, 'bad.json'), corrupt);
    expect(await effects.retainedRecords()).toEqual([]);

    async function writeAndRead(dir: string, name: string, bytes: Buffer) {
      await writeFile(join(dir, name), bytes);
      return effects.retainedRecords();
    }
  });
});
