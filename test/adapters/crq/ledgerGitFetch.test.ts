// Differential run: the same throwaway local repositories through Python's real
// `review_ledger.GitLedger.fetch` (python3.14 oracle:
// test/helpers/ledgerGitFetchOracle.py) and the TS `GitLedger.fetch`. Pins the
// stale-snapshot refetch (a checkpoint strictly newer than the fetched head),
// the per-record size bound enforced before any blob body is read, and the
// byte-grouped `cat-file --batch` plumbing sequence. Local repositories only.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { GitLedger, type GitCall, type RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const ORACLE = fileURLToPath(new URL('../../helpers/ledgerGitFetchOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));
const CHECKPOINT = 'refs/crq/review-ledger-validated';
const BRANCH = 'refs/heads/cq/review-ledger';
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const RECORD_BYTES = 1024 * 1024;

const python = (() => {
  const probe = spawnSync('python3.14', ['--version']);
  return probe.status === 0 ? 'python3.14' : 'python3';
})();

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

const fixedDate = '2026-11-01T00:00:00Z';
function git(cwd: string, args: string[], env: Record<string, string> = {}, input?: string) {
  return execFileSync(
    'git',
    ['-C', cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', ...args],
    {
      encoding: 'utf8',
      input,
      env: {
        ...scrubbedGitEnv(),
        GIT_AUTHOR_DATE: fixedDate,
        GIT_COMMITTER_DATE: fixedDate,
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  ).trim();
}

interface Fixture {
  readonly clone: string;
  /** Commit ids, oldest first; the remote branch starts at `chain[0]`. */
  readonly chain: string[];
}

/** `blobs` lists the junk blob sizes added by each commit after the first. */
async function makeFixture(blobs: number[][]): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'crq-ledger-fetch-'));
  roots.push(root);
  const remote = join(root, 'origin.git');
  const clone = join(root, 'clone');
  execFileSync('git', ['init', '-q', '--bare', '--object-format=sha1', remote]);
  execFileSync('git', ['init', '-q', '--object-format=sha1', clone]);
  git(clone, ['remote', 'add', 'origin', remote]);
  const chain: string[] = [git(clone, ['commit-tree', EMPTY_TREE, '-m', 'c0'])];
  let counter = 0;
  for (const [index, sizes] of blobs.entries()) {
    const index_ = join(root, `index-${index}`);
    for (const size of sizes) {
      counter += 1;
      const file = join(root, `blob-${counter}`);
      await writeFile(file, Buffer.alloc(size, 0x61 + (counter % 20)));
      const oid = git(clone, ['hash-object', '-w', file]);
      git(
        clone,
        ['update-index', '--add', '--cacheinfo', `100644,${oid},records/2026/11/r${counter}.json`],
        {
          GIT_INDEX_FILE: index_,
        },
      );
    }
    const tree =
      sizes.length === 0 ? EMPTY_TREE : git(clone, ['write-tree'], { GIT_INDEX_FILE: index_ });
    chain.push(
      git(clone, [
        'commit-tree',
        tree,
        '-p',
        chain[chain.length - 1] as string,
        '-m',
        `c${index + 1}`,
      ]),
    );
  }
  return { clone, chain };
}

function publish(fixture: Fixture, upTo: number): void {
  git(fixture.clone, ['push', '-q', 'origin', `${fixture.chain[upTo]}:${BRANCH}`]);
}

interface Outcome {
  readonly result: { ok: { head: string; records: number } } | { error: string; message: string };
  readonly checkpoint: string;
  readonly log: Array<[string, number | null]>;
}

function runOracle(fixture: Fixture, advance: string[]): Outcome {
  const stdout = execFileSync(python, ['-I', ORACLE, APPS], {
    input: JSON.stringify({ clone: fixture.clone, advance }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', LC_ALL: 'C.UTF-8' },
  });
  return JSON.parse(stdout) as Outcome;
}

async function runTs(fixture: Fixture, advance: string[]): Promise<Outcome> {
  const pending = [...advance];
  const log: Array<[string, number | null]> = [];
  const runGit: RunGit = (args, options): Promise<GitCall> => {
    if (args[0] === 'update-ref' && args[1] === CHECKPOINT && pending.length > 0) {
      const sha = pending.shift() as string;
      git(fixture.clone, ['push', '-q', 'origin', `${sha}:${BRANCH}`]);
      git(fixture.clone, ['update-ref', CHECKPOINT, sha]);
    }
    if (
      ['fetch', 'rev-list', 'cat-file'].includes(args[0] ?? '') ||
      (args[0] === 'update-ref' && args[1] === CHECKPOINT)
    ) {
      const lines =
        options?.input === undefined
          ? null
          : options.input.reduce((count, byte) => count + (byte === 0x0a ? 1 : 0), 0);
      log.push([args.join(' ').replace(/refs\/crq\/ledger-fetch\/[0-9a-f]+/g, '<ref>'), lines]);
    }
    const run = spawnSync('git', [...args], {
      cwd: fixture.clone,
      input: options?.input,
      env: { ...scrubbedGitEnv(), ...options?.env },
      maxBuffer: 256 * 1024 * 1024,
    });
    return Promise.resolve({
      args,
      code: run.status,
      stdout: new Uint8Array(run.stdout),
      stderr: run.stderr.toString('utf8'),
    });
  };
  let result: Outcome['result'];
  try {
    const { head, values } = await new GitLedger({ repo: fixture.clone, runGit }).fetch();
    result = { ok: { head, records: values.length } };
  } catch (error) {
    const name = error instanceof Error ? error.name : 'unknown';
    result = {
      error: name === 'LedgerIntegrityError' ? 'IntegrityError' : name,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const probe = spawnSync(
    'git',
    ['-C', fixture.clone, 'rev-parse', '--verify', '--quiet', CHECKPOINT],
    {
      env: scrubbedGitEnv(),
      encoding: 'utf8',
    },
  );
  const checkpoint = probe.status === 0 ? probe.stdout.trim() : '';
  return { result, checkpoint, log };
}

async function both(
  blobs: number[][],
  publishedIndex: number,
  advanceIndexes: number[],
): Promise<{ ts: Outcome; py: Outcome; chain: string[] }> {
  const a = await makeFixture(blobs);
  const b = await makeFixture(blobs);
  expect(a.chain).toEqual(b.chain);
  publish(a, publishedIndex);
  publish(b, publishedIndex);
  const advance = advanceIndexes.map((index) => a.chain[index] as string);
  return { ts: await runTs(a, advance), py: runOracle(b, advance), chain: a.chain };
}

describe('GitLedger.fetch differential (Python 3.14 oracle)', () => {
  it('an uncontended fetch returns the fetched head and writes the checkpoint', async () => {
    const { ts, py, chain } = await both([[]], 0, []);
    expect(py.result).toEqual({ ok: { head: chain[0], records: 0 } });
    expect(ts).toEqual(py);
  });

  it('refetches when the checkpoint is strictly newer than the fetched head', async () => {
    const { ts, py, chain } = await both([[], []], 0, [1]);
    expect(py.result).toEqual({ ok: { head: chain[1], records: 0 } });
    expect(py.log.filter(([call]) => call.startsWith('fetch '))).toHaveLength(2);
    expect(ts).toEqual(py);
  });

  it('refuses after three stale snapshots', async () => {
    const { ts, py } = await both([[], [], []], 0, [1, 2, 3]);
    expect(py.result).toEqual({
      error: 'IntegrityError',
      message: 'ledger head is older than the validated checkpoint',
    });
    expect(ts).toEqual(py);
  });

  it('rejects an oversized record from its size alone, before any body is read', async () => {
    const { ts, py } = await both([[RECORD_BYTES + 1]], 1, []);
    expect(py.result).toEqual({
      error: 'IntegrityError',
      message: 'ledger record exceeds validation bound',
    });
    expect(py.log.some(([call]) => call === 'cat-file --batch')).toBe(false);
    expect(ts).toEqual(py);
  });

  it('groups blob bodies by total bytes as well as by count', async () => {
    const sizes = [900_000, 900_000, 900_000, 900_000, 900_000];
    const { ts, py } = await both([sizes], 1, []);
    const bodies = py.log.filter(([call]) => call === 'cat-file --batch');
    // 4 x 900 KB fits the 4 MiB group budget; the fifth waits for a new group.
    expect(bodies[0]?.[1]).toBe(4);
    expect(ts.log).toEqual(py.log);
    // The junk blobs are not JSON, so both sides stop at decode; only the git
    // plumbing sequence is under comparison here, not the decoder's error text.
    expect('error' in ts.result).toBe(true);
    expect('error' in py.result).toBe(true);
    expect(ts.checkpoint).toBe(py.checkpoint);
  });
});
