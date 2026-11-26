// Differential run: the same throwaway local repositories through Python's real
// `crq_repair.mechanical` (the content gate `repair_tick.harvest` runs over a
// fixer's claimed commits; oracle: test/helpers/repairMechanicalOracle.py, with
// only the `node ... gates.hackDetector` process replaced by a declared triple)
// and the TS port. The returned record, the exception class and text, the diff
// text each detector call received, and the written `repair.patch` must be equal.
// Local repositories only: no remote, forge, provider or service.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import {
  gitRepairMechanical,
  type RepairMechanical,
} from '../../../src/adapters/crq/repairMechanical.js';
import type { DetectorProcess, DetectorRun } from '../../../src/adapters/crq/repairHackDetector.js';
import { PyError } from '../../../src/queue-runner/pyErrors.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';
import { oraclePython } from '../../helpers/oraclePython.js';

const ORACLE = fileURLToPath(new URL('../../helpers/repairMechanicalOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../../apps/crq-python', import.meta.url));
const JOB = 'crq-job-1';
const cleanups: string[] = [];

const GIT_ENV: Record<string, string> = {
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

const runGitFor =
  (repo: string): RunGit =>
  (args, options) =>
    runGitIn(repo)(args, { ...options, env: { ...GIT_ENV, ...options?.env } });

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

const okJson = '{"status":"ok","value":[]}';
const CLEAN: DetectorProcess = { code: 0, stdout: okJson, stderr: '' };
const FINDING: DetectorProcess = {
  code: 0,
  stdout: '{"status":"ok","value":[{"kind":"skip","file":"t.test.ts","message":"it.skip"}]}',
  stderr: '',
};
const GARBAGE: DetectorProcess = { code: 3, stdout: 'not json', stderr: 'boom' };

interface Fixture {
  root: string;
  clone: string;
  wtRoot: string;
  base: string;
  work: Map<string, { path: string; commit: string }>;
}

async function makeFixture(): Promise<Fixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'crq-mech-')));
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
  git(clone, 'checkout', '-q', '--detach', base);
  const work = new Map<string, { path: string; commit: string }>();
  const make = async (name: string, content: string | Buffer, message = `fix ${JOB}`) => {
    const path = join(wtRoot, `crq-publish-${name}`);
    git(clone, 'worktree', 'add', '-q', '--detach', path, base);
    await writeFile(join(path, 'a.txt'), content);
    git(path, 'add', 'a.txt');
    git(path, 'commit', '-q', '-m', message);
    work.set(name, { path, commit: git(path, 'rev-parse', 'HEAD') });
    return path;
  };
  await make('good', 'l1 fixed\nl2\nl3\n');
  await make('trailing-ws', 'l1\nl2\nl3   \n');
  await make('trailing-blank', 'l1\nl2\nl3\n\n\n');
  await make('crlf', 'l1\r\nl2 fixed\r\nl3\r\n');
  await make('lone-cr', 'l1\rl2 fixed\nl3\n');
  await make('unicode', 'l1 café ☃ \u{1f600}\nl2\nl3\n');
  await make('latin1', Buffer.from('l1 caf\xe9\nl2\nl3\n', 'latin1'));
  await make('nul', Buffer.from('l1\0l2\nl3\n'));
  await make('big', `${'x'.repeat(130_000)}\n`);
  await make('wrong-job', 'l1 fixed\nl2\nl3\n', 'fix crq-job-9');
  const dirty = await make('dirty', 'l1 d\nl2\nl3\n');
  await writeFile(join(dirty, 'stray.txt'), 'stray\n');
  return { root, clone, wtRoot, base, work };
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
  calls: string[];
  patch: string | null;
}
interface Case {
  name: string;
  work: string;
  detector: DetectorProcess;
  /** Defaults to the fixture base. */
  base?: string;
  /** Defaults to the work's commit. */
  commits?: (commit: string) => string[];
  /** `missing`: a directory that does not exist (same path on both sides); `file`: a regular file. */
  dir?: 'missing' | 'file';
}

/** Python classes whose TypeScript spelling is a PyError kind of the same family. */
const FAMILY: Record<string, string> = {
  UnicodeDecodeError: 'ValueError',
  NotADirectoryError: 'OSError',
  DetectorRejection: 'ValueError',
};
const OPAQUE = new Set(['UnicodeDecodeError']);

async function dirsFor(item: Case, tag: string): Promise<string> {
  const dir = join(fx.root, `out-${tag}-${item.name.replace(/\W+/g, '-')}`);
  if (item.dir === 'missing') return join(fx.root, 'no-such-dir', 'x');
  if (item.dir === 'file') {
    // One shared path: nothing is written through it, and the error text names it.
    const shared = join(fx.root, 'not-a-directory');
    await writeFile(shared, 'a file, not a directory');
    return shared;
  }
  await mkdir(dir);
  return dir;
}

function runPython(items: Case[], dirs: string[]): Outcome[] {
  const cases = items.map((item, index) => {
    const work = fx.work.get(item.work)!;
    return {
      wt: work.path,
      base: item.base ?? fx.base,
      commits: item.commits?.(work.commit) ?? [work.commit],
      job: JOB,
      dir: dirs[index],
      detector: item.detector,
    };
  });
  const stdout = execFileSync(oraclePython(), ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', ...GIT_ENV },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}

async function runTs(item: Case, dir: string): Promise<Outcome> {
  const calls: string[] = [];
  const detector: DetectorRun = async (diff) => {
    calls.push(diff);
    return item.detector;
  };
  const mech: RepairMechanical = gitRepairMechanical({
    clone: fx.clone,
    worktreeRoot: fx.wtRoot,
    runGitFor,
    repairDirectory: () => dir,
    detector,
  });
  const work = fx.work.get(item.work)!;
  const out: Outcome = { calls, patch: null };
  try {
    out.ok = await mech.mechanical(
      { path: work.path },
      item.base ?? fx.base,
      item.commits?.(work.commit) ?? [work.commit],
      JOB,
    );
  } catch (error) {
    out.error =
      error instanceof PyError ? error.kind : error instanceof Error ? error.name : 'unknown';
    out.message = error instanceof Error ? error.message : String(error);
  }
  try {
    out.patch = await readFile(join(dir, 'repair.patch'), 'utf8');
  } catch {
    out.patch = null;
  }
  return out;
}

describe('repair mechanical: Python differential', () => {
  const cases = (): Case[] => [
    { name: 'a clean repair passes', work: 'good', detector: CLEAN },
    {
      name: 'trailing whitespace is stripped from the patch and the scan',
      work: 'trailing-ws',
      detector: CLEAN,
    },
    { name: 'trailing blank lines are stripped', work: 'trailing-blank', detector: CLEAN },
    { name: 'CRLF becomes LF through universal newlines', work: 'crlf', detector: CLEAN },
    { name: 'a lone CR becomes LF', work: 'lone-cr', detector: CLEAN },
    { name: 'non-ASCII UTF-8 content', work: 'unicode', detector: CLEAN },
    { name: 'non-UTF-8 diff bytes are a decode failure', work: 'latin1', detector: CLEAN },
    { name: 'a NUL byte makes git call the file binary', work: 'nul', detector: CLEAN },
    { name: 'an oversized diff is written but never scanned', work: 'big', detector: CLEAN },
    {
      name: 'a detector finding rejects after the patch is written',
      work: 'good',
      detector: FINDING,
    },
    {
      name: 'an unreadable detector is an outage after the patch is written',
      work: 'good',
      detector: GARBAGE,
    },
    {
      name: 'a detector exit code rejects a clean-looking verdict',
      work: 'good',
      detector: { ...CLEAN, code: 1 },
    },
    {
      name: 'a commit that does not name the job fails verify: no patch, no scan',
      work: 'wrong-job',
      detector: CLEAN,
    },
    { name: 'a dirty tree fails verify: no patch, no scan', work: 'dirty', detector: CLEAN },
    {
      name: 'an unclaimed range fails verify',
      work: 'good',
      detector: CLEAN,
      commits: () => [fx.base],
    },
    { name: 'no claimed commits', work: 'good', detector: CLEAN, commits: () => [] },
    {
      name: 'a missing repair directory fails after the diff, before the scan',
      work: 'good',
      detector: CLEAN,
      dir: 'missing',
    },
    { name: 'a repair directory that is a file', work: 'good', detector: CLEAN, dir: 'file' },
  ];

  it('matches Python on every case (record, error, detector input, patch)', async () => {
    const items = cases();
    const pyDirs = await Promise.all(items.map((item) => dirsFor(item, 'py')));
    const tsDirs = await Promise.all(items.map((item) => dirsFor(item, 'ts')));
    const expected = runPython(items, pyDirs);
    for (const [index, item] of items.entries()) {
      const got = await runTs(item, tsDirs[index]!);
      const want = expected[index]!;
      const label = item.name;
      const family = want.error === undefined ? undefined : (FAMILY[want.error] ?? want.error);
      expect(got.error, label).toBe(family);
      if (want.error === undefined) expect(got.ok, label).toEqual(want.ok);
      else if (!OPAQUE.has(want.error)) expect(got.message, label).toBe(want.message);
      expect(got.calls, label).toEqual(want.calls);
      expect(got.patch, label).toEqual(want.patch);
    }
  });

  it('the cases reach both outcomes and the traps are really exercised', async () => {
    const items = cases();
    const dirs = await Promise.all(items.map((item) => dirsFor(item, 'chk')));
    const results = runPython(items, dirs);
    const byName = new Map(items.map((item, i) => [item.name, results[i]!] as const));
    expect(byName.get('a clean repair passes')!.ok).toEqual({
      verify: 'ok',
      hack: 'ok',
      tests: 'suspended',
    });
    const ws = byName.get('trailing whitespace is stripped from the patch and the scan')!;
    expect(ws.patch!.endsWith('+l3\n')).toBe(true);
    expect(ws.calls[0]!.endsWith('+l3')).toBe(true);
    expect(byName.get('an oversized diff is written but never scanned')!.calls).toEqual([]);
    expect(byName.get('an oversized diff is written but never scanned')!.patch).not.toBeNull();
    expect(
      byName.get('a missing repair directory fails after the diff, before the scan')!.error,
    ).toBe('FileNotFoundError');
    expect(byName.get('a dirty tree fails verify: no patch, no scan')!.patch).toBeNull();
    expect(byName.get('non-UTF-8 diff bytes are a decode failure')!.error).toBe(
      'UnicodeDecodeError',
    );
  });
});
