// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the gh call-log assertions (mutations, PR-object reads,
// pushes, the composed worktree push argv).
import { flagValue } from './review-loop.argv.js';
import { COORDS, HEAD_REF, SHA } from './review-loop.fixtures.js';

/** Count of recorded git push invocations. */
export const gitLogPushes = (gitLog: string[][]): number =>
  gitLog.filter((args) => args[2] === 'push').length;

/** Gh mutation argv: a REST POST or the resolveReviewThread graphql mutation. */
export const isGhMutation = (args: string[]): boolean => {
  if (args.includes('-X')) {
    return true;
  }
  return flagValue(args, 'query').includes('resolveReviewThread');
};

/** Indexes of the PR-object reads — snapshotPrState always starts there. */
export const prReadIndexes = (ghLog: string[][]): number[] =>
  ghLog
    .map((args, index) =>
      args[0] === 'api' &&
      args[1] === `repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}`
        ? index
        : -1,
    )
    .filter((index) => index >= 0);

export const firstMutationIndex = (ghLog: string[][]): number =>
  ghLog.findIndex((args) => isGhMutation(args));

/** The composed worktree push argv the loop must use (clarified pattern). */
export const expectedPushArgs = (
  worktreePath: string,
  target = 'origin',
  expected = SHA,
): string[] => [
  '-C',
  worktreePath,
  'push',
  `--force-with-lease=refs/heads/${HEAD_REF}:${expected}`,
  target,
  `${SHA}:refs/heads/${HEAD_REF}`,
];
