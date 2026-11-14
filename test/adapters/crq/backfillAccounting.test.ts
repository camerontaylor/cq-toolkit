/**
 * `backfill_accounting.Repository` and `backfill_cache.Cache` over real Git.
 *
 * The fixtures are tiny temporary repositories built with the real `git`
 * binary. They pin the behaviours the differential vectors cannot express:
 * which objects are visible, which changed intervals a crafted patch may
 * claim, the exact-rename and unique-deletion rules, Python's list-index
 * semantics in `carry`, the cached-vs-uncached coverage fold, and the fact
 * cache's "every failure is a miss" rule.
 */
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';
import {
  BackfillFactCache,
  BackfillCacheError,
  GitAccountingRepository,
  accountingFactSalt,
} from '../../../src/adapters/crq/backfillAccounting.js';
import { fileArtifactStore, type ArtifactStore } from '../../../src/adapters/crq/findingStore.js';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import type { BackfillCaptureRepo } from '../../../src/policy/crq/backfillInventory.js';
import type { BackfillReportRepo } from '../../../src/policy/crq/backfillReport.js';
import { LEDGER_REPOSITORY, ledgerEvent, ledgerLoads } from '../../../src/policy/crq/ledger.js';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { ledgerJsonBytes, ledgerJsonDigest } from '../../../src/policy/crq/pythonJson.js';

const ROOTS: string[] = [];

afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_DATE: '2026-10-29T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-29T00:00:00Z',
};
for (const key of [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_NAMESPACE',
]) {
  delete GIT_ENV[key];
}

class Fixture {
  readonly base: string;
  readonly root: string;
  readonly artifacts: ArtifactStore;
  readonly repo: GitAccountingRepository;

  constructor() {
    this.base = mkdtempSync(join(tmpdir(), 'crq-accounting-'));
    ROOTS.push(this.base);
    this.root = join(this.base, 'repo');
    mkdirSync(this.root, { recursive: true });
    this.artifacts = fileArtifactStore(join(this.base, 'artifacts'));
    this.git('init', '-q');
    this.git('config', 'user.name', 'fixture');
    this.git('config', 'user.email', 'fixture@localhost');
    this.repo = new GitAccountingRepository({
      repo: this.root,
      runGit: runGitIn(this.root),
    });
  }

  git(...args: string[]): string {
    return this.execute(args, GIT_ENV);
  }

  private execute(args: string[], env: NodeJS.ProcessEnv): string {
    return execFileSync('git', ['-C', this.root, ...args], {
      env,
      encoding: 'utf8',
    }).trim();
  }

  commit(files: Record<string, string | Uint8Array | null>, date?: string): string {
    for (const [name, content] of Object.entries(files)) {
      const path = join(this.root, name);
      if (content === null) {
        unlinkSync(path);
        continue;
      }
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
    }
    this.git('add', '-A');
    const env =
      date === undefined
        ? GIT_ENV
        : { ...GIT_ENV, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    this.execute(['commit', '-qm', 'Fixture change'], env);
    return this.git('rev-parse', 'HEAD');
  }

  projection(target: string, names: readonly string[]): { base: string; head: string } {
    const directory = mkdtempSync(join(tmpdir(), 'crq-index-'));
    try {
      const env = { ...GIT_ENV, GIT_INDEX_FILE: join(directory, 'index') };
      this.execute(['read-tree', target], env);
      for (const name of names) {
        this.execute(['update-index', '--force-remove', '--', name], env);
      }
      const tree = this.execute(['write-tree'], env);
      const base = this.execute(['commit-tree', tree, '-p', target, '-m', 'Removed files'], env);
      const head = this.execute(
        [
          'commit-tree',
          this.git('rev-parse', `${target}^{tree}`),
          '-p',
          base,
          '-m',
          'Restored files',
        ],
        env,
      );
      return { base, head };
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
}

function countedRunGit(repo: string): { runGit: RunGit; calls: string[][] } {
  const inner = runGitIn(repo);
  const calls: string[][] = [];
  return {
    runGit: async (args, options) => {
      calls.push([...args]);
      return inner(args, options);
    },
    calls,
  };
}

function jsonValue(value: unknown): JsonValue {
  return parseJsonValue(JSON.stringify(value));
}

function reviewRecord(options: {
  target: string;
  base: string;
  head: string;
  targetTree: string;
  headTree: string;
  scope: Array<Record<string, unknown>>;
  artifact: { sha256: string; location: string };
  runId?: string;
}): JsonValue {
  const runId = options.runId ?? 'run-1';
  const payload = {
    repo: LEDGER_REPOSITORY,
    subject_id: 'subject',
    job_id: 'subject:0',
    attempt_id: 'subject:0:1',
    source: {
      repo: LEDGER_REPOSITORY,
      producer: 'crq-runner-app',
      type: 'crq-run',
      id: runId,
      authenticated: true,
    },
    base: options.base,
    head: options.head,
    head_tree: options.headTree,
    target: options.target,
    target_tree: options.targetTree,
    policy_digest: 'b'.repeat(64),
    scope_digest: ledgerJsonDigest(options.scope),
    paths: options.scope.map((row) => ({
      path: row['path'],
      blob: row['blob'],
      mode: '100644',
      disposition: 'included',
      reason: 'verified fixture',
      baseline: {},
    })),
    requested_scope: options.scope,
    input_scope: options.scope,
    reviewed_scope: options.scope,
    completion: { terminal: true, skipped: false, scope_verified: true, exit_code: 0, errors: [] },
    outcome: 'completed',
    artifacts: [options.artifact],
    findings: [],
  };
  return ledgerEvent(
    'review',
    `${LEDGER_REPOSITORY}:crq-runner-app:${runId}`,
    '2026-10-31T00:00:00Z',
    jsonValue(payload),
  );
}

async function fullReview(
  fixture: Fixture,
  target: string,
  name: string,
  intervals: number[][],
): Promise<JsonValue> {
  const { base, head } = fixture.projection(target, [name]);
  const entry = (await fixture.repo.entries(target)).get(name);
  if (entry === undefined) throw new Error(`missing fixture entry ${name}`);
  const artifact = await fixture.artifacts.put(
    new TextEncoder().encode('authenticated retained fixture evidence'),
  );
  return reviewRecord({
    target,
    base,
    head,
    targetTree: await fixture.repo.tree(target),
    headTree: await fixture.repo.tree(head),
    scope: [{ path: name, blob: entry.blob, intervals }],
    artifact,
  });
}

function rehash(value: JsonValue, mutate: (plain: Record<string, unknown>) => void): JsonValue {
  const plain = toPlainJson(value) as Record<string, unknown>;
  mutate(plain);
  delete plain['id'];
  plain['id'] = ledgerJsonDigest(plain);
  return jsonValue(plain);
}

async function history(fixture: Fixture): Promise<{
  old: string;
  value: JsonValue;
  middle: string;
}> {
  const old = fixture.commit({ a: 'one\ntwo\nthree\nfour\n', other: 'x\n' });
  const value = await fullReview(fixture, old, 'a', [[1, 4]]);
  fixture.commit({ a: 'one\nchanged\nthree\nfour\n' });
  fixture.git('mv', 'a', 'renamed');
  fixture.commit({});
  const middle = fixture.commit({ other: 'y\n' });
  return { old, value, middle };
}

describe('changed intervals over real Git', () => {
  test('a filename with a space keeps its path', async () => {
    const fixture = new Fixture();
    const base = fixture.commit({ 'my file.ts': 'before\n' });
    const head = fixture.commit({ 'my file.ts': 'after\n' });
    expect([
      ...((await fixture.repo.changedIntervals(base, head)).get('my file.ts') ?? []),
    ]).toEqual([1]);
  });

  test('patch content cannot forge a file header or a hunk extension', async () => {
    const fixture = new Fixture();
    const old = fixture.commit({ a: 'first\nsecond\nthird\n', other: 'unchanged\n' });
    const forged = fixture.commit({ a: 'first\n++ b/other\nthird\n' });
    const intervals = await fixture.repo.changedIntervals(old, forged);
    expect([...(intervals.get('a') ?? [])]).toEqual([2]);
    expect(intervals.has('other')).toBe(false);
    const control = fixture.commit({ a: 'first\ncontent\u000c@@ -1 +1,100 @@\nthird\n' });
    expect([...((await fixture.repo.changedIntervals(forged, control)).get('a') ?? [])]).toEqual([
      2,
    ]);
  });

  test('multiple hunks and an unterminated final line credit the header ranges', async () => {
    const fixture = new Fixture();
    const old = fixture.commit({ a: 'one\ntwo\nthree\nfour\nfive' });
    const head = fixture.commit({ a: 'ONE\ntwo\nthree\nfour\nFIVE' });
    expect([...((await fixture.repo.changedIntervals(old, head)).get('a') ?? [])]).toEqual([1, 5]);
  });

  test('a quoted path cannot inherit the previous file', async () => {
    const fixture = new Fixture();
    const old = fixture.commit({ a: 'one\ntwo\nthree\n', é: 'one\ntwo\nthree\n' });
    const head = fixture.commit({ a: 'ONE\ntwo\nthree\n', é: 'one\ntwo\nTHREE\n' });
    expect([...((await fixture.repo.changedIntervals(old, head)).get('a') ?? [])]).toEqual([1]);
  });
});

describe('inventory', () => {
  test('every object is visible, including empty, binary, oversize and symlink', async () => {
    const fixture = new Fixture();
    const first = fixture.commit({
      a: 'one\ntwo\n',
      empty: '',
      binary: new Uint8Array([0, 0x78]),
      oversize: 'x'.repeat(20),
    });
    symlinkSync('a', join(fixture.root, 'link'));
    const target = fixture.commit({});
    expect(first).not.toBe(target);
    const rows = new Map((await fixture.repo.inventory(target, 10)).map((row) => [row.path, row]));
    expect(new Set(rows.keys())).toEqual(new Set(['a', 'empty', 'binary', 'oversize', 'link']));
    expect(rows.get('empty')?.disposition).toBe('empty');
    expect(rows.get('oversize')?.lines).toBe(1);
    for (const name of ['binary', 'oversize', 'link']) {
      expect(rows.get(name)?.disposition).toBe('unsupported');
    }
  });

  test('one blob read per invocation and copies on every hit', async () => {
    const fixture = new Fixture();
    const target = fixture.commit({ a: 'one\n', b: 'two\n' });
    const { runGit, calls } = countedRunGit(fixture.root);
    const repo = new GitAccountingRepository({ repo: fixture.root, runGit });
    repo.beginInvocation();
    const first = await repo.inventory(target, 10);
    (first[0] as unknown as Record<string, unknown>)['tier'] = 'mutated';
    const second = await repo.inventory(target, 10);
    expect(second[0]).not.toHaveProperty('tier');
    expect(calls.filter((args) => args[0] === 'cat-file').length).toBe(2);
    (second[0] as unknown as Record<string, unknown>)['tier'] = 'mutated';
    expect(await repo.inventory(target, 10)).toEqual(
      await new GitAccountingRepository({
        repo: fixture.root,
        runGit: runGitIn(fixture.root),
      }).inventory(target, 10),
    );
    const uncached = new GitAccountingRepository({
      repo: fixture.root,
      runGit,
    });
    await uncached.inventory(target, 10);
    await uncached.inventory(target, 10);
    expect(calls.filter((args) => args[0] === 'cat-file').length).toBe(6);
  });

  test('public entries are copies', async () => {
    const fixture = new Fixture();
    const target = fixture.commit({ a: 'one\n' });
    fixture.repo.beginInvocation();
    const entries = await fixture.repo.entries(target);
    (entries.get('a') as { blob: string }).blob = 'poison';
    expect((await fixture.repo.entries(target)).get('a')?.blob).not.toBe('poison');
  });

  test('a path beginning with U+FEFF keeps its identity', async () => {
    const fixture = new Fixture();
    const name = '\uFEFFa.ts';
    const target = fixture.commit({ [name]: 'one\n' });
    expect((await fixture.repo.inventory(target, 10)).map((row) => row.path)).toEqual([name]);
    expect((await fixture.repo.entries(target)).has(name)).toBe(true);
  });
});

describe('lineage and deletion', () => {
  test('a unique exact rename survives; a duplicate source blob does not', async () => {
    const fixture = new Fixture();
    const old = fixture.commit({ a: 'unique\n' });
    fixture.commit({ duplicate: 'unique\n' });
    fixture.git('mv', 'a', 'renamed');
    fixture.commit({});
    const target = fixture.commit({ duplicate: null });
    expect(await fixture.repo.lineage(old, target, 'a')).toBeNull();
  });

  test('a nonancestor target has no lineage', async () => {
    const fixture = new Fixture();
    const old = fixture.commit({ a: 'one\n' });
    const tree = fixture.git('rev-parse', `${old}^{tree}`);
    const unrelated = fixture.git('commit-tree', tree, '-m', 'Unrelated squash');
    expect(await fixture.repo.lineage(old, unrelated, 'a')).toBeNull();
  });

  test('multiple proven deletions reuse the immutable diff cache', async () => {
    const fixture = new Fixture();
    const old = fixture.commit({ a: 'unique-a\n', b: 'unique-b\n', other: 'keep\n' });
    const target = fixture.commit({ a: null, b: null });
    const { runGit, calls } = countedRunGit(fixture.root);
    const repo = new GitAccountingRepository({ repo: fixture.root, runGit });
    repo.beginInvocation();
    expect(await repo.provenDeleted(old, target, 'a')).toBe(true);
    expect(await repo.provenDeleted(old, target, 'b')).toBe(true);
    expect(calls.filter((args) => args[0] === 'diff').length).toBe(2);
  });

  test('a rename away is not an unambiguous deletion', async () => {
    const fixture = new Fixture();
    const old = fixture.commit({ a: 'unique\n' });
    fixture.git('mv', 'a', 'renamed');
    const target = fixture.commit({});
    expect(await fixture.repo.provenDeleted(old, target, 'a')).toBe(false);
  });
});

describe('carry', () => {
  test('Python list-index semantics survive the cached and uncached paths', async () => {
    const fixture = new Fixture();
    const { old, middle } = await history(fixture);
    const uncached = new GitAccountingRepository({
      repo: fixture.root,
      runGit: runGitIn(fixture.root),
    });
    const index = join(fixture.base, 'index');
    const cached = new GitAccountingRepository({
      repo: fixture.root,
      runGit: runGitIn(fixture.root),
      diskCache: new BackfillFactCache({ root: index, store: fixture.artifacts }),
    });
    for (const lines of [
      [1, 3, 4],
      [0, -1],
      [5, 9],
    ]) {
      const expected = await uncached.carry(old, middle, 'a', new Set(lines));
      expect(await cached.carry(old, middle, 'a', new Set(lines))).toEqual(expected);
      expect(await cached.carry(old, middle, 'a', new Set(lines))).toEqual(expected);
    }
    await expect(uncached.carry(old, middle, 'a', new Set([-4]))).rejects.toThrow(
      'list index out of range',
    );
    await expect(cached.carry(old, middle, 'a', new Set([-4]))).rejects.toThrow(
      'list index out of range',
    );
  });
});

describe('coverage', () => {
  test('a cached fold matches uncached across runs and targets', async () => {
    const fixture = new Fixture();
    const { value, middle } = await history(fixture);
    const expected = await new GitAccountingRepository({
      repo: fixture.root,
      runGit: runGitIn(fixture.root),
    }).coverage(middle, [value], fixture.artifacts);
    expect(expected.covered).toEqual(new Map([['renamed', new Set([1, 3, 4])]]));
    expect(expected.gaps).toEqual([]);

    const fresh = () =>
      new GitAccountingRepository({
        repo: fixture.root,
        runGit: runGitIn(fixture.root),
        diskCache: new BackfillFactCache({
          root: join(fixture.base, 'index'),
          store: fixture.artifacts,
        }),
      });
    expect(await fresh().coverage(middle, [value], fixture.artifacts)).toEqual(expected);

    const warmCalls = countedRunGit(fixture.root);
    const warm = new GitAccountingRepository({
      repo: fixture.root,
      runGit: warmCalls.runGit,
      diskCache: new BackfillFactCache({
        root: join(fixture.base, 'index'),
        store: fixture.artifacts,
      }),
    });
    expect(await warm.coverage(middle, [value], fixture.artifacts)).toEqual(expected);
    expect(warmCalls.calls.filter((args) => args[0] === 'blame')).toEqual([]);

    const target = fixture.commit({ other: 'z\n' });
    const laterExpected = await new GitAccountingRepository({
      repo: fixture.root,
      runGit: runGitIn(fixture.root),
    }).coverage(target, [value], fixture.artifacts);
    const laterCalls = countedRunGit(fixture.root);
    const later = new GitAccountingRepository({
      repo: fixture.root,
      runGit: laterCalls.runGit,
      diskCache: new BackfillFactCache({
        root: join(fixture.base, 'index'),
        store: fixture.artifacts,
      }),
    });
    expect(await later.coverage(target, [value], fixture.artifacts)).toEqual(laterExpected);
    const blamed = laterCalls.calls.filter((args) => args[0] === 'blame');
    expect(blamed.map((args) => args[args.length - 3])).toEqual([target]);
    expect(
      laterCalls.calls.filter((args) => args[0] === 'diff' && args[1] === '--name-status'),
    ).toHaveLength(1);
  });

  test('cached evidence that disappeared becomes a gap, never credit', async () => {
    const fixture = new Fixture();
    const target = fixture.commit({ a: 'one\n' });
    const value = await fullReview(fixture, target, 'a', [[1, 1]]);
    const index = join(fixture.base, 'index');
    const fresh = () =>
      new GitAccountingRepository({
        repo: fixture.root,
        runGit: runGitIn(fixture.root),
        diskCache: new BackfillFactCache({ root: index, store: fixture.artifacts }),
      });
    expect((await fresh().coverage(target, [value], fixture.artifacts)).covered).toEqual(
      new Map([['a', new Set([1])]]),
    );
    const reference = (value as JsonObject).get('payload') as JsonObject;
    const artifacts = reference.get('artifacts') as JsonValue[];
    const location = (artifacts[0] as JsonObject).get('location') as string;
    unlinkSync(location);
    const lost = await fresh().coverage(target, [value], fixture.artifacts);
    expect(lost.covered.size).toBe(0);
    expect(lost.gaps.map((gap) => gap.review)).toEqual([(value as JsonObject).get('id')]);
  });

  test('a skipped partition never credits', async () => {
    const fixture = new Fixture();
    const target = fixture.commit({ a: 'one\n' });
    const value = await fullReview(fixture, target, 'a', [[1, 1]]);
    const skipped = rehash(value, (plain) => {
      const payload = plain['payload'] as Record<string, unknown>;
      payload['outcome'] = 'skipped';
      (payload['completion'] as Record<string, unknown>)['skipped'] = true;
    });
    expect((await fixture.repo.coverage(target, [skipped], fixture.artifacts)).covered.size).toBe(
      0,
    );
  });

  test('a failed verification is never persisted', async () => {
    const fixture = new Fixture();
    const target = fixture.commit({ a: 'one\n' });
    const value = await fullReview(fixture, target, 'a', [[1, 1]]);
    const payload = (value as JsonObject).get('payload') as JsonObject;
    const location = ((payload.get('artifacts') as JsonValue[])[0] as JsonObject).get(
      'location',
    ) as string;
    unlinkSync(location);
    const index = join(fixture.base, 'index');
    const repo = new GitAccountingRepository({
      repo: fixture.root,
      runGit: runGitIn(fixture.root),
      diskCache: new BackfillFactCache({ root: index, store: fixture.artifacts }),
    });
    expect((await repo.coverage(target, [value], fixture.artifacts)).gaps).toHaveLength(1);
    expect(() => readdirSync(join(index, 'facts', 'verified_review'))).toThrow();
    expect(() => readdirSync(join(index, 'facts', 'coverage'))).toThrow();
  });
});

describe('fact cache', () => {
  test('round trip is bound to namespace and identity', async () => {
    const fixture = new Fixture();
    const cache = new BackfillFactCache({
      root: join(fixture.base, 'index'),
      store: fixture.artifacts,
    });
    const identity = { target: 'a'.repeat(40) };
    expect(await cache.get('blame', identity)).toBeNull();
    await cache.put('blame', identity, [[1, 2]]);
    expect(toPlainJson((await cache.get('blame', identity)) as JsonValue)).toEqual([[1, 2]]);
    expect(await cache.get('blame', { target: 'b'.repeat(40) })).toBeNull();
    expect(await cache.get('carry', identity)).toBeNull();
    expect(() => cache.key('../escape', {})).toThrow(BackfillCacheError);
  });

  test('a version bump or salt change invalidates every fact', async () => {
    const fixture = new Fixture();
    const root = join(fixture.base, 'index');
    const cache = new BackfillFactCache({ root, store: fixture.artifacts });
    await cache.put('lineage', { old: 'x' }, { path: 'a' });
    const upgraded = new BackfillFactCache({
      root,
      store: fixture.artifacts,
      salt: accountingFactSalt('git version 9'),
    });
    expect(await upgraded.get('lineage', { old: 'x' })).toBeNull();
    const bumped = new BackfillFactCache({
      root,
      store: fixture.artifacts,
      version: 2,
    });
    expect(await bumped.get('lineage', { old: 'x' })).toBeNull();
    expect(toPlainJson((await cache.get('lineage', { old: 'x' })) as JsonValue)).toEqual({
      path: 'a',
    });
  });

  test('a corrupt index or tampered artifact is a miss', async () => {
    const fixture = new Fixture();
    const root = join(fixture.base, 'index');
    const cache = new BackfillFactCache({ root, store: fixture.artifacts });
    await cache.put('lineage', { old: 'x' }, { path: 'a' });
    const index = readdirSync(join(root, 'facts', 'lineage'))[0] as string;
    const file = join(root, 'facts', 'lineage', index);
    const reference = ledgerLoads(readFileSync(file)) as JsonObject;
    const location = reference.get('location') as string;
    chmodSync(location, 0o644);
    writeFileSync(location, 'forged');
    expect(await cache.get('lineage', { old: 'x' })).toBeNull();
    writeFileSync(file, 'not json');
    expect(await cache.get('lineage', { old: 'x' })).toBeNull();
  });

  test('an index pointing at another valid fact is a miss', async () => {
    const fixture = new Fixture();
    const root = join(fixture.base, 'index');
    const cache = new BackfillFactCache({ root, store: fixture.artifacts });
    await cache.put('lineage', { old: 'x' }, { path: 'a' });
    await cache.put('lineage', { old: 'y' }, { path: 'b' });
    const x = join(root, 'facts', 'lineage', `${cache.key('lineage', { old: 'x' })}.json`);
    const y = join(root, 'facts', 'lineage', `${cache.key('lineage', { old: 'y' })}.json`);
    writeFileSync(x, readFileSync(y));
    expect(await cache.get('lineage', { old: 'x' })).toBeNull();
    expect(toPlainJson((await cache.get('lineage', { old: 'y' })) as JsonValue)).toEqual({
      path: 'b',
    });
  });

  test('an index write failure still stores the durable artifact', async () => {
    const fixture = new Fixture();
    const blocker = join(fixture.base, 'blocker');
    writeFileSync(blocker, 'not a directory');
    const cache = new BackfillFactCache({
      root: join(blocker, 'index'),
      store: fixture.artifacts,
    });
    await cache.put('lineage', { old: 'x' }, { path: 'a' });
    expect(readdirSync(join(fixture.base, 'artifacts', 'sha256')).length).toBeGreaterThan(0);
    expect(await cache.get('lineage', { old: 'x' })).toBeNull();
  });

  test('a wrong-shape fact is a miss and is recomputed', async () => {
    const fixture = new Fixture();
    const { old, value, middle } = await history(fixture);
    const root = join(fixture.base, 'index');
    const cache = new BackfillFactCache({ root, store: fixture.artifacts });
    const fresh = () =>
      new GitAccountingRepository({
        repo: fixture.root,
        runGit: runGitIn(fixture.root),
        diskCache: cache,
      });
    const expectedCarry = await new GitAccountingRepository({
      repo: fixture.root,
      runGit: runGitIn(fixture.root),
    }).carry(old, middle, 'a', new Set([1, 3, 4]));
    const expectedCoverage = await new GitAccountingRepository({
      repo: fixture.root,
      runGit: runGitIn(fixture.root),
    }).coverage(middle, [value], fixture.artifacts);
    await fresh().coverage(middle, [value], fixture.artifacts);
    const forged: Array<[string, unknown]> = [
      ['carry', { path: 'renamed', matches: [[1, 1, 1]], old_lines: '4' }],
      ['coverage', { covered: { renamed: [[1, 4]] }, evidence: { renamed: 'id' } }],
    ];
    for (const [kind, value] of forged) {
      for (const name of readdirSync(join(root, 'facts', kind))) {
        const file = join(root, 'facts', kind, name);
        const key = basename(name, '.json');
        const reference = await fixture.artifacts.put(ledgerJsonBytes({ key, value }));
        writeFileSync(file, ledgerJsonBytes(reference));
      }
    }
    expect(await fresh().carry(old, middle, 'a', new Set([1, 3, 4]))).toEqual(expectedCarry);
    expect(await fresh().coverage(middle, [value], fixture.artifacts)).toEqual(expectedCoverage);
  });
});

describe('report and capture seams', () => {
  test('the repository satisfies the four-method report seam', async () => {
    const fixture = new Fixture();
    const { old, middle } = await history(fixture);
    const report: BackfillReportRepo = fixture.repo;
    const captureRepo: BackfillCaptureRepo = fixture.repo;
    expect(captureRepo).toBe(fixture.repo);
    expect(await report.tree(old)).toBe(await fixture.repo.tree(old));
    expect(await report.lineage(old, middle, 'a')).toBe('renamed');
    const carried = await report.carry(old, middle, 'a', new Set([1, 3, 4]));
    expect(carried.name).toBe('renamed');
    expect([...carried.mapped]).toEqual([1, 3, 4]);
    expect(await report.provenDeleted(old, middle, 'a')).toBe(false);
  });

  test('retain produces a verified git bundle reference', async () => {
    const fixture = new Fixture();
    const target = fixture.commit({ a: 'one\n' });
    const reference = await fixture.repo.retain(fixture.artifacts, [target]);
    expect(reference.kind).toBe('git-bundle');
    await fixture.repo.restore(
      [
        new JsonObject([
          ['sha256', reference.sha256],
          ['location', reference.location],
          ['kind', 'git-bundle'],
        ]),
      ],
      fixture.artifacts,
    );
  });
});

describe('churn', () => {
  test('counts first-parent commits touching each path in the 30-day window', async () => {
    const fixture = new Fixture();
    fixture.commit({ c: 'one\n' }, '2026-01-01T00:00:00Z');
    fixture.commit({ a: 'one\n' }, '2026-10-20T00:00:00Z');
    fixture.commit({ b: 'one\n' }, '2026-10-21T00:00:00Z');
    const target = fixture.commit({ a: 'two\n' }, '2026-10-22T00:00:00Z');
    const counts = await fixture.repo.churn(target, '2026-11-15T00:00:00Z');
    expect(counts.get('a')).toBe(2);
    expect(counts.get('b')).toBe(1);
    expect(counts.get('c')).toBeUndefined();
  });
});
