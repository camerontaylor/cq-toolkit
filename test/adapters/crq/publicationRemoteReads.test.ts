// Differential run: the same throwaway LOCAL bare repositories, named as `origin`
// in a throwaway clone, through Python's real `crq.git('ls-remote', '--heads',
// 'origin', 'refs/heads/' + branch)` and the `remote.split()[0] if remote else None`
// line of `repair_tick.recover_publication` (the oracle is
// test/helpers/publicationRemoteReadsOracle.py) and the TS remote read driving the
// real `recoverPublication`. Values and the exception class must be equal, and for a
// failed process the message too. Scripted-process cases pin the failure classes a
// repository cannot produce on demand (spawn failure, the time bound). No network, no
// credential, no forge and no remote service: `origin` is a directory under the test's
// temp root, and neither the adapter nor the oracle writes to it (the fixtures
// themselves are made by the test with plain `git`).
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gitPublicationRemoteReads,
  type PublicationRemoteReads,
} from '../../../src/adapters/crq/publicationRemoteReads.js';
import type { GitCall, RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { isPyError } from '../../../src/queue-runner/pyErrors.js';
import {
  recoverPublication,
  remoteHeadOf,
  type PublicationRecoveryEffects,
  REFUSE_BRANCH_DIFFERS,
} from '../../../src/queue-runner/publicationRecovery.js';
import type { PublicationPublishEffects } from '../../../src/queue-runner/publicationPublish.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const ORACLE = fileURLToPath(
  new URL('../../helpers/publicationRemoteReadsOracle.py', import.meta.url),
);
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));

// The structural subset the recovery and publish orchestrations declare.
type Pinned = Pick<PublicationRecoveryEffects, keyof PublicationRemoteReads> &
  Pick<PublicationPublishEffects, keyof PublicationRemoteReads>;
const pinned = (reads: PublicationRemoteReads): Pinned => reads;

interface Fixture {
  root: string;
  /** A clone whose `origin` is the populated bare repository. */
  clone: string;
  /** A clone whose `origin` is an empty bare repository. */
  emptyOrigin: string;
  /** A clone whose `origin` names a directory that does not exist. */
  missingOrigin: string;
  /** A repository with no `origin` remote at all. */
  noOrigin: string;
  shas: Record<'main' | 'one' | 'shadow' | 'decoy' | 'only' | 'bad', string>;
}

/**
 * Characters Python's `str.strip()` removes and `branchPathFault` accepts, so a valid branch
 * can END in one: no-break space, ideographic space, a general-punctuation space, NEL and
 * line separator. Each is published as `ws/<n><char>` at the `one` commit.
 */
const TRAILING_WHITESPACE = ['\u00a0', '\u3000', '\u2005', '\u0085', '\u2028'] as const;
const wsBranch = (index: number): string => `ws/${index}${TRAILING_WHITESPACE[index]}`;

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
      ...args,
    ],
    { encoding: 'utf8', env: scrubbedGitEnv(), stdio: ['ignore', 'pipe', 'pipe'] },
  ).trim();
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-pub-remote-reads-')));
  cleanups.push(root);
  const clone = join(root, 'clone');
  const bare = join(root, 'origin.git');
  const emptyBare = join(root, 'empty.git');
  const emptyOrigin = join(root, 'empty-clone');
  const missingOrigin = join(root, 'missing-clone');
  const noOrigin = join(root, 'no-origin');
  await mkdir(clone);
  await mkdir(emptyOrigin);
  await mkdir(missingOrigin);
  await mkdir(noOrigin);
  git(root, 'init', '-q', '--bare', '--object-format=sha1', bare);
  git(root, 'init', '-q', '--bare', '--object-format=sha1', emptyBare);
  for (const dir of [clone, emptyOrigin, missingOrigin, noOrigin])
    git(dir, 'init', '-q', '--object-format=sha1');
  git(clone, 'remote', 'add', 'origin', bare);
  git(emptyOrigin, 'remote', 'add', 'origin', emptyBare);
  git(missingOrigin, 'remote', 'add', 'origin', join(root, 'gone.git'));

  const commit = async (name: string): Promise<string> => {
    await writeFile(join(clone, `${name}.txt`), `${name}\n`);
    git(clone, 'add', `${name}.txt`);
    git(clone, 'commit', '-q', '-m', name);
    return git(clone, 'rev-parse', 'HEAD');
  };
  const shas = {
    main: await commit('main'),
    one: await commit('one'),
    shadow: await commit('shadow'),
    decoy: await commit('decoy'),
    only: await commit('only'),
    bad: await commit('bad'),
  };
  const publish = (sha: string, ref: string) => git(clone, 'push', '-q', 'origin', `${sha}:${ref}`);
  publish(shas.main, 'refs/heads/main');
  publish(shas.one, 'refs/heads/fix/one');
  for (const index of TRAILING_WHITESPACE.keys())
    publish(shas.one, `refs/heads/${wsBranch(index)}`);
  // `ls-remote` matches a pattern as a tail, so these decoys also match the pattern
  // of the branch they are named after, and sort before it where it exists.
  publish(shas.shadow, 'refs/heads/shadow');
  publish(shas.decoy, 'refs/heads/a/refs/heads/shadow');
  publish(shas.only, 'refs/heads/a/refs/heads/onlydecoy');
  // A ref whose name is not UTF-8, matched by the tail of `refs/heads/badutf`. Git
  // stores the name as bytes; the test writes the loose ref directly.
  const dir = Buffer.concat([
    Buffer.from(join(bare, 'refs', 'heads') + '/'),
    Buffer.from([0xff]),
    Buffer.from('/refs/heads'),
  ]);
  await mkdir(dir, { recursive: true });
  await writeFile(Buffer.concat([dir, Buffer.from('/badutf')]), `${shas.bad}\n`);
  return { root, clone, emptyOrigin, missingOrigin, noOrigin, shas };
}

// The differential compares Git's failure text with the oracle child, which is pinned to
// `C.UTF-8`; the TS runner inherits this process's environment, so pin it here too and a
// host with a non-English locale cannot make Git's stderr differ between the two sides.
const LOCALE_KEYS = ['LC_ALL', 'LANGUAGE'] as const;
const savedLocale = new Map<string, string | undefined>();

beforeAll(async () => {
  for (const key of LOCALE_KEYS) savedLocale.set(key, process.env[key]);
  process.env['LC_ALL'] = 'C.UTF-8';
  delete process.env['LANGUAGE'];
  fx = await makeFixture();
});

afterAll(async () => {
  for (const [key, value] of savedLocale) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(cleanups.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Outcome {
  ok?: unknown;
  error?: string;
  message?: string;
}

function runOracle(
  cases: readonly { op: 'ls_remote' | 'remote_head'; clone: string; branch: string }[],
): Outcome[] {
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

async function runTs(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: await run() };
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

describe('publication remote read: Python differential', () => {
  interface Case {
    name: string;
    clone: () => string;
    branch: string;
  }
  const cases: Case[] = [
    { name: 'a present branch', clone: () => fx.clone, branch: 'fix/one' },
    { name: 'a present top-level branch', clone: () => fx.clone, branch: 'main' },
    { name: 'an absent branch is the empty string', clone: () => fx.clone, branch: 'absent' },
    { name: 'a prefix of a branch is absent', clone: () => fx.clone, branch: 'fix/o' },
    { name: 'a longer name is absent', clone: () => fx.clone, branch: 'fix/one/extra' },
    { name: 'a case variant is absent', clone: () => fx.clone, branch: 'FIX/ONE' },
    { name: 'an empty origin lists nothing', clone: () => fx.emptyOrigin, branch: 'main' },
    {
      name: 'an origin that does not exist is a failure, not an absent branch',
      clone: () => fx.missingOrigin,
      branch: 'main',
    },
    {
      name: 'a clone with no origin remote is a failure, not an absent branch',
      clone: () => fx.noOrigin,
      branch: 'main',
    },
    ...TRAILING_WHITESPACE.flatMap((char, index) => [
      {
        name: `a present branch ending in U+${char.codePointAt(0)!.toString(16).padStart(4, '0')} is present, not absent`,
        clone: () => fx.clone,
        branch: wsBranch(index),
      },
      {
        name: `the same name without its trailing U+${char.codePointAt(0)!.toString(16).padStart(4, '0')} is absent`,
        clone: () => fx.clone,
        branch: `ws/${index}`,
      },
    ]),
    {
      name: 'a listing that is not UTF-8 is a ValueError (UnicodeDecodeError)',
      clone: () => fx.clone,
      branch: 'badutf',
    },
  ];

  it('agrees with Python on every value, exception class and failure text', async () => {
    const reads = (clone: string) => gitPublicationRemoteReads({ clone });
    for (const op of ['ls_remote', 'remote_head'] as const) {
      const oracle = runOracle(cases.map((c) => ({ op, clone: c.clone(), branch: c.branch })));
      for (const [index, item] of cases.entries()) {
        const run = async () => {
          const text = await reads(item.clone()).lsRemoteHeads(item.branch);
          return op === 'ls_remote' ? text : remoteHeadOf(text);
        };
        const ts = await runTs(run);
        const py = oracle[index]!;
        const label = `${op}: ${item.name}`;
        // UnicodeDecodeError is a ValueError subclass.
        const pyClass = py.error === 'UnicodeDecodeError' ? 'ValueError' : py.error;
        expect({ label, error: ts.error }).toEqual({ label, error: pyClass });
        if (py.error === undefined) expect({ label, ok: ts.ok }).toEqual({ label, ok: py.ok });
        if (py.error === 'RuntimeError')
          expect({ label, message: ts.message }).toEqual({ label, message: py.message });
      }
    }
  });

  // Regression: the exact-ref filter used to run after `pyStrip`, which took the trailing
  // whitespace off the last row's ref, so a present branch read as absent and recovery pushed
  // with an empty lease where Python finalizes.
  it('reads a present branch ending in Unicode whitespace, as Python does', async () => {
    const reads = gitPublicationRemoteReads({ clone: fx.clone });
    for (const [index, char] of TRAILING_WHITESPACE.entries()) {
      const branch = wsBranch(index);
      const [listing, head] = ['ls_remote', 'remote_head'].map(
        (op) => runOracle([{ op: op as 'ls_remote' | 'remote_head', clone: fx.clone, branch }])[0]!,
      );
      // Python strips the whole listing, so the character is gone from the ref it returns.
      expect(listing, branch).toEqual({ ok: `${fx.shas.one}\trefs/heads/ws/${index}` });
      expect(head, branch).toEqual({ ok: fx.shas.one });
      const text = await reads.lsRemoteHeads(branch);
      expect(text, `U+${char.codePointAt(0)!.toString(16)}`).toBe(listing!.ok);
      expect(remoteHeadOf(text)).toBe(fx.shas.one);
    }
  });

  it('reads the exact tip rows the fixture published', async () => {
    const reads = gitPublicationRemoteReads({ clone: fx.clone });
    await expect(reads.lsRemoteHeads('fix/one')).resolves.toBe(
      `${fx.shas.one}\trefs/heads/fix/one`,
    );
    await expect(reads.lsRemoteHeads('absent')).resolves.toBe('');
    await expect(
      gitPublicationRemoteReads({ clone: fx.missingOrigin }).lsRemoteHeads('main'),
    ).rejects.toMatchObject({ kind: 'RuntimeError' });
  });

  // The one deliberate narrowing of the port: a remote branch named
  // `a/refs/heads/<branch>` also matches the tail pattern. Python reads its tip as
  // this branch's tip (or a branch that does not exist as present); the TS read does not.
  it('drops the tail-match decoys Python would read as the branch itself', async () => {
    const reads = gitPublicationRemoteReads({ clone: fx.clone });
    const [shadow, onlyDecoy] = runOracle([
      { op: 'remote_head', clone: fx.clone, branch: 'shadow' },
      { op: 'remote_head', clone: fx.clone, branch: 'onlydecoy' },
    ]);
    // Python: the decoy row sorts first, so its SHA is taken for the real branch...
    expect(shadow).toEqual({ ok: fx.shas.decoy });
    // ...and a branch that is not on the remote reads as published at the decoy's SHA.
    expect(onlyDecoy).toEqual({ ok: fx.shas.only });
    // TS: the real branch's own row, and an absent branch stays absent.
    const own = await reads.lsRemoteHeads('shadow');
    expect(own).toBe(`${fx.shas.shadow}\trefs/heads/shadow`);
    expect(remoteHeadOf(own)).toBe(fx.shas.shadow);
    await expect(reads.lsRemoteHeads('onlydecoy')).resolves.toBe('');
  });

  it('pins the type against what the orchestrations declare', () => {
    expect(Object.keys(pinned(gitPublicationRemoteReads({ clone: fx.clone })))).toEqual([
      'lsRemoteHeads',
    ]);
  });
});

function call(code: number | null, stdout: string | Uint8Array, stderr = ''): GitCall {
  return {
    args: [],
    code,
    stdout: typeof stdout === 'string' ? new TextEncoder().encode(stdout) : stdout,
    stderr,
  };
}

describe('publication remote read: scripted process', () => {
  const SHA = 'a'.repeat(40);
  const ROW = `${SHA}\trefs/heads/fix/one`;
  function scripted(reply: (cwd: string, args: readonly string[]) => GitCall) {
    const log: { cwd: string; args: readonly string[] }[] = [];
    const runGitFor =
      (cwd: string): RunGit =>
      async (args) => {
        log.push({ cwd, args });
        return { ...reply(cwd, args), args };
      };
    return { log, reads: gitPublicationRemoteReads({ clone: '/clone', runGitFor }) };
  }

  it('runs the exact argv in the clone, against the literal origin', async () => {
    const { log, reads } = scripted(() => call(0, `${ROW}\n`));
    await expect(reads.lsRemoteHeads('fix/one')).resolves.toBe(ROW);
    // A leading dash is part of a refname operand, never an option.
    await reads.lsRemoteHeads('-x');
    expect(log).toEqual([
      { cwd: '/clone', args: ['ls-remote', '--heads', 'origin', 'refs/heads/fix/one'] },
      { cwd: '/clone', args: ['ls-remote', '--heads', 'origin', 'refs/heads/-x'] },
    ]);
  });

  it('answers an absent branch with the empty string, from an exit 0 and no output', async () => {
    const { reads } = scripted(() => call(0, ''));
    await expect(reads.lsRemoteHeads('fix/one')).resolves.toBe('');
    const blank = scripted(() => call(0, ' \n\u0085\n'));
    await expect(blank.reads.lsRemoteHeads('fix/one')).resolves.toBe('');
  });

  it('treats a call that never exited (spawn failure, time or output bound) as OSError, never absent', async () => {
    for (const stderr of ['spawn failed', '', 'killed']) {
      const { reads } = scripted(() => call(null, '', stderr));
      const failure = await reads.lsRemoteHeads('fix/one').catch((error: unknown) => error);
      expect(isPyError(failure, 'OSError'), stderr).toBe(true);
      expect(isPyError(failure, 'RuntimeError')).toBe(false);
    }
  });

  it('checks the exit status before reading the output of a call that never exited', async () => {
    // subprocess.run raises before it returns anything: partial invalid bytes are no ValueError.
    const { reads } = scripted(() => call(null, new Uint8Array([0xff, 0xfe])));
    await expect(reads.lsRemoteHeads('fix/one')).rejects.toMatchObject({ kind: 'OSError' });
  });

  it('keeps a non-zero exit a RuntimeError with the Python text, never an absent branch', async () => {
    const stderr = `\u0085fatal: one\r\ntwo\rthree ${'e'.repeat(450)}\n`;
    const { reads } = scripted(() => call(128, '', stderr));
    const failure = await reads.lsRemoteHeads('fix/one').catch((error: unknown) => error);
    expect(isPyError(failure, 'RuntimeError')).toBe(true);
    // Universal newlines, then str.strip() (U+0085 is whitespace), then [:400].
    const text = `fatal: one\ntwo\nthree ${'e'.repeat(450)}`;
    expect((failure as Error).message).toBe(
      `git ls-remote --heads origin refs/heads/fix/one … exit 128: ${text.slice(0, 400)}`,
    );
    // Even a call that printed a row before failing is a failure.
    const partial = scripted(() => call(2, `${ROW}\n`, 'fatal'));
    await expect(partial.reads.lsRemoteHeads('fix/one')).rejects.toMatchObject({
      kind: 'RuntimeError',
    });
  });

  it('decodes strict UTF-8 before the exit status, as subprocess text mode does', async () => {
    const invalid = new Uint8Array([0x66, 0xff, 0x0a]);
    const ok = scripted(() => call(0, invalid));
    await expect(ok.reads.lsRemoteHeads('fix/one')).rejects.toMatchObject({ kind: 'ValueError' });
    const failed = scripted(() => call(128, invalid, 'fatal'));
    await expect(failed.reads.lsRemoteHeads('fix/one')).rejects.toMatchObject({
      kind: 'ValueError',
    });
  });

  it('strips with Python whitespace and translates universal newlines', async () => {
    const { reads } = scripted(() => call(0, `\u001c\u0085 ${ROW}\r\n `));
    await expect(reads.lsRemoteHeads('fix/one')).resolves.toBe(ROW);
    // The first token is what recovery reads, as `remote.split()[0]`.
    expect(remoteHeadOf(await reads.lsRemoteHeads('fix/one'))).toBe(SHA);
  });

  it('compares the ref before stripping, so a branch ending in Unicode whitespace is present', async () => {
    for (const char of TRAILING_WHITESPACE) {
      const branch = `fix/one${char}`;
      const row = `${SHA}\trefs/heads/${branch}`;
      // The branch's own row ends the listing, so its ref carries the whitespace to the end.
      const decoy = `${'b'.repeat(40)}\trefs/heads/a/refs/heads/${branch}`;
      const { reads } = scripted(() => call(0, `${decoy}\n${row}\n`));
      const text = await reads.lsRemoteHeads(branch);
      // The kept row is stripped as Python strips the listing.
      expect(text).toBe(`${SHA}\trefs/heads/fix/one`);
      expect(remoteHeadOf(text)).toBe(SHA);
    }
    // The stripped name is a different ref: its row never names `fix/one` exactly.
    const other = scripted(() => call(0, `${SHA}\trefs/heads/fix/one\u00a0\n`));
    await expect(other.reads.lsRemoteHeads('fix/one')).resolves.toBe('');
  });

  it('keeps only the rows for exactly the requested ref', async () => {
    const decoy = `${'b'.repeat(40)}\trefs/heads/a/refs/heads/fix/one`;
    const longer = `${'c'.repeat(40)}\trefs/heads/fix/one/more`;
    const { reads } = scripted(() => call(0, `${decoy}\n${ROW}\n${longer}\n`));
    await expect(reads.lsRemoteHeads('fix/one')).resolves.toBe(ROW);
    const only = scripted(() => call(0, `${decoy}\n`));
    await expect(only.reads.lsRemoteHeads('fix/one')).resolves.toBe('');
    // A row without a tab names no ref.
    const bare = scripted(() => call(0, `${SHA} refs/heads/fix/one\n`));
    await expect(bare.reads.lsRemoteHeads('fix/one')).resolves.toBe('');
  });

  it.each([
    '',
    'ma*',
    'x[ab]',
    'x?y',
    'a b',
    'a\nb',
    'a\u0000b',
    '/x',
    'x/',
    'a//b',
    'a..b',
    '.hidden',
    'x.lock',
    'x@{1}',
    '@',
    'a\\b',
    'a:b',
    'a~1',
    'a^',
    'x.',
    42 as unknown as string,
    undefined as unknown as string,
  ])('refuses the branch %j as a ValueError before any process runs', async (branch) => {
    const { log, reads } = scripted(() => call(0, ''));
    await expect(reads.lsRemoteHeads(branch)).rejects.toMatchObject({ kind: 'ValueError' });
    expect(log).toEqual([]);
  });
});

describe('publication remote read through recoverPublication', () => {
  const HEAD = 'a'.repeat(40);
  const OTHER = 'b'.repeat(40);
  const BRANCH = 'crq/fix-1';

  function harness(reply: GitCall | ((args: readonly string[]) => GitCall), branch = BRANCH) {
    const events: string[] = [];
    const runGitFor = (): RunGit => async (args) => {
      events.push(`git ${args.join(' ')}`);
      return { ...(typeof reply === 'function' ? reply(args) : reply), args };
    };
    const reads = gitPublicationRemoteReads({ clone: '/clone', runGitFor });
    const effects: PublicationRecoveryEffects = {
      lsRemoteHeads: (branch) => reads.lsRemoteHeads(branch),
      prInfo: () => {
        events.push('prInfo');
        return Promise.reject(new Error('no open PR is read here'));
      },
      listBranchPrs: () => {
        events.push('listBranchPrs');
        return Promise.resolve([]);
      },
      isAncestor: (older, newer) => {
        events.push(`isAncestor ${older} ${newer}`);
        return Promise.resolve(true);
      },
      push: (branch, expected, sha) => {
        events.push(`push ${branch} ${expected === '' ? '<absent>' : expected} ${sha}`);
        return Promise.resolve();
      },
      finalize: () => {
        events.push('finalize');
        return Promise.resolve();
      },
    };
    const recover = (): Promise<void> =>
      recoverPublication(
        effects,
        { pr: 7 },
        {},
        { head: HEAD, target: OTHER, branch, open_pr: false },
      );
    return { events, recover };
  }

  const LS = `git ls-remote --heads origin refs/heads/${BRANCH}`;

  it('pushes with the empty lease when the branch is absent', async () => {
    const { events, recover } = harness(call(0, ''));
    await recover();
    expect(events).toEqual([LS, 'listBranchPrs', `push ${BRANCH} <absent> ${HEAD}`, 'finalize']);
  });

  it('finalizes without a push when the branch is already at the prepared head', async () => {
    const { events, recover } = harness(call(0, `${HEAD}\trefs/heads/${BRANCH}\n`));
    await recover();
    expect(events).toEqual([LS, 'listBranchPrs', 'finalize']);
  });

  it('leases the verified remote tip and refuses a branch that differs from the journal', async () => {
    const { events, recover } = harness(call(0, `${OTHER}\trefs/heads/${BRANCH}\n`));
    await expect(recover()).rejects.toMatchObject({
      kind: 'ValueError',
      message: REFUSE_BRANCH_DIFFERS,
    });
    expect(events).toEqual([LS, 'listBranchPrs']);
  });

  // Regression: a published branch whose name ends in Unicode whitespace read as absent, so
  // recovery pushed with an empty lease (git rejects it on an existing ref) instead of finalizing.
  it.each(TRAILING_WHITESPACE.map((char) => [char.codePointAt(0)!.toString(16), char] as const))(
    'finalizes a present branch ending in U+%s without an empty-lease push',
    async (_code, char) => {
      const branch = `${BRANCH}${char}`;
      const { events, recover } = harness(call(0, `${HEAD}\trefs/heads/${branch}\n`), branch);
      await recover();
      expect(events).toEqual([
        `git ls-remote --heads origin refs/heads/${branch}`,
        'listBranchPrs',
        'finalize',
      ]);
    },
  );

  it('refuses, and never pushes, a present branch ending in whitespace at a different head', async () => {
    const branch = `${BRANCH}\u00a0`;
    const { events, recover } = harness(call(0, `${OTHER}\trefs/heads/${branch}\n`), branch);
    await expect(recover()).rejects.toMatchObject({
      kind: 'ValueError',
      message: REFUSE_BRANCH_DIFFERS,
    });
    expect(events).toEqual([`git ls-remote --heads origin refs/heads/${branch}`, 'listBranchPrs']);
  });

  it.each([
    ['a failed Git process', call(128, '', 'fatal: unable to access remote'), 'RuntimeError'],
    ['a spawn failure', call(null, '', 'spawn git ENOENT'), 'OSError'],
    ['the time bound', call(null, '', 'timed out'), 'OSError'],
  ] as const)('stops before any other read or effect on %s', async (_name, reply, kind) => {
    const { events, recover } = harness(reply);
    await expect(recover()).rejects.toMatchObject({ kind });
    // Nothing was read after the remote read failed, and nothing was pushed or finalized:
    // a failure is never the empty listing of an absent branch.
    expect(events).toEqual([LS]);
  });

  it('stops on an unreadable listing instead of reading it as an absent branch', async () => {
    const { events, recover } = harness(call(0, new Uint8Array([0xff, 0xfe])));
    await expect(recover()).rejects.toMatchObject({ kind: 'ValueError' });
    expect(events).toEqual([LS]);
  });
});
