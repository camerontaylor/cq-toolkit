import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  GitSubjectRepository,
  type BackfillSubjectAccounting,
} from '../../../src/adapters/crq/backfillSubjects.js';
import { GitCoverageRepository } from '../../../src/adapters/crq/coverageSource.js';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { changedIntervals } from '../../../src/adapters/crq/reviewVerify.js';
import { ledgerPath } from '../../../src/policy/crq/ledger.js';
import { compareCodePoints, ledgerJsonDigest } from '../../../src/policy/crq/pythonJson.js';
import {
  construct,
  type ConstructResult,
  type SubjectInventoryRow,
  type SubjectTreeEntry,
} from '../../../src/policy/crq/backfillSubjects.js';

interface Fixture {
  readonly root: string;
  readonly runGit: RunGit;
  /** Run one fixture git command and return trimmed stdout. */
  git(...args: string[]): Promise<string>;
  /** Write/remove fixture files and commit them; returns the new commit id. */
  commit(files: Record<string, string | Uint8Array | null>): Promise<string>;
}

const FIXTURE_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_DATE: '2026-10-29T00:00:00Z',
  GIT_COMMITTER_DATE: '2026-10-29T00:00:00Z',
};

const SUBJECT_COMMIT_ENV: Readonly<Record<string, string>> = {
  GIT_AUTHOR_NAME: 'crq',
  GIT_AUTHOR_EMAIL: 'crq@localhost',
  GIT_COMMITTER_NAME: 'crq',
  GIT_COMMITTER_EMAIL: 'crq@localhost',
  GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
};

function decode(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

async function ok(
  runGit: RunGit,
  args: readonly string[],
  env?: Record<string, string>,
): Promise<Uint8Array> {
  const call = await runGit(args, env === undefined ? undefined : { env });
  if (call.code !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${call.stderr}`);
  return call.stdout;
}

async function fixtureRepo(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'cq-crq-subjects-'));
  const runGit = runGitIn(root);
  await ok(runGit, ['init', '-q']);
  await ok(runGit, ['config', 'user.name', 'fixture']);
  await ok(runGit, ['config', 'user.email', 'fixture@localhost']);
  const git = async (...args: string[]): Promise<string> => decode(await ok(runGit, args)).trim();
  const commit = async (files: Record<string, string | Uint8Array | null>): Promise<string> => {
    for (const [name, content] of Object.entries(files)) {
      const target = join(root, name);
      if (content === null) {
        await rm(target, { force: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
    }
    await ok(runGit, ['add', '-A']);
    await ok(runGit, ['commit', '-qm', 'Fixture change'], { ...FIXTURE_ENV });
    return decode(await ok(runGit, ['rev-parse', 'HEAD'])).trim();
  };
  return { root, runGit, git, commit };
}

/** Python `line_bytes` length: split on `\n`, dropping one trailing empty. */
function lineCount(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let newlines = 0;
  for (const byte of data) if (byte === 0x0a) newlines += 1;
  return data[data.length - 1] === 0x0a ? newlines : newlines + 1;
}

/**
 * The Stage 1 accounting surface over real Git for this suite. It reuses the
 * merged `changedIntervals` parser and coverage repository rather than faking
 * any Git fact; only `inventory` and `entries` are read here directly.
 */
class RealAccounting implements BackfillSubjectAccounting {
  private readonly coverage: GitCoverageRepository;

  constructor(private readonly runGit: RunGit) {
    this.coverage = new GitCoverageRepository(runGit);
  }

  private async ok(args: readonly string[]): Promise<Uint8Array> {
    const call = await this.runGit(args);
    if (call.code !== 0) throw new Error(`git ${args[0] ?? ''} failed: ${call.stderr}`);
    return call.stdout;
  }

  async resolve(value: string): Promise<string> {
    if (!/^[0-9a-f]{40,64}$/.test(value)) {
      throw new Error('target must be an immutable full object ID');
    }
    return decode(await this.ok(['rev-parse', `${value}^{commit}`])).trim();
  }

  async tree(commit: string): Promise<string> {
    return decode(await this.ok(['rev-parse', `${await this.resolve(commit)}^{tree}`])).trim();
  }

  async entries(commit: string): Promise<ReadonlyMap<string, SubjectTreeEntry>> {
    const raw = Buffer.from(await this.ok(['ls-tree', '-r', '-z', await this.resolve(commit)]));
    const result = new Map<string, SubjectTreeEntry>();
    let cursor = 0;
    while (cursor < raw.length) {
      const end = raw.indexOf(0, cursor);
      if (end < 0) break;
      const record = raw.subarray(cursor, end);
      cursor = end + 1;
      const tab = record.indexOf(0x09);
      if (tab < 0) throw new Error('malformed ls-tree entry');
      const [mode, kind, blob] = record.subarray(0, tab).toString('utf8').split(' ');
      const nameBytes = record.subarray(tab + 1);
      const name = nameBytes.toString('utf8');
      let path: string;
      try {
        path = ledgerPath(name);
      } catch {
        path = `git-path-bytes:${nameBytes.toString('hex')}`;
      }
      result.set(path, { path, mode: mode as string, kind: kind as string, blob: blob as string });
    }
    return result;
  }

  async inventory(target: string, maxFileBytes: number): Promise<readonly SubjectInventoryRow[]> {
    const entries = [...(await this.entries(target)).values()].sort((left, right) =>
      compareCodePoints(left.path, right.path),
    );
    const rows: SubjectInventoryRow[] = [];
    for (const entry of entries) {
      const row: {
        path: string;
        blob: string;
        mode: string;
        kind: string;
        lines: number | null;
        bytes: number | null;
        disposition: string;
        reason: string;
      } = {
        path: entry.path,
        blob: entry.blob,
        mode: entry.mode,
        kind: entry.kind,
        lines: null,
        bytes: null,
        disposition: 'unsupported',
        reason: 'non-regular object',
      };
      if (entry.path.startsWith('git-path-bytes:')) {
        row.reason = 'non-canonical or non-UTF8 path';
        rows.push(row);
        continue;
      }
      if ((entry.mode !== '100644' && entry.mode !== '100755') || entry.kind !== 'blob') {
        rows.push(row);
        continue;
      }
      const call = await this.runGit(['cat-file', 'blob', entry.blob]);
      if (call.code !== 0) {
        row.reason = 'unreadable blob';
        rows.push(row);
        continue;
      }
      const data = call.stdout;
      row.bytes = data.length;
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(data);
      } catch {
        row.reason = 'non-UTF8 blob';
        rows.push(row);
        continue;
      }
      if (data.includes(0)) {
        row.reason = 'binary blob';
      } else {
        row.lines = lineCount(data);
        if (data.length > maxFileBytes) {
          row.reason = 'current content exceeds per-file limit';
        } else if (data.length > 0) {
          row.disposition = 'included';
          row.reason = 'tracked regular UTF8 text';
        } else {
          row.disposition = 'empty';
          row.reason = 'empty current blob';
        }
      }
      rows.push(row);
    }
    return rows;
  }

  changedIntervals(base: string, head: string): Promise<ReadonlyMap<string, ReadonlySet<number>>> {
    return changedIntervals(this.runGit, base, head);
  }

  lineage(old: string, next: string, path: string): Promise<string | null> {
    return this.coverage.lineage(old, next, path);
  }
}

interface Policy {
  max_files: number;
  max_file_bytes: number;
  max_total_bytes: number;
  reviewer: {
    verified: boolean;
    evidence: string;
    max_files: number;
    max_diff_bytes: number;
  };
}

function policy(): Policy {
  return {
    max_files: 8,
    max_file_bytes: 262144,
    max_total_bytes: 2097152,
    reviewer: {
      verified: true,
      evidence: 'offline-fixture-only',
      max_files: 8,
      max_diff_bytes: 2097152,
    },
  };
}

interface Partition {
  readonly subject_id: string;
  readonly base: string;
  readonly head: string;
  readonly refs: string;
  readonly scope: Array<{ path: string; blob: string; intervals: number[][] }>;
  readonly paths: Array<{
    path: string;
    blob: string;
    mode: string;
    baseline: Record<string, unknown>;
  }>;
  readonly residual: boolean;
  readonly diff_bytes: number;
  readonly scope_digest: string;
}

function partitionAt(result: ConstructResult, index = 0): Partition {
  return result.partitions[index] as unknown as Partition;
}

async function candidate(
  fixture: Fixture,
  accounting: RealAccounting,
  target: string,
  names: readonly string[],
  kind: 'A' | 'B' = 'B',
): Promise<Record<string, unknown>> {
  const entries = await accounting.entries(target);
  const scope: Array<Record<string, unknown>> = [];
  for (const name of names) {
    const entry = entries.get(name);
    if (entry === undefined) throw new Error(`fixture target is missing ${name}`);
    const data = await ok(fixture.runGit, ['cat-file', 'blob', entry.blob]);
    scope.push({
      path: name,
      blob: entry.blob,
      intervals: [[1, lineCount(data)]],
    });
  }
  return {
    target,
    kind,
    scope,
    scope_digest: ledgerJsonDigest(scope),
    subject_id: 'b'.repeat(64),
    job_id: `${'b'.repeat(64)}:0`,
    generation: 0,
    prs: [1],
    tier: 'T1',
    family: 'family',
    partition: 0,
  };
}

async function subjectRepo(fixture: Fixture): Promise<{
  accounting: RealAccounting;
  repo: GitSubjectRepository;
}> {
  const accounting = new RealAccounting(fixture.runGit);
  const repo = new GitSubjectRepository({ runGit: fixture.runGit, accounting });
  return { accounting, repo };
}

describe('backfill subject adapter', () => {
  test('current projection tree and immutable refs survive a tip move', async () => {
    const fixture = await fixtureRepo();
    try {
      const target = await fixture.commit({ a: 'one\ntwo\n' });
      const { accounting, repo } = await subjectRepo(fixture);
      const result = await construct(
        repo,
        await candidate(fixture, accounting, target, ['a']),
        policy(),
      );

      expect(result.debt).toEqual([]);
      const partition = partitionAt(result);
      expect(await accounting.tree(partition.head)).toBe(await accounting.tree(target));

      await fixture.commit({ a: 'later\n' });
      await fixture.git('gc');
      expect(await fixture.git('rev-parse', `${partition.refs}/target`)).toBe(target);

      const replay = await construct(
        repo,
        await candidate(fixture, accounting, target, ['a']),
        policy(),
      );
      expect(replay).toEqual(result);
      await expect(
        repo.pin(partition.subject_id, 0, 0, partition.head, partition.head, target),
      ).rejects.toThrow('immutable subject pin conflict');
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('linear stack picks the earliest pre-merge baseline and re-cuts the residual', async () => {
    const fixture = await fixtureRepo();
    try {
      await fixture.commit({ a: 'same\nold\n' });
      const first = await fixture.commit({ a: 'same\nnew\n' });
      const target = await fixture.commit({ a: 'same\nnewer\n' });
      const { accounting, repo } = await subjectRepo(fixture);
      const members = [
        { merge: target, paths: [{ path: 'a', source_path: 'a', lineage_verified: true }] },
        { merge: first, paths: [{ path: 'a', source_path: 'a', lineage_verified: true }] },
      ];

      const result = await construct(
        repo,
        await candidate(fixture, accounting, target, ['a'], 'A'),
        policy(),
        members,
      );

      expect(result.debt).toEqual([]);
      expect(result.partitions).toHaveLength(2);
      const initial = partitionAt(result, 0);
      const residual = partitionAt(result, 1);
      expect(initial.paths[0]?.baseline['merge']).toBe(first);
      expect(initial.scope[0]?.intervals).toEqual([[2, 2]]);
      expect(initial.residual).toBe(false);
      expect(residual.residual).toBe(true);
      expect(residual.scope[0]?.intervals).toEqual([[1, 2]]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('an empty synthetic diff projects the unchanged uncovered file', async () => {
    const fixture = await fixtureRepo();
    try {
      await fixture.commit({ a: 'same\n' });
      const merge = await fixture.commit({ other: 'changed\n' });
      const { accounting, repo } = await subjectRepo(fixture);
      const members = [{ merge, paths: [{ path: 'a', source_path: 'a', lineage_verified: true }] }];

      const result = await construct(
        repo,
        await candidate(fixture, accounting, merge, ['a'], 'A'),
        policy(),
        members,
      );

      expect(result.debt).toEqual([]);
      expect(result.partitions).toHaveLength(1);
      expect(partitionAt(result).residual).toBe(true);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('a member without paths has no baseline and falls back', async () => {
    const fixture = await fixtureRepo();
    try {
      await fixture.commit({ a: 'same\n' });
      const merge = await fixture.commit({ a: 'changed\n' });
      const { accounting, repo } = await subjectRepo(fixture);

      const result = await construct(
        repo,
        await candidate(fixture, accounting, merge, ['a'], 'A'),
        policy(),
        [{ merge }],
      );

      expect(result.debt).toEqual([]);
      expect(partitionAt(result).paths[0]?.baseline['reason']).toBe(
        'missing/ambiguous baseline lineage',
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('nonlinear members fall back and an oversize peer does not block the subject', async () => {
    const fixture = await fixtureRepo();
    try {
      const root = await fixture.commit({ a: 'old\n' });
      const left = await fixture.commit({ a: 'left\n' });
      await fixture.git('checkout', '-q', root);
      const right = await fixture.commit({ a: 'right\n', big: 'x'.repeat(50) });
      const { accounting, repo } = await subjectRepo(fixture);
      const members = [left, right].map((merge) => ({
        merge,
        paths: [{ path: 'a', source_path: 'a', lineage_verified: true }],
      }));
      const tight = policy();
      tight.max_file_bytes = 20;

      const result = await construct(
        repo,
        await candidate(fixture, accounting, right, ['a', 'big'], 'A'),
        tight,
        members,
      );

      expect(result.partitions).toHaveLength(1);
      expect(partitionAt(result).paths[0]?.baseline['reason']).toBe('nonlinear stack baselines');
      expect(result.debt).toEqual([
        {
          path: 'big',
          reason: 'current content exceeds per-file limit',
          disposition: 'unsupported',
        },
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('PR context is inert commit text and leaves the tree unchanged', async () => {
    const fixture = await fixtureRepo();
    try {
      await fixture.commit({ a: 'old\n' });
      const target = await fixture.commit({ a: 'new\n' });
      const marker = join(fixture.root, 'must-not-exist');
      const { accounting, repo } = await subjectRepo(fixture);
      const members = [
        {
          pr: 1,
          merge: target,
          paths: [{ path: 'a', source_path: 'a', lineage_verified: true }],
          context: { title: 'untrusted', body: `$(touch ${marker}); echo unsafe` },
        },
      ];

      const result = await construct(
        repo,
        await candidate(fixture, accounting, target, ['a'], 'A'),
        policy(),
        members,
      );

      const partition = partitionAt(result);
      expect(await fixture.git('show', '-s', '--format=%B', partition.head)).toContain(
        'BEGIN UNTRUSTED PR CONTEXT',
      );
      expect(existsSync(marker)).toBe(false);
      expect(await accounting.tree(partition.head)).toBe(await accounting.tree(target));
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('a stdin commit message is byte-identical to the oracle -m form', async () => {
    const fixture = await fixtureRepo();
    try {
      const parent = await fixture.commit({ a: 'one\n' });
      const { accounting, repo } = await subjectRepo(fixture);
      const tree = await accounting.tree(parent);
      const messages = [
        'crq pinned current subject',
        'crq pinned current subject\n\nbody\n\nwith a trailing newline',
        'crq pinned current subject\n\nbody\n',
      ];
      for (const message of messages) {
        const viaStdin = await repo.commitTree(tree, parent, message);
        const viaArgv = decode(
          await ok(fixture.runGit, ['commit-tree', tree, '-p', parent, '-m', message], {
            ...SUBJECT_COMMIT_ENV,
          }),
        ).trim();
        expect(viaStdin).toBe(viaArgv);
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('the diff byte count matches the oracle stdout length', async () => {
    const fixture = await fixtureRepo();
    try {
      const parent = await fixture.commit({ a: 'one\n', big: 'x'.repeat(1000) });
      const target = await fixture.commit({ a: 'two\n', big: 'y'.repeat(2000) });
      const { repo } = await subjectRepo(fixture);
      const expected = (
        await ok(fixture.runGit, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--binary',
          parent,
          target,
        ])
      ).length;

      expect(await repo.diffBytes(parent, target)).toBe(expected);
      expect(await repo.diffBytes(target, target)).toBe(0);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('file count and measured diff limits split without truncation', async () => {
    const fixture = await fixtureRepo();
    try {
      const names = Array.from({ length: 11 }, (_, index) => `p/${String(index).padStart(2, '0')}`);
      const files: Record<string, string> = {};
      for (const name of names) files[name] = 'one\n';
      const target = await fixture.commit(files);
      const { accounting, repo } = await subjectRepo(fixture);
      const sizedPolicy = policy();
      sizedPolicy.max_files = 3;

      const sized = await construct(
        repo,
        await candidate(fixture, accounting, target, names),
        sizedPolicy,
      );
      expect(sized.debt).toEqual([]);
      const covered = sized.partitions.flatMap((part) =>
        (part['paths'] as Array<{ path: string }>).map((row) => row.path),
      );
      expect(new Set(covered)).toEqual(new Set(names));
      expect(sized.partitions.every((part) => (part['paths'] as unknown[]).length <= 3)).toBe(true);

      const diffPolicy = policy();
      diffPolicy.reviewer.max_diff_bytes = 1;
      const unsupported = await construct(
        repo,
        await candidate(fixture, accounting, target, names),
        diffPolicy,
      );
      expect(unsupported.partitions).toEqual([]);
      expect(unsupported.debt).toHaveLength(11);
      for (const entry of unsupported.debt) {
        expect(entry['reason']).toBe('single-file diff exceeds verified reviewer byte limit');
      }
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('UTF-8 content is lossless and non-ASCII paths fall back exactly like the oracle', async () => {
    const fixture = await fixtureRepo();
    try {
      const utf8 = 'café\n文件\n';
      const target = await fixture.commit({ 'utf8.txt': utf8 });
      const { accounting, repo } = await subjectRepo(fixture);
      const result = await construct(
        repo,
        await candidate(fixture, accounting, target, ['utf8.txt']),
        policy(),
      );

      expect(result.debt).toEqual([]);
      const partition = partitionAt(result);
      expect(partition.scope).toEqual([
        {
          path: 'utf8.txt',
          // Python-oracle vector: the blob id for `café\n文件\n`.
          blob: '46632b1d203441a6491216e41ffa73cbaa9853a3',
          intervals: [[1, 2]],
        },
      ]);
      expect(partition.scope_digest).toBe(ledgerJsonDigest(partition.scope));
      expect(partition.subject_id).toBe(
        ledgerJsonDigest({
          parent: 'b'.repeat(64),
          scope: partition.scope,
          partition: 0,
          residual: false,
        }),
      );
      expect(partition.diff_bytes).toBeGreaterThan(Buffer.byteLength(utf8));

      const nonAscii = await fixture.commit({ 'é.txt': 'naïve\n' });
      const quoted = await construct(
        repo,
        await candidate(fixture, accounting, nonAscii, ['é.txt']),
        policy(),
      );
      expect(quoted.partitions).toEqual([]);
      expect(quoted.debt).toEqual([
        {
          path: 'é.txt',
          disposition: 'unsupported',
          reason: 'projection cannot expose requested head intervals',
        },
      ]);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('pin validates generation, partition and identity before writing a ref', async () => {
    const fixture = await fixtureRepo();
    try {
      const target = await fixture.commit({ a: 'one\n' });
      const { accounting, repo } = await subjectRepo(fixture);
      const sha = await accounting.resolve(target);
      const identity = 'c'.repeat(64);
      await expect(repo.pin(identity, -1, 0, sha, sha, sha)).rejects.toThrow(
        'invalid pin generation/partition',
      );
      await expect(repo.pin(identity, 0, 1.5, sha, sha, sha)).rejects.toThrow(
        'invalid pin generation/partition',
      );
      await expect(repo.pin('C'.repeat(64), 0, 0, sha, sha, sha)).rejects.toThrow(
        'invalid subject identity',
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
