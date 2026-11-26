/**
 * Differential test for the worktree verification and retention helpers
 * (src/adapters/crq/repairWorktreeCapture.ts) against the PRODUCTION Python:
 * `crq_repair.verify` (crq_repair/__init__.py:62-82), `retain.retain` and
 * `retain.untracked_directories` (crq_repair/retain.py:56-119) and
 * `crq_repair.retain_preserving_nested` (crq_repair.py:300-326).
 *
 * Offline: every scenario is a throwaway scratch git repository built from the
 * step list in apps/crq-python/fixtures/crq-process-helpers/cases.json, in a
 * temporary directory, under a pinned git identity and no git config. Commit
 * SHAs are therefore identical to Python's and the fixture names them
 * symbolically.
 *
 * Tar parity is by member (name, type, size, mode, link target, content), not
 * byte for byte: Python adds a PAX `mtime` record and uname/gname, so the
 * `untracked.tar` digest, and with it the `retained-<token>` name, differs from
 * Python's. The manifest digest is self-consistent, which is all
 * `cleanup_harvested` checks.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { atomicJsonText, receiptJsonDigest } from '../../../src/policy/crq/pythonJson.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';
import {
  retain,
  retainPreservingNested,
  untrackedDirectories,
  verifyRepairCommits,
} from '../../../src/adapters/crq/repairWorktreeCapture.js';
import {
  expectSameOutcome,
  loadFixture,
  plain,
  type Recorded,
} from '../../helpers/processHelpersOracle.js';
import {
  pinGitEnv,
  runMore,
  markOf,
  runSteps,
  scrubber,
  statusOf,
  substitute,
  walkFiles,
  type Scratch,
  type Step,
} from '../../helpers/processHelpersScratch.js';
import { readTar } from '../../helpers/tarMembers.js';

const fixture = loadFixture();
let restoreEnv: () => void = () => undefined;
beforeAll(() => {
  restoreEnv = pinGitEnv();
});
afterAll(() => restoreEnv());

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

/** The snapshot description `snapshot_of` records in the Python emitter. */
function snapshotOf(scratch: Scratch, target: string) {
  const scrub = scrubber(scratch.root, scratch.marks);
  const manifestText = readFileSync(join(target, 'manifest.json'), 'utf8');
  const manifest = JSON.parse(manifestText) as {
    sha256: Record<string, string>;
  } & Record<string, unknown>;
  const digests: Record<string, string> = {};
  for (const name of [
    'staged.patch',
    'unstaged.patch',
    'committed.patch',
    'untracked.tar',
    'commits.bundle',
  ]) {
    digests[name] = sha256(readFileSync(join(target, name)));
  }
  const bundle = readFileSync(join(target, 'commits.bundle'));
  const heads =
    bundle.length === 0
      ? null
      : scrub(
          execFileSync('git', ['bundle', 'list-heads', join(target, 'commits.bundle')], {
            cwd: scratch.repo,
          }).toString('utf8'),
        );
  const masked = JSON.parse(manifestText) as typeof manifest;
  masked.sha256['untracked.tar'] = '<sha256>';
  masked.sha256['commits.bundle'] = '<sha256>';
  const patch = (name: string): string => readFileSync(join(target, name)).toString('utf8');
  return {
    manifest: JSON.parse(scrub(JSON.stringify(masked))) as unknown,
    manifest_key_order: Object.keys(manifest),
    manifest_sha256_key_order: Object.keys(manifest.sha256),
    manifest_text_matches_atomic: manifestText === atomicJsonText(manifest),
    digests_consistent: stable(digests) === stable(manifest.sha256),
    named_by_manifest: target.endsWith(`retained-${receiptJsonDigest(manifest)}`),
    files: readdirSync(target).sort(),
    patches: {
      'staged.patch': patch('staged.patch'),
      'unstaged.patch': patch('unstaged.patch'),
      'committed.patch': patch('committed.patch'),
    },
    tar: readTar(readFileSync(join(target, 'untracked.tar'))),
    bundle_empty: bundle.length === 0,
    bundle_heads: heads,
    dir_mode: statSync(target).mode & 0o7777,
    manifest_mode: statSync(join(target, 'manifest.json')).mode & 0o7777,
  };
}

describe('fixture', () => {
  it('names the verified Python sources', () => {
    expect(fixture.verify.length).toBeGreaterThan(30);
    expect(fixture.retain.length).toBeGreaterThan(20);
    expect(fixture.nested.length).toBeGreaterThan(5);
  });
});

describe('verifyRepairCommits (crq_repair/__init__.py:62-82)', () => {
  for (const c of fixture.verify as Array<
    Recorded & { repo: Step[]; base: string; commits: unknown; job: string }
  >) {
    it(c.name, () => {
      const scratch = runSteps(c.repo);
      try {
        const scrub = scrubber(scratch.root, scratch.marks);
        const commits = Array.isArray(c.commits)
          ? c.commits.map((entry: unknown) => {
              if (typeof entry !== 'string') return entry;
              if (entry.startsWith('UPPER:')) {
                return substitute(entry.slice('UPPER:'.length), scratch.marks).toUpperCase();
              }
              return substitute(entry, scratch.marks);
            })
          : c.commits;
        expectSameOutcome(
          () =>
            verifyRepairCommits(scratch.repo, substitute(c.base, scratch.marks), commits, c.job),
          c,
          (head) => scrub(String(head)),
        );
      } finally {
        scratch.dispose();
      }
    });
  }
});

describe('retain (crq_repair/retain.py:56-107)', () => {
  for (const c of fixture.retain as Array<
    Recorded & {
      repo: Step[];
      options: { include_clean?: boolean };
      snapshot?: Record<string, unknown>;
      second_capture_reuses_snapshot?: boolean;
      leftover_capture_dirs: string[];
      evidence_entries: number | null;
      tree_unchanged: boolean;
      untracked_directories: Recorded;
    }
  >) {
    it(c.name, () => {
      const scratch = runSteps(c.repo);
      try {
        const scrub = scrubber(scratch.root, scratch.marks);
        const evidence = join(scratch.root, 'evidence', 'attempt');
        const before = statusOf(scratch.repo, scrub);
        const options = { includeClean: c.options.include_clean === true };
        let target: string | null = null;
        expectSameOutcome(
          () => {
            target = retain(scratch.repo, markOf(scratch, 'c0'), evidence, options);
            return target;
          },
          c,
          (value) => (value === null ? null : '<snapshot>'),
        );
        if (target !== null) {
          expect(plain(snapshotOf(scratch, target)), c.name).toEqual(plain(c.snapshot));
          const again = retain(scratch.repo, markOf(scratch, 'c0'), evidence, options);
          expect(again === target, 'second capture reuses the snapshot').toBe(
            c.second_capture_reuses_snapshot,
          );
        }
        const leftovers = existsSync(evidence)
          ? readdirSync(evidence)
              .filter((name) => name.startsWith('.capture-'))
              .sort()
          : [];
        expect(leftovers, 'no capture temp dir survives').toEqual(c.leftover_capture_dirs);
        expect(existsSync(evidence) ? readdirSync(evidence).length : null).toEqual(
          plain(c.evidence_entries),
        );
        expect(statusOf(scratch.repo, scrub) === before, 'tree unchanged').toBe(c.tree_unchanged);
        expectSameOutcome(
          () => untrackedDirectories(scratch.repo),
          { ...c.untracked_directories, name: `${c.name}: untracked_directories` },
          (dirs) => dirs,
        );
      } finally {
        scratch.dispose();
      }
    });
  }
});

describe('retainPreservingNested (crq_repair.py:300-326)', () => {
  for (const c of fixture.nested as Array<{
    name: string;
    rounds: Step[][];
    results: Recorded[];
    moved_files: string[] | null;
    moved_git_heads: string[] | null;
    capture_dirs: boolean[] | null;
    snapshots: unknown[];
    tree_status: string;
  }>) {
    it(c.name, () => {
      const scratch = runSteps(c.rounds[0] ?? []);
      try {
        const scrub = scrubber(scratch.root, scratch.marks);
        const evidence = join(scratch.root, 'evidence', 'attempt');
        c.rounds.forEach((steps, index) => {
          if (index > 0) runMore(scratch, steps);
          expectSameOutcome(
            () => {
              retainPreservingNested(scratch.repo, markOf(scratch, 'c0'), evidence);
              return null;
            },
            { ...c.results[index], name: `${c.name}: round ${index}` },
          );
        });
        const holder = join(evidence, 'retained-nested');
        const norm = (path: string): string => path.replace(/capture-[A-Za-z0-9_]+/, 'capture-*');
        const files = existsSync(holder) ? walkFiles(holder) : null;
        expect(
          files === null
            ? null
            : files
                .filter((path) => !path.includes('.git/'))
                .map(norm)
                .sort(),
          'moved files',
        ).toEqual(c.moved_files);
        expect(
          files === null
            ? null
            : files
                .filter((path) => path.endsWith('.git/HEAD'))
                .map(norm)
                .sort(),
          'moved git heads',
        ).toEqual(c.moved_git_heads);
        expect(
          existsSync(holder)
            ? readdirSync(holder)
                .map((name) => name.startsWith('capture-'))
                .sort()
            : null,
        ).toEqual(c.capture_dirs);
        const snapshots = (existsSync(evidence) ? readdirSync(evidence) : [])
          .filter((name) => name.startsWith('retained-') && name !== 'retained-nested')
          .map((name) => plain(snapshotOf(scratch, join(evidence, name))) as { manifest: unknown })
          .sort((a, b) => (stable(a.manifest) < stable(b.manifest) ? -1 : 1));
        expect(snapshots).toEqual(plain(c.snapshots));
        expect(statusOf(scratch.repo, scrub)).toBe(c.tree_status);
      } finally {
        scratch.dispose();
      }
    });
  }
});

describe('TS-only pins', () => {
  it('refuses an untracked name that is not valid UTF-8 (Python archives it via surrogateescape)', () => {
    const scratch = runSteps([
      ['git', 'init', '-q', '-b', 'main'],
      ['write', 'a.txt', 'one\n'],
      ['commit_all', 'base'],
      ['mark', 'c0'],
    ]);
    try {
      writeFileSync(Buffer.concat([Buffer.from(scratch.repo + '/bad-'), Buffer.from([0xff])]), 'x');
      let thrown: unknown;
      try {
        retain(scratch.repo, markOf(scratch, 'c0'), join(scratch.root, 'evidence'));
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(PyError);
      expect((thrown as PyError).kind).toBe('ValueError');
      expect(existsSync(join(scratch.root, 'evidence'))).toBe(false);
    } finally {
      scratch.dispose();
    }
  });

  it('archives a symlink target byte for byte, even when it is not UTF-8', () => {
    const scratch = runSteps([
      ['git', 'init', '-q', '-b', 'main'],
      ['write', 'a.txt', 'one\n'],
      ['commit_all', 'base'],
      ['mark', 'c0'],
    ]);
    try {
      const raw = Buffer.concat([Buffer.from('bad'), Buffer.from([0xff]), Buffer.from('target')]);
      symlinkSync(raw as unknown as string, join(scratch.repo, 'lnk'));
      const target = retain(scratch.repo, markOf(scratch, 'c0'), join(scratch.root, 'evidence'));
      const archive = readFileSync(join(target as string, 'untracked.tar'));
      expect(archive.includes(raw)).toBe(true);
      expect(archive.includes(Buffer.from([0xef, 0xbf, 0xbd]))).toBe(false);
    } finally {
      scratch.dispose();
    }
  });

  it('keeps a pre-epoch mtime readable by moving it to a PAX record', () => {
    const scratch = runSteps([
      ['git', 'init', '-q', '-b', 'main'],
      ['write', 'a.txt', 'one\n'],
      ['commit_all', 'base'],
      ['mark', 'c0'],
      ['write', 'old.txt', 'old\n'],
    ]);
    try {
      execFileSync('touch', ['-d', '1968-01-01T00:00:00Z', join(scratch.repo, 'old.txt')]);
      const target = retain(scratch.repo, markOf(scratch, 'c0'), join(scratch.root, 'evidence'));
      const tar = join(target as string, 'untracked.tar');
      const listed = spawnSync('tar', ['-tvf', tar], { encoding: 'utf8' });
      expect(listed.status, listed.stderr).toBe(0);
      expect(listed.stdout).toContain('old.txt');
      expect(listed.stdout).toContain('1968-0');
    } finally {
      scratch.dispose();
    }
  });

  it('writes an archive GNU tar reads: long, non-ASCII, symlink and hard-link entries', () => {
    const long = `${'d'.repeat(40)}/${'e'.repeat(40)}/${'f'.repeat(40)}.txt`;
    const scratch = runSteps([
      ['git', 'init', '-q', '-b', 'main'],
      ['write', 'a.txt', 'one\n'],
      ['commit_all', 'base'],
      ['mark', 'c0'],
      ['write', long, 'long\n'],
      ['write', 'café ☃.txt', 'u\n'],
      ['write', 'h1.txt', 'same\n'],
      ['link', 'h1.txt', 'h2.txt'],
      ['symlink', 'z-link', 'h1.txt'],
    ]);
    try {
      const target = retain(scratch.repo, markOf(scratch, 'c0'), join(scratch.root, 'evidence'));
      expect(target).not.toBeNull();
      const tar = join(target as string, 'untracked.tar');
      expect(statSync(tar).size % 10240).toBe(0);
      const listed = spawnSync('tar', ['-tf', tar], {
        encoding: 'utf8',
        env: { ...process.env, LC_ALL: 'C.UTF-8' },
      });
      expect(listed.status).toBe(0);
      expect(listed.stdout.split('\n').filter(Boolean).sort()).toEqual(
        [long, 'café ☃.txt', 'h1.txt', 'h2.txt', 'z-link'].sort(),
      );
      const content = spawnSync('tar', ['-xOf', tar, long], { encoding: 'utf8' });
      expect(content.stdout).toBe('long\n');
      mkdirSync(join(scratch.root, 'x'));
    } finally {
      scratch.dispose();
    }
  });
});
