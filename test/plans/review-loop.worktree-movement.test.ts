// Observed worktree movement (slice 9 item 2, drill-6 revision): head and
// range accountability, the fail-closed head reads, and the backward-move
// block.
import { describe, expect, test } from 'vitest';
import {
  actionableThread,
  ANCESTOR_SHA,
  BEFORE_SHA,
  BEEF_SHA,
  completeWorker,
  DEAD_SHA,
  defaultWorld,
  fixLine,
  gitLogPushes,
  MID_SHA,
  NEW_SHA,
  PREEXISTING_SHA,
  runLoop,
  SHA,
  type LoopWorld,
} from './review-loop.helpers.js';

describe('observed worktree movement (slice 9 item 2, drill-6 revision)', () => {
  test('a worker claiming no change while the worktree advanced → unreported-commit reason, no publish', async () => {
    // THE LYING-WORKER PIN (drill 6 revision): the worker claims
    // changed:false and claims NO commit, so the advanced tip is UNCLAIMED —
    // under HEAD-accountability the tip itself is the unreported commit and
    // publication stays blocked.
    const world = defaultWorld();
    world.worktreeAdvancesAt = 2; // a commit lands during the fix stage
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, 'Nothing to change: already handled at line 3.', [])),
      ],
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual(
      `unreported-commit: worktree tip ${'4444'.repeat(10)} is not a claimed fix — a worker committed without reporting it`,
    );
    expect(gitLogPushes(gitLog)).toBe(0); // no publish
    // Publish-gate unification (jMY2X): the blocked gate withholds the
    // reply — no "nothing to change" post over an unsane tree, nothing
    // recorded; the next run re-plans the still-actionable thread.
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });

  test('HEAD-accountability (drill 6): item A commits+claims, sibling B honest no-change → publishable, A resolves, B reply-only', async () => {
    // The false-positive that motivated the fix (found live, drill 6): one
    // real fix plus an honest no-op must NOT read as "unreported" under the
    // run-level head delta. The tip IS A's verified, claimed commit.
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.commitMessages = { [NEW_SHA]: 'Fix review item T1 in src/a.ts' };
    world.worktreeAdvancesAt = 2; // job 1's commit lands during the fix stage...
    world.worktreeAdvancesTo = NEW_SHA; // ...and IS the claimed tip
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Fixed A.', [NEW_SHA])),
        completeWorker(
          fixLine(false, 'Nothing to change for B: src/b.ts line 8 already guards it.', []),
        ),
      ],
      gitLog,
    });
    expect(outcome.reasons).toEqual([]);
    expect(outcome.status).toBe('ok');
    // The publish push AND replyAndResolve's push-before-post.
    expect(gitLogPushes(gitLog)).toBe(2);
    // A: reply + resolve; B: reply-only (an honest no-change never resolves).
    expect(outcome.actionsPosted).toBe(3);
    expect(outcome.reply?.posted.map((record) => record.kind)).toEqual([
      'review_reply',
      'review_reply',
      'resolve_thread',
    ]);
  });

  test('a claimed tip that fails verification names the failing stage (round-1 low): attribution-missing', async () => {
    // The tip IS reported — the worker claimed NEW_SHA — but fails the
    // per-item gate (the commit message names no item), so the reason must
    // say WHICH stage refused, not read as "unreported". Publication is
    // withheld, so only the unreported reason fires here (the action stage
    // continues past withheld rows).
    const world = defaultWorld();
    world.commitMessages = {}; // NEW_SHA carries NO item attribution
    world.worktreeAdvancesAt = 2; // the (claimed) commit lands during the fix stage...
    world.worktreeAdvancesTo = NEW_SHA; // ...and IS the tip
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [NEW_SHA]))],
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual(
      `unreported-commit: worktree tip ${NEW_SHA} was claimed but failed verification (attribution-missing)`,
    );
    expect(gitLogPushes(gitLog)).toBe(0); // publication withheld
    // Publish-gate unification (jMY2X): the blocked gate withholds the reply.
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });

  test('a claimed tip failing resolvability/ancestry names those stages (round-2 low)', async () => {
    // not-descendant: the claimed sha does not even resolve in the worktree
    // (rev-parse refuses unknown shas) — the gate names the stage.
    const unresolvable: LoopWorld = {
      ...defaultWorld(),
      knownShas: [SHA], // BEEF_SHA is a lie: rev-parse cannot resolve it
      commitMessages: {},
      worktreeAdvancesAt: 2,
      worktreeAdvancesTo: BEEF_SHA,
    };
    const unresolvableRun = await runLoop(unresolvable, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [BEEF_SHA]))],
    });
    expect(unresolvableRun.outcome.reasons).toContainEqual(
      `unreported-commit: worktree tip ${BEEF_SHA} was claimed but failed verification (not-descendant)`,
    );
    // not-ancestor: the sha resolves and descends, but its HEAD-ancestry is
    // refused (the world's ancestorFails drives the fake's merge-base).
    const notAncestor: LoopWorld = {
      ...defaultWorld(),
      knownShas: [SHA, NEW_SHA],
      ancestorFails: [NEW_SHA],
      commitMessages: {},
      worktreeAdvancesAt: 2,
      worktreeAdvancesTo: NEW_SHA,
    };
    const notAncestorRun = await runLoop(notAncestor, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [NEW_SHA]))],
    });
    expect(notAncestorRun.outcome.reasons).toContainEqual(
      `unreported-commit: worktree tip ${NEW_SHA} was claimed but failed verification (not-ancestor)`,
    );
  });

  test('an unreadable post-run HEAD → fail-closed: head-unreadable reason, no publish, reply withheld (round 3 + jLtVU/jMP_C)', async () => {
    // The range gate cannot bound an unreadable HEAD — publication must be
    // withheld with its OWN reason, never fail-open (round 3). The loop's
    // post-run read is read 3 (reads 1-2 are resolution + the pre-fix
    // boundary). And under headUnreadable EVERY ok row is withheld
    // (jMP_C): this pin's row is CHANGED:FALSE — the no-change reply must
    // NOT post or record, because a failed boundary read means the loop
    // cannot establish that HEAD stayed unchanged (an unreported local
    // commit could escape accountability, and a recorded round would make
    // the next run skip the retry).
    const world = defaultWorld();
    world.headReadFailsAfter = 2;
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, 'Nothing to change: already handled at line 3.', [])),
      ],
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual(
      'worktree head unreadable (post-run): fatal: unreadable HEAD',
    );
    expect(outcome.reasons).toContainEqual('reply withheld for fix-1 — publication blocked');
    expect(outcome.actionsPosted).toBe(0); // NO action of any kind: nothing records
    expect(outcome.reply).toBeUndefined();
    expect(gitLogPushes(gitLog)).toBe(0); // publication withheld fail-closed
  });

  test('an unreadable PRE-run HEAD → fail-closed with the pre-run reason, no publish, reply withheld (P1 + jLtVU)', async () => {
    // The P1 shape, exactly: the PRE-run boundary read (read 2) fails while
    // resolution (read 1) and the post-run read (3) succeed. headMoved goes
    // false — with the old post-run-only gate the range check was skipped
    // and an unaccounted nonempty range could publish. Fail-closed names
    // the failing read instead — and this CHANGED row's reply is withheld
    // (jLtVU): it would cite "Commits: <sha>" for a commit that was never
    // published.
    const world = defaultWorld();
    world.headReadFailsAt = 2;
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [NEW_SHA]))],
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual(
      'worktree head unreadable (pre-run): fatal: unreadable HEAD',
    );
    expect(outcome.reasons).toContainEqual('reply withheld for fix-1 — publication blocked');
    expect(outcome.actionsPosted).toBe(0); // NO action of any kind: nothing records
    expect(outcome.reply).toBeUndefined();
    expect(gitLogPushes(gitLog)).toBe(0); // publication withheld fail-closed
  });

  test('range accountability (round 2): an unclaimed MID-RANGE commit below the OBSERVED base blocks and names the sha', async () => {
    // The regression the tip-only rule missed (round-2 major): worker A
    // commits unreported (claims changed:false — it asserts nothing), worker
    // B commits + claims on top. The range is enumerated from the OBSERVED
    // base (codex P2) — `SHA..HEAD` — and MID_SHA sits unclaimed inside it:
    // publication must block and the reason must name it.
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.commitMessages = { [NEW_SHA]: 'Fix review item T2 in src/b.ts' };
    world.worktreeAdvancesAt = 2;
    world.worktreeAdvancesTo = NEW_SHA; // the tip: T2's claimed commit
    world.revListByBase = {
      [SHA]: [NEW_SHA, MID_SHA], // the observed base sees both added commits
      [BEFORE_SHA]: [], // the stale snapshot base would see an empty range
    };
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(
          fixLine(false, 'A: nothing to change, src/a.ts line 3 already guards it.', []),
        ),
        completeWorker(fixLine(true, 'Fixed B.', [NEW_SHA])),
      ],
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual(
      `unreported-commit: 1 commit(s) in ${SHA}..HEAD are not claimed fixes: ${MID_SHA}`,
    );
    expect(gitLogPushes(gitLog)).toBe(0); // publication withheld
    // Publish-gate unification (jMY2X): the blocked gate withholds BOTH
    // rows' replies — nothing records; the next run re-plans everything.
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });

  test('a stale PR-snapshot head does NOT block a legitimate run (codex P2): the range base is the OBSERVED head', async () => {
    // The snapshot's REST headSha can LAG the sha resolvePrWorktree fetched
    // and checked out. With the snapshot's stale sha as the range base, the
    // range drags in PRE-EXISTING commits (PREEXISTING_SHA, between the
    // stale head and the observed base) that can never be claimed — a
    // legitimate run was blocked as unreported. The fix: the base is the
    // OBSERVED pre-run head (SHA), whose range holds only the claimed fix.
    const world = defaultWorld();
    world.threads = [actionableThread('T1', 'src/a.ts', 3, 101)];
    world.revListByBase = {
      [BEFORE_SHA]: [PREEXISTING_SHA, NEW_SHA], // the stale base drags in pre-existing work
      [SHA]: [NEW_SHA], // the OBSERVED base sees only the claimed fix
    };
    world.commitMessages = { [NEW_SHA]: 'Fix review item T1 in src/a.ts' };
    world.worktreeAdvancesAt = 2;
    world.worktreeAdvancesTo = NEW_SHA; // the fix commit is the tip
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed the fruit.', [NEW_SHA]))],
      gitLog,
    });
    expect(outcome.reasons).toEqual([]);
    expect(outcome.status).toBe('ok');
    // The publish push AND replyAndResolve's push-before-post.
    expect(gitLogPushes(gitLog)).toBe(2);
    // The verified fix resolves its thread.
    expect(outcome.actionsPosted).toBe(2);
    expect(outcome.reply?.posted.map((record) => record.kind)).toEqual([
      'review_reply',
      'resolve_thread',
    ]);
  });

  test('a BACKWARD head move with an empty accounted range blocks publication (jLBJm P2)', async () => {
    // A worker `git reset` to an ANCESTOR of the before-head moves HEAD
    // without adding any commit: `rev-list <before>..HEAD` comes back
    // EMPTY, and an empty accounted range is UNACCOUNTED — the honest
    // changed:false reply must not publish (or record) a round over a
    // moved-backward tree.
    const world = defaultWorld();
    world.commitMessages = {};
    world.worktreeAdvancesAt = 2;
    world.worktreeAdvancesTo = ANCESTOR_SHA; // an ancestor of BEFORE_SHA
    world.revListShas = []; // `rev-list <before>..HEAD` is empty behind the base
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(false, 'Nothing to change: already handled at line 3.', [])),
      ],
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual(
      `unreported-commit: worktree head moved to ${ANCESTOR_SHA} but ${SHA}..HEAD is empty — the tip is not a claimed fix (backward or out-of-range movement)`,
    );
    expect(gitLogPushes(gitLog)).toBe(0); // publication withheld
    // Publish-gate unification (jMY2X): the blocked gate withholds the
    // changed:false row's reply too — nothing records.
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });

  test('range accountability: A claims+verifies, B claims+verifies → the whole range is accounted for and publishes', async () => {
    // Every sha in the added range is a verified claimed commit — the range
    // rule publishes exactly like the old tip rule did for this shape.
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.commitMessages = {
      [NEW_SHA]: 'Fix review item T1 in src/a.ts',
      [DEAD_SHA]: 'Fix review item T2 in src/b.ts',
    };
    world.knownShas = [SHA, NEW_SHA, DEAD_SHA];
    world.worktreeAdvancesAt = 2;
    world.worktreeAdvancesTo = DEAD_SHA; // B's commit is the tip
    world.revListShas = [DEAD_SHA, NEW_SHA]; // the whole range is claimed
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Fixed A.', [NEW_SHA])),
        completeWorker(fixLine(true, 'Fixed B.', [DEAD_SHA])),
      ],
      gitLog,
    });
    expect(outcome.reasons).toEqual([]);
    expect(outcome.status).toBe('ok');
    // The publish push AND replyAndResolve's push-before-post.
    expect(gitLogPushes(gitLog)).toBe(2);
    // Both threads reply AND resolve — replies before resolves.
    expect(outcome.actionsPosted).toBe(4);
    expect(outcome.reply?.posted.map((record) => record.kind)).toEqual([
      'review_reply',
      'review_reply',
      'resolve_thread',
      'resolve_thread',
    ]);
  });

  test('a dirty worktree at publish time → dirty-worktree reason, no push, no resolve', async () => {
    const world = defaultWorld();
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
      gitLog,
      onSpend: () => {
        world.dirty = true;
      },
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual('dirty-worktree');
    expect(gitLog.some((args) => args[2] === 'push')).toBe(false);
    // Publish-gate unification (jMY2X): the blocked gate withholds the reply
    // — no resolve, nothing records.
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });
});
