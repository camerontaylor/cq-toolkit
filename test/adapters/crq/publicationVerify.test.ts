// Differential run: the same throwaway local repositories through Python's real
// `crq_repair.verify` (the claimed-range check `repair_tick.publish` runs after
// each replayed repair; the oracle is test/helpers/publicationVerifyOracle.py)
// and the TS publication verification. Value (the verified HEAD) and the
// exception class and text must be equal. Scripted-process cases pin what a
// repository cannot produce on demand (spawn failure, the call order, argument
// narrowings). Local repositories only: no remote, forge, provider, service or
// worktree mutation by the adapter; the fixtures are made by the test with plain `git`.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitPublicationVerify,
  namesJob,
  REJECT_DIRTY_TREE,
  REJECT_EMPTY_COMMIT,
  REJECT_MISSING_FINDING_ID,
  REJECT_MISSING_OR_DUPLICATE,
  REJECT_NOT_40_HEX,
  REJECT_NOT_ANCESTOR_OF_HEAD,
  REJECT_NOT_DESCENDANT,
  REJECT_UNCLAIMED_COMMITS,
  type PublicationVerify,
} from '../../../src/adapters/crq/publicationVerify.js';
import { gitPublicationReads } from '../../../src/adapters/crq/publicationGitReads.js';
import { gitPublicationWorktrees } from '../../../src/adapters/crq/publicationWorktrees.js';
import type { GitCall, RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { isPyError } from '../../../src/queue-runner/pyErrors.js';
import {
  publishRepair,
  type PublicationPublishEffects,
} from '../../../src/queue-runner/publicationPublish.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const ORACLE = fileURLToPath(new URL('../../helpers/publicationVerifyOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));

// The structural subset the publish orchestration declares.
type Pinned = Pick<PublicationPublishEffects, keyof PublicationVerify>;
const pinned = (verify: PublicationVerify): Pinned => verify;

const JOB = 'crq-job-1';
const cleanups: string[] = [];

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

interface Fixture {
  root: string;
  clone: string;
  wtRoot: string;
  base: string;
  /** A commit on a branch that is not a descendant of `base`. */
  sibling: string;
  /** One commit over `base` naming JOB. */
  good: { path: string; commit: string };
  /** Two commits over `base`, one per job (`crq-job-1`, `crq-job-2`). */
  pair: { path: string; first: string; second: string };
  /** Two commits over `base`, both naming both jobs. */
  both: { path: string; first: string; second: string };
  /** HEAD is `base`; a descendant of it exists in the repository only. */
  behind: { path: string; commit: string };
  empty: { path: string; commit: string };
  merge: { path: string; commit: string; side: string };
  dirtyUntracked: { path: string; commit: string };
  dirtyTracked: { path: string; commit: string };
  /** One worktree per message: HEAD is the single commit carrying it. */
  messages: Map<string, { path: string; commit: string }>;
}

const MESSAGES = [
  'fix crq-job-1',
  'fix crq-job-12',
  'fix crq-job-11',
  'fix 1crq-job-1',
  'fix crq-job-1x',
  'fix xcrq-job-1',
  'fix crq-job-1١',
  'fix ١crq-job-1',
  'fix CRQ-JOB-1',
  'fix crq-job-1\n\nbody',
  'subject\n\nbody names crq-job-1 mid line',
  'no id here',
  'fix a.b',
  'fix axb',
  'fix [x]',
  'fix [x]]',
  'fix a|b',
  'fix a$b',
  'fix (x)',
  'fix a\\b',
  'fix a/b',
];

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-verify-')));
  cleanups.push(root);
  const clone = join(root, 'clone');
  const wtRoot = join(root, 'wt');
  await mkdir(clone);
  await mkdir(wtRoot);
  git(clone, 'init', '-q', '--object-format=sha1');
  const commit = async (dir: string, name: string, text: string, message: string) => {
    await writeFile(join(dir, name), text);
    git(dir, 'add', name);
    git(dir, 'commit', '-q', '-m', message);
    return git(dir, 'rev-parse', 'HEAD');
  };
  const base = await commit(clone, 'a.txt', 'l1\nl2\nl3\n', 'base');
  git(clone, 'checkout', '-q', '--detach', base);
  const sibling = await commit(clone, 'sibling.txt', 's\n', 'sibling');
  git(clone, 'checkout', '-q', '--detach', base);

  const worktree = (name: string): string => {
    const path = join(wtRoot, name);
    git(clone, 'worktree', 'add', '-q', '--detach', path, base);
    return path;
  };

  const goodPath = worktree('crq-publish-good');
  const good = await commit(goodPath, 'a.txt', 'l1 fixed\nl2\nl3\n', `fix ${JOB}: one`);

  const pairPath = worktree('crq-publish-pair');
  const pairFirst = await commit(pairPath, 'a.txt', 'l1 one\nl2\nl3\n', `fix ${JOB}: one`);
  const pairSecond = await commit(pairPath, 'b.txt', 'two\n', 'fix crq-job-2: two');

  const bothPath = worktree('crq-publish-both');
  const bothFirst = await commit(bothPath, 'a.txt', 'l1 q\nl2\nl3\n', 'crq-job-1 crq-job-2 first');
  const bothSecond = await commit(bothPath, 'b.txt', 'q\n', 'second crq-job-1 crq-job-2');

  const behindPath = worktree('crq-publish-behind');

  const emptyPath = worktree('crq-publish-empty');
  git(emptyPath, 'commit', '-q', '--allow-empty', '-m', `fix ${JOB}: empty`);
  const emptyCommit = git(emptyPath, 'rev-parse', 'HEAD');

  const mergePath = worktree('crq-publish-merge');
  const side = await commit(mergePath, 'side.txt', 'side\n', `fix ${JOB}: side`);
  git(mergePath, 'checkout', '-q', '--detach', base);
  await commit(mergePath, 'main.txt', 'main\n', `fix ${JOB}: main`);
  git(mergePath, 'merge', '-q', '--no-ff', '-m', `fix ${JOB}: merge`, side);
  const mergeCommit = git(mergePath, 'rev-parse', 'HEAD');

  const untrackedPath = worktree('crq-publish-untracked');
  const untrackedCommit = await commit(untrackedPath, 'a.txt', 'u\n', `fix ${JOB}: u`);
  await writeFile(join(untrackedPath, 'stray.txt'), 'stray\n');
  const trackedPath = worktree('crq-publish-tracked');
  const trackedCommit = await commit(trackedPath, 'a.txt', 't\n', `fix ${JOB}: t`);
  await writeFile(join(trackedPath, 'a.txt'), 'edited after commit\n');

  const messages = new Map<string, { path: string; commit: string }>();
  for (const [index, message] of MESSAGES.entries()) {
    const path = worktree(`crq-publish-msg${String(index)}`);
    messages.set(message, {
      path,
      commit: await commit(path, 'a.txt', `m${String(index)}\n`, message),
    });
  }

  return {
    root,
    clone,
    wtRoot,
    base,
    sibling,
    good: { path: goodPath, commit: good },
    pair: { path: pairPath, first: pairFirst, second: pairSecond },
    both: { path: bothPath, first: bothFirst, second: bothSecond },
    behind: { path: behindPath, commit: good },
    empty: { path: emptyPath, commit: emptyCommit },
    merge: { path: mergePath, commit: mergeCommit, side },
    dirtyUntracked: { path: untrackedPath, commit: untrackedCommit },
    dirtyTracked: { path: trackedPath, commit: trackedCommit },
    messages,
  };
}

let fx: Fixture;

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
  wt: string;
  base: string;
  commits: string[];
  job: string;
}

function runOracle(cases: Case[]): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
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

async function runTs(item: Case, verify: PublicationVerify): Promise<Outcome> {
  try {
    await verify.verify({ path: item.wt }, item.base, item.commits, item.job);
    // Python returns the HEAD it read; the TS seam returns nothing.
    return { ok: git(item.wt, 'rev-parse', 'HEAD') };
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

describe('publication verify: Python differential', () => {
  const msg = (message: string) => {
    const entry = fx.messages.get(message);
    if (entry === undefined) throw new Error(`no fixture for ${message}`);
    return entry;
  };
  const named = (message: string, job: string): Case => ({
    name: `message ${JSON.stringify(message)} vs job ${JSON.stringify(job)}`,
    wt: msg(message).path,
    base: fx.base,
    commits: [msg(message).commit],
    job,
  });

  const cases = (): Case[] => [
    {
      name: 'one claimed repair verifies',
      wt: fx.good.path,
      base: fx.base,
      commits: [fx.good.commit],
      job: JOB,
    },
    {
      name: 'a second repair verifies over the first as its base',
      wt: fx.pair.path,
      base: fx.pair.first,
      commits: [fx.pair.second],
      job: 'crq-job-2',
    },
    {
      name: 'both repairs claimed under one job: the second lacks the id',
      wt: fx.pair.path,
      base: fx.base,
      commits: [fx.pair.first, fx.pair.second],
      job: JOB,
    },
    {
      name: 'claimed in reverse order is still the claimed set',
      wt: fx.both.path,
      base: fx.base,
      commits: [fx.both.second, fx.both.first],
      job: JOB,
    },
    {
      name: 'a commit left out of the claim is unclaimed',
      wt: fx.pair.path,
      base: fx.base,
      commits: [fx.pair.first],
      job: JOB,
    },
    { name: 'no claimed commits', wt: fx.good.path, base: fx.base, commits: [], job: JOB },
    {
      name: 'duplicate claimed commits',
      wt: fx.good.path,
      base: fx.base,
      commits: [fx.good.commit, fx.good.commit],
      job: JOB,
    },
    {
      name: 'short sha',
      wt: fx.good.path,
      base: fx.base,
      commits: [fx.good.commit.slice(0, 12)],
      job: JOB,
    },
    { name: 'the literal HEAD', wt: fx.good.path, base: fx.base, commits: ['HEAD'], job: JOB },
    {
      name: 'a 40-character non-hex string',
      wt: fx.good.path,
      base: fx.base,
      commits: ['g'.repeat(40)],
      job: JOB,
    },
    {
      name: 'a trailing newline is not a full match',
      wt: fx.good.path,
      base: fx.base,
      commits: [`${fx.good.commit}\n`],
      job: JOB,
    },
    {
      name: 'an unknown object is a RuntimeError, not a rejection',
      wt: fx.good.path,
      base: fx.base,
      commits: ['9'.repeat(40)],
      job: JOB,
    },
    {
      name: 'a tree object is not a commit',
      wt: fx.good.path,
      base: fx.base,
      commits: [git(fx.good.path, 'rev-parse', 'HEAD^{tree}')],
      job: JOB,
    },
    {
      name: 'the base itself is not a repair',
      wt: fx.good.path,
      base: fx.good.commit,
      commits: [fx.good.commit],
      job: JOB,
    },
    {
      name: 'a commit that does not descend from the base',
      wt: fx.good.path,
      base: fx.sibling,
      commits: [fx.good.commit],
      job: JOB,
    },
    {
      name: 'an upper-case spelling of the claim: passes every per-commit check, fails the range set',
      wt: fx.good.path,
      base: fx.base,
      commits: [fx.good.commit.toUpperCase()],
      job: JOB,
    },
    {
      name: 'a descendant that is not an ancestor of HEAD',
      wt: fx.behind.path,
      base: fx.base,
      commits: [fx.behind.commit],
      job: JOB,
    },
    {
      name: 'an empty commit',
      wt: fx.empty.path,
      base: fx.base,
      commits: [fx.empty.commit],
      job: JOB,
    },
    {
      name: 'a merge commit lists no paths, so it is empty',
      wt: fx.merge.path,
      base: fx.base,
      commits: [fx.merge.commit],
      job: JOB,
    },
    {
      name: 'an untracked file dirties the tree',
      wt: fx.dirtyUntracked.path,
      base: fx.base,
      commits: [fx.dirtyUntracked.commit],
      job: JOB,
    },
    {
      name: 'an edited tracked file dirties the tree',
      wt: fx.dirtyTracked.path,
      base: fx.base,
      commits: [fx.dirtyTracked.commit],
      job: JOB,
    },
    named('fix crq-job-1', JOB),
    named('fix crq-job-12', JOB),
    named('fix crq-job-11', JOB),
    named('fix 1crq-job-1', JOB),
    named('fix crq-job-1x', JOB),
    named('fix xcrq-job-1', JOB),
    named('fix crq-job-1١', JOB),
    named('fix ١crq-job-1', JOB),
    named('fix CRQ-JOB-1', JOB),
    named('fix crq-job-1\n\nbody', JOB),
    named('subject\n\nbody names crq-job-1 mid line', JOB),
    named('no id here', JOB),
    named('fix a.b', 'a.b'),
    named('fix axb', 'a.b'),
    named('fix [x]', '[x]'),
    named('fix [x]]', '[x]'),
    named('fix a|b', 'a|b'),
    named('fix a$b', 'a$b'),
    named('fix (x)', '(x)'),
    named('fix a\\b', 'a\\b'),
    named('fix a/b', 'a/b'),
    named('fix a/b', 'a'),
    named('fix crq-job-1', ''),
    named('no id here', ''),
  ];

  it('agrees with Python on the verified HEAD, the exception class and its text', async () => {
    const verify = gitPublicationVerify({ worktreeRoot: fx.wtRoot });
    const all = cases();
    const oracle = runOracle(all);
    const seen = new Set<string>();
    for (const [index, item] of all.entries()) {
      const ts = await runTs(item, verify);
      const py = oracle[index]!;
      const label = item.name;
      expect({ label, error: ts.error }).toEqual({ label, error: py.error });
      if (py.error === undefined) expect({ label, ok: ts.ok }).toEqual({ label, ok: py.ok });
      else expect({ label, message: ts.message }).toEqual({ label, message: py.message });
      seen.add(py.error === undefined ? 'ok' : (py.message ?? ''));
    }
    // The oracle exercised every verdict, so the differential is not vacuous.
    for (const reject of [
      REJECT_MISSING_OR_DUPLICATE,
      REJECT_NOT_40_HEX,
      REJECT_NOT_DESCENDANT,
      REJECT_NOT_ANCESTOR_OF_HEAD,
      REJECT_EMPTY_COMMIT,
      REJECT_MISSING_FINDING_ID,
      REJECT_UNCLAIMED_COMMITS,
      REJECT_DIRTY_TREE,
    ])
      expect(seen, reject).toContain(reject);
    expect(seen).toContain('ok');
    expect([...seen].some((text) => text.startsWith('git cat-file failed: '))).toBe(true);
  });

  it('matches the attribution regex of Python for every message above', () => {
    // Recorded from the oracle run: the boundary is Unicode decimal digits.
    expect(namesJob('fix crq-job-1١', JOB)).toBe(false);
    expect(namesJob('fix ١crq-job-1', JOB)).toBe(false);
    expect(namesJob('fix crq-job-1x', JOB)).toBe(true);
    expect(namesJob('fix a/b', 'a/b')).toBe(true);
    expect(namesJob('', '')).toBe(true);
  });
});

function call(code: number | null, stdout: string | Uint8Array = '', stderr = ''): GitCall {
  return {
    args: [],
    code,
    stdout: typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout,
    stderr,
  };
}

describe('publication verify: scripted process', () => {
  const BASE = 'b'.repeat(40);
  const HEAD = 'a'.repeat(40);
  const CLAIM = 'c'.repeat(40);
  const W = { path: '/wt/crq-publish-x' };

  /** Answers a verifying range by default; `override` replaces one command's reply. */
  function scripted(override?: (args: readonly string[]) => GitCall | undefined) {
    const log: { cwd: string; args: readonly string[] }[] = [];
    const runGitFor =
      (cwd: string): RunGit =>
      async (args) => {
        log.push({ cwd, args });
        const reply =
          override?.(args) ??
          (args[0] === 'rev-parse'
            ? call(0, `${HEAD}\n`)
            : args[0] === 'diff-tree'
              ? call(0, 'a.txt\n')
              : args[0] === 'show'
                ? call(0, 'fix crq-job-1\n')
                : args[0] === 'rev-list'
                  ? call(0, `${CLAIM}\n`)
                  : call(0));
        return { ...reply, args };
      };
    return { log, verify: gitPublicationVerify({ worktreeRoot: '/wt', runGitFor }) };
  }

  it('runs the exact argv, in order, in the worktree it belongs to', async () => {
    const { log, verify } = scripted();
    await verify.verify(W, BASE, [CLAIM], JOB);
    expect(log).toEqual([
      { cwd: W.path, args: ['rev-parse', 'HEAD'] },
      { cwd: W.path, args: ['cat-file', '-e', `${CLAIM}^{commit}`] },
      { cwd: W.path, args: ['merge-base', '--is-ancestor', BASE, CLAIM] },
      { cwd: W.path, args: ['merge-base', '--is-ancestor', CLAIM, HEAD] },
      { cwd: W.path, args: ['diff-tree', '--root', '--no-commit-id', '--name-only', '-r', CLAIM] },
      { cwd: W.path, args: ['show', '-s', '--format=%B', CLAIM] },
      { cwd: W.path, args: ['rev-list', `${BASE}..HEAD`] },
      { cwd: W.path, args: ['status', '--porcelain'] },
    ]);
  });

  it('checks the shape of the claim before any Git call for it, and the count before HEAD', async () => {
    const empty = scripted();
    await expect(empty.verify.verify(W, BASE, [], JOB)).rejects.toThrow(
      REJECT_MISSING_OR_DUPLICATE,
    );
    expect(empty.log).toEqual([]);
    const short = scripted();
    await expect(short.verify.verify(W, BASE, ['abc'], JOB)).rejects.toThrow(REJECT_NOT_40_HEX);
    expect(short.log).toEqual([{ cwd: W.path, args: ['rev-parse', 'HEAD'] }]);
  });

  it('stops at the first rejection without reading further', async () => {
    const { log, verify } = scripted((args) =>
      args[0] === 'merge-base' && args[2] === BASE ? call(1) : undefined,
    );
    await expect(verify.verify(W, BASE, [CLAIM], JOB)).rejects.toThrow(REJECT_NOT_DESCENDANT);
    expect(log.map((entry) => entry.args[0])).toEqual(['rev-parse', 'cat-file', 'merge-base']);
  });

  it('is a ValueError for any non-zero ancestry exit, as Python tests the return code only', async () => {
    for (const code of [1, 128]) {
      const first = scripted((args) =>
        args[0] === 'merge-base' && args[2] === BASE ? call(code) : undefined,
      );
      await expect(first.verify.verify(W, BASE, [CLAIM], JOB), String(code)).rejects.toMatchObject({
        kind: 'ValueError',
        message: REJECT_NOT_DESCENDANT,
      });
      const second = scripted((args) =>
        args[0] === 'merge-base' && args[2] === CLAIM ? call(code) : undefined,
      );
      await expect(second.verify.verify(W, BASE, [CLAIM], JOB), String(code)).rejects.toMatchObject(
        {
          kind: 'ValueError',
          message: REJECT_NOT_ANCESTOR_OF_HEAD,
        },
      );
    }
  });

  it('treats a call that never exited as OSError at every step, never as a rejection', async () => {
    for (const command of [
      'rev-parse',
      'cat-file',
      'merge-base',
      'diff-tree',
      'show',
      'rev-list',
      'status',
    ]) {
      const { verify } = scripted((args) =>
        args[0] === command ? call(null, '', 'spawn failed') : undefined,
      );
      await expect(verify.verify(W, BASE, [CLAIM], JOB), command).rejects.toMatchObject({
        kind: 'OSError',
      });
    }
    // The second ancestry call (claim in HEAD) is a merge-base too.
    const second = scripted((args) =>
      args[0] === 'merge-base' && args[2] === CLAIM ? call(null, '', 'timed out') : undefined,
    );
    await expect(second.verify.verify(W, BASE, [CLAIM], JOB)).rejects.toMatchObject({
      kind: 'OSError',
    });
  });

  it('keeps an exit status from a plain read a RuntimeError, so a later tick retries', async () => {
    for (const command of ['rev-parse', 'cat-file', 'diff-tree', 'show', 'rev-list', 'status']) {
      const { verify } = scripted((args) =>
        args[0] === command ? call(128, '', `fatal: ${command}`) : undefined,
      );
      const failure = await verify.verify(W, BASE, [CLAIM], JOB).catch((error: unknown) => error);
      expect(isPyError(failure, 'RuntimeError'), command).toBe(true);
      expect((failure as Error).message).toBe(`git ${command} failed: fatal: ${command}`);
    }
  });

  it('compares the range as a set of strings, case-sensitively', async () => {
    const extra = scripted((args) =>
      args[0] === 'rev-list' ? call(0, `${CLAIM}\n${'d'.repeat(40)}\n`) : undefined,
    );
    await expect(extra.verify.verify(W, BASE, [CLAIM], JOB)).rejects.toThrow(
      REJECT_UNCLAIMED_COMMITS,
    );
    const fewer = scripted((args) => (args[0] === 'rev-list' ? call(0, '') : undefined));
    await expect(fewer.verify.verify(W, BASE, [CLAIM], JOB)).rejects.toThrow(
      REJECT_UNCLAIMED_COMMITS,
    );
    const upper = scripted((args) =>
      args[0] === 'rev-list' ? call(0, `${CLAIM.toUpperCase()}\n`) : undefined,
    );
    await expect(upper.verify.verify(W, BASE, [CLAIM], JOB)).rejects.toThrow(
      REJECT_UNCLAIMED_COMMITS,
    );
    // A repeated line in the listing is one member, as `set(...)` makes it.
    const repeated = scripted((args) =>
      args[0] === 'rev-list' ? call(0, `${CLAIM}\n${CLAIM}\n`) : undefined,
    );
    await expect(repeated.verify.verify(W, BASE, [CLAIM], JOB)).resolves.toBeUndefined();
  });

  it('reads Python text: strict UTF-8 and universal newlines, strip and splitlines', async () => {
    const invalid = scripted((args) =>
      args[0] === 'show' ? call(0, new Uint8Array([0x66, 0xff, 0xfe])) : undefined,
    );
    await expect(invalid.verify.verify(W, BASE, [CLAIM], JOB)).rejects.toMatchObject({
      kind: 'ValueError',
    });
    const crlf = scripted((args) =>
      args[0] === 'rev-list' ? call(0, `\u0085${CLAIM}\r\n `) : undefined,
    );
    await expect(crlf.verify.verify(W, BASE, [CLAIM], JOB)).resolves.toBeUndefined();
    const blank = scripted((args) => (args[0] === 'status' ? call(0, ' \u0085\n') : undefined));
    await expect(blank.verify.verify(W, BASE, [CLAIM], JOB)).resolves.toBeUndefined();
    const dirty = scripted((args) => (args[0] === 'status' ? call(0, ' M a.txt\n') : undefined));
    await expect(dirty.verify.verify(W, BASE, [CLAIM], JOB)).rejects.toThrow(REJECT_DIRTY_TREE);
  });

  it('refuses a base that is not a 40-hex object id, where Python would run git on any string', async () => {
    for (const base of ['HEAD~0', 'main', '--all', `${BASE}\n`, BASE.slice(1)]) {
      const { log, verify } = scripted();
      await expect(verify.verify(W, base, [CLAIM], JOB), base).rejects.toMatchObject({
        kind: 'ValueError',
        message: 'base is not a 40-hex object id',
      });
      expect(
        log.some((entry) => entry.args[0] === 'merge-base'),
        base,
      ).toBe(false);
    }
  });

  it('is a TypeError, as Python raises for a non-str, for a non-string claim, base or job', async () => {
    const claim = scripted();
    await expect(
      claim.verify.verify(W, BASE, [7 as unknown as string], JOB),
    ).rejects.toBeInstanceOf(TypeError);
    const base = scripted();
    await expect(
      base.verify.verify(W, 7 as unknown as string, [CLAIM], JOB),
    ).rejects.toBeInstanceOf(TypeError);
    const job = scripted();
    await expect(job.verify.verify(W, BASE, [CLAIM], 7)).rejects.toBeInstanceOf(TypeError);
  });

  it('refuses a worktree outside the root before any Git call', async () => {
    for (const path of ['/wt', '/wt/a/b', '/other/crq-publish-x', 'relative', '/wt/../x']) {
      const { log, verify } = scripted();
      await expect(verify.verify({ path }, BASE, [CLAIM], JOB), path).rejects.toMatchObject({
        kind: 'ValueError',
      });
      expect(log, path).toEqual([]);
    }
    expect(() => gitPublicationVerify({ worktreeRoot: 'wt' })).toThrow(
      'worktree root must be absolute',
    );
  });

  it('satisfies the structural pin of the publish orchestration', () => {
    const { verify } = scripted();
    expect(pinned(verify).verify).toBeTypeOf('function');
  });
});

describe('publication verify through publishRepair (real repositories)', () => {
  /** A primary clone with a repair commit that applies cleanly to the target. */
  async function repairRepo(message: string, extra?: (clone: string) => Promise<void>) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-verify-e2e-')));
    cleanups.push(root);
    const clone = join(root, 'clone');
    const wtRoot = join(root, 'wt');
    await mkdir(clone);
    await mkdir(wtRoot);
    git(clone, 'init', '-q', '--object-format=sha1');
    await writeFile(join(clone, 'a.txt'), 'l1\nl2\nl3\n');
    git(clone, 'add', 'a.txt');
    git(clone, 'commit', '-q', '-m', 'base');
    const base = git(clone, 'rev-parse', 'HEAD');
    await writeFile(join(clone, 'a.txt'), 'l1 fixed\nl2\nl3\n');
    git(clone, 'commit', '-q', '-am', message);
    const repair = git(clone, 'rev-parse', 'HEAD');
    await extra?.(clone);
    git(clone, 'checkout', '-q', '--detach', base);
    git(clone, 'update-ref', 'refs/remotes/origin/main', base);
    return { clone, wtRoot, base, repair };
  }

  function effects(repo: { clone: string; wtRoot: string }, calls: string[]) {
    const reads = gitPublicationReads({ clone: repo.clone, worktreeRoot: repo.wtRoot });
    const writes = gitPublicationWorktrees({
      clone: repo.clone,
      worktreeRoot: repo.wtRoot,
      worktreePrefix: 'crq-',
    });
    const verify = gitPublicationVerify({ worktreeRoot: repo.wtRoot });
    return {
      ...reads,
      ...writes,
      ...verify,
      async removeWorktree(worktree: { path: string; branch: string }) {
        calls.push('remove');
        await writes.removeWorktree(worktree);
      },
      readJournal: async () => null,
      async writePatch() {
        calls.push('patch');
      },
      async hackDetector() {
        calls.push('detector');
        throw new Error('stop after verification');
      },
    } as unknown as PublicationPublishEffects;
  }

  it('lets a replayed repair that names its job reach the content scans', async () => {
    const repo = await repairRepo(`fix ${JOB}: one`);
    const calls: string[] = [];
    const record: Record<string, unknown> = { jobs: [JOB], open_pr: false, base: repo.base };
    await expect(
      publishRepair(effects(repo, calls), {}, { id: 'x' }, 'run1', record, [
        { commits: [repo.repair], job: JOB },
      ]),
    ).rejects.toThrow('stop after verification');
    expect(calls).toEqual(['patch', 'detector', 'remove']);
  });

  it('rejects a replayed repair whose message lacks the job before any scan, and removes the worktree', async () => {
    const repo = await repairRepo('fix something else');
    const calls: string[] = [];
    const record: Record<string, unknown> = { jobs: [JOB], open_pr: false, base: repo.base };
    const failure = await publishRepair(effects(repo, calls), {}, { id: 'x' }, 'run1', record, [
      { commits: [repo.repair], job: JOB },
    ]).catch((error: unknown) => error);
    expect(isPyError(failure, 'ValueError')).toBe(true);
    expect((failure as Error).message).toBe(REJECT_MISSING_FINDING_ID);
    expect(calls).toEqual(['remove']);
    expect(record['publication']).toBeUndefined();
  });
});
