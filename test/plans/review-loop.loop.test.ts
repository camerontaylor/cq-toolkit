// Review-loop core contract: the happy path and enrichment, the v1-ledger
// gate (W2.2), failure handling, the CLI exit seam, the re-run no-op, and
// the plan registry entry.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import type { OpInvocation } from '../../src/driver/types.js';
import { exitCodeForOpResult } from '../../src/cli/exit.js';
import { PlanSchema } from '../../src/kernel/schema.js';
import type { Plan } from '../../src/kernel/types.js';
import { listPlans } from '../../src/plans/registry.js';
import {
  actionableThread,
  BEEF_SHA,
  completeWorker,
  defaultWorld,
  expectedPushArgs,
  fixLine,
  firstMutationIndex,
  isGhMutation,
  iso,
  NEW_SHA,
  prReadIndexes,
  REPLY_AGE,
  restComment,
  ROOT_AGE,
  rootComment,
  runLoop,
  scratchDirs,
  SHA,
} from './review-loop.helpers.js';

// ---------------------------------------------------------------------------
// 1 + 2. Happy path and enrichment
// ---------------------------------------------------------------------------

describe('review-loop happy path', () => {
  test('fix commits → push publishes → verify sees progress → reply + resolve post, verify before any post', async () => {
    const { outcome, ghLog, gitLog, worktreePath } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort path.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.reasons).toEqual([]);
    expect(outcome.worktree.path).toBe(worktreePath);
    expect(outcome.fixReport?.counts.done).toBe(1);
    expect(outcome.verify?.progress).toBe(true);
    expect(outcome.actionsPosted).toBe(2);
    const kinds = outcome.reply?.posted.map((record) => record.kind);
    expect(kinds).toEqual(['review_reply', 'resolve_thread']);

    // VERIFY BEFORE ANY POST: no gh mutation argv precedes the AFTER-snapshot
    // (the second PR-object read — snapshotPrState always opens there).
    const reads = prReadIndexes(ghLog);
    expect(reads.length).toBe(2);
    const mutation = firstMutationIndex(ghLog);
    expect(mutation).toBeGreaterThan(reads[1] ?? -1);

    // Every git push — the fix-stage publish AND replyAndResolve's
    // push-before-post — is exactly the composed worktree argv.
    const pushes = gitLog.filter((args) => args[2] === 'push');
    expect(pushes.length).toBeGreaterThanOrEqual(1);
    for (const args of pushes) {
      expect(args).toEqual(expectedPushArgs(worktreePath));
    }
  });

  test('the fix job input carries the correlated thread body and prior comments', async () => {
    const world = defaultWorld();
    world.pullsComments = [
      restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null),
      restComment(201, 'reviewer', 'See the timeout path too.', iso(REPLY_AGE), 101),
    ];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Done.', [NEW_SHA]))],
      invocations,
    });
    const job = outcome.plan.jobs[0] as {
      input: {
        item: {
          id: string;
          path: string | null;
          line: number | null;
          body: string;
          comments: Array<{ authorLogin: string | null; body: string; createdAt: string | null }>;
        };
      };
    };
    expect(job.input.item.id).toBe('T1');
    expect(job.input.item.path).toBe('src/a.ts');
    expect(job.input.item.line).toBe(3);
    expect(job.input.item.body).toBe('Fix src/a.ts at 3.');
    expect(job.input.item.comments).toEqual([
      {
        authorLogin: 'reviewer',
        // The REST fetch supplied no actor type for this reply, so the thread
        // vocabulary carries an explicit null — the same "fetched, unknown"
        // value the GraphQL reply mapping produces, never an omitted key.
        authorType: null,
        body: 'See the timeout path too.',
        createdAt: iso(REPLY_AGE),
      },
    ]);
    // And the worker actually received that payload.
    expect(invocations[0]?.prompt).toContain('Fix src/a.ts at 3.');
    expect(invocations[0]?.prompt).toContain('See the timeout path too.');
  });
});

// ---------------------------------------------------------------------------
// The fix run over an existing v1 journal — the governed ledger gate (W2.2)
// ---------------------------------------------------------------------------

describe('the fix run over an existing v1 journal (W2.2)', () => {
  test('v1 dispatch history refuses the always-governed fix run; governanceOptIn legacyJournal=reset upgrades it', async () => {
    // A pre-existing v1 journal for the loop's plan id with a dispatch: v1
    // carries no spend, so the ALWAYS-governed fix run refuses without the
    // opt-in and the loop surfaces the kernel refusal verbatim (the kernel
    // throw propagates out of runReviewLoop).
    const scratch = await mkdtemp(join(tmpdir(), 'cq-review-loop-v1-'));
    scratchDirs.push(scratch);
    const journalDir = join(scratch, 'ledger');
    await mkdir(journalDir, { recursive: true });
    const v1RunId = 'review-loop--legacy--dd';
    await writeFile(
      join(journalDir, `${v1RunId}.ndjson`),
      [
        {
          type: 'run-started',
          runId: v1RunId,
          at: '2026-01-01T00:00:00.000Z',
          planId: 'review-loop',
        },
        {
          type: 'job-started',
          runId: v1RunId,
          at: '2026-01-01T00:00:00.000Z',
          jobId: 'fix-1',
          op: 'review.fixItem',
          attempt: 1,
        },
      ]
        .map((event) => JSON.stringify(event))
        .join('\n') + '\n',
    );

    await expect(
      runLoop(defaultWorld(), {
        driverResults: [completeWorker(fixLine(true, 'Done.', [NEW_SHA]))],
        runOptions: { journalDir },
      }),
    ).rejects.toThrow(/unaccounted dispatches/);

    // With the reset opt-in the SAME history is "charged 0" (annex §4): the
    // fix run proceeds and the loop completes its happy path.
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Done.', [NEW_SHA]))],
      runOptions: { journalDir },
      governanceOptIn: ['budget.legacyJournal=reset'],
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.fixReport?.counts.done).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. NO PROGRESS and partial failure
// ---------------------------------------------------------------------------

describe('review-loop failure handling', () => {
  test('a claimed fix the snapshots cannot confirm → needs-human, resolve withheld, reply posted', async () => {
    const world = defaultWorld();
    world.advanceOnPush = false; // the push lands but origin never moves
    world.knownShas = [SHA]; // the claimed sha is NOT in the world (unverifiable)
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    // The PR-wide verdict is observability only — the HASFAILURES reason is
    // the per-item unverified-commits gate (round-2 finding 6).
    expect(outcome.reasons.some((reason) => reason.includes('NO PROGRESS'))).toBe(false);
    expect(outcome.reasons.some((reason) => reason.includes('unverified-commits'))).toBe(true);
    expect(outcome.verify?.summary).toBe('NO PROGRESS');
    // The resolve is withheld; the honest reply still posts — picked and
    // asserted: exactly one action, and it is not a resolve.
    expect(outcome.actionsPosted).toBe(1);
    expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });

  test('a malformed worker answer fails its row; the ok sibling is withheld (publication blocked)', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, BEEF_SHA]; // T2's commit is real; T1's answer is malformed
    world.commitMessages = { [BEEF_SHA]: 'Fix review item T2 in src/b.ts' };
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker('not json at all'),
        completeWorker(fixLine(true, 'Fixed.', [BEEF_SHA])),
      ],
      ghLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('fix job fix-1 ended failed'))).toBe(
      true,
    );
    expect(outcome.fixReport?.counts.done).toBe(1);
    expect(outcome.fixReport?.counts.failed).toBe(1);
    // Nothing was published (mixed-worktree guard): the after-snapshot lags.
    expect(outcome.verify?.progress).toBe(false);
    // Publish-gate unification (jMY2X): the blocked gate withholds EVERY
    // ok row — T2's reply does not post or record; the next run re-plans.
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
    expect(
      outcome.reasons.some((reason) => reason.includes('publish-withheld-mixed-worktree')),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. The CLI exit-code seam
// ---------------------------------------------------------------------------

describe('review-loop exit mapping', () => {
  test('a needs-human outcome maps to exit 3 through the CLI mapper', () => {
    expect(exitCodeForOpResult({ status: 'needs-human', reason: 'verify: NO PROGRESS' })).toBe(3);
    expect(exitCodeForOpResult({ status: 'ok', value: null })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 6. Re-run no-op
// ---------------------------------------------------------------------------

describe('review-loop re-run no-op', () => {
  test('a responded+resolved thread → zero batches, zero jobs, zero mutations, ok, no NO PROGRESS', async () => {
    // The thread's last word is the responder's AND the thread is resolved
    // in-world (a prior round closed it): classify 'resolved' — the
    // carried-resolve walk (jNUCa) does not fire for an already-resolved,
    // already-dispatched thread, and the re-run stays a true no-op. (A
    // responded-but-UNRESOLVED thread legitimately carries its resolve on
    // the next run — see the jNUCa pin.)
    const world = defaultWorld();
    world.threads = [
      {
        id: 'T1',
        isResolved: true,
        isOutdated: false,
        path: 'src/a.ts',
        line: 3,
        comments: { nodes: [rootComment(101, 'reviewer', 'Fix src/a.ts at 3.')] },
      },
    ];
    world.pullsComments = [
      restComment(101, 'reviewer', 'Fix src/a.ts at 3.', iso(ROOT_AGE), null),
      restComment(202, 'prauthor', 'Addressed in the pushed commit.', iso(REPLY_AGE), 101),
    ];
    const invocations: OpInvocation[] = [];
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, { invocations, ghLog });
    expect(outcome.status).toBe('ok');
    expect(outcome.batches).toEqual([]);
    expect(outcome.plan.jobs).toEqual([]);
    expect(invocations).toHaveLength(0);
    expect(outcome.verify).toBeUndefined();
    expect(outcome.actionsPosted).toBe(0);
    expect(ghLog.some((args) => isGhMutation(args))).toBe(false);
    expect(JSON.stringify(outcome).includes('NO PROGRESS')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7. The plan registry entry
// ---------------------------------------------------------------------------

describe('review-loop plan registry entry', () => {
  test("listPlans() discovers 'review-loop' and its importer yields the valid empty plan", async () => {
    const entries = await listPlans();
    const entry = entries.find((candidate) => candidate.name === 'review-loop');
    if (entry === undefined) {
      throw new Error("plan registry did not discover 'review-loop'");
    }
    const emptyPlan: Plan = await entry.importer();
    expect(emptyPlan.id).toBe('review-loop');
    expect(emptyPlan.jobs).toEqual([]);
    expect(PlanSchema.parse(emptyPlan)).toEqual(emptyPlan);
  });
});
