// Differential run: the same disposable local repositories through Python's real
// `crq.make_worktree`, `crq.remove_worktree`, `crq_repair.git` (`wt_git` cherry-pick)
// and `crq.git('update-ref', ...)` (the oracle is
// test/helpers/publicationWorktreesOracle.py) and the TS publication worktree
// writes. Each case builds two identical deterministic fixtures (fixed identity and
// dates, so object ids agree), runs the Python steps in one and the TS steps in the
// other, and compares the per-step exception class and message AND the final
// repository state (worktree registry, local branches, refs, the directories under
// the worktree root, and each worktree's HEAD, status and CHERRY_PICK_HEAD).
// Scripted-process cases pin the failure classes a repository cannot produce on
// demand. Disposable repositories only: no remote, forge, provider or service, and
// no existing worktree or shared ref is touched.
import { execFileSync } from 'node:child_process';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { gitPublicationReads } from '../../../src/adapters/crq/publicationGitReads.js';
import {
  gitPublicationWorktrees,
  type PublicationWorktrees,
} from '../../../src/adapters/crq/publicationWorktrees.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import type { GitCall, RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { isPyError } from '../../../src/queue-runner/pyErrors.js';
import type { PublicationPublishEffects } from '../../../src/queue-runner/publicationPublish.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const ORACLE = fileURLToPath(
  new URL('../../helpers/publicationWorktreesOracle.py', import.meta.url),
);
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));
const PREFIX = 'coderabbit-queue-';

/** Fixed identity and dates: both fixtures and both implementations mint identical object ids. */
const GIT_ENV: Record<string, string> = {
  // One locale for every Git process and the Python oracle: failure text is compared
  // verbatim, so Git must not translate it from an inherited LANG/LANGUAGE.
  LC_ALL: 'C.UTF-8',
  LANGUAGE: '',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
};

type Reads = Pick<PublicationPublishEffects, 'makeWorktree' | 'removeWorktree'> &
  Pick<PublicationPublishEffects, 'cherryPick' | 'updateRef'>;
const pinned = (writes: PublicationWorktrees): Reads => writes;

const cleanups: string[] = [];
afterAll(async () => {
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync(
    'git',
    [
      '-C',
      cwd,
      '-c',
      'commit.gpgsign=false',
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.autocrlf=false',
      ...args,
    ],
    {
      encoding: 'utf8',
      env: { ...scrubbedGitEnv(), ...GIT_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

/** The hardened production runner, with the test identity, locale and config isolation added. */
const runGitFor =
  (repo: string): RunGit =>
  (args, options) =>
    runGitIn(repo)(args, { ...options, env: { ...GIT_ENV, ...options?.env } });

interface Fixture {
  root: string;
  clone: string;
  wtRoot: string;
  outside: string;
  shas: Record<string, string>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-worktrees-')));
  cleanups.push(root);
  const clone = join(root, 'clone');
  const wtRoot = join(root, 'wt');
  const outside = join(root, 'outside');
  await Promise.all([mkdir(clone), mkdir(wtRoot), mkdir(outside)]);
  git(clone, 'init', '-q', '--object-format=sha1');
  const commit = async (name: string, text: string, message: string): Promise<string> => {
    await writeFile(join(clone, name), text);
    git(clone, 'add', name);
    git(clone, 'commit', '-q', '-m', message);
    return git(clone, 'rev-parse', 'HEAD');
  };
  const shas: Record<string, string> = {};
  shas['base'] = await commit('a.txt', 'l1\nl2\nl3\n', 'base');
  shas['repair'] = await commit('a.txt', 'l1 fixed\nl2\nl3\n', 'repair');
  git(clone, 'checkout', '-q', '--detach', shas['base']!);
  shas['target'] = await commit('a.txt', 'l1 other\nl2\nl3\n', 'target moved the same line');
  git(clone, 'checkout', '-q', '--detach', shas['base']!);
  shas['clean'] = await commit('c.txt', 'c\n', 'applies anywhere');
  git(clone, 'checkout', '-q', '--detach', shas['base']!);
  shas['applied'] = await commit('a.txt', 'l1 fixed\nl2\nl3\n', 'repair already applied');
  git(clone, 'checkout', '-q', '--detach', shas['base']!);
  for (const [name, sha] of Object.entries(shas))
    if (name !== 'base') git(clone, 'update-ref', `refs/heads/${name}`, sha);
  git(clone, 'update-ref', 'refs/remotes/origin/main', shas['target']!);
  return { root, clone, wtRoot, outside, shas };
}

type SymbolicCommit = 'base' | 'repair' | 'target' | 'clean' | 'applied' | 'unknown';
type Step =
  | { op: 'make'; name: string; commit: SymbolicCommit }
  | { op: 'remove'; name: string }
  | { op: 'cherry'; name: string; commit: SymbolicCommit }
  | { op: 'update_ref'; name: string; commit: SymbolicCommit };

const wtPath = (fx: Fixture, name: string): string => join(fx.wtRoot, `${PREFIX}${name}`);
const sha = (fx: Fixture, commit: SymbolicCommit): string =>
  commit === 'unknown' ? '9'.repeat(40) : fx.shas[commit]!;

function pyStep(fx: Fixture, step: Step): Record<string, string> {
  switch (step.op) {
    case 'make':
      return { op: 'make', name: step.name, commit: sha(fx, step.commit) };
    case 'remove':
      return { op: 'remove', path: wtPath(fx, step.name), branch: `crq/${step.name}` };
    case 'cherry':
      return { op: 'cherry', path: wtPath(fx, step.name), commit: sha(fx, step.commit) };
    case 'update_ref':
      return {
        op: 'update_ref',
        ref: `refs/crq/publication/${step.name}`,
        commit: sha(fx, step.commit),
      };
  }
}

interface Outcome {
  ok?: true;
  error?: string;
  message?: string;
}

const OS_ERRORS = new Set([
  'OSError',
  'FileNotFoundError',
  'NotADirectoryError',
  'PermissionError',
]);

function normalize(text: string, fx: Fixture): string {
  return text.split(fx.root).join('<R>');
}

async function runTs(fx: Fixture, steps: readonly Step[]): Promise<Outcome[]> {
  const writes = gitPublicationWorktrees({
    clone: fx.clone,
    worktreeRoot: fx.wtRoot,
    worktreePrefix: PREFIX,
    runGitFor,
  });
  const outcomes: Outcome[] = [];
  for (const step of steps) {
    try {
      switch (step.op) {
        case 'make':
          await writes.makeWorktree(step.name, sha(fx, step.commit));
          break;
        case 'remove':
          await writes.removeWorktree({
            path: wtPath(fx, step.name),
            branch: `crq/${step.name}`,
          });
          break;
        case 'cherry':
          await writes.cherryPick(
            { path: wtPath(fx, step.name), branch: `crq/${step.name}` },
            sha(fx, step.commit),
          );
          break;
        case 'update_ref':
          await writes.updateRef(`refs/crq/publication/${step.name}`, sha(fx, step.commit));
          break;
      }
      outcomes.push({ ok: true });
    } catch (error) {
      outcomes.push({
        error: isPyError(error, 'RuntimeError')
          ? 'RuntimeError'
          : isPyError(error, 'OSError')
            ? 'OSError'
            : isPyError(error, 'ValueError')
              ? 'ValueError'
              : error instanceof Error
                ? error.name
                : 'unknown',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return outcomes;
}

function runOracle(cases: readonly { fx: Fixture; steps: readonly Step[] }[]): Outcome[][] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({
      cases: cases.map(({ fx, steps }) => ({
        clone: fx.clone,
        wtRoot: fx.wtRoot,
        prefix: PREFIX,
        steps: steps.map((step) => pyStep(fx, step)),
      })),
    }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env['PATH'] ?? '', ...GIT_ENV },
  });
  return (JSON.parse(stdout) as { results: Outcome[][] }).results.map((steps, index) =>
    steps.map((step) => ({
      ...step,
      ...(step.error === undefined
        ? {}
        : {
            error: OS_ERRORS.has(step.error)
              ? 'OSError'
              : step.error === 'UnicodeDecodeError'
                ? 'ValueError'
                : step.error,
          }),
      ...(step.message === undefined ? {} : { message: normalize(step.message, cases[index]!.fx) }),
    })),
  );
}

/** Everything a publisher or a retry could observe about the repository afterwards. */
async function snapshot(fx: Fixture): Promise<Record<string, unknown>> {
  const tolerant = (cwd: string, ...args: string[]): string => {
    try {
      return normalize(git(cwd, ...args), fx);
    } catch (error) {
      return `<exit ${(error as { status?: number }).status ?? '?'}>`;
    }
  };
  const entries: Record<string, unknown> = {};
  for (const name of (await readdir(fx.wtRoot)).sort()) {
    const path = join(fx.wtRoot, name);
    const info = await lstat(path);
    if (!info.isDirectory()) {
      entries[name] = info.isSymbolicLink() ? 'symlink' : 'file';
      continue;
    }
    entries[name] = {
      files: (await readdir(path)).sort(),
      head: tolerant(path, 'rev-parse', 'HEAD'),
      status: tolerant(path, 'status', '--porcelain'),
      cherryPickHead: tolerant(path, 'rev-parse', '-q', '--verify', 'CHERRY_PICK_HEAD'),
    };
  }
  return {
    registry: tolerant(fx.clone, 'worktree', 'list', '--porcelain'),
    refs: tolerant(
      fx.clone,
      'for-each-ref',
      '--format=%(refname) %(objectname)',
      'refs/heads',
      'refs/crq',
    ),
    entries,
    outside: (await readdir(fx.outside)).sort(),
  };
}

interface Case {
  name: string;
  prep?: (fx: Fixture) => Promise<void>;
  steps: Step[];
}

const make = (name: string, commit: SymbolicCommit = 'target'): Step => ({
  op: 'make',
  name,
  commit,
});
const remove = (name: string): Step => ({ op: 'remove', name });
const cherry = (name: string, commit: SymbolicCommit): Step => ({ op: 'cherry', name, commit });
const updateRef = (name: string, commit: SymbolicCommit): Step => ({
  op: 'update_ref',
  name,
  commit,
});

const CASES: Case[] = [
  { name: 'make a fresh worktree', steps: [make('publish-r1')] },
  {
    name: 'happy path: make, replay a clean commit, remove',
    steps: [make('publish-r1'), cherry('publish-r1', 'clean'), remove('publish-r1')],
  },
  {
    name: 'a conflicting replay is a RuntimeError and leaves CHERRY_PICK_HEAD',
    steps: [make('publish-r1'), cherry('publish-r1', 'repair')],
  },
  {
    name: 'remove force-cleans a conflicted, dirty worktree and its branch',
    steps: [make('publish-r1'), cherry('publish-r1', 'repair'), remove('publish-r1')],
  },
  {
    name: 'an empty replay (already applied) is a RuntimeError with a recorded pick',
    steps: [make('publish-r1', 'applied'), cherry('publish-r1', 'repair')],
  },
  {
    name: 'cherry-pick of an unknown commit is a RuntimeError',
    steps: [make('publish-r1'), cherry('publish-r1', 'unknown')],
  },
  {
    name: 'make of an unknown commit is a RuntimeError and leaves nothing behind',
    steps: [make('publish-r1', 'unknown')],
  },
  {
    name: 'a retried make resets a live, advanced worktree and its branch',
    steps: [make('publish-r1'), cherry('publish-r1', 'clean'), make('publish-r1', 'applied')],
  },
  {
    name: 'make over a stale unregistered directory',
    prep: async (fx) => {
      await mkdir(wtPath(fx, 'publish-r1'));
      await writeFile(join(wtPath(fx, 'publish-r1'), 'junk.txt'), 'x');
    },
    steps: [make('publish-r1')],
  },
  {
    name: 'make over a registered worktree whose directory vanished',
    prep: async (fx) => {
      git(
        fx.clone,
        'worktree',
        'add',
        '-q',
        '-B',
        'crq/publish-r1',
        wtPath(fx, 'publish-r1'),
        'HEAD',
      );
      await rm(wtPath(fx, 'publish-r1'), { recursive: true });
    },
    steps: [make('publish-r1')],
  },
  {
    name: 'make over a stale branch at another commit',
    prep: async (fx) => {
      git(fx.clone, 'branch', 'crq/publish-r1', fx.shas['repair']!);
    },
    steps: [make('publish-r1')],
  },
  {
    name: 'make while the branch is checked out in another worktree',
    prep: async (fx) => {
      git(
        fx.clone,
        'worktree',
        'add',
        '-q',
        '-B',
        'crq/publish-r1',
        join(fx.outside, 'held'),
        'HEAD',
      );
    },
    steps: [make('publish-r1')],
  },
  {
    name: 'make where the path is a symlink to a directory elsewhere',
    prep: async (fx) => {
      await writeFile(join(fx.outside, 'keep.txt'), 'keep');
      await symlink(fx.outside, wtPath(fx, 'publish-r1'));
    },
    steps: [make('publish-r1')],
  },
  {
    name: 'make where the path is a regular file',
    prep: async (fx) => {
      await writeFile(wtPath(fx, 'publish-r1'), 'file');
    },
    steps: [make('publish-r1')],
  },
  {
    name: 'remove of an absent path still prunes and deletes the branch',
    prep: async (fx) => {
      git(fx.clone, 'branch', 'crq/publish-r1', fx.shas['repair']!);
      git(
        fx.clone,
        'worktree',
        'add',
        '-q',
        '-B',
        'crq/publish-gone',
        wtPath(fx, 'publish-gone'),
        'HEAD',
      );
      await rm(wtPath(fx, 'publish-gone'), { recursive: true });
    },
    steps: [remove('publish-r1')],
  },
  {
    name: 'remove of a locked worktree: the directory goes, the registration stays',
    prep: async (fx) => {
      git(
        fx.clone,
        'worktree',
        'add',
        '-q',
        '-B',
        'crq/publish-r1',
        wtPath(fx, 'publish-r1'),
        'HEAD',
      );
      git(fx.clone, 'worktree', 'lock', wtPath(fx, 'publish-r1'));
    },
    steps: [remove('publish-r1')],
  },
  {
    name: 'remove leaves a symlink and its target alone',
    prep: async (fx) => {
      await writeFile(join(fx.outside, 'keep.txt'), 'keep');
      await symlink(fx.outside, wtPath(fx, 'publish-r1'));
    },
    steps: [remove('publish-r1')],
  },
  {
    name: 'update-ref creates and then overwrites the publication ref',
    steps: [updateRef('r1', 'target'), updateRef('r1', 'repair')],
  },
  {
    name: 'update-ref of an unknown object is a RuntimeError',
    steps: [updateRef('r1', 'unknown')],
  },
  {
    name: 'cherry-pick in a worktree directory that does not exist is an OS error',
    steps: [cherry('publish-missing', 'clean')],
  },
];

describe('publication worktree writes: Python differential', () => {
  it('agrees with Python on every step outcome and the final repository state', async () => {
    const pairs = await Promise.all(
      CASES.map(async (item) => {
        const py = await makeFixture();
        const ts = await makeFixture();
        expect(ts.shas).toEqual(py.shas);
        await item.prep?.(py);
        await item.prep?.(ts);
        return { item, py, ts };
      }),
    );
    const oracle = runOracle(pairs.map(({ item, py }) => ({ fx: py, steps: item.steps })));
    for (const [index, { item, py, ts }] of pairs.entries()) {
      const tsOutcomes = (await runTs(ts, item.steps)).map((step) => ({
        ...step,
        ...(step.message === undefined ? {} : { message: normalize(step.message, ts) }),
      }));
      const label = item.name;
      const expected = oracle[index]!.map((step) => ({
        error: step.error,
        message: step.error === 'RuntimeError' ? step.message : undefined,
      }));
      const actual = tsOutcomes.map((step) => ({
        error: step.error,
        message: step.error === 'RuntimeError' ? step.message : undefined,
      }));
      expect({ label, steps: actual }).toEqual({ label, steps: expected });
      expect({ label, state: await snapshot(ts) }).toEqual({ label, state: await snapshot(py) });
    }
  }, 120_000);

  it('the cases exercise every error class and success path they claim to', async () => {
    const fx = await makeFixture();
    const outcomes = await runTs(fx, [
      make('publish-r1'),
      cherry('publish-r1', 'repair'),
      cherry('publish-missing', 'clean'),
      updateRef('r1', 'unknown'),
    ]);
    expect(outcomes.map((o) => o.error)).toEqual([
      undefined,
      'RuntimeError',
      'OSError',
      'RuntimeError',
    ]);
    expect(outcomes[1]!.message).toMatch(/^git cherry-pick failed: /);
    expect(outcomes[3]!.message).toMatch(
      /^git update-ref refs\/crq\/publication\/r1 9{40} … exit 128: /,
    );
  });
});

describe('publication worktree writes: composition with the Git reads', () => {
  it('makes, replays, reads back, journals the ref and removes, leaving nothing', async () => {
    const fx = await makeFixture();
    const writes = gitPublicationWorktrees({
      clone: fx.clone,
      worktreeRoot: fx.wtRoot,
      worktreePrefix: PREFIX,
      runGitFor,
    });
    const reads = gitPublicationReads({ clone: fx.clone, worktreeRoot: fx.wtRoot, runGitFor });
    const target = await reads.revParseDefaultRef();
    expect(target).toBe(fx.shas['target']);
    const wt = await writes.makeWorktree('publish-r1', target);
    expect(wt).toEqual({ path: wtPath(fx, 'publish-r1'), branch: 'crq/publish-r1' });
    const before = await reads.revParseHead(wt);
    await writes.cherryPick(wt, fx.shas['clean']!);
    const claims = await reads.revListSince(wt, before);
    expect(claims).toHaveLength(1);
    expect(await reads.diffSince(wt, target)).toContain('+c');
    const head = await reads.revParseHead(wt);
    await writes.updateRef('refs/crq/publication/r1', head);
    expect(git(fx.clone, 'rev-parse', 'refs/crq/publication/r1')).toBe(head);
    // A conflict is the deterministic-replay signal publishRepair reads.
    const conflict = await writes.cherryPick(wt, fx.shas['repair']!).catch((e: unknown) => e);
    expect(isPyError(conflict, 'RuntimeError')).toBe(true);
    expect((conflict as Error).message).toMatch(/^git cherry-pick failed: error: could not apply /);
    await writes.removeWorktree(wt);
    await expect(stat(wt.path)).rejects.toThrow();
    expect(git(fx.clone, 'branch', '--list', 'crq/*')).toBe('');
    expect(git(fx.clone, 'worktree', 'list', '--porcelain').split('\n\n')).toHaveLength(1);
    // The publication ref outlives the worktree: it is the durable identity.
    expect(git(fx.clone, 'rev-parse', 'refs/crq/publication/r1')).toBe(head);
  });
});

function call(code: number | null, stdout = '', stderr = ''): GitCall {
  return { args: [], code, stdout: new TextEncoder().encode(stdout), stderr };
}

interface Recorded {
  readonly cwd: string;
  readonly args: readonly string[];
  readonly env: Record<string, string> | undefined;
}

function scripted(
  replies: (args: readonly string[], index: number) => GitCall | Promise<GitCall>,
): {
  runGitFor: (repo: string) => RunGit;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  return {
    calls,
    runGitFor: (cwd) => async (args, options) => {
      calls.push({ cwd, args, env: options?.env });
      return replies(args, calls.length - 1);
    },
  };
}

describe('publication worktree writes: scripted failure classes', () => {
  const OID = 'a'.repeat(40);
  const options = (
    runner: { runGitFor: (repo: string) => RunGit },
    root = '/nonexistent-wt-root',
  ) => ({
    clone: '/nonexistent-clone',
    worktreeRoot: root,
    worktreePrefix: PREFIX,
    runGitFor: runner.runGitFor,
  });

  it('makes a worktree with the exact Python argv, LFS smudge off and a pre-clean first', async () => {
    const runner = scripted(() => call(0));
    const writes = gitPublicationWorktrees(options(runner));
    const wt = await writes.makeWorktree('publish-r1', OID);
    expect(wt).toEqual({
      path: `/nonexistent-wt-root/${PREFIX}publish-r1`,
      branch: 'crq/publish-r1',
    });
    expect(runner.calls).toEqual([
      { cwd: '/nonexistent-clone', args: ['worktree', 'prune'], env: undefined },
      { cwd: '/nonexistent-clone', args: ['branch', '-D', 'crq/publish-r1'], env: undefined },
      {
        cwd: '/nonexistent-clone',
        args: [
          '-c',
          'filter.lfs.smudge=',
          '-c',
          'filter.lfs.process=',
          'worktree',
          'add',
          '--quiet',
          '-B',
          'crq/publish-r1',
          `/nonexistent-wt-root/${PREFIX}publish-r1`,
          OID,
        ],
        env: { GIT_LFS_SKIP_SMUDGE: '1' },
      },
    ]);
  });

  it('cleans up again after a failed add and re-raises Python failure text (stderr stripped, 400)', async () => {
    const runner = scripted((args) =>
      args.includes('add') ? call(128, '', `  fatal: ${'x'.repeat(500)}\r\n`) : call(1),
    );
    const writes = gitPublicationWorktrees(options(runner));
    const error = await writes.makeWorktree('publish-r1', OID).catch((e: unknown) => e);
    expect(isPyError(error, 'RuntimeError')).toBe(true);
    expect((error as Error).message).toBe(
      `git -c filter.lfs.smudge= -c filter.lfs.process= worktree … exit 128: fatal: ${'x'.repeat(393)}`,
    );
    expect(runner.calls.map((c) => c.args.slice(0, 2).join(' '))).toEqual([
      'worktree prune',
      'branch -D',
      '-c filter.lfs.smudge=',
      'worktree prune',
      'branch -D',
    ]);
  });

  it('a call that never finished is an OS error, cleaned up after the add but never before it', async () => {
    const add = scripted((args) => (args.includes('add') ? call(null, '', 'timed out') : call(0)));
    const error = await gitPublicationWorktrees(options(add))
      .makeWorktree('publish-r1', OID)
      .catch((e: unknown) => e);
    expect(isPyError(error, 'OSError')).toBe(true);
    expect(add.calls).toHaveLength(5);
    const pre = scripted(() => call(null));
    const early = await gitPublicationWorktrees(options(pre))
      .makeWorktree('publish-r1', OID)
      .catch((e: unknown) => e);
    expect(isPyError(early, 'OSError')).toBe(true);
    expect(pre.calls).toHaveLength(1);
  });

  it('a decode failure is a ValueError and is not cleaned up, as Python catches only RuntimeError/Timeout', async () => {
    const runner = scripted((args) =>
      args.includes('add') ? { ...call(0), stdout: new Uint8Array([0x66, 0xff, 0xfe]) } : call(0),
    );
    const error = await gitPublicationWorktrees(options(runner))
      .makeWorktree('publish-r1', OID)
      .catch((e: unknown) => e);
    expect(isPyError(error, 'ValueError')).toBe(true);
    expect(runner.calls).toHaveLength(3);
  });

  it('cherry-pick: a Git exit is RuntimeError with stderr[:200] unstripped; no exit code is OSError', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-worktrees-cp-')));
    cleanups.push(root);
    const path = join(root, `${PREFIX}publish-r1`);
    await mkdir(path);
    const failing = scripted(() => call(1, '', `${'y'.repeat(250)}\n`));
    const writes = gitPublicationWorktrees(options(failing, root));
    const handle = { path, branch: 'crq/publish-r1' };
    const error = await writes.cherryPick(handle, OID).catch((e: unknown) => e);
    expect(isPyError(error, 'RuntimeError')).toBe(true);
    expect((error as Error).message).toBe(`git cherry-pick failed: ${'y'.repeat(200)}`);
    expect(failing.calls).toEqual([{ cwd: path, args: ['cherry-pick', OID], env: undefined }]);
    const lost = scripted(() => call(null));
    const spawn = await gitPublicationWorktrees(options(lost, root))
      .cherryPick(handle, OID)
      .catch((e: unknown) => e);
    expect(isPyError(spawn, 'OSError')).toBe(true);
  });

  it('refuses names, handles and operands Python would have run on, before any Git call', async () => {
    const runner = scripted(() => call(0));
    const writes = gitPublicationWorktrees(options(runner, '/wt'));
    const refusals: Promise<unknown>[] = [];
    for (const name of ['', 'a/b', '../x', '.hidden', '-flag', 'a..b', 'x.lock', 'x.', 'a b', 'ä'])
      refusals.push(writes.makeWorktree(name, OID));
    for (const bad of ['HEAD', 'main', '--upload-pack=x', 'a'.repeat(39), 'g'.repeat(40)]) {
      refusals.push(writes.makeWorktree('publish-r1', bad));
      refusals.push(
        writes.cherryPick({ path: `/wt/${PREFIX}publish-r1`, branch: 'crq/publish-r1' }, bad),
      );
      refusals.push(writes.updateRef('refs/crq/publication/r1', bad));
    }
    for (const [path, branch] of [
      ['/wt', 'crq/x'],
      ['/wt/x', 'crq/x'], // no prefix
      [`/wt/${PREFIX}`, 'crq/'], // empty name
      [`/wt/${PREFIX}a/b`, 'crq/b'], // nested
      [`/elsewhere/${PREFIX}x`, 'crq/x'],
      [`/wt/${PREFIX}x`, 'crq/y'], // branch mismatch
      [`/wt/${PREFIX}x`, 'main'],
      [`/wt/${PREFIX}x/..`, 'crq/x'],
      [`${PREFIX}x`, 'crq/x'], // relative
    ] as const) {
      refusals.push(writes.removeWorktree({ path, branch }));
      refusals.push(writes.cherryPick({ path, branch }, OID));
    }
    for (const ref of [
      'refs/heads/main',
      'refs/crq/publication/',
      'refs/crq/publication/a/b',
      'HEAD',
    ])
      refusals.push(writes.updateRef(ref, OID));
    const settled = await Promise.allSettled(refusals);
    for (const result of settled) {
      expect(result.status).toBe('rejected');
      expect(isPyError((result as PromiseRejectedResult).reason, 'ValueError')).toBe(true);
    }
    expect(runner.calls).toEqual([]);
  });

  it('refuses an unusable worktree root or prefix at construction', () => {
    const runner = scripted(() => call(0));
    expect(() => gitPublicationWorktrees(options(runner, 'relative'))).toThrow();
    for (const worktreePrefix of ['', '.', '..', 'a/b', 'a\\b'])
      expect(() =>
        gitPublicationWorktrees({ ...options(runner, '/wt'), worktreePrefix }),
      ).toThrow();
  });

  it.each(['/wt/', '/wt//', '/wt/./'])(
    'accepts a direct child of the root spelled %j',
    async (root) => {
      const runner = scripted(() => call(0));
      const writes = gitPublicationWorktrees(options(runner, root));
      await expect(
        writes.removeWorktree({ path: `/wt/${PREFIX}x/`, branch: 'crq/x' }),
      ).resolves.toBeUndefined();
      expect(runner.calls.map((c) => c.args.join(' '))).toEqual([
        'worktree prune',
        'branch -D crq/x',
      ]);
    },
  );

  it('never deletes through a symlink or a plain file at the owned path', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-worktrees-rm-')));
    cleanups.push(root);
    const outside = join(root, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'keep.txt'), 'keep');
    const wtRoot = join(root, 'wt');
    await mkdir(wtRoot);
    await symlink(outside, join(wtRoot, `${PREFIX}publish-link`));
    await writeFile(join(wtRoot, `${PREFIX}publish-file`), 'file');
    await mkdir(join(wtRoot, `${PREFIX}publish-dir`));
    await writeFile(join(wtRoot, `${PREFIX}publish-dir`, 'f'), 'f');
    const runner = scripted(() => call(128, '', 'fatal: not a working tree'));
    const writes = gitPublicationWorktrees(options(runner, wtRoot));
    for (const name of ['publish-link', 'publish-file', 'publish-dir'])
      await writes.removeWorktree({
        path: join(wtRoot, `${PREFIX}${name}`),
        branch: `crq/${name}`,
      });
    expect(await readFile(join(outside, 'keep.txt'), 'utf8')).toBe('keep');
    expect((await lstat(join(wtRoot, `${PREFIX}publish-link`))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(wtRoot, `${PREFIX}publish-file`))).isFile()).toBe(true);
    await expect(lstat(join(wtRoot, `${PREFIX}publish-dir`))).rejects.toThrow();
  });

  it('pins the types against what PublicationPublishEffects declares', () => {
    const runner = scripted(() => call(0));
    expect(Object.keys(pinned(gitPublicationWorktrees(options(runner))))).toEqual([
      'makeWorktree',
      'removeWorktree',
      'cherryPick',
      'updateRef',
    ]);
  });
});
