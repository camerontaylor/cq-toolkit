// Thread settle gate (PR #336 incident): the loopReplyVerdict mechanics and
// the idempotence pins — one answer per thread and head, round binding,
// re-open triggers, and the reply stamps. The describe wrapper is
// reproduced from the pre-split review-loop.test.ts so every test's full
// title path stays byte-identical.
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../src/driver/types.js';
import {
  loopReplyVerdict,
  REPLY_RESOLVE_MARKER,
  replyHeadStamp,
  replySignature,
  settleRound,
} from '../../src/plans/review-loop.js';
import {
  actionableThread,
  answerOnce,
  BEFORE_SHA,
  completeWorker,
  DISPOSITION,
  fixLine,
  isGhMutation,
  iso,
  LOOP_LOGIN,
  loopReply,
  OLD_HEAD,
  postedBodies,
  reply,
  restComment,
  REPLY_AGE,
  root,
  runLoop,
  settleWorld,
  SIG,
} from './review-loop.helpers.js';

describe('thread settle gate (PR #336 incident)', () => {
  test('loopReplyVerdict: latest word, timestamp, author, round, head and header decide', () => {
    const ROOT = 'Fix src/a.ts at 3.';
    const thread = (replies: ReturnType<typeof reply>[]) => ({ id: 'T1', body: ROOT, replies });
    // The round the posting run answered: the thread with no replies yet.
    const header = `${SIG}\n${replyHeadStamp(BEFORE_SHA, settleRound({ id: 'T1', body: ROOT }, []))}`;
    const stamped = `${header}\n\n${DISPOSITION}`;
    const marked = `${header}\n${REPLY_RESOLVE_MARKER}\n\nGuarded the abort.`;
    const base = { signature: SIG, headSha: BEFORE_SHA, ownLogin: null };
    const verdict = (
      replies: ReturnType<typeof reply>[],
      over: Partial<Parameters<typeof loopReplyVerdict>[1]> = {},
    ) => loopReplyVerdict(thread(replies), { ...base, ...over });
    const settled = { kind: 'settled', carryResolve: false };
    const stale = { kind: 'stale' };
    const unproven = { kind: 'unproven' };

    // Rejection carry is stricter than silence: authenticate current head AND round.
    expect(verdict([reply(stamped)], { requireCurrentIdentity: true })).toEqual(unproven);
    expect(
      verdict([reply(stamped)], {
        requireCurrentIdentity: true,
        ownLogin: LOOP_LOGIN,
        headSha: null,
      }),
    ).toEqual(unproven);
    expect(
      verdict([reply(`${SIG}\n\nlegacy`)], { requireCurrentIdentity: true, ownLogin: LOOP_LOGIN }),
    ).toEqual(unproven);
    expect(
      verdict([reply(stamped)], { requireCurrentIdentity: true, ownLogin: LOOP_LOGIN }),
    ).toEqual(settled);
    expect(
      verdict([reply(marked)], { requireCurrentIdentity: true, ownLogin: LOOP_LOGIN }),
    ).toEqual({ kind: 'settled', carryResolve: true });
    expect(verdict([])).toEqual(unproven);
    expect(verdict([reply(stamped)])).toEqual(settled);
    expect(verdict([reply(stamped)], { headSha: BEFORE_SHA.toUpperCase() })).toEqual(settled);
    // Another head: the loop answers again, once.
    expect(verdict([reply(stamped)], { headSha: OLD_HEAD })).toEqual(stale);
    // Unknown current head: silence, never a mutation.
    expect(verdict([reply(marked)], { headSha: null, ownLogin: LOOP_LOGIN })).toEqual(settled);
    // A legacy reply binds nothing: only the KNOWN identity's authorship proves it.
    expect(verdict([reply(`${SIG}\n\nplaceholder`)], { ownLogin: LOOP_LOGIN })).toEqual(settled);
    expect(verdict([reply(`${SIG}\n\nplaceholder`)])).toEqual(unproven);
    expect(
      verdict([reply(`${SIG}\n\nplaceholder`, iso(REPLY_AGE), 'mallory')], {
        ownLogin: LOOP_LOGIN,
      }),
    ).toEqual(unproven);
    // Reviewer input after the loop's reply: the reply is no longer the latest word.
    expect(verdict([reply(stamped), reply('Still wrong.', iso(1), 'reviewer')])).toEqual(unproven);
    // Feedback that landed before the reply but after the posting run's fetch.
    expect(verdict([reply('Also EBUSY.', iso(REPLY_AGE + 1), 'reviewer'), reply(stamped)])).toEqual(
      stale,
    );
    // An undated latest reply is not provably the latest word.
    expect(verdict([reply(stamped, null)])).toEqual(unproven);
    // Another PR's signature is not this loop's word.
    expect(verdict([reply(replySignature('octo', 'widget', 8))])).toEqual(unproven);
    // With the identity known, only the loop's own reply settles or carries.
    expect(verdict([reply(stamped)], { ownLogin: LOOP_LOGIN.toUpperCase() })).toEqual(settled);
    expect(verdict([reply(marked, iso(REPLY_AGE), 'mallory')], { ownLogin: LOOP_LOGIN })).toEqual(
      unproven,
    );
    expect(verdict([reply(marked)], { ownLogin: LOOP_LOGIN })).toEqual({
      kind: 'settled',
      carryResolve: true,
    });
    // Without the identity a marked reply is answered again (no stranded resolve).
    expect(verdict([reply(marked)])).toEqual(stale);
    // The marker counts only in the header, never quoted in the summary.
    expect(
      verdict([reply(`${header}\n\nQuoted ${REPLY_RESOLVE_MARKER}\n${REPLY_RESOLVE_MARKER}`)], {
        ownLogin: LOOP_LOGIN,
      }),
    ).toEqual(settled);
  });

  test('the incident: run 1 answers once; with its reply re-fetched, run 2 dispatches nothing (fresh dispatch log)', async () => {
    const body = await answerOnce();
    expect(body).toMatch(
      new RegExp(`^${SIG}\\n<!-- cq-review-loop-head:${BEFORE_SHA} round:[0-9a-f]{8} -->\\n\\n`),
    );
    // GitHub now serves the posted reply as the thread's latest word. The
    // dispatch log is NOT shared (a lost runner cache): the gate reads the
    // reply itself — with and without the loop identity configured.
    for (const responderLogin of [undefined, LOOP_LOGIN]) {
      const world = settleWorld();
      world.pullsComments = [root(), loopReply(body)];
      const ghLog: string[][] = [];
      const invocations: OpInvocation[] = [];
      const { outcome } = await runLoop(world, {
        driverResults: [],
        ghLog,
        invocations,
        ...(responderLogin !== undefined ? { responderLogin } : {}),
      });
      expect(invocations).toHaveLength(0);
      expect(outcome.plan.jobs).toEqual([]);
      expect(outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
      expect(outcome.actionsPosted).toBe(0);
      expect(ghLog.filter((args) => isGhMutation(args))).toEqual([]);
      expect(outcome.status).toBe('ok');
    }
  });

  test.each([
    'Reading the anchored code first.',
    'Reading the anchored file first.',
    'Starting work on the reviewed item.',
    'placeholder',
  ])('a legacy UNSTAMPED loop reply %j as the latest word settles the thread', async (live) => {
    const world = settleWorld();
    world.pullsComments = [
      root(),
      restComment(9001, LOOP_LOGIN, `${SIG}\n\nStarting work.`, iso(REPLY_AGE + 2), 101),
      restComment(9002, LOOP_LOGIN, `${SIG}\n\n${live}`, iso(REPLY_AGE), 101),
    ];
    const ghLog: string[][] = [];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [],
      ghLog,
      invocations,
      responderLogin: LOOP_LOGIN,
    });
    expect(invocations).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
    expect(ghLog.filter((args) => isGhMutation(args))).toEqual([]);
  });

  test('feedback that landed between the posting fetch and the post re-opens the thread (round binding)', async () => {
    const body = await answerOnce();
    const world = settleWorld();
    world.pullsComments = [
      root(),
      restComment(9002, 'reviewer', 'Also handle EBUSY.', iso(REPLY_AGE + 30_000), 101),
      loopReply(body),
    ];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, 'Already satisfied: EBUSY is retried at line 3.', [])),
      ],
      responderLogin: LOOP_LOGIN,
    });
    expect(outcome.plan.jobs).toHaveLength(1);
    expect(outcome.actionsPosted).toBe(1);
  });

  test('new reviewer input after the loop reply re-opens the thread for one answer', async () => {
    const body = await answerOnce();
    const world = settleWorld();
    world.pullsComments = [
      root(),
      loopReply(body),
      restComment(9002, 'reviewer', 'It still fails on EBUSY.', iso(REPLY_AGE - 60_000), 101),
    ];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, 'Already satisfied: EBUSY is retried at line 3.', [])),
      ],
    });
    expect(outcome.plan.jobs).toHaveLength(1);
    expect(outcome.actionsPosted).toBe(1);
  });

  test('a new head re-opens a thread answered for an older head; the new reply carries the new stamp', async () => {
    const body = await answerOnce();
    const world = settleWorld();
    world.sha = OLD_HEAD;
    world.pullsComments = [root(), loopReply(body)];
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      ghLog,
    });
    expect(outcome.actionsPosted).toBe(1);
    expect(postedBodies(ghLog)[0]).toContain(`<!-- cq-review-loop-head:${OLD_HEAD} round:`);
  });

  test('an unchanged row is stamped with the worktree head it inspected when the PR head moved after the worktree resolved (PR #343 review)', async () => {
    // resolvePrWorktree saw OLD_HEAD; a push landed before fetchReviewState,
    // which serves BEFORE_SHA. The worker read OLD_HEAD's tree, so the reply
    // must not claim BEFORE_SHA — the next run re-opens against the new head.
    const world = { ...settleWorld(), worktreeHead: OLD_HEAD };
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      ghLog,
    });
    expect(outcome.actionsPosted).toBe(1);
    const body = postedBodies(ghLog)[0] ?? '';
    expect(body).toContain(`<!-- cq-review-loop-head:${OLD_HEAD} round:`);
    expect(body).not.toContain(BEFORE_SHA);

    const rerun = settleWorld(); // the PR head is BEFORE_SHA now
    rerun.pullsComments = [root(), loopReply(body)];
    const invocations: OpInvocation[] = [];
    const { outcome: second } = await runLoop(rerun, {
      driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      invocations,
    });
    expect(second.plan.jobs).toHaveLength(1);
    expect(second.actionsPosted).toBe(1);
  });

  test('a stamp naming the GraphQL head does not settle when the checked-out worktree is newer (PR #343 review)', async () => {
    const body = await answerOnce();
    // GitHub still serves BEFORE_SHA as headRefOid, but resolvePrWorktree
    // already checked out the newly pushed OLD_HEAD tree: compare against it.
    const world = { ...settleWorld(), worktreeHead: OLD_HEAD };
    world.pullsComments = [root(), loopReply(body)];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      invocations,
    });
    expect(outcome.skipped).not.toContainEqual({ id: 'T1', reason: 'loop-replied-this-head' });
    expect(outcome.plan.jobs).toHaveLength(1);
  });

  describe('an edit the dispatch round cannot see re-opens the thread (PR #343 review)', () => {
    // Two prior replies: the dispatch round reads only the LATEST one, so an
    // edit to the root or to the first reply changes no timestamp or body it
    // keys on. The settle round covers the whole thread.
    const reply1 = (text: string) =>
      restComment(9100, 'reviewer', text, iso(REPLY_AGE + 10_000), 101);
    const reply2 = restComment(9101, 'reviewer', 'Still open.', iso(REPLY_AGE + 5000), 101);
    const answerBody = async (): Promise<string> => {
      const world = settleWorld();
      world.pullsComments = [root(), reply1('Please guard line 3.'), reply2];
      const ghLog: string[][] = [];
      await runLoop(world, {
        driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
        ghLog,
      });
      return postedBodies(ghLog)[0] ?? '';
    };

    test('unedited: the reply still settles the thread (control)', async () => {
      const body = await answerBody();
      const world = settleWorld();
      world.pullsComments = [root(), reply1('Please guard line 3.'), reply2, loopReply(body)];
      const { outcome } = await runLoop(world, { driverResults: [] });
      expect(outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
    });

    test('the root comment was edited', async () => {
      const body = await answerBody();
      const world = settleWorld();
      world.threads = [actionableThread('T1', 'src/a.ts', 4, 101)];
      world.pullsComments = [root(), reply1('Please guard line 3.'), reply2, loopReply(body)];
      const { outcome } = await runLoop(world, {
        driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      });
      expect(outcome.plan.jobs).toHaveLength(1);
      expect(outcome.actionsPosted).toBe(1);
    });

    test('the first reply was edited (same id and timestamp)', async () => {
      const body = await answerBody();
      const world = settleWorld();
      world.pullsComments = [
        root(),
        reply1('Please guard line 3 AND line 4.'),
        reply2,
        loopReply(body),
      ];
      const { outcome } = await runLoop(world, {
        driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      });
      expect(outcome.plan.jobs).toHaveLength(1);
    });
  });
});
