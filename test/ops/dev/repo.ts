// Real-git harness for the dev-family op tests: a throwaway work repo with
// a bare `origin` holding `merge-queue`, and effects that run REAL git while
// every other command (the reviewer, pnpm, node, gitleaks) is scripted. The
// tests then pin behaviour — what the ops record and refuse — rather than
// the exact git argv they use.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CommandResult, DevEffects } from '../../../src/ops/dev/effects.js';
import { DEV_LEDGER_VERSION, type DevRecord } from '../../../src/ops/dev/record.js';
import { readWorkState, type WorkState } from '../../../src/ops/dev/internal/workState.js';
import { makeSubprocessDevEffects } from '../../../src/ops/dev/effects.js';
import { checkRecord, cycleRecord, okResult } from './fakes.js';

export interface TestRepo {
  root: string;
  /** Run git in the work repo; returns stdout. */
  git(...args: string[]): string;
  /** Write a repo-relative file (parents created). */
  write(path: string, content: string | Buffer): Promise<void>;
  /** Commit everything currently in the tree. */
  commitAll(message: string): string;
  cleanup(): Promise<void>;
}

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: '/dev/null',
};

/**
 * A repo on branch `feature/x` one commit past `origin/merge-queue` (the
 * base commit holds README.md; the feature commit adds src/a.ts).
 */
export async function makeTestRepo(
  options: { objectFormat?: 'sha1' | 'sha256' } = {},
): Promise<TestRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'cq-dev-repo-'));
  const root = join(dir, 'work');
  const origin = join(dir, 'origin.git');
  await mkdir(root);
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', env: GIT_ENV });
  const write = async (path: string, content: string | Buffer): Promise<void> => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  const commitAll = (message: string): string => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const formatArgs = options.objectFormat ? [`--object-format=${options.objectFormat}`] : [];
  execFileSync('git', ['init', '-q', ...formatArgs, '--bare', origin], { env: GIT_ENV });
  git('init', '-q', ...formatArgs, '-b', 'main');
  await write('README.md', '# fixture\n');
  commitAll('base');
  git('remote', 'add', 'origin', origin);
  git('push', '-q', 'origin', 'HEAD:merge-queue');
  git('fetch', '-q', 'origin');
  git('checkout', '-q', '-b', 'feature/x');
  await write('src/a.ts', 'export const a = 1;\n');
  commitAll('feature');
  return { root, git, write, commitAll, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

/** A scripted non-git command: a result, a plain stdout, or undefined (unscripted). */
export type CommandHandler = (
  command: string,
  args: readonly string[],
) => CommandResult | string | undefined | Promise<CommandResult | string | undefined>;

export type RepoEffects = DevEffects & {
  calls: { command: string; args: readonly string[] }[];
  logs: string[];
};

/**
 * Effects over the repo: git runs for real; anything else must be scripted
 * by `handler` (an unscripted command throws, so no test silently spawns a
 * real tool). The host lock is a pass-through and logs stay in memory.
 */
export function repoEffects(
  repo: TestRepo,
  handler: CommandHandler = () => undefined,
  overrides: Partial<DevEffects> = {},
  /** Non-git commands that also run for real (e.g. `tar`). */
  realCommands: readonly string[] = [],
): RepoEffects {
  const real = makeSubprocessDevEffects(repo.root);
  const calls: RepoEffects['calls'] = [];
  const logs: string[] = [];
  return {
    ...real,
    calls,
    logs,
    nowIso: () => '2026-10-18T00:00:00.000Z',
    withHostLock: async (fn) => fn(),
    writeReviewLog: async (_branch, stamp, content) => {
      logs.push(content);
      return `/tmp/fake-cq-dev-review/${stamp}.log`;
    },
    runCommand: async (command, args, opts) => {
      calls.push({ command, args: [...args] });
      const scripted = await handler(command, args);
      if (scripted !== undefined)
        return typeof scripted === 'string' ? okResult(scripted) : scripted;
      if (command === 'git' || realCommands.includes(command))
        return real.runCommand(command, args, opts);
      throw new Error(`unscripted command: ${command} ${args.join(' ')}`);
    },
    ...overrides,
  };
}

/** Seed the branch ledger with a terminal cycle and a green check at the CURRENT state. */
export async function seed(
  target: TestRepo,
  extra: (state: WorkState) => DevRecord[] = () => [],
): Promise<WorkState> {
  const read = await readWorkState(repoEffects(target), { target: 'merge-queue' });
  if (!read.ok) throw new Error(read.reason);
  const { state } = read;
  const at = { base: state.base, head: state.head, dirtySha256: state.dirtySha256 };
  repoEffects(target)
    .openLedger(state.branch)
    .save({
      version: DEV_LEDGER_VERSION,
      branch: state.branch,
      records: [cycleRecord(at), checkRecord(at), ...extra(state)],
    });
  return state;
}
