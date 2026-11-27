// Shared fixtures for the merge-head-evidence differential tests: one synthetic
// Git environment, the Python oracle runner, a disposable local `Repo` and the
// `bothOutcomes` comparison. Local repositories only: no network, forge, provider
// or remote write; every fixture is made with plain `git`.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunGit } from '../../src/adapters/crq/ledgerGit.js';
import { runGitIn } from '../../src/adapters/crq/publishSource.js';
import {
  mergeHeadEvidence,
  type MergeHeadInput,
} from '../../src/ops/crq/internal/mergeHeadEvidence.js';
import { scrubbedGitEnv } from './git-env.js';
import { pythonAvailable } from './pythonOracle.js';

export const PATH = 'src/app.ts';
const ORACLE = fileURLToPath(new URL('./mergeHeadEvidenceOracle.py', import.meta.url));
const APPS = fileURLToPath(new URL('../../apps/crq-python', import.meta.url));

// One synthetic Git environment for fixtures, the Python oracle and the TS runner.
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
  (dir: string): RunGit =>
  (args, options) =>
    runGitIn(dir)(args, { ...options, env: { ...GIT_ENV, ...options?.env } });

export interface Outcome {
  ok?: unknown;
  error?: string;
  message?: string;
}
export function oracle(cases: readonly unknown[]): Outcome[] {
  const stdout = execFileSync('python3', ['-I', ORACLE, APPS], {
    input: JSON.stringify({ cases }),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { PATH: process.env.PATH ?? '', ...GIT_ENV },
  });
  return (JSON.parse(stdout) as { results: Outcome[] }).results;
}
// Round-trip so TS `undefined` fields compare like absent JSON keys.
const plain = (value: unknown): unknown => JSON.parse(JSON.stringify(value));

/** A fixture repository whose history is built by named commits of one source file. */
export class Repo {
  private constructor(
    readonly dir: string,
    readonly state: string,
  ) {}
  static async create(): Promise<Repo> {
    const root = await mkdtemp(join(tmpdir(), 'crq-line-location-'));
    const dir = join(root, 'clone');
    const state = join(root, 'state');
    await mkdir(join(dir, 'src'), { recursive: true });
    await mkdir(join(state, 'repair/inbox'), { recursive: true });
    await writeFile(
      join(state, 'repair/inbox/job1.json'),
      JSON.stringify({ job: 'job1', finding: { path: PATH } }),
    );
    const repo = new Repo(dir, state);
    repo.git('init', '-q', '--object-format=sha1');
    return repo;
  }
  git(...args: string[]): string {
    return execFileSync(
      'git',
      ['-C', this.dir, '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args],
      {
        encoding: 'utf8',
        env: { ...scrubbedGitEnv(), ...GIT_ENV },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    ).trim();
  }
  /** Commit `text` as the source on top of the checked-out commit. */
  async commit(text: string | Buffer, message: string): Promise<string> {
    await writeFile(join(this.dir, PATH), text);
    this.git('add', PATH);
    this.git('commit', '-q', '--allow-empty', '-m', message);
    return this.git('rev-parse', 'HEAD');
  }
  checkout(commit: string): void {
    this.git('checkout', '-q', '-f', '--detach', commit);
  }
  /** `--no-ff` merge of `side` into the checked-out commit; `ours` drops the side's tree. */
  merge(side: string, ours = false): string {
    this.git('merge', '-q', '--no-ff', ...(ours ? ['-s', 'ours'] : []), '-m', 'merge', side);
    return this.git('rev-parse', 'HEAD');
  }
  async cleanup(): Promise<void> {
    await rm(dirname(this.dir), { recursive: true, force: true });
  }
}

export interface Scenario {
  published: string;
  /** The PR head the forge reports; defaults to `published`. */
  actual?: string;
  /** The forge merge commit whose tree must keep the repair. */
  merge?: string;
  commits?: string[];
}
const inputOf = (s: Scenario): MergeHeadInput => ({
  published: s.published,
  actual: s.actual ?? s.published,
  commits: s.commits ?? [s.published],
  anchors: [PATH],
  ...(s.merge === undefined ? {} : { merge: s.merge }),
});

export async function tsOutcome(repo: Repo, s: Scenario): Promise<Outcome> {
  try {
    return { ok: plain(await mergeHeadEvidence(inputOf(s), runGitFor(repo.dir))) };
  } catch (error) {
    return { error: 'ValueError', message: error instanceof Error ? error.message : String(error) };
  }
}
/** Both implementations on the same repository; returns `[python, ts]`. */
export async function bothOutcomes(
  repo: Repo,
  scenarios: readonly Scenario[],
): Promise<[Outcome[], Outcome[]]> {
  const python = oracle(
    scenarios.map((s) => ({
      op: 'evidence',
      clone: repo.dir,
      state: repo.state,
      published: s.published,
      commits: s.commits ?? [s.published],
      actual: s.actual ?? s.published,
      merge: s.merge ?? null,
    })),
  ).map((o) => ({ ...o, ...(o.error ? { error: 'ValueError' } : {}) }));
  const ts = await Promise.all(scenarios.map((s) => tsOutcome(repo, s)));
  return [python, ts];
}

export const lines = (...rows: string[]): string => rows.join('\n') + '\n';
export const pythonOk = pythonAvailable();
