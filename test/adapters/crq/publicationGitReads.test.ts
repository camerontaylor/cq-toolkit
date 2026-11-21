// Differential run: the same throwaway local repositories through Python's real
// `crq.git`, `crq.is_ancestor` and `crq_repair.git` (the `wt_git` of
// `repair_tick.publish`; the oracle is test/helpers/publicationGitReadsOracle.py)
// and the TS publication Git reads. Values and the exception class must be equal.
// Scripted-process cases pin the failure classes a repository cannot produce on
// demand (spawn failure, the time bound). Local repositories only: no remote,
// forge, provider, service or worktree mutation by the adapter; the fixtures
// themselves are made by the test with plain `git`.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitPublicationReads,
  type PublicationGitReads,
} from '../../../src/adapters/crq/publicationGitReads.js';
import type { GitCall, RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { isPyError, PyError } from '../../../src/queue-runner/pyErrors.js';
import {
  publishRepair,
  STALE_DOES_NOT_APPLY,
  type PublicationPublishEffects,
} from '../../../src/queue-runner/publicationPublish.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const ORACLE = fileURLToPath(
  new URL('../../helpers/publicationGitReadsOracle.py', import.meta.url),
);
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));

// The structural subset the publish orchestration declares.
type Pinned = Pick<PublicationPublishEffects, keyof PublicationGitReads>;
const pinned = (reads: PublicationGitReads): Pinned => reads;

interface Fixture {
  root: string;
  clone: string;
  wtRoot: string;
  base: string;
  target: string;
  repair: string;
  unrelated: string;
  /** Worktree at `target` with the conflicting repair mid cherry-pick. */
  conflicted: string;
  /** Worktree at `target`, clean, with a staged but uncommitted file. */
  staged: string;
  /** Worktree at `target`, clean, nothing in progress. */
  clean: string;
  /** Worktree at `target` plus two replayed commits (CRLF and a rename). */
  replayed: string;
  /** Worktree whose diff against `target` is not valid UTF-8. */
  invalid: string;
  missing: string;
}

const cleanups: string[] = [];
let fx: Fixture;

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.invalid',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    { encoding: 'utf8', env: scrubbedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-git-reads-')));
  cleanups.push(root);
  const clone = join(root, 'clone');
  const wtRoot = join(root, 'wt');
  await mkdir(clone);
  await mkdir(wtRoot);
  git(clone, 'init', '-q', '--object-format=sha1');
  const write = (dir: string, name: string, text: string | Buffer) =>
    writeFile(join(dir, name), text);
  const commit = async (dir: string, name: string, text: string | Buffer, message: string) => {
    await write(dir, name, text);
    git(dir, 'add', name);
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const base = await commit(clone, 'a.txt', 'l1\nl2\nl3\n', 'base');
  const repair = await commit(clone, 'a.txt', 'l1 fixed\nl2\nl3\n', 'repair');
  git(clone, 'checkout', '-q', '--detach', base);
  const target = await commit(clone, 'a.txt', 'l1 other\nl2\nl3\n', 'target moved the same line');
  git(clone, 'checkout', '-q', '--detach', base);
  const unrelated = await commit(clone, 'b.txt', 'b\n', 'unrelated');
  git(clone, 'checkout', '-q', '--detach', target);
  // `c.git('rev-parse', DEFAULT_REF)` resolves the promoted tip.
  git(clone, 'update-ref', 'refs/remotes/origin/main', target);
  git(clone, 'update-ref', 'refs/heads/repair', repair);
  git(clone, 'checkout', '-q', '--detach', target);

  const worktree = (name: string): string => {
    const path = join(wtRoot, name);
    git(clone, 'worktree', 'add', '-q', '--detach', path, target);
    return path;
  };
  const conflicted = worktree('crq-publish-conflicted');
  expect(() => git(conflicted, 'cherry-pick', repair)).toThrow();
  const staged = worktree('crq-publish-staged');
  await write(staged, 'staged.txt', 's\n');
  git(staged, 'add', 'staged.txt');
  const clean = worktree('crq-publish-clean');
  const replayed = worktree('crq-publish-replayed');
  await commit(replayed, 'crlf.txt', 'one\r\ntwo\r\nlone\rcr\n', 'crlf');
  git(replayed, 'mv', 'crlf.txt', 'moved.txt');
  git(replayed, 'commit', '-q', '-m', 'rename');
  const invalid = worktree('crq-publish-invalid');
  await commit(invalid, 'bin.txt', Buffer.from([0x66, 0xff, 0xfe, 0x0a]), 'not utf-8');
  return {
    root,
    clone,
    wtRoot,
    base,
    target,
    repair,
    unrelated,
    conflicted,
    staged,
    clean,
    replayed,
    invalid,
    missing: join(wtRoot, 'crq-publish-missing'),
  };
}

beforeAll(async () => {
  fx = await makeFixture();
});

afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Outcome {
  ok?: unknown;
  error?: string;
  message?: string;
}

interface Case {
  name: string;
  oracle: { op: 'default_ref' | 'is_ancestor' | 'wt' | 'rev_list'; wt?: string; args?: string[] };
  ts: (reads: PublicationGitReads) => Promise<unknown>;
}

function runOracle(cases: Case[], clone: string): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases: cases.map((c) => ({ ...c.oracle, clone })) }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      PATH: process.env.PATH ?? '',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      LC_ALL: 'C.UTF-8',
    },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

async function runTs(item: Case, reads: PublicationGitReads): Promise<Outcome> {
  try {
    return { ok: await item.ts(reads) };
  } catch (error) {
    return {
      error: isPyError(error, 'RuntimeError')
        ? 'RuntimeError'
        : isPyError(error, 'ValueError')
          ? 'ValueError'
          : error instanceof Error
            ? error.name
            : 'unknown',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

describe('publication Git reads: Python differential', () => {
  const wt = (path: string) => ({ path });
  const cases = (): Case[] => [
    {
      name: 'default ref resolves the promoted tip',
      oracle: { op: 'default_ref' },
      ts: (r) => r.revParseDefaultRef(),
    },
    {
      name: 'ancestor: base of target',
      oracle: { op: 'is_ancestor', args: [fx.base, fx.target] },
      ts: (r) => r.isAncestor(fx.base, fx.target),
    },
    {
      name: 'ancestor: target is not an ancestor of base (exit 1)',
      oracle: { op: 'is_ancestor', args: [fx.target, fx.base] },
      ts: (r) => r.isAncestor(fx.target, fx.base),
    },
    {
      name: 'ancestor: diverged tips',
      oracle: { op: 'is_ancestor', args: [fx.unrelated, fx.target] },
      ts: (r) => r.isAncestor(fx.unrelated, fx.target),
    },
    {
      name: 'ancestor: unknown object is false (exit 128), as Python compares the code only',
      oracle: { op: 'is_ancestor', args: ['9'.repeat(40), fx.target] },
      ts: (r) => r.isAncestor('9'.repeat(40), fx.target),
    },
    {
      name: 'head of a clean worktree',
      oracle: { op: 'wt', wt: fx.clean, args: ['rev-parse', 'HEAD'] },
      ts: (r) => r.revParseHead(wt(fx.clean)),
    },
    {
      name: 'CHERRY_PICK_HEAD present mid cherry-pick',
      oracle: { op: 'wt', wt: fx.conflicted, args: ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'] },
      ts: async (r) => {
        await r.verifyCherryPickHead(wt(fx.conflicted));
        return git(fx.conflicted, 'rev-parse', '--verify', 'CHERRY_PICK_HEAD');
      },
    },
    {
      name: 'CHERRY_PICK_HEAD absent is a RuntimeError with Python text',
      oracle: { op: 'wt', wt: fx.clean, args: ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'] },
      ts: async (r) => {
        await r.verifyCherryPickHead(wt(fx.clean));
        return '';
      },
    },
    {
      name: 'conflicted files mid cherry-pick',
      oracle: { op: 'wt', wt: fx.conflicted, args: ['diff', '--name-only', '--diff-filter=U'] },
      ts: (r) => r.conflictedFiles(wt(fx.conflicted)),
    },
    {
      name: 'no conflicted files in a clean worktree',
      oracle: { op: 'wt', wt: fx.clean, args: ['diff', '--name-only', '--diff-filter=U'] },
      ts: (r) => r.conflictedFiles(wt(fx.clean)),
    },
    {
      name: 'staged files',
      oracle: { op: 'wt', wt: fx.staged, args: ['diff', '--cached', '--name-only'] },
      ts: (r) => r.stagedFiles(wt(fx.staged)),
    },
    {
      name: 'staged files of a conflicted pick (resolved path is unmerged, not staged)',
      oracle: { op: 'wt', wt: fx.conflicted, args: ['diff', '--cached', '--name-only'] },
      ts: (r) => r.stagedFiles(wt(fx.conflicted)),
    },
    {
      name: 'no staged files',
      oracle: { op: 'wt', wt: fx.clean, args: ['diff', '--cached', '--name-only'] },
      ts: (r) => r.stagedFiles(wt(fx.clean)),
    },
    {
      name: 'rev-list of the replayed commits, oldest first',
      oracle: {
        op: 'rev_list',
        wt: fx.replayed,
        args: ['rev-list', '--reverse', `${fx.target}..HEAD`],
      },
      ts: (r) => r.revListSince(wt(fx.replayed), fx.target),
    },
    {
      name: 'rev-list of nothing is the empty list',
      oracle: {
        op: 'rev_list',
        wt: fx.clean,
        args: ['rev-list', '--reverse', `${fx.target}..HEAD`],
      },
      ts: (r) => r.revListSince(wt(fx.clean), fx.target),
    },
    {
      name: 'rev-list from an unknown object is a RuntimeError',
      oracle: {
        op: 'rev_list',
        wt: fx.clean,
        args: ['rev-list', '--reverse', `${'9'.repeat(40)}..HEAD`],
      },
      ts: (r) => r.revListSince(wt(fx.clean), '9'.repeat(40)),
    },
    {
      name: 'diff with CRLF and lone CR content (universal newlines) and a rename',
      oracle: { op: 'wt', wt: fx.replayed, args: ['diff', `${fx.target}..HEAD`] },
      ts: (r) => r.diffSince(wt(fx.replayed), fx.target),
    },
    {
      name: 'diff of a clean worktree is empty',
      oracle: { op: 'wt', wt: fx.clean, args: ['diff', `${fx.target}..HEAD`] },
      ts: (r) => r.diffSince(wt(fx.clean), fx.target),
    },
    {
      name: 'diff that is not valid UTF-8 is a ValueError (UnicodeDecodeError)',
      oracle: { op: 'wt', wt: fx.invalid, args: ['diff', `${fx.target}..HEAD`] },
      ts: (r) => r.diffSince(wt(fx.invalid), fx.target),
    },
  ];

  it('agrees with Python on every value and exception class', async () => {
    const reads = gitPublicationReads({ clone: fx.clone, worktreeRoot: fx.wtRoot });
    const all = cases();
    const oracle = runOracle(all, fx.clone);
    for (const [index, item] of all.entries()) {
      const ts = await runTs(item, reads);
      const py = oracle[index]!;
      const label = item.name;
      // UnicodeDecodeError is a ValueError subclass.
      const pyClass = py.error === 'UnicodeDecodeError' ? 'ValueError' : py.error;
      expect({ label, error: ts.error }).toEqual({ label, error: pyClass });
      if (py.error === undefined) expect({ label, ok: ts.ok }).toEqual({ label, ok: py.ok });
      if (py.error === 'RuntimeError')
        expect({ label, message: ts.message }).toEqual({ label, message: py.message });
    }
  });

  it('carries the CRLF translation: no carriage return survives into the patch', async () => {
    const reads = gitPublicationReads({ clone: fx.clone, worktreeRoot: fx.wtRoot });
    const diff = await reads.diffSince(wt(fx.replayed), fx.target);
    expect(diff).toContain('+one\n+two\n+lone\ncr');
    expect(diff).not.toContain('\r');
  });

  it('pins the types against what PublicationPublishEffects declares', () => {
    expect(
      Object.keys(pinned(gitPublicationReads({ clone: fx.clone, worktreeRoot: fx.wtRoot }))),
    ).toEqual([
      'revParseDefaultRef',
      'isAncestor',
      'revParseHead',
      'verifyCherryPickHead',
      'conflictedFiles',
      'stagedFiles',
      'revListSince',
      'diffSince',
    ]);
  });
});

describe('publication Git reads: hardening and refusals', () => {
  it('refuses the diff drivers an ambient config could configure', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-git-reads-cfg-')));
    cleanups.push(root);
    const wtRoot = join(root, 'wt');
    await mkdir(wtRoot);
    const clone = join(root, 'clone');
    await mkdir(clone);
    git(clone, 'init', '-q', '--object-format=sha1');
    await writeFile(join(clone, 'a.txt'), 'one\n');
    git(clone, 'add', 'a.txt');
    git(clone, 'commit', '-q', '-m', 'one');
    const target = git(clone, 'rev-parse', 'HEAD');
    const marker = join(root, 'driver-ran');
    git(clone, 'config', 'diff.external', `sh -c 'touch ${marker}'`);
    git(clone, 'config', 'diff.noprefix', 'true');
    git(clone, 'config', 'color.ui', 'always');
    git(clone, 'config', 'color.diff', 'always');
    const path = join(wtRoot, 'crq-publish-cfg');
    git(clone, 'worktree', 'add', '-q', '--detach', path, target);
    await writeFile(join(path, 'a.txt'), 'two\n');
    git(path, 'commit', '-q', '-am', 'two');
    const reads = gitPublicationReads({ clone, worktreeRoot: wtRoot });
    const diff = await reads.diffSince({ path }, target);
    expect(diff).toMatch(/^diff --git a\/a\.txt b\/a\.txt\n/);
    expect(diff).not.toContain('\u001b');
    await expect(stat(marker)).rejects.toThrow();
  });

  it('refuses a worktree outside the worktree root', async () => {
    const reads = gitPublicationReads({ clone: fx.clone, worktreeRoot: fx.wtRoot });
    for (const path of [
      fx.clone,
      join(fx.wtRoot, '..'),
      join(fx.wtRoot, 'a', 'b'),
      fx.wtRoot,
      'relative',
    ]) {
      await expect(reads.revParseHead({ path })).rejects.toMatchObject({ kind: 'ValueError' });
    }
  });

  it('refuses a missing worktree as a Git failure, not a spawn failure', async () => {
    const reads = gitPublicationReads({ clone: fx.clone, worktreeRoot: fx.wtRoot });
    await expect(reads.revParseHead({ path: fx.missing })).rejects.toMatchObject({
      kind: 'RuntimeError',
    });
  });

  it.each(['/wt/', '/wt//', '/wt/./'])(
    'accepts a direct child of the root spelled %j, and still refuses non-children',
    async (spelling) => {
      const calls: string[] = [];
      const reads = gitPublicationReads({
        clone: '/clone',
        worktreeRoot: spelling,
        runGitFor: (cwd) => async () => {
          calls.push(cwd);
          return call(0, `${'a'.repeat(40)}\n`);
        },
      });
      await expect(reads.revParseHead({ path: '/wt/x' })).resolves.toBe('a'.repeat(40));
      await expect(reads.revParseHead({ path: '/wt/x/' })).resolves.toBe('a'.repeat(40));
      expect(calls).toEqual(['/wt/x', '/wt/x']);
      for (const path of ['/wt', '/wt/', '/wt/x/y', '/other/x', '/wt/..', '/wt/x/..']) {
        await expect(reads.revParseHead({ path }), path).rejects.toMatchObject({
          kind: 'ValueError',
        });
      }
      expect(calls).toHaveLength(2);
    },
  );

  it('keeps the filesystem root a valid worktree root', async () => {
    const reads = gitPublicationReads({
      clone: '/clone',
      worktreeRoot: '/',
      runGitFor: () => async () => call(0, 'ok\n'),
    });
    await expect(reads.revParseHead({ path: '/x' })).resolves.toBe('ok');
    await expect(reads.revParseHead({ path: '/x/y' })).rejects.toMatchObject({
      kind: 'ValueError',
    });
    await expect(reads.revParseHead({ path: '/' })).rejects.toMatchObject({ kind: 'ValueError' });
  });

  it.each(['', '-x', '--output=/tmp/x', 'HEAD', 'abc', 'g'.repeat(40), `${'a'.repeat(40)}\n`])(
    'refuses the operand %j before any process runs',
    async (operand) => {
      const calls: (readonly string[])[] = [];
      const reads = gitPublicationReads({
        clone: '/clone',
        worktreeRoot: '/wt',
        runGitFor: () => async (args) => {
          calls.push(args);
          return call(0, '');
        },
      });
      await expect(reads.isAncestor(operand, 'a'.repeat(40))).rejects.toMatchObject({
        kind: 'ValueError',
      });
      await expect(reads.isAncestor('a'.repeat(40), operand)).rejects.toMatchObject({
        kind: 'ValueError',
      });
      await expect(reads.revListSince({ path: '/wt/x' }, operand)).rejects.toMatchObject({
        kind: 'ValueError',
      });
      await expect(reads.diffSince({ path: '/wt/x' }, operand)).rejects.toMatchObject({
        kind: 'ValueError',
      });
      expect(calls).toEqual([]);
    },
  );
});

function call(code: number | null, stdout: string | Uint8Array, stderr = ''): GitCall {
  return {
    args: [],
    code,
    stdout: typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout,
    stderr,
  };
}

describe('publication Git reads: scripted process', () => {
  const SHA = 'a'.repeat(40);
  function scripted(reply: (cwd: string, args: readonly string[]) => GitCall) {
    const log: { cwd: string; args: readonly string[] }[] = [];
    const runGitFor =
      (cwd: string): RunGit =>
      async (args) => {
        log.push({ cwd, args });
        return { ...reply(cwd, args), args };
      };
    return { log, reads: gitPublicationReads({ clone: '/clone', worktreeRoot: '/wt', runGitFor }) };
  }

  it('runs the exact argv in the clone or the worktree it belongs to', async () => {
    const { log, reads } = scripted(() => call(0, `${SHA}\n`));
    const w = { path: '/wt/crq-publish-x' };
    await reads.revParseDefaultRef();
    await reads.isAncestor(SHA, SHA);
    await reads.revParseHead(w);
    await reads.verifyCherryPickHead(w);
    await reads.conflictedFiles(w);
    await reads.stagedFiles(w);
    await reads.revListSince(w, SHA);
    await reads.diffSince(w, SHA);
    expect(log).toEqual([
      { cwd: '/clone', args: ['rev-parse', 'origin/main'] },
      { cwd: '/clone', args: ['merge-base', '--is-ancestor', SHA, SHA] },
      { cwd: w.path, args: ['rev-parse', 'HEAD'] },
      { cwd: w.path, args: ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'] },
      { cwd: w.path, args: ['diff', '--name-only', '--diff-filter=U'] },
      { cwd: w.path, args: ['diff', '--cached', '--name-only'] },
      { cwd: w.path, args: ['rev-list', '--reverse', `${SHA}..HEAD`] },
      {
        cwd: w.path,
        args: [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          '--src-prefix=a/',
          '--dst-prefix=b/',
          `${SHA}..HEAD`,
        ],
      },
    ]);
  });

  const everyRead = (reads: PublicationGitReads): [string, () => Promise<unknown>][] => {
    const w = { path: '/wt/crq-publish-x' };
    return [
      ['revParseDefaultRef', () => reads.revParseDefaultRef()],
      ['isAncestor', () => reads.isAncestor(SHA, SHA)],
      ['revParseHead', () => reads.revParseHead(w)],
      ['verifyCherryPickHead', () => reads.verifyCherryPickHead(w)],
      ['conflictedFiles', () => reads.conflictedFiles(w)],
      ['stagedFiles', () => reads.stagedFiles(w)],
      ['revListSince', () => reads.revListSince(w, SHA)],
      ['diffSince', () => reads.diffSince(w, SHA)],
    ];
  };

  it('treats a call that never exited (spawn failure, time or output bound) as OSError, never a miss', async () => {
    const { reads } = scripted(() => call(null, '', 'spawn failed'));
    for (const [name, run] of everyRead(reads)) {
      await expect(run(), name).rejects.toMatchObject({ kind: 'OSError' });
    }
  });

  it('keeps an exit status a semantic answer: RuntimeError, or false for ancestry', async () => {
    const { reads } = scripted(() => call(128, '', 'fatal: bad object'));
    for (const [name, run] of everyRead(reads)) {
      if (name === 'isAncestor') await expect(run()).resolves.toBe(false);
      else await expect(run(), name).rejects.toMatchObject({ kind: 'RuntimeError' });
    }
  });

  it('cannot read a spawn failure as an absent CHERRY_PICK_HEAD inside publishRepair', async () => {
    const { reads } = scripted((_cwd, args) =>
      args[0] === 'rev-parse' && args[1] === '--verify'
        ? call(null, '', 'spawn failed')
        : call(0, ''),
    );
    const failure = await reads
      .verifyCherryPickHead({ path: '/wt/x' })
      .catch((error: unknown) => error);
    expect(isPyError(failure, 'RuntimeError')).toBe(false);
    expect(isPyError(failure, 'OSError')).toBe(true);
  });

  it('formats the Python RuntimeError texts', async () => {
    const stderr = `${'e'.repeat(250)}\n`;
    const { reads } = scripted(() => call(128, '', stderr));
    await expect(reads.revParseDefaultRef()).rejects.toThrow(
      `git rev-parse origin/main … exit 128: ${'e'.repeat(250).slice(0, 400)}`,
    );
    await expect(reads.revParseHead({ path: '/wt/x' })).rejects.toThrow(
      `git rev-parse failed: ${'e'.repeat(200)}`,
    );
  });

  it('translates and strips stderr as Python text mode does', async () => {
    const stderr = '\u0085fatal: one\r\ntwo\rthree\r\n\u0085';
    const { reads } = scripted(() => call(128, '', stderr));
    // crq.git: p.stderr.strip()[:400] after universal newlines; U+FEFF is not Python whitespace.
    await expect(reads.revParseDefaultRef()).rejects.toThrow(
      'git rev-parse origin/main … exit 128: fatal: one\ntwo\nthree',
    );
    // wt_git: p.stderr[:200], translated but not stripped.
    await expect(reads.revParseHead({ path: '/wt/x' })).rejects.toThrow(
      'git rev-parse failed: \u0085fatal: one\ntwo\nthree\n\u0085',
    );
    const kept = scripted(() => call(128, '', '\ufefffatal\ufeff\n'));
    await expect(kept.reads.revParseDefaultRef()).rejects.toThrow(
      'git rev-parse origin/main … exit 128: \ufefffatal\ufeff',
    );
    const unfinished = scripted(() => call(null, '', '\u0085spawn\r\nfailed\r\n'));
    await expect(unfinished.reads.revParseHead({ path: '/wt/x' })).rejects.toThrow(
      'git rev-parse did not complete: spawn\nfailed',
    );
  });

  it('strips with Python whitespace and splits on Python line breaks', async () => {
    const { reads } = scripted(() => call(0, `\u001c\u0085 ${SHA}\n${SHA.replace(/a/g, 'b')} ﻿\n`));
    await expect(reads.revParseHead({ path: '/wt/x' })).resolves.toBe(
      `${SHA}\n${SHA.replace(/a/g, 'b')} ﻿`,
    );
    await expect(reads.revListSince({ path: '/wt/x' }, SHA)).resolves.toEqual([
      SHA,
      SHA.replace(/a/g, 'b'),
      '﻿',
    ]);
  });
});

describe('publication Git reads through publishRepair (real repositories)', () => {
  it('marks a conflicting replay stale from the conflicted-file read, and removes the worktree', async () => {
    const reads = gitPublicationReads({ clone: fx.clone, worktreeRoot: fx.wtRoot });
    const calls: string[] = [];
    const worktree = { path: join(fx.wtRoot, 'crq-publish-e2e'), branch: 'crq/publish-e2e' };
    // The fixture worktree is made and the pick is run by the test, not the adapter.
    git(fx.clone, 'worktree', 'add', '-q', '--detach', worktree.path, fx.target);
    const effects = {
      ...reads,
      iso: () => 'now',
      readJournal: async () => null,
      makeWorktree: async () => worktree,
      removeWorktree: async () => {
        calls.push('remove');
      },
      async cherryPick(_wt: unknown, sha: string) {
        try {
          git(worktree.path, 'cherry-pick', sha);
        } catch (error) {
          const text = error instanceof Error ? error.message : '';
          throw new PyError('RuntimeError', `git cherry-pick failed: ${text.slice(0, 200)}`);
        }
      },
    } as unknown as PublicationPublishEffects;
    const record: Record<string, unknown> = { jobs: ['crq-job'], open_pr: false, base: fx.base };
    await publishRepair(effects, {}, { id: 'x' }, 'run1', record, [
      { commits: [fx.repair], job: 'crq-job' },
    ]);
    expect(record['state']).toBe('stale');
    expect(String(record['error']).startsWith(STALE_DOES_NOT_APPLY)).toBe(true);
    expect(calls).toEqual(['remove']);
  });
});
