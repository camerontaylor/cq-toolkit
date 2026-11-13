// Push targeting: the keyed HEAD:<headRefName> refspec (finding 1) and the
// fork head-repository target (round-3 item 1).
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  AFTER_SHA,
  BEFORE_SHA,
  completeWorker,
  defaultWorld,
  expectedPushArgs,
  fakeGit,
  fixLine,
  HEAD_REF,
  LABEL,
  NEW_SHA,
  SHA,
  runLoop,
  scratchDirs,
} from './review-loop.helpers.js';

// ---------------------------------------------------------------------------
// Round-1 reviewer fixes — keyed push refspec, per-item resolve gate,
// fail-toward-human paths
// ---------------------------------------------------------------------------

describe('push refspec targets the PR head (finding 1)', () => {
  test('the fake advances the served head ONLY for HEAD:<headRefName> pushes', async () => {
    const world = defaultWorld();
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-loop-'));
    scratchDirs.push(scratch);
    const worktreePath = join(scratch, 'pr-7-pr-7-fix');
    const git = fakeGit(world, [], worktreePath);
    // The internal worktree label must NOT move origin's PR head — the
    // pre-fix refspec would have pushed a stray branch and a phantom signal.
    await git(['-C', worktreePath, 'push', 'origin', `HEAD:${LABEL}`]);
    expect(world.sha).toBe(BEFORE_SHA);
    await git(['-C', worktreePath, 'push', 'origin', `HEAD:${HEAD_REF}`]);
    expect(world.sha).toBe(AFTER_SHA);
  });

  test('every composed push argv in a run targets HEAD:<headRefName>', async () => {
    const { gitLog, worktreePath } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    const pushes = gitLog.filter((args) => args[2] === 'push');
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    for (const args of pushes) {
      expect(args).toEqual(expectedPushArgs(worktreePath));
    }
  });
});

// ---------------------------------------------------------------------------
// Round-3 — fork push target, per-item attribution, blocked escalation,
// mixed-worktree publication, truncated context, package surface
// ---------------------------------------------------------------------------

describe('fork push target (round-3 item 1)', () => {
  test('a same-repo PR pushes to origin; a fork PR pushes to the head repository URL', async () => {
    const sameRepo = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    const sameRepoPushes = sameRepo.gitLog.filter((args) => args[2] === 'push');
    expect(sameRepoPushes.length).toBeGreaterThanOrEqual(1);
    for (const args of sameRepoPushes) {
      expect(args).toEqual(expectedPushArgs(sameRepo.worktreePath));
    }
    expect(sameRepo.outcome.status).toBe('ok'); // the keyed fake advanced: the push reached the PR

    const forked = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
      headRepo: 'octo/widget-fork',
    });
    const forkPushes = forked.gitLog.filter((args) => args[2] === 'push');
    expect(forkPushes.length).toBeGreaterThanOrEqual(1);
    for (const args of forkPushes) {
      expect(args).toEqual(
        expectedPushArgs(forked.worktreePath, 'https://github.com/octo/widget-fork.git'),
      );
    }
    // The keyed fake advances for EITHER form — the refspec is what carries
    // the PR head, the target only carries the destination.
    expect(forked.outcome.status).toBe('ok');
  });
});

test('second publication uses the confirmed advanced lease', async () => {
  const world = defaultWorld();
  world.worktreeAdvancesAt = 2;
  world.worktreeAdvancesTo = NEW_SHA;
  const { gitLog, outcome } = await runLoop(world, {
    driverResults: [completeWorker(fixLine(true, 'fix', [NEW_SHA]))],
  });
  const pushes = gitLog.filter((args) => args[2] === 'push');
  expect(pushes).toHaveLength(2);
  expect(pushes[1]?.[3]).toBe(`--force-with-lease=refs/heads/${HEAD_REF}:${NEW_SHA}`);
  expect(outcome.actionsPosted).toBeGreaterThan(0);
});

test('publication callback runs only after a successful push', async () => {
  for (const fails of [false, true]) {
    const world = defaultWorld();
    if (fails) world.pushFailAt = 1;
    const gitLog: string[][] = [];
    const confirmed: string[] = [];
    let pushCompleted = false;
    await runLoop(world, {
      gitLog,
      driverResults: [completeWorker(fixLine(true, 'fix', [NEW_SHA]))],
      gitHook: async (args, run) => {
        const result = await run(args);
        if (args[2] === 'push' && result.code === 0) pushCompleted = true;
        return result;
      },
      onPublished: (sha) => {
        expect(pushCompleted).toBe(true);
        expect(sha).toBe(SHA);
        confirmed.push(sha);
      },
    });
    if (fails) expect(confirmed).toEqual([]);
    else expect(confirmed.length).toBeGreaterThan(0);
  }
});

test('rejected publication is reconciled and withholds all replies without retry', async () => {
  const world = defaultWorld();
  world.pushFailAt = 1;
  const { gitLog, outcome } = await runLoop(world, {
    driverResults: [completeWorker(fixLine(true, 'fix', [NEW_SHA]))],
  });
  expect(gitLog.filter((args) => args[2] === 'push')).toHaveLength(1);
  expect(gitLog.some((args) => args[2] === 'ls-remote')).toBe(true);
  expect(outcome.actionsPosted).toBe(0);
});

test('a lost acknowledgement is reconciled before the reply-stage push and replies', async () => {
  const world = defaultWorld();
  world.worktreeAdvancesAt = 2;
  world.worktreeAdvancesTo = NEW_SHA;
  world.loseFirstPushAcknowledgement = true;
  const { gitLog, outcome } = await runLoop(world, {
    driverResults: [completeWorker(fixLine(true, 'fix', [NEW_SHA]))],
  });
  expect(outcome.status).toBe('ok');
  expect(outcome.actionsPosted).toBeGreaterThan(0);
  const publication = gitLog.findIndex((args) => args[2] === 'push');
  const reconciliation = gitLog.findIndex((args) => args[2] === 'ls-remote');
  const replyPush = gitLog.findLastIndex((args) => args[2] === 'push');
  expect(reconciliation).toBeGreaterThan(publication);
  expect(replyPush).toBeGreaterThan(reconciliation);
  expect(gitLog[replyPush]?.[3]).toBe(`--force-with-lease=refs/heads/${HEAD_REF}:${NEW_SHA}`);
});

test('a mid-run pushurl change cannot redirect the reply-stage push', async () => {
  const world = defaultWorld();
  world.changePushurlAfterFirstPush = true;
  const { gitLog, outcome } = await runLoop(world, {
    driverResults: [completeWorker(fixLine(true, 'fix', [NEW_SHA]))],
  });
  expect(outcome.status).toBe('ok');
  const pushes = gitLog.filter((args) => args[2] === 'push');
  expect(pushes).toHaveLength(2);
  expect(pushes.map((args) => args[4])).toEqual(['/fake/origin.git', '/fake/origin.git']);
  expect(gitLog.filter((args) => args[2] === 'remote' && args[3] === 'get-url')).toHaveLength(1);
});
