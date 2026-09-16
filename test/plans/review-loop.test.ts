// E4 slice 2 — tests for the review-loop plan wiring
// (src/plans/review-loop.ts; ws-e item 8).
//
// Pinned here:
//   1. HAPPY PATH: one actionable thread → the fix driver commits → the
//      worktree push publishes it → the after-snapshot sees the new commit →
//      reply + resolve post → outcome ok (fixReport came from the governed
//      runPlan: counts.done === 1). VERIFY BEFORE ANY POST is asserted from
//      the fake gh's call log: no mutation argv precedes the AFTER-snapshot
//      argv. Every git push argv is exactly the composed worktree form
//      ['-C', <worktree>, 'push', 'origin', 'HEAD:<branch>'] — the prWorktree
//      argv pattern (leading -C, since the runner spawns with the process
//      cwd).
//   2. ENRICHMENT: the fix job's input.item carries the thread's body, path,
//      line, and prior comments reconstructed from the fetched state (REST
//      reply chains included).
//   3. NO PROGRESS: the driver claims a fix but the fake world never moves
//      (identical snapshots) → needs-human naming NO PROGRESS; the resolve
//      is withheld (a claimed fix without observable movement never hides
//      its thread); the reply still posts (the worker's account is reported
//      honestly for the human to judge).
//   4. PARTIAL FAILURE: a malformed worker answer → that fix row failed →
//      needs-human, while the other thread still gets its reply + resolve
//      (stopOnError false).
//   5. EXIT CODE: the needs-human outcome maps to exit 3 through the CLI
//      mapper (the "via the CLI" claim, tested at the mapper seam).
//   6. RE-RUN NO-OP: the actionable thread now carries the responder's reply
//      → classify says responded → zero batches, zero fix jobs, zero gh
//      mutations, outcome ok, and NO 'NO PROGRESS' anywhere (verify never
//      ran — a no-op must not manufacture a verdict).
//   7. REGISTRY: listPlans() discovers 'review-loop'; its importer resolves
//      to the valid empty instance; PlanSchema.parse accepts it.
//
// Hermetic by construction: the gh and git seams are routed fakes recording
// every argv (no network, no spawned processes, no real clocks); the fix
// workers run through the REAL makeFixReviewItem op over a scripted Driver;
// the only filesystem writes are the test's own mkdtemp scratch dirs.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { Driver, OpInvocation, WorkerResult } from '../../src/driver/types.js';
import { exitCodeForOpResult } from '../../src/cli/exit.js';
import { PlanSchema } from '../../src/kernel/schema.js';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../src/kernel/types.js';
import type { Plan } from '../../src/kernel/types.js';
import type { ClassifiedItem } from '../../src/ops/review/classifyThreads.js';
import type { FetchedReviewState } from '../../src/ops/review/fetchReviewState.js';
import { makeFixReviewItem } from '../../src/ops/review/fixReviewItem.js';
import { FixReviewItemInputSchema } from '../../src/ops/review/registry.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import type { PlannedBatch } from '../../src/ops/review/planReviewBatch.js';
import type { RegistryMap, WorktreeRegistry } from '../../src/ops/review/prWorktree.js';
import type { ReviewThread } from '../../src/ops/review/threads.js';
import { listPlans } from '../../src/plans/registry.js';
import { enrichBatches, runReviewLoop } from '../../src/plans/review-loop.js';
import type { ReviewLoopOutcome } from '../../src/plans/review-loop.js';

// ---------------------------------------------------------------------------
// Fixtures — the loop world, the routed gh/git fakes, the scripted driver
// ---------------------------------------------------------------------------

const NOW = 1_750_000_000_000;
const COORDS = { owner: 'octo', repo: 'widget', pr: 7 } as const;
/** The review worktree's branch label (reviewBranchFor(7)) and its checked-out sha. */
const LABEL = 'cq-review/pr-7';
const SHA = 'b7e5f1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';

interface LoopWorld {
  /** The head sha the fake gh serves for the PR object. */
  sha: string;
  /** When true, a recorded git push moves the served head sha (the fix landed). */
  advanceOnPush: boolean;
  /** GraphQL thread nodes served to fetchReviewState. */
  threads: unknown[];
  /** REST pulls-comment entries (flat shape is tolerated by the slurp guard). */
  pullsComments: unknown[];
  /** Resolved-thread nodes served to the snapshot walks. */
  resolvedThreads: unknown[];
}

/** One GraphQL root-comment node (fetchReviewState reads databaseId + author + body). */
const rootComment = (databaseId: number, login: string, body: string): unknown => ({
  databaseId,
  author: { login },
  body,
  createdAt: '2026-09-14T00:00:00Z',
});

/** One actionable thread: external reviewer, unresolved, fresh. */
const actionableThread = (id: string, path: string, line: number, databaseId: number): unknown => ({
  id,
  isResolved: false,
  isOutdated: false,
  path,
  line,
  comments: { nodes: [rootComment(databaseId, 'reviewer', `Fix ${path} at ${String(line)}.`)] },
});

/** The default world: T1 actionable (external), T2 the responder's own (skip). */
const defaultWorld = (): LoopWorld => ({
  sha: 'sha-before',
  advanceOnPush: true,
  threads: [
    actionableThread('T1', 'src/a.ts', 3, 101),
    {
      id: 'T2',
      isResolved: false,
      isOutdated: false,
      path: 'src/b.ts',
      line: 8,
      comments: { nodes: [rootComment(102, 'prauthor', 'The responder note.')] },
    },
  ],
  pullsComments: [],
  resolvedThreads: [],
});

/** Value of a `name=…` argv entry the gh -f/-F flags carry. */
const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/**
 * A REST pulls-comment entry. The chain ROOT (in_reply_to_id null, id =
 * the thread's rootDatabaseId) must be present for attachRestReplies to
 * anchor a reply — real GitHub collections always include it.
 */
const restComment = (
  id: number,
  login: string,
  body: string,
  iso: string,
  inReplyToId: number | null,
): unknown => ({
  id,
  node_id: null,
  user: { login },
  body,
  created_at: iso,
  in_reply_to_id: inReplyToId,
});

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });

/** The routed gh fake: snapshots, the review-state fetch, replies, resolves. */
const fakeGh =
  (world: LoopWorld, log: string[][]): GhFn =>
  async (args) => {
    log.push(args);
    if (args.includes('graphql')) {
      const query = flagValue(args, 'query');
      if (query.includes('resolveReviewThread')) {
        // The fake echoes the REQUESTED thread and fails loudly on a
        // missing or unexpected one — a resolve can only ever target a
        // thread the world actually served.
        const threadId = flagValue(args, 'threadId');
        const known = world.threads.flatMap((node) =>
          typeof node === 'object' && node !== null && 'id' in node
            ? [String((node as { id: unknown }).id)]
            : [],
        );
        if (threadId === '' || !known.includes(threadId)) {
          return {
            code: 1,
            stdout: '',
            stderr: `fake gh: resolveReviewThread for unexpected threadId ${JSON.stringify(threadId)}`,
          };
        }
        return ok(
          JSON.stringify({
            data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
          }),
        );
      }
      if (query.includes('threadsCursor')) {
        return ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: world.resolvedThreads,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        );
      }
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                author: { login: 'prauthor' },
                headRefName: 'pr-7-fix',
                headRefOid: world.sha,
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: world.threads,
                },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        }),
      );
    }
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path === `repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}`) {
      return ok(JSON.stringify({ head: { sha: world.sha } }));
    }
    if (
      path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}/reviews`)
    ) {
      return ok('[]');
    }
    if (path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}/`)) {
      return ok(JSON.stringify(world.pullsComments));
    }
    if (path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/issues/${String(COORDS.pr)}/`)) {
      return ok('[]');
    }
    return { code: 1, stdout: '', stderr: `unexpected gh argv: ${args.join(' ')}` };
  };

/** The routed git fake: prWorktree's model (a reusable on-label tree) + pushes. */
const fakeGit =
  (world: LoopWorld, log: string[][], worktreePath: string): GhFn =>
  async (args) => {
    log.push(args);
    // prWorktree composes every git argv with a leading '-C <path>' — the
    // subcommand starts at index 2 in that form, at 0 without it.
    const rest = args[0] === '-C' ? args.slice(2) : args;
    if (rest[0] === 'rev-parse' && rest[1] === '--absolute-git-dir') {
      return ok('/fake/git-dir\n');
    }
    if (rest[0] === 'fetch' && rest[1] === 'origin') {
      return ok('');
    }
    if (rest[0] === 'rev-parse' && (rest[1] ?? '').startsWith('refs/cq-review/pr-')) {
      return ok(`${SHA}\n`);
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') {
      return ok(`worktree ${worktreePath}\nHEAD ${SHA}\nbranch refs/heads/${LABEL}\n\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === '--abbrev-ref') {
      return ok(`${LABEL}\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === 'HEAD') {
      return ok(`${SHA}\n`);
    }
    if (rest[0] === 'push') {
      if (world.advanceOnPush) {
        world.sha = 'sha-after';
      }
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected git argv: ${args.join(' ')}` };
  };

/** An unsynchronized in-memory WorktreeRegistry (single-threaded tests). */
const memoryRegistry = (): WorktreeRegistry => {
  let map: RegistryMap = {};
  return {
    load: async () => ({ ...map }),
    save: async (next) => {
      map = { ...next };
    },
    update: async (key, entry) => {
      const next = { ...map };
      if (entry === null) {
        delete next[key];
      } else {
        next[key] = entry;
      }
      map = next;
    },
    withLock: async (fn) => fn(),
  };
};

/** A 'complete' WorkerResult whose structuredOutput is a single JSON line. */
const completeWorker = (line: string): WorkerResult => ({
  structuredOutput: line,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason: 'complete',
});

/** The single-line JSON contract a compliant worker answers with. */
const fixLine = (changed: boolean, summary: string, commits: string[]): string =>
  JSON.stringify({ changed, summary, commits });

// ---------------------------------------------------------------------------
// The loop runner: fresh scratch, scripted driver, wired seams
// ---------------------------------------------------------------------------

const scratchDirs: string[] = [];
afterEach(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop();
    if (dir !== undefined) {
      await rm(dir, { recursive: true, force: true });
    }
  }
});

/** Run the loop over a world with a scripted driver; record every argv. */
const runLoop = async (
  world: LoopWorld,
  o: {
    driverResults?: WorkerResult[];
    ghLog?: string[][];
    gitLog?: string[][];
    invocations?: OpInvocation[];
  } = {},
): Promise<{
  outcome: ReviewLoopOutcome;
  ghLog: string[][];
  gitLog: string[][];
  worktreePath: string;
}> => {
  const scratch = await mkdtemp(join(tmpdir(), 'cq-review-loop-'));
  scratchDirs.push(scratch);
  const worktreePath = join(scratch, 'pr-7-pr-7-fix');
  const ghLog = o.ghLog ?? [];
  const gitLog = o.gitLog ?? [];
  const driver: Driver = {
    run: async (invocation) => {
      o.invocations?.push(invocation);
      const next = o.driverResults?.shift();
      if (next === undefined) {
        throw new Error('scripted driver: no scripted result left');
      }
      return next;
    },
  };
  // The fix op dispatches through a registry view whose review.fixItem binds
  // the scripted Driver — the same governed runPlan seam the CLI uses.
  const view: OpRegistryView = {
    get: (name) =>
      name === 'review.fixItem'
        ? ({
            name: 'review.fixItem',
            inputSchema: FixReviewItemInputSchema,
            importer: async () => makeFixReviewItem({ driver }),
          } as unknown as OpRegistryEntry<never, never>)
        : undefined,
  };
  const outcome = await runReviewLoop({
    owner: COORDS.owner,
    repo: COORDS.repo,
    pr: COORDS.pr,
    headRefName: 'pr-7-fix',
    repoRoot: '/fake/repo',
    gh: fakeGh(world, ghLog),
    git: fakeGit(world, gitLog, worktreePath),
    registry: memoryRegistry(),
    driver: { model: 'test-model', provider: 'test-provider' },
    driverRegistryView: view,
    nowMs: NOW,
    dispatchLogPath: join(scratch, 'dispatch.jsonl'),
    worktreeRoot: scratch,
  });
  return { outcome, ghLog, gitLog, worktreePath };
};

/** Gh mutation argv: a REST POST or the resolveReviewThread graphql mutation. */
const isGhMutation = (args: string[]): boolean => {
  if (args.includes('-X')) {
    return true;
  }
  return flagValue(args, 'query').includes('resolveReviewThread');
};

/** Indexes of the PR-object reads — snapshotPrState always starts there. */
const prReadIndexes = (ghLog: string[][]): number[] =>
  ghLog
    .map((args, index) =>
      args[0] === 'api' &&
      args[1] === `repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}`
        ? index
        : -1,
    )
    .filter((index) => index >= 0);

const firstMutationIndex = (ghLog: string[][]): number =>
  ghLog.findIndex((args) => isGhMutation(args));

/** The composed worktree push argv the loop must use (clarified pattern). */
const expectedPushArgs = (worktreePath: string): string[] => [
  '-C',
  worktreePath,
  'push',
  'origin',
  `HEAD:${LABEL}`,
];

// ---------------------------------------------------------------------------
// 1 + 2. Happy path and enrichment
// ---------------------------------------------------------------------------

describe('review-loop happy path', () => {
  test('fix commits → push publishes → verify sees progress → reply + resolve post, verify before any post', async () => {
    const { outcome, ghLog, gitLog, worktreePath } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Guarded the abort path.', ['cafe123']))],
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
      restComment(101, 'reviewer', 'Fix src/a.ts at 3.', '2026-09-14T00:00:00Z', null),
      restComment(201, 'reviewer', 'See the timeout path too.', '2026-09-15T00:00:00Z', 101),
    ];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Done.', ['cafe123']))],
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
        body: 'See the timeout path too.',
        createdAt: '2026-09-15T00:00:00Z',
      },
    ]);
    // And the worker actually received that payload.
    expect(invocations[0]?.prompt).toContain('Fix src/a.ts at 3.');
    expect(invocations[0]?.prompt).toContain('See the timeout path too.');
  });
});

// ---------------------------------------------------------------------------
// 3 + 4. NO PROGRESS and partial failure
// ---------------------------------------------------------------------------

describe('review-loop failure handling', () => {
  test('a claimed fix the snapshots cannot confirm → needs-human, resolve withheld, reply posted', async () => {
    const world = defaultWorld();
    world.advanceOnPush = false; // the push lands but origin never moves
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', ['cafe123']))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('NO PROGRESS'))).toBe(true);
    expect(outcome.verify?.summary).toBe('NO PROGRESS');
    // The resolve is withheld; the honest reply still posts — picked and
    // asserted: exactly one action, and it is not a resolve.
    expect(outcome.actionsPosted).toBe(1);
    expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });

  test('a malformed worker answer fails its row; the other thread still gets reply + resolve', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker('not json at all'),
        completeWorker(fixLine(true, 'Fixed.', ['beef456'])),
      ],
      ghLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('fix job fix-1 ended failed'))).toBe(
      true,
    );
    expect(outcome.fixReport?.counts.done).toBe(1);
    expect(outcome.fixReport?.counts.failed).toBe(1);
    expect(outcome.verify?.progress).toBe(true);
    expect(outcome.actionsPosted).toBe(2);
    expect(outcome.reply?.posted.map((record) => record.actionId)).toEqual([
      'review-loop:7:reply:T2',
      'review-loop:7:resolve:T2',
    ]);
    // The resolve mutation targets T2 SPECIFICALLY — the fake echoes the
    // requested thread and would fail loudly on any other id.
    const resolveArgs = ghLog.find((args) =>
      flagValue(args, 'query').includes('resolveReviewThread'),
    );
    expect(resolveArgs).toBeDefined();
    expect(flagValue(resolveArgs ?? [], 'threadId')).toBe('T2');
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
  test('a responded thread → zero batches, zero jobs, zero mutations, ok, no NO PROGRESS', async () => {
    const world = defaultWorld();
    world.pullsComments = [
      restComment(101, 'reviewer', 'Fix src/a.ts at 3.', '2026-09-14T00:00:00Z', null),
      restComment(202, 'prauthor', 'Addressed in the pushed commit.', '2026-09-15T12:00:00Z', 101),
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

// ---------------------------------------------------------------------------
// CodeRabbit cycle 1 — enrichment abandonment inside a shared batch
// ---------------------------------------------------------------------------

/** A minimal fetched thread for the enrichment unit fixtures. */
const enrichThread = (id: string, rootDatabaseId: number): ReviewThread => ({
  id,
  rootDatabaseId,
  path: 'src/a.ts',
  line: 3,
  isResolved: false,
  isOutdated: false,
  authorLogin: 'reviewer',
  createdAt: '2026-09-14T00:00:00Z',
  body: `Fix src/a.ts (${id}).`,
  replies: [],
});

/** A clean fetched state over the given threads. */
const enrichmentState = (threads: ReviewThread[]): FetchedReviewState => ({
  repo: { owner: 'octo', name: 'widget' },
  pr: 7,
  authorLogin: 'prauthor',
  headRefName: 'pr-7-fix',
  headRefOid: 'sha',
  threads,
  reviews: [],
  restReviewComments: [],
  restIssueComments: [],
  truncated: false,
  truncatedBecause: [],
});

const plannedThread = (id: string): ClassifiedItem => ({
  kind: 'thread',
  id,
  verdict: 'actionable',
  path: 'src/a.ts',
  reason: 'thread_needs_response',
});

describe('enrichBatches batch abandonment (CodeRabbit cycle 1)', () => {
  test('a vanished item keeps its row, unprocessed siblings are batch-abandoned, correlated siblings keep their jobs', () => {
    const state = enrichmentState([enrichThread('T-sib', 101), enrichThread('T-tail', 103)]);
    // Shared batch: the correlated sibling first, then a GHOST (the race —
    // its id no longer correlates), then an unprocessed tail item.
    const batch: PlannedBatch = {
      mode: 'shared',
      worktreeHint: 'shared-pr-worktree',
      items: [plannedThread('T-sib'), plannedThread('T-ghost'), plannedThread('T-tail')],
    };
    const { items, skipped } = enrichBatches([batch], state);
    expect(skipped).toEqual([
      { id: 'T-ghost', reason: 'item-vanished' },
      { id: 'T-tail', reason: 'batch-abandoned-item-vanished' },
    ]);
    // Only the already-correlated sibling gets a fix job.
    expect(items.map((entry) => entry.source.itemId)).toEqual(['T-sib']);
    expect(items[0]?.source.threadRootRestId).toBe(101);
    expect(items[0]?.item.body).toBe('Fix src/a.ts (T-sib).');
  });

  test('isolated mode is a no-op: a vanished 1:1 batch yields exactly the item-vanished row and no jobs', () => {
    const state = enrichmentState([]);
    const batch: PlannedBatch = {
      mode: 'isolated',
      worktreeHint: null,
      items: [plannedThread('T-ghost')],
    };
    const { items, skipped } = enrichBatches([batch], state);
    expect(skipped).toEqual([{ id: 'T-ghost', reason: 'item-vanished' }]);
    expect(items).toEqual([]);
  });
});
