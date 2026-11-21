/**
 * Offline fixture repository for merge-tree credit tests: one published repair
 * and the four ways a forge merge commit can relate to it. No network, no
 * forge; every commit is a local object in a throwaway repository.
 */
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { scrubbedGitEnv } from './git-env.js';

const BASE_TEXT = 'l1 old\nl2\nl3\nl4\nl5 tail\n';
const FIXED_TEXT = 'l1 fixed\nl2\nl3\nl4\nl5 tail\n';
const TARGET_TEXT = 'l1 old\nl2\nl3\nl4\nl5 target change\n';
const BOTH_TEXT = 'l1 fixed\nl2\nl3\nl4\nl5 target change\n';
const REVERTED_TEXT = 'l1 old\nl2\nl3\nl4\nl5 target change\n';

export interface MergeTreeRepo {
  readonly dir: string;
  readonly path: string;
  readonly base: string;
  /** The PR head, and the commit the repair was published at. */
  readonly published: string;
  /** Target tip before any merge: advanced past `base` by an unrelated change. */
  readonly target: string;
  /** `--no-ff` merge of `published` into `target`: the repair is in the tree. */
  readonly kept: string;
  /** `-s ours` merge: contains `published` as an ancestor but its tree drops the repair. */
  readonly dropped: string;
  /** Single-parent commit carrying the repair; `published` is not its ancestor. */
  readonly squashed: string;
  /** A kept merge followed by a commit that reverts the repaired line. */
  readonly reverted: string;
  /** A reachable commit with no relation to the repair: just the target tip. */
  readonly wrong: string;
  /** Well-formed object id that no object in the repository has. */
  readonly unreachable: string;
  git(...args: string[]): string;
  cleanup(): Promise<void>;
}

export async function createMergeTreeRepo(): Promise<MergeTreeRepo> {
  const dir = await mkdtemp(join(tmpdir(), 'crq-merge-tree-'));
  const git = (...args: string[]): string =>
    execFileSync(
      'git',
      [
        '-C',
        dir,
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
      { encoding: 'utf8', env: scrubbedGitEnv() },
    ).trim();
  const commit = async (content: string, message: string): Promise<string> => {
    await writeFile(join(dir, 'src', 'app.ts'), content);
    git('add', 'src/app.ts');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    git('init', '-q', '--object-format=sha1');
    await mkdir(join(dir, 'src'));
    const base = await commit(BASE_TEXT, 'base');
    const published = await commit(FIXED_TEXT, 'published repair');
    git('checkout', '-q', '--detach', base);
    const target = await commit(TARGET_TEXT, 'unrelated target change');
    git('merge', '-q', '--no-ff', '-m', 'Keep repair', published);
    const kept = git('rev-parse', 'HEAD');
    const reverted = await commit(REVERTED_TEXT, 'later revert of the repaired line');
    git('checkout', '-q', '--detach', target);
    git('merge', '-q', '--no-ff', '-s', 'ours', '-m', 'Drop repair', published);
    const dropped = git('rev-parse', 'HEAD');
    git('checkout', '-q', '--detach', target);
    const squashed = await commit(BOTH_TEXT, 'Squash repair');
    return {
      dir,
      path: 'src/app.ts',
      base,
      published,
      target,
      kept,
      dropped,
      squashed,
      reverted,
      wrong: target,
      unreachable: '9'.repeat(40),
      git,
      cleanup: () => rm(dir, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}
