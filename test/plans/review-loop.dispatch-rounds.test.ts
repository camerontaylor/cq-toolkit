// Dispatch identity and carry: round-versioned keys (slice 9 item 3), the
// journal-only refusal (#363), the carried resolves over responded threads
// (codex P2 jNUCa), the carry authorization (jNfip) and under the single
// identity (PR #343 review), and the already-answered skip (slice 9 item 4).
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { OpInvocation, WorkerResult } from '../../src/driver/types.js';
import {
  completeWorker,
  defaultWorld,
  flagValue,
  fixLine,
  isGhMutation,
  iso,
  markResolved,
  NEW_SHA,
  restComment,
  REPLY_AGE,
  ROOT_AGE,
  runLoop,
  scratchDirs,
  SHA,
} from './review-loop.helpers.js';

describe('round-versioned dispatch keys (slice 9 item 3)', () => {
  test('two rounds → both replies post, each resolve fires once; an exact re-run posts nothing', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-rounds-'));
    scratchDirs.push(scratch);
    const dispatchLogPath = join(scratch, 'dispatch.jsonl');
    const world = defaultWorld();
    world.pullsComments = [
      restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null),
      restComment(201, 'reviewer', 'Round one: also handle EBUSY.', iso(REPLY_AGE), 101),
    ];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed round one.', [NEW_SHA]))],
      dispatchLogPath,
    });
    expect(run1.outcome.status).toBe('ok');
    expect(run1.outcome.actionsPosted).toBe(2);
    const roundOneReply = run1.outcome.reply?.posted[0]?.actionId ?? '';

    // Round two: NEW feedback on the same thread → a NEW fingerprint.
    const world2 = defaultWorld();
    world2.pullsComments = [
      ...world.pullsComments,
      restComment(202, 'reviewer', 'Round two: also handle EACCES.', iso(REPLY_AGE - 1), 101),
    ];
    const run2 = await runLoop(world2, {
      driverResults: [completeWorker(fixLine(true, 'Fixed round two.', [NEW_SHA]))],
      dispatchLogPath,
    });
    expect(run2.outcome.status).toBe('ok');
    expect(run2.outcome.actionsPosted).toBe(2);
    const roundTwoReply = run2.outcome.reply?.posted[0]?.actionId ?? '';
    expect(roundTwoReply).not.toBe(roundOneReply);
    expect(roundTwoReply).toMatch(/^review-loop:7:reply:T1-[0-9a-f]{8}$/);

    // A local receipt is not authenticated current-head evidence. The fake
    // forge deliberately omits both posted replies, so recheck instead of
    // treating the journal as proof that the feedback was answered.
    const invocations: OpInvocation[] = [];
    const run3 = await runLoop(world2, { driverResults: [], invocations, dispatchLogPath });
    expect(run3.outcome.status).toBe('needs-human');
    expect(run3.outcome.plan.jobs).toHaveLength(1);
    expect(invocations).toHaveLength(1);
    expect(run3.outcome.actionsPosted).toBe(0);
  });
});

describe('pending-resolve journal-only refusal (#363)', () => {
  test('a recorded reply missing from the fetched forge state must recheck, never carry its resolve', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-carry-'));
    scratchDirs.push(scratch);
    const dispatchLogPath = join(scratch, 'dispatch.jsonl');
    const world = defaultWorld();
    world.resolveReviewThreadFails = true;
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
      dispatchLogPath,
    });
    expect(run1.outcome.status).toBe('needs-human');
    expect(run1.outcome.reply?.posted.map((record) => record.kind)).toEqual(['review_reply']);
    world.resolveReviewThreadFails = false;
    const invocations: OpInvocation[] = [];
    const run2 = await runLoop(world, { driverResults: [], invocations, dispatchLogPath });
    expect(run2.outcome.status).toBe('needs-human');
    expect(run2.outcome.plan.jobs).toHaveLength(1);
    expect(invocations).toHaveLength(1);
    expect(run2.outcome.actionsPosted).toBe(0);
    expect(run2.ghLog.some((args) => args.some((arg) => arg.includes('mutation Resolve')))).toBe(
      false,
    );
  });
});

describe('carried resolves over responded threads (codex P2 jNUCa)', () => {
  test('reply posted + resolve failed → the next run carries the resolve from the RESPONDED classification; then a full no-op', async () => {
    // The jNUCa shape: the loop's reply is the thread's LATEST word, so the
    // next run classifies the thread 'responded' and planReviewBatch
    // excludes it — the planned-items carry never sees it. The classification
    // walk carries the round-versioned resolve instead: no fix job (the
    // driver is never called), no re-reply, and the thread resolves.
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-carry2-'));
    scratchDirs.push(scratch);
    const dispatchLogPath = join(scratch, 'dispatch.jsonl');
    const world = defaultWorld();
    world.resolveReviewThreadFails = true; // run 1: the reply posts; the resolve fails
    const invocations1: OpInvocation[] = [];
    const ghLog1: string[][] = [];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
      invocations: invocations1,
      ghLog: ghLog1,
      dispatchLogPath,
    });
    expect(run1.outcome.status).toBe('needs-human');
    expect(
      run1.outcome.reasons.some((reason) => reason.includes('dispatch failed (resolve_thread')),
    ).toBe(true);
    expect(run1.outcome.actionsPosted).toBe(1);
    expect(run1.outcome.reply?.posted.map((record) => record.kind)).toEqual(['review_reply']);

    // Run 2: the fetched state shows the loop's reply as the thread's latest
    // word (responder-authored, postdating the feedback) → the thread
    // classifies 'responded' → the carried resolve posts from the
    // classification walk.
    world.resolveReviewThreadFails = false;
    world.sha = SHA; // the fix pushed: the PR head is the stamped head now
    world.pullsComments = [
      restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null),
      // The loop's OWN reply, exactly as run 1 composed it (signature, head
      // stamp, resolve marker), re-fetched under the single-identity
      // deployment (authored by the PR author, who is also the responder) —
      // that is the carry's authorization (jNfip).
      restComment(
        201,
        'prauthor',
        ghLog1.filter((args) => args.includes('-X')).map((args) => flagValue(args, 'body'))[0] ??
          '',
        iso(REPLY_AGE),
        101,
      ),
    ];
    const invocations2: OpInvocation[] = [];
    const run2 = await runLoop(world, {
      driverResults: [],
      invocations: invocations2,
      dispatchLogPath,
      responderLogin: 'prauthor',
    });
    expect(run2.outcome.status).toBe('ok');
    expect(run2.outcome.reasons).toEqual([]);
    expect(run2.outcome.plan.jobs).toEqual([]);
    expect(invocations2).toHaveLength(0);
    expect(run2.outcome.actionsPosted).toBe(1);
    expect(run2.outcome.reply?.posted.map((record) => record.kind)).toEqual(['resolve_thread']);

    // Run 3: the resolve recorded and GitHub serves the thread resolved → a
    // full no-op.
    markResolved(world, 'T1');
    const invocations3: OpInvocation[] = [];
    const run3 = await runLoop(world, {
      driverResults: [],
      invocations: invocations3,
      dispatchLogPath,
      responderLogin: 'prauthor',
    });
    expect(run3.outcome.status).toBe('ok');
    expect(run3.outcome.plan.jobs).toEqual([]);
    expect(invocations3).toHaveLength(0);
    expect(run3.outcome.actionsPosted).toBe(0);
    expect(run3.outcome.reply).toBeUndefined();
  });
});

describe('carried-resolve authorization (jNfip)', () => {
  test('a responded thread whose latest reply is NOT signature-led is NOT carried — nothing dispatches', async () => {
    // The spoof/shape pin for jNfip: a responder-authored plain reply (no
    // leading signature) makes the thread 'responded', but the carry is
    // authorized only by the loop's OWN signature-led reply. Without it the
    // walk refuses — no resolve posts, nothing records; the feedback stays
    // outstanding instead of being closed without a verified fix.
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-auth-'));
    scratchDirs.push(scratch);
    const world = defaultWorld();
    world.resolveReviewThreadFails = false;
    world.pullsComments = [
      restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null),
      restComment(202, 'prauthor', 'Addressed in the pushed commit.', iso(REPLY_AGE), 101),
    ];
    const invocations: OpInvocation[] = [];
    const run = await runLoop(world, {
      driverResults: [],
      invocations,
      dispatchLogPath: join(scratch, 'dispatch.jsonl'),
    });
    expect(run.outcome.status).toBe('ok');
    expect(run.outcome.plan.jobs).toEqual([]);
    expect(invocations).toHaveLength(0);
    expect(run.outcome.actionsPosted).toBe(0);
    expect(run.outcome.reply).toBeUndefined();
  });
});

describe('carried-resolve authorization under the single identity (PR #343 review)', () => {
  const SIG = '<!-- cq-review-loop:octo/widget#7 -->';
  const postedBodies = (ghLog: string[][]): string[] =>
    ghLog.filter((args) => args.includes('-X')).map((args) => flagValue(args, 'body'));
  const root = () => restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null);
  /** Run 1 over T1: returns the exact reply body the loop posted. */
  const answerOnce = async (result: WorkerResult): Promise<string> => {
    const world = defaultWorld();
    world.pullsComments = [root()];
    const ghLog: string[][] = [];
    await runLoop(world, { driverResults: [result], ghLog });
    return postedBodies(ghLog)[0] ?? '';
  };
  /** Run 2: the single-identity world (replies authored by the PR author). */
  const rerun = async (comments: ReturnType<typeof restComment>[], responderLogin?: string) => {
    const world = defaultWorld();
    world.pullsComments = comments;
    const ghLog: string[][] = [];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [],
      ghLog,
      invocations,
      ...(responderLogin !== undefined ? { responderLogin } : {}),
    });
    return { outcome, mutations: ghLog.filter((args) => isGhMutation(args)), invocations };
  };
  const selfReply = (body: string, id = 9001) =>
    restComment(id, 'prauthor', body, iso(REPLY_AGE), 101);

  test('a changed:false reply (no resolve marker) never resolves the thread', async () => {
    const body = await answerOnce(
      completeWorker(fixLine(false, 'Already satisfied: line 3 already guards the case.', [])),
    );
    expect(body).not.toContain('cq-review-loop-resolve');
    for (const responderLogin of [undefined, 'prauthor']) {
      const { mutations, invocations } = await rerun([root(), selfReply(body)], responderLogin);
      expect(mutations).toEqual([]);
      expect(invocations).toHaveLength(0);
    }
  });

  test('a legacy signature-led reply (no stamp, no marker) never resolves the thread', async () => {
    for (const responderLogin of [undefined, 'prauthor']) {
      const { mutations } = await rerun(
        [root(), selfReply(`${SIG}\n\nFixed with a pushed commit.`)],
        responderLogin,
      );
      expect(mutations).toEqual([]);
    }
  });

  // A STALE proof re-plans the thread even though classify calls it
  // 'responded' (the loop shares the PR author's login): the loop answers it
  // again, once, and never resolves it (PR #343 independent review, finding 3).
  const reanswer = async (comments: ReturnType<typeof restComment>[], worktreeHead?: string) => {
    const world = defaultWorld();
    if (worktreeHead !== undefined) world.worktreeHead = worktreeHead;
    world.pullsComments = comments;
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, 'Already satisfied: line 3 already guards the case.', [])),
      ],
      ghLog,
      responderLogin: 'prauthor',
    });
    expect(outcome.plan.jobs).toHaveLength(1);
    expect(outcome.reply?.posted.map((record) => record.kind)).toEqual(['review_reply']);
    return postedBodies(ghLog)[0] ?? '';
  };

  test('a marked reply posted over unseen reviewer input is answered again, not resolved (round binding)', async () => {
    const body = await answerOnce(completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA])));
    expect(body).toContain('cq-review-loop-resolve');
    await reanswer([
      root(),
      restComment(9002, 'reviewer', 'Also handle EBUSY.', iso(REPLY_AGE + 30_000), 101),
      selfReply(body),
    ]);
  });

  test('a marked reply stamped for an older head is answered again, not resolved', async () => {
    const body = await answerOnce(completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA])));
    // The PR moved on: the worktree resolvePrWorktree checked out is at a
    // head the stamp (the pushed SHA) does not name.
    await reanswer([root(), selfReply(body)], 'f40e01550df09310707247bd2cb97b0ac79a5d1b');
  });

  test('an unchanged reply re-opens at a new checked-out head, and the new answer settles it', async () => {
    const NEW_HEAD = 'f40e01550df09310707247bd2cb97b0ac79a5d1b';
    const body = await answerOnce(
      completeWorker(fixLine(false, 'Already satisfied: line 3 already guards the case.', [])),
    );
    const second = await reanswer([root(), selfReply(body)], NEW_HEAD);
    expect(second).toContain(`<!-- cq-review-loop-head:${NEW_HEAD} round:`);
    const world = defaultWorld();
    world.worktreeHead = NEW_HEAD;
    world.pullsComments = [
      root(),
      selfReply(body),
      restComment(9002, 'prauthor', second, iso(REPLY_AGE - 60_000), 101),
    ];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [],
      invocations,
      responderLogin: 'prauthor',
    });
    expect(invocations).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
  });
});

describe('already-answered skip for comment items (slice 9 item 4)', () => {
  test('run 1 answers a comment item; an identical run 2 skips it; new feedback re-opens it', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-comments-'));
    scratchDirs.push(scratch);
    const dispatchLogPath = join(scratch, 'dispatch.jsonl');
    const world = defaultWorld();
    world.threads = []; // ONLY the top-level comment item is actionable
    world.issueComments = [
      {
        id: 555,
        node_id: null,
        user: { login: 'reviewer' },
        body: 'Please also fix the docs.',
        created_at: iso(ROOT_AGE),
      },
    ];

    const run1Invocations: OpInvocation[] = [];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Docs fixed.', [NEW_SHA]))],
      invocations: run1Invocations,
      dispatchLogPath,
    });
    expect(run1.outcome.status).toBe('ok');
    expect(run1.outcome.plan.jobs).toHaveLength(1);
    expect(run1.outcome.actionsPosted).toBe(1);

    const run2Invocations: OpInvocation[] = [];
    const run2 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
      invocations: run2Invocations,
      dispatchLogPath,
    });
    expect(run2.outcome.plan.jobs).toEqual([]);
    expect(run2.outcome.skipped).toEqual([{ id: '555', reason: 'already-answered-this-round' }]);
    expect(run2Invocations).toHaveLength(0); // the driver is never invoked for it
    expect(run2.outcome.actionsPosted).toBe(0);
    expect(run2.outcome.reply).toBeUndefined();

    // NEW feedback (a fresh top-level comment) → a new item → actionable again.
    const world3 = defaultWorld();
    world3.threads = []; // only the comment items are in play
    world3.issueComments = [
      ...world.issueComments,
      {
        id: 556,
        node_id: null,
        user: { login: 'reviewer' },
        body: 'New feedback: also the README.',
        created_at: iso(REPLY_AGE),
      },
    ];
    const run3Invocations: OpInvocation[] = [];
    const run3 = await runLoop(world3, {
      driverResults: [completeWorker(fixLine(true, 'README fixed.', [NEW_SHA]))],
      invocations: run3Invocations,
      dispatchLogPath,
    });
    expect(run3.outcome.status).toBe('ok');
    expect(run3.outcome.plan.jobs).toHaveLength(1);
    expect(run3Invocations).toHaveLength(1);
    expect(run3.outcome.actionsPosted).toBe(1);
  });
});
