// Thread settle gate (PR #336 incident), continued: published-fix stamps,
// engine-rejection identity, sibling and evidence verification, the carried
// resolve, and the fix-outcome contract. The describe wrapper is reproduced
// from the pre-split review-loop.test.ts so every test's full title path
// stays byte-identical.
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../src/driver/types.js';
import { evidenceFailure, REPLY_RESOLVE_MARKER } from '../../src/plans/review-loop.js';
import {
  actionableThread,
  answerOnce,
  BEFORE_SHA,
  completeWorker,
  DEFAULT_WORLD_FILES,
  dispositionLine,
  DISPOSITION,
  fixLine,
  isGhMutation,
  legacyFixLine,
  LOOP_LOGIN,
  loopReply,
  markResolved,
  NEW_SHA,
  postedBodies,
  postedKinds,
  publishedWorld,
  root,
  runLoop,
  scratchDirs,
  settleWorld,
  SHA,
} from './review-loop.helpers.js';

describe('evidence verifier defense in depth', () => {
  test('rejects empty and invalid line citations even if a producer bypasses validation', async () => {
    const git = async (args: string[]) => ({
      code: 0,
      stdout: args.includes('-t') ? 'blob' : args.includes('-s') ? '4' : 'line',
      stderr: '',
    });
    expect(await evidenceFailure(git, '/worktree', SHA, [])).toBe('no evidence cited');
    for (const line of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(await evidenceFailure(git, '/worktree', SHA, [{ path: 'src/a.ts', line }])).toContain(
        'not a valid line',
      );
    }
    expect(
      await evidenceFailure(git, '/worktree', SHA, [{ path: 'src/a.ts', line: 1 }]),
    ).toBeNull();
  });
});

describe('thread settle gate (PR #336 incident)', () => {
  test('a marked reply with no dispatch record (lost cache) is looked at again, never silently re-resolved (PR #343 Codex review)', async () => {
    const world = publishedWorld();
    const ghLog1: string[][] = [];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA]))],
      ghLog: ghLog1,
      responderLogin: LOOP_LOGIN,
    });
    expect(postedKinds(run1.outcome)).toEqual(['review_reply', 'resolve_thread']);
    // A reviewer reopened the thread; the runner cache holding run 1's
    // records is gone (a fresh dispatch log per runLoop).
    const rerun = settleWorld();
    rerun.sha = SHA;
    rerun.pullsComments = [root(), loopReply(postedBodies(ghLog1)[0] ?? '')];
    const { outcome } = await runLoop(rerun, {
      driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      responderLogin: LOOP_LOGIN,
    });
    expect(outcome.plan.jobs).toHaveLength(1);
    expect(postedKinds(outcome)).toEqual(['review_reply']);
  });

  test('a thread reopened after its recorded resolve is looked at again (PR #343 review)', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-reopen-'));
    scratchDirs.push(scratch);
    const dispatchLogPath = join(scratch, 'dispatch.jsonl');
    const world = publishedWorld();
    const ghLog1: string[][] = [];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA]))],
      ghLog: ghLog1,
      dispatchLogPath,
      responderLogin: LOOP_LOGIN,
    });
    expect(postedKinds(run1.outcome)).toEqual(['review_reply', 'resolve_thread']);
    // The reviewer pressed "unresolve": the thread is fetched unresolved again
    // with no new comment and the same head, its resolve already recorded.
    const rerun = settleWorld();
    rerun.sha = SHA;
    rerun.pullsComments = [root(), loopReply(postedBodies(ghLog1)[0] ?? '')];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(rerun, {
      driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      invocations,
      dispatchLogPath,
      responderLogin: LOOP_LOGIN,
    });
    expect(outcome.plan.jobs).toHaveLength(1);
    expect(outcome.skipped).not.toContainEqual({ id: 'T1', reason: 'loop-replied-this-head' });
  });

  test('a published fix stamps the worktree head it pushed', async () => {
    const world = publishedWorld();
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA]))],
      ghLog,
    });
    expect(outcome.status).toBe('ok');
    expect(postedBodies(ghLog)[0]).toContain(`<!-- cq-review-loop-head:${SHA} round:`);
  });

  test.each(['malformed', 'unrelated'] as const)(
    'engine rejection identity refuses %s head metadata before forge dispatch',
    async (mode) => {
      const ghLog: string[][] = [];
      const { outcome } = await runLoop(publishedWorld(), {
        engineObservedHead: mode === 'malformed' ? 'not-a-commit' : 'f'.repeat(40),
        driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
        ghLog,
      });
      expect(outcome.status).toBe('needs-human');
      expect(postedBodies(ghLog)).toEqual([]);
      expect(ghLog.filter(isGhMutation)).toEqual([]);
      expect(outcome.reasons.join(' ')).toMatch(/engine execution head/);
    },
  );
  test('an unchanged row beside a sibling that committed is stamped with the head it INSPECTED, not the pushed one', async () => {
    const world = publishedWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T3', 'src/c.ts', 9, 103),
    ];
    world.commitMessages = { [NEW_SHA]: 'Fix review item T3 in src/c.ts' };
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, DISPOSITION, [])),
        completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA])),
      ],
      ghLog,
    });
    expect(outcome.status).toBe('ok');
    const bodies = postedBodies(ghLog);
    expect(bodies.find((body) => body.includes(DISPOSITION))).toContain(
      `<!-- cq-review-loop-head:${BEFORE_SHA} round:`,
    );
    expect(bodies.find((body) => body.includes('Guarded the abort.'))).toContain(
      `<!-- cq-review-loop-head:${SHA} round:`,
    );
  });

  test('a no-outcome sibling does not withhold a verified fix: the fix publishes, replies and resolves; the run is needs-human (PR #343 CodeRabbit cycle)', async () => {
    const world = publishedWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T3', 'src/c.ts', 9, 103),
    ];
    world.commitMessages = { [NEW_SHA]: 'Fix review item T3 in src/c.ts' };
    const ghLog: string[][] = [];
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(dispositionLine('no_outcome', 'Investigating why the test fails.')),
        completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA])),
      ],
      ghLog,
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('no outcome to post'))).toBe(true);
    expect(
      outcome.reasons.some((reason) => reason.includes('publish-withheld-mixed-worktree')),
    ).toBe(false);
    expect(gitLog.some((args) => args.includes('push'))).toBe(true);
    expect(postedKinds(outcome)).toEqual(['review_reply', 'resolve_thread']);
    expect(postedBodies(ghLog)).toHaveLength(1);
    expect(postedBodies(ghLog)[0]).toContain('Guarded the abort.');
  });

  test('unchanged evidence is verified at the head the reply is stamped with, not a sibling commit (PR #343 Codex review)', async () => {
    const world = publishedWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T3', 'src/c.ts', 9, 103),
    ];
    world.commitMessages = { [NEW_SHA]: 'Fix review item T3 in src/c.ts' };
    // Only the sibling's pushed tree has src/new.ts; the inspected head does not.
    world.filesAt = { [SHA]: { ...DEFAULT_WORLD_FILES, 'src/new.ts': 5 } };
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, DISPOSITION, [], [{ path: 'src/new.ts', line: 1 }])),
        completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA])),
      ],
      ghLog,
    });
    expect(outcome.reasons.some((reason) => reason.includes('evidence does not verify'))).toBe(
      true,
    );
    const bodies = postedBodies(ghLog);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain('Guarded the abort.');
  });

  test('#362 a later unchanged worker can cite the already committed sibling it actually observed', async () => {
    const world = publishedWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T3', 'src/c.ts', 9, 103),
    ];
    world.commitMessages = { [NEW_SHA]: 'Fix review item T1 in src/a.ts' };
    world.filesAt = { [SHA]: { ...DEFAULT_WORLD_FILES, 'src/new.ts': 5 } };
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Added sibling evidence.', [NEW_SHA])),
        completeWorker(fixLine(false, DISPOSITION, [], [{ path: 'src/new.ts', line: 1 }])),
      ],
      ghLog,
    });
    expect(outcome.status).toBe('ok');
    const bodies = postedBodies(ghLog);
    expect(bodies).toHaveLength(2);
    expect(bodies.find((body) => body.includes(DISPOSITION))).toContain(
      `<!-- cq-review-loop-head:${SHA} round:`,
    );
  });

  test('a verified fix whose resolve failed: the settled rerun carries ONLY the resolve (own identity), then a full no-op', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-settle-carry-'));
    scratchDirs.push(scratch);
    const dispatchLogPath = join(scratch, 'dispatch.jsonl');
    const world = publishedWorld();
    world.resolveReviewThreadFails = true;
    const ghLog1: string[][] = [];
    const run1 = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA]))],
      ghLog: ghLog1,
      dispatchLogPath,
      responderLogin: LOOP_LOGIN,
    });
    expect(postedKinds(run1.outcome)).toEqual(['review_reply']);
    const [body] = postedBodies(ghLog1);
    expect(body?.split('\n\n')[0]).toContain(REPLY_RESOLVE_MARKER);

    // Run 2: the reply is the thread's latest word for the current head
    // (the stamp names the pushed worktree head) → settled; the marked,
    // own-authored reply carries the failed resolve.
    world.resolveReviewThreadFails = false;
    world.sha = SHA;
    world.pullsComments = [root(), loopReply(body ?? '')];
    const invocations2: OpInvocation[] = [];
    const run2 = await runLoop(world, {
      driverResults: [],
      invocations: invocations2,
      dispatchLogPath,
      responderLogin: LOOP_LOGIN,
    });
    expect(invocations2).toHaveLength(0);
    expect(run2.outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
    expect(postedKinds(run2.outcome)).toEqual(['resolve_thread']);
    // The carried id IS the posting run's resolve id (its round).
    expect(run2.outcome.reply?.posted[0]?.actionId).toBe(
      run1.outcome.reply?.posted[0]?.actionId.replace(':reply:', ':resolve:'),
    );

    // Run 3: the resolve recorded and GitHub serves the thread resolved →
    // nothing dispatches.
    markResolved(world, 'T1');
    const invocations3: OpInvocation[] = [];
    const run3 = await runLoop(world, {
      driverResults: [],
      invocations: invocations3,
      dispatchLogPath,
      responderLogin: LOOP_LOGIN,
    });
    expect(run3.outcome.status).toBe('ok');
    expect(invocations3).toHaveLength(0);
    expect(run3.outcome.actionsPosted).toBe(0);
    expect(run3.outcome.reply).toBeUndefined();
  });

  test('an unreadable checked-out head is unknown: the thread settles in silence and no resolve is carried (PR #343 Codex review)', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-settle-nohead-'));
    scratchDirs.push(scratch);
    const dispatchLogPath = join(scratch, 'dispatch.jsonl');
    const world = publishedWorld();
    world.resolveReviewThreadFails = true;
    const ghLog1: string[][] = [];
    await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort.', [NEW_SHA]))],
      ghLog: ghLog1,
      dispatchLogPath,
      responderLogin: LOOP_LOGIN,
    });
    // Run 2: GraphQL serves the stamped head, but the pre-fix worktree read
    // fails, so the gate cannot prove the head and must not carry the resolve.
    const rerun = settleWorld();
    rerun.sha = SHA;
    rerun.headReadFailsAt = 2;
    rerun.pullsComments = [root(), loopReply(postedBodies(ghLog1)[0] ?? '')];
    const ghLog2: string[][] = [];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(rerun, {
      driverResults: [],
      ghLog: ghLog2,
      invocations,
      dispatchLogPath,
      responderLogin: LOOP_LOGIN,
    });
    expect(invocations).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
    expect(ghLog2.filter((args) => isGhMutation(args))).toEqual([]);
  });

  test('a signature-led reply NOT authored by the loop identity neither settles nor carries', async () => {
    const body = await answerOnce();
    const forged = body.replace('\n\n', `\n${REPLY_RESOLVE_MARKER}\n\n`);
    const world = settleWorld();
    world.pullsComments = [root(), loopReply(forged, 9001, 'mallory')];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
      responderLogin: LOOP_LOGIN,
    });
    expect(outcome.plan.jobs).toHaveLength(1);
    expect(postedKinds(outcome)).toEqual(['review_reply']);
  });

  test('a summary quoting the resolve marker never manufactures resolve intent', async () => {
    const body = await answerOnce(
      `Already satisfied; the reply format ${REPLY_RESOLVE_MARKER} is documented at line 3.`,
    );
    expect(body.split('\n\n')[0]).not.toContain(REPLY_RESOLVE_MARKER);
    const world = settleWorld();
    world.pullsComments = [root(), loopReply(body)];
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [],
      ghLog,
      responderLogin: LOOP_LOGIN,
    });
    expect(outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
    expect(ghLog.filter((args) => isGhMutation(args))).toEqual([]);
  });

  test('an UNCHANGED reply carries no resolve marker', async () => {
    expect(await answerOnce()).not.toContain(REPLY_RESOLVE_MARKER);
  });

  // THE FIX OUTCOME CONTRACT: free text is never judged. A legacy contract
  // without a disposition is no outcome, whatever its summary says: every
  // non-answer from the incident and both independent reviews posts nothing
  // and leaves the thread unsettled.
  test.each([
    'Reading the anchored code first.',
    'placeholder',
    'Starting work.',
    'Reading the anchored code first. Starting work on the reviewed item.',
    'Investigating why the test fails.',
    'I am investigating why no changes are applied.',
    'The investigation of `src/a.ts` is still in progress.',
    'Checking whether `src/a.ts` shows the reported issue.',
    'The next step is to inspect `src/a.ts` before making any changes.',
    'No changes are needed in the guard at `src/a.ts:3`.',
  ])(
    'a legacy free-text answer %j posts NOTHING, records why, and stays unsettled',
    async (live) => {
      const ghLog: string[][] = [];
      const run1 = await runLoop(settleWorld(), {
        driverResults: [completeWorker(legacyFixLine(false, live, []))],
        ghLog,
        responderLogin: LOOP_LOGIN,
      });
      expect(run1.outcome.status).toBe('needs-human');
      expect(run1.outcome.reasons.some((reason) => reason.includes('no outcome to post'))).toBe(
        true,
      );
      expect(run1.outcome.actionsPosted).toBe(0);
      expect(ghLog.filter((args) => isGhMutation(args))).toEqual([]);
      // Nothing was posted, so nothing settles: run 2 dispatches the worker again.
      const invocations: OpInvocation[] = [];
      const run2 = await runLoop(settleWorld(), {
        driverResults: [completeWorker(fixLine(false, DISPOSITION, []))],
        invocations,
        responderLogin: LOOP_LOGIN,
      });
      expect(invocations).toHaveLength(1);
      expect(run2.outcome.actionsPosted).toBe(1);
    },
  );

  test.each([
    ['needs_human', 'A maintainer must choose between the two retry policies.'],
    ['no_outcome', 'Reading the anchored code first.'],
  ])('disposition %s posts NOTHING and leaves the thread unsettled', async (disposition, text) => {
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(settleWorld(), {
      driverResults: [completeWorker(dispositionLine(disposition, text))],
      ghLog,
      responderLogin: LOOP_LOGIN,
    });
    expect(outcome.status).toBe('needs-human');
    expect(
      outcome.reasons.some((reason) => reason.includes(`worker disposition ${disposition}`)),
    ).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(ghLog.filter((args) => isGhMutation(args))).toEqual([]);
  });

  test.each([
    ['no evidence at all', []],
    ['a file that does not exist', [{ path: 'src/zzz.ts', line: 1 }]],
    ['a line past the end of the file', [{ path: 'src/a.ts', line: 99 }]],
    // A directory is no file (PR #343 CodeRabbit cycle on fa64d9b8).
    ['a directory', [{ path: 'src', line: 1 }]],
    // An empty file has no line 1; an oversized file is never buffered (PR #343 Codex review).
    ['line 1 of an empty file', [{ path: 'src/empty.ts', line: 1 }]],
    ['a file too large to verify', [{ path: 'src/huge.ts', line: 1 }]],
  ] as const)(
    'an unchanged answer citing %s posts NOTHING and stays unsettled',
    async (_name, evidence) => {
      const ghLog: string[][] = [];
      const { outcome } = await runLoop(settleWorld(), {
        driverResults: [completeWorker(fixLine(false, DISPOSITION, [], [...evidence]))],
        ghLog,
        responderLogin: LOOP_LOGIN,
      });
      expect(outcome.status).toBe('needs-human');
      expect(outcome.reasons.some((reason) => reason.includes('no outcome to post'))).toBe(true);
      expect(outcome.actionsPosted).toBe(0);
      expect(ghLog.filter((args) => isGhMutation(args))).toEqual([]);
    },
  );

  test('an unchanged answer with verified evidence posts once, shows the evidence, and settles', async () => {
    // The independent review's P2 at c05577e2: a completed "leaving unchanged" disposition.
    const summary =
      'I am leaving `src/a.ts:3` unchanged because its guard already rejects empty input.';
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(settleWorld(), {
      driverResults: [completeWorker(fixLine(false, summary, []))],
      ghLog,
      responderLogin: LOOP_LOGIN,
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(1);
    const body = postedBodies(ghLog)[0] ?? '';
    expect(body).toContain(summary);
    expect(body).toContain('Evidence: `src/a.ts:3`');
    const rerun = settleWorld();
    rerun.pullsComments = [root(), loopReply(body)];
    const invocations: OpInvocation[] = [];
    const second = await runLoop(rerun, {
      driverResults: [],
      invocations,
      responderLogin: LOOP_LOGIN,
    });
    expect(invocations).toHaveLength(0);
    expect(second.outcome.skipped).toEqual([{ id: 'T1', reason: 'loop-replied-this-head' }]);
  });

  test('a future-tense disposition that declines a change posts once (PR #343 independent review, finding 2)', async () => {
    const summary = 'I will make no changes because line 3 already rejects empty input.';
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(settleWorld(), {
      driverResults: [completeWorker(fixLine(false, summary, []))],
      ghLog,
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(1);
    expect(postedBodies(ghLog)[0]).toContain(summary);
  });
});
