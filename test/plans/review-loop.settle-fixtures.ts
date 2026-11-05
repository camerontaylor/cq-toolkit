// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the settle-gate suite's shared fixtures and answers
// (reproduced describe wrappers live in review-loop.settle-gate.test.ts and
// review-loop.settle-outcomes.test.ts).
import { expect } from 'vitest';
import type { ReviewLoopOutcome } from '../../src/plans/review-loop.js';
import { flagValue } from './review-loop.argv.js';
import { completeWorker, fixLine } from './review-loop.contracts.js';
import {
  defaultWorld,
  iso,
  NEW_SHA,
  REPLY_AGE,
  restComment,
  ROOT_AGE,
  SHA,
  type LoopWorld,
} from './review-loop.fixtures.js';
import { runLoop } from './review-loop.runner.js';

export const settleWorld = (): LoopWorld => ({ ...defaultWorld(), worktreeFollowsOrigin: true });
/** A world whose fix run publishes: the worktree advances to SHA after the pre-fix read. */
export const publishedWorld = (): LoopWorld => ({
  ...settleWorld(),
  worktreeAdvancesAt: 2,
  worktreeAdvancesTo: SHA,
  revListShas: [NEW_SHA],
});
export const LOOP_LOGIN = 'cq-automation[bot]';
export const SIG = '<!-- cq-review-loop:octo/widget#7 -->';
export const OLD_HEAD = 'f40e01550df09310707247bd2cb97b0ac79a5d1b';
export const DISPOSITION = 'Already satisfied: src/a.ts line 3 already guards the case.';
export const reply = (
  body: string,
  createdAt: string | null = iso(REPLY_AGE),
  authorLogin: string = LOOP_LOGIN,
) => ({ authorLogin, body, createdAt });
export const postedBodies = (ghLog: string[][]): string[] =>
  ghLog.filter((args) => args.includes('-X')).map((args) => flagValue(args, 'body'));
export const postedKinds = (outcome: ReviewLoopOutcome): string[] =>
  outcome.reply?.posted.map((record) => record.kind) ?? [];
export const root = () => restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null);
export const loopReply = (body: string, id = 9001, login = LOOP_LOGIN) =>
  restComment(id, login, body, iso(REPLY_AGE), 101);
/** Run 1 over T1 with no replies: the loop posts one answer; returns its body. */
export const answerOnce = async (summary = DISPOSITION): Promise<string> => {
  const world = settleWorld();
  world.pullsComments = [root()];
  const ghLog: string[][] = [];
  const { outcome } = await runLoop(world, {
    driverResults: [completeWorker(fixLine(false, summary, []))],
    ghLog,
  });
  expect(outcome.actionsPosted).toBe(1);
  return postedBodies(ghLog)[0] ?? '';
};
