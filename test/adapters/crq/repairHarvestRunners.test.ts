// The harvest-shaped sequence (repair_tick.py:605-620) through the bound runners in a
// throwaway local repository: make_worktree('verify-<job>', last) → verify → mechanical →
// remove_worktree. The wrapped ports carry their own Python differentials
// (publicationWorktrees, publicationVerify, repairMechanical); this test pins the binding:
// the verify worktree name and branch, the string-path handle, the `STATE/repair/<job>`
// patch directory and the error classes reaching the harvest seam. Local only.
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RunGit } from '../../../src/adapters/crq/ledgerGit.js';
import { runGitIn } from '../../../src/adapters/crq/publishSource.js';
import { repairHarvestRunners } from '../../../src/adapters/crq/repairHarvestRunners.js';
import type { DetectorRun } from '../../../src/adapters/crq/repairHackDetector.js';
import { isPyError } from '../../../src/queue-runner/pyErrors.js';
import { scrubbedGitEnv } from '../../helpers/git-env.js';

const JOB = 'crq-job-1';
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

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

let root: string;
let clone: string;
let wtRoot: string;
let state: string;
let base: string;
let fixed: string;
let wrongJob: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'crq-runners-')));
  clone = join(root, 'clone');
  wtRoot = join(root, 'wt');
  state = join(root, 'state');
  await mkdir(clone);
  await mkdir(wtRoot);
  await mkdir(join(state, 'repair', JOB), { recursive: true });
  git(clone, 'init', '-q', '--object-format=sha1');
  await writeFile(join(clone, 'a.txt'), 'l1\nl2\n');
  git(clone, 'add', 'a.txt');
  git(clone, 'commit', '-q', '-m', 'base');
  base = git(clone, 'rev-parse', 'HEAD');
  await writeFile(join(clone, 'a.txt'), 'l1 fixed\nl2\n');
  git(clone, 'commit', '-q', '-am', `fix ${JOB}`);
  fixed = git(clone, 'rev-parse', 'HEAD');
  await writeFile(join(clone, 'a.txt'), 'l1 other\nl2\n');
  git(clone, 'commit', '-q', '-am', 'fix crq-job-9');
  wrongJob = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'checkout', '-q', '--detach', fixed);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

const make = (detector?: DetectorRun) =>
  repairHarvestRunners({
    clone,
    worktreeRoot: wtRoot,
    worktreePrefix: 'crq-publish-',
    runGitFor,
    stateRoot: state,
    ...(detector === undefined ? {} : { detector }),
  });

describe('repairHarvestRunners', () => {
  it('runs the harvest sequence: worktree, verify, mechanical, patch, removal', async () => {
    const runners = make();
    const { path, branch } = await runners.makeWorktree(`verify-${JOB}`, fixed);
    expect(path).toBe(join(wtRoot, `crq-publish-verify-${JOB}`));
    expect(branch).toBe(`crq/verify-${JOB}`);
    try {
      await runners.verify(path, base, [fixed], JOB);
      await runners.mechanical(path, base, [fixed], JOB);
      const patch = await readFile(join(state, 'repair', JOB, 'repair.patch'), 'utf8');
      expect(patch).toContain('+l1 fixed');
      expect(patch.endsWith('\n')).toBe(true);
    } finally {
      await runners.removeWorktree(path, branch);
    }
    expect(await exists(path)).toBe(false);
    expect(git(clone, 'branch', '--list', branch)).toBe('');
  });

  it('a range naming another job is a ValueError from verify, before any patch', async () => {
    const runners = make();
    const { path, branch } = await runners.makeWorktree(`verify-${JOB}`, wrongJob);
    try {
      await rm(join(state, 'repair', JOB, 'repair.patch'), { force: true });
      const error = await runners
        .mechanical(path, base, [wrongJob, fixed], JOB)
        .catch((e: unknown) => e);
      expect(isPyError(error, 'ValueError')).toBe(true);
      expect(await exists(join(state, 'repair', JOB, 'repair.patch'))).toBe(false);
    } finally {
      await runners.removeWorktree(path, branch);
    }
  });

  it('a detector rejection is a ValueError and an unavailable one stays retryable', async () => {
    const finding =
      '{"status":"ok","value":[{"kind":"skip","file":"t.test.ts","message":"it.skip"}]}';
    const reject = make(async () => ({ code: 0, stdout: finding, stderr: '' }));
    const down = make(async () => ({ code: 3, stdout: 'not json', stderr: 'boom' }));
    for (const [runners, kind] of [
      [reject, 'ValueError'],
      [down, 'DetectorUnavailable'],
    ] as const) {
      const { path, branch } = await runners.makeWorktree(`verify-${JOB}`, fixed);
      try {
        const error = await runners.mechanical(path, base, [fixed], JOB).catch((e: unknown) => e);
        expect(isPyError(error, kind)).toBe(true);
        expect((error as { kind: string }).kind).toBe(kind);
      } finally {
        await runners.removeWorktree(path, branch);
      }
    }
  });

  it('refuses to remove a worktree it does not own', async () => {
    const error = await make()
      .removeWorktree(join(root, 'elsewhere'), 'crq/verify-x')
      .catch((e: unknown) => e);
    expect(isPyError(error, 'ValueError')).toBe(true);
  });
});
