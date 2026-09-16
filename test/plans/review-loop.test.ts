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
import { MAX_ITEM_BODY_CHARS } from '../../src/ops/review/fixReviewItem.js';
import { reviewFixHarness } from '../../src/ops/review/fixReviewItem.js';
import type { ReviewLoopOutcome } from '../../src/plans/review-loop.js';

// ---------------------------------------------------------------------------
// Fixtures — the loop world, the routed gh/git fakes, the scripted driver
// ---------------------------------------------------------------------------

const NOW = 1_750_000_000_000;
const COORDS = { owner: 'octo', repo: 'widget', pr: 7 } as const;

/**
 * Fixture timestamps are DERIVED from the injected clock, never absolute —
 * an absolute "September 2026" stamp is a time bomb against the classify
 * table's recency heuristics (an unknowingly future date flips the
 * last-word/answered comparisons under a real clock). ROOT_AGE keeps the
 * anchors an hour old; REPLY_AGE is "recently replied".
 */
const ROOT_AGE = 60 * 60_000;
const REPLY_AGE = 5 * 60_000;
const iso = (ageMs: number): string => new Date(NOW - ageMs).toISOString();
/** The review worktree's branch label (reviewBranchFor(7)) and its checked-out sha. */
const LABEL = 'cq-review/pr-7';
/** The PR's real head branch — the push refspec target (finding 1). */
const HEAD_REF = 'pr-7-fix';
const SHA = 'b7e5f1a2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8';
/**
 * A REAL new commit in the world: full 40-hex (the per-item resolve gate
 * rejects short shas and non-sha literals outright), known to the fake git
 * (rev-parse + ancestry answer), and a STRICT descendant of the served
 * origin head.
 */
const NEW_SHA = 'cafe1234cafe1234cafe1234cafe1234cafe1234';
const BEEF_SHA = 'beef4567beef4567beef4567beef4567beef4567';
/** The served origin heads — 40-hex so the per-item gate's STRICT
 * descendant check (sha ≠ before.headSha) is exercisable. */
const BEFORE_SHA = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const AFTER_SHA = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

interface LoopWorld {
  /** The head sha the fake gh serves for the PR object. */
  sha: string;
  /** When true, a recorded git push moves the served head sha (the fix landed). */
  advanceOnPush: boolean;
  /**
   * Shas the fake git world knows: `rev-parse --verify <sha>^{commit}`
   * succeeds and `merge-base --is-ancestor <sha> HEAD` exits 0 exactly for
   * these — the per-item resolve gate (finding 2) sees a hallucinated sha
   * as unverifiable.
   */
  knownShas: string[];
  /** When set, the Nth and every later git push FAILS (1-based). */
  pushFailAt?: number;
  /**
   * When set, the fake gh's PR-object reads keep serving the OLD head —
   * origin REST lag — while the git world HAS the new commit (finding 6:
   * the PR-wide verdict is observability only).
   */
  laggingOrigin?: boolean;
  /** Commit messages the fake git answers for `log -1 --format=%B <sha>`. */
  commitMessages: Record<string, string>;
  /** REST issue comments (the top-level PR conversation) served to the fetch. */
  issueComments: unknown[];
  /**
   * The worktree HEAD advances after this many reads of `rev-parse HEAD`
   * at the worktree path (read 1 is resolvePrWorktree's candidate check,
   * read 2 is the loop's pre-fix boundary, read 3 is the post-fix
   * boundary — 2 models "a commit landed during the fix stage").
   */
  worktreeAdvancesAt?: number;
  /** The sha the ADVANCED worktree HEAD reports (default: the 4444 filler). */
  worktreeAdvancesTo?: string;
  /** When true, `status --porcelain` reports a dirty worktree. */
  dirty?: boolean;
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
  createdAt: iso(ROOT_AGE),
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
  sha: BEFORE_SHA,
  advanceOnPush: true,
  knownShas: [SHA, NEW_SHA],
  commitMessages: { [NEW_SHA]: 'Fix review item T1 in src/a.ts' },
  issueComments: [],
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
                headRefName: HEAD_REF,
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
      return ok(JSON.stringify({ head: { sha: world.laggingOrigin ? BEFORE_SHA : world.sha } }));
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
      return ok(JSON.stringify(world.issueComments));
    }
    return { code: 1, stdout: '', stderr: `unexpected gh argv: ${args.join(' ')}` };
  };

/** The routed git fake: prWorktree's model (a reusable on-label tree) + pushes. */
const fakeGit = (world: LoopWorld, log: string[][], worktreePath: string): GhFn => {
  let pushCount = 0;
  let worktreeHeadReads = 0;
  return async (args) => {
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
    // The per-item resolve gate's mechanical checks (finding 2): a sha is
    // verifiable exactly when the world knows it.
    if (rest[0] === 'rev-parse' && rest[1] === '--verify') {
      const sha = (rest[2] ?? '').replace(/\^\{commit\}$/, '');
      if (world.knownShas.includes(sha)) {
        return ok(`${sha}\n`);
      }
      return { code: 128, stdout: '', stderr: `fatal: Needed a single revision: ${sha}` };
    }
    if (rest[0] === 'merge-base' && rest[1] === '--is-ancestor') {
      // Two-ref ancestry: 0 when (a) FROM is a served origin head (either —
      // the stage-5 publish may already have moved it) and TO is a known new
      // commit (the strict-descendant check), or (b) FROM is a known new
      // commit and TO is HEAD (the pushed-head check).
      const from = rest[2] ?? '';
      const to = rest[3] ?? '';
      const servedHead = from === BEFORE_SHA || from === AFTER_SHA;
      const descendantOfHead = servedHead && world.knownShas.includes(to);
      const inPushedHead = world.knownShas.includes(from) && to === 'HEAD';
      if (descendantOfHead || inPushedHead) {
        return { code: 0, stdout: '', stderr: '' };
      }
      return { code: 128, stdout: '', stderr: 'fatal: not an ancestor relation in this world' };
    }
    if (rest[0] === 'log' && rest[1] === '-1') {
      // Per-item attribution (round-3 finding 3): the commit message the
      // world carries for this sha.
      return ok(world.commitMessages[rest[3] ?? ''] ?? '');
    }
    if (rest[0] === 'worktree' && rest[1] === 'list') {
      return ok(`worktree ${worktreePath}\nHEAD ${SHA}\nbranch refs/heads/${LABEL}\n\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === '--abbrev-ref') {
      return ok(`${LABEL}\n`);
    }
    if (rest[0] === 'rev-parse' && rest[1] === 'HEAD') {
      if (args[1] === worktreePath) {
        // The loop's per-stage worktree HEAD reads (slice 9 item 2): the
        // head advances after the configured read count.
        worktreeHeadReads += 1;
        const advanced =
          world.worktreeAdvancesAt !== undefined && worktreeHeadReads > world.worktreeAdvancesAt;
        return ok(`${advanced ? (world.worktreeAdvancesTo ?? '4444'.repeat(10)) : SHA}\n`);
      }
      return ok(`${SHA}\n`);
    }
    if (rest[0] === 'status' && rest[1] === '--porcelain') {
      return world.dirty === true ? ok(' M src/a.ts\n') : ok('');
    }
    if (rest[0] === 'push') {
      pushCount += 1;
      if (world.pushFailAt !== undefined && pushCount >= world.pushFailAt) {
        return { code: 1, stdout: '', stderr: 'fatal: remote rejected the push\n' };
      }
      // KEYED (finding 1): only a push of the PR's REAL head moves the
      // served origin state — a push of the internal cq-review label must
      // NOT (a stray label branch and a phantom progress signal).
      if (world.advanceOnPush && rest[2] === `HEAD:${HEAD_REF}`) {
        world.sha = AFTER_SHA;
      }
      return ok('');
    }
    return { code: 1, stdout: '', stderr: `unexpected git argv: ${args.join(' ')}` };
  };
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
const completeWorker = (line: string, extra?: Partial<WorkerResult>): WorkerResult => ({
  structuredOutput: line,
  usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
  denials: [],
  stopReason: 'complete',
  ...extra,
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
    headRepo?: string;
    dispatchLogPath?: string;
    promptOverride?: string;
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
    headRefName: HEAD_REF,
    ...(o.headRepo !== undefined ? { headRepo: o.headRepo } : {}),
    repoRoot: '/fake/repo',
    gh: fakeGh(world, ghLog),
    git: fakeGit(world, gitLog, worktreePath),
    registry: memoryRegistry(),
    driver: { model: 'test-model', provider: 'test-provider' },
    driverRegistryView: view,
    nowMs: NOW,
    dispatchLogPath: o.dispatchLogPath ?? join(scratch, 'dispatch.jsonl'),
    worktreeRoot: scratch,
    ...(o.promptOverride !== undefined ? { promptOverride: o.promptOverride } : {}),
  });
  return { outcome, ghLog, gitLog, worktreePath };
};

/** Count of recorded git push invocations. */
const gitLogPushes = (gitLog: string[][]): number =>
  gitLog.filter((args) => args[2] === 'push').length;

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
const expectedPushArgs = (worktreePath: string, target = 'origin'): string[] => [
  '-C',
  worktreePath,
  'push',
  target,
  `HEAD:${HEAD_REF}`,
];

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

  test('a malformed worker answer fails its row; the other thread still gets its reply (publication withheld)', async () => {
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
    expect(outcome.actionsPosted).toBe(1); // T2's reply; the resolve is withheld
    // Round-versioned actionId: reply:<itemId>-<round fingerprint>.
    expect(outcome.reply?.posted.map((record) => record.actionId)).toEqual([
      expect.stringMatching(/^review-loop:7:reply:T2-[0-9a-f]{8}$/),
    ]);
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
  test('a responded thread → zero batches, zero jobs, zero mutations, ok, no NO PROGRESS', async () => {
    const world = defaultWorld();
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
  createdAt: iso(ROOT_AGE),
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

describe('per-item resolve gate (finding 2)', () => {
  test('a hallucinated sha → reply posts, resolve withheld with the unverified-commits reason', async () => {
    const world = defaultWorld();
    world.knownShas = [SHA]; // the claimed sha does not exist in the world
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('unverified-commits'))).toBe(true);
    // Fail toward visible: the reply reports the claim; the thread stays open.
    expect(outcome.actionsPosted).toBe(1);
    expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });
});

describe('fail-toward-human paths (finding 6 + Codex P1)', () => {
  test('a truncated classification refuses before the fix stage — no report, needs-human with the causes, zero mutations', async () => {
    const world = defaultWorld();
    // An orphan REST chain root = reviewThreads lag → the fail-closed flag.
    world.pullsComments = [restComment(999, 'reviewer', 'orphan chain root', iso(ROOT_AGE), null)];
    const ghLog: string[][] = [];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, { driverResults: [], invocations, ghLog });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toEqual(['reviewThreads.lag']);
    expect(outcome.fixReport).toBeUndefined();
    expect(outcome.plan.jobs).toEqual([]);
    expect(outcome.actionsPosted).toBe(0);
    expect(invocations).toHaveLength(0);
    expect(ghLog.some((args) => isGhMutation(args))).toBe(false);
  });

  test('a push failing at the stage-5 publish → needs-human with the push reason, nothing posts', async () => {
    const world = defaultWorld();
    world.pushFailAt = 1;
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.startsWith('push failed (exit 1)'))).toBe(true);
    expect(outcome.reasons.some((reason) => reason.startsWith('dispatch push failed:'))).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply?.pushed).toBe(false);
  });

  test('a push failing only at the reply stage → needs-human with the dispatch push reason, nothing posts', async () => {
    const world = defaultWorld();
    world.pushFailAt = 2; // the stage-5 publish lands; the reply-stage push fails
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.startsWith('dispatch push failed:'))).toBe(true);
    expect(outcome.reasons.some((reason) => reason.startsWith('push failed (exit'))).toBe(false);
    expect(outcome.verify?.progress).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply?.pushed).toBe(false);
    expect(outcome.reply?.posted).toEqual([]);
  });

  test('a budget-exhausted fix row feeds hasFailures and posts nothing for its thread', async () => {
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]), { stopReason: 'budget' })],
    });
    expect(outcome.status).toBe('needs-human');
    expect(
      outcome.reasons.some((reason) => reason.includes('fix job fix-1 ended budget-exhausted')),
    ).toBe(true);
    expect(outcome.reasons.some((reason) => reason.includes('budget cap hit'))).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });

  test('a thread with no REST root id → recorded reason, no actions for it', async () => {
    const world = defaultWorld();
    world.threads = [
      // Deleted root: no databaseId, no anchor — but the thread classifies
      // actionable (null author is never the responder).
      {
        id: 'T-noanchor',
        isResolved: false,
        isOutdated: false,
        path: 'src/a.ts',
        line: null,
        comments: { nodes: [] },
      },
    ];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Did it.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('no root REST id'))).toBe(true);
    expect(outcome.actionsPosted).toBe(0);
    expect(outcome.reply).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Round-2 reviewer fixes — spoof-proof resolve gate + observability-only
// verify + doc truth
// ---------------------------------------------------------------------------

describe('resolve-gate spoofing (round-2 finding 2)', () => {
  test.each([
    ['the before-snapshot (base) sha', BEFORE_SHA],
    ['a fabricated unknown 40-hex sha', 'abcd'.repeat(10)],
  ])(
    '%s is rejected by the loop gate — reply posts, no resolve, unverified-commits reason',
    async (_name, sha) => {
      const { outcome } = await runLoop(defaultWorld(), {
        driverResults: [completeWorker(fixLine(true, 'Claims the fix.', [sha]))],
      });
      expect(outcome.status).toBe('needs-human');
      expect(outcome.reasons.some((reason) => reason.includes('unverified-commits'))).toBe(true);
      expect(outcome.actionsPosted).toBe(1);
      expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
      expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
    },
  );

  test('the literal HEAD never survives the op parse — the fix row fails instead', async () => {
    // Defense in depth: the 40-hex contract rejects 'HEAD' at the op, so
    // the loop sees a FAILED row (never a gate-eligible claim).
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Claims the fix.', ['HEAD']))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('fix job fix-1 ended failed'))).toBe(
      true,
    );
    expect(outcome.reasons.some((reason) => reason.includes('unverified-commits'))).toBe(false);
    expect(outcome.actionsPosted).toBe(0);
  });

  test('a real new commit is accepted — the resolve posts', async () => {
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(true);
  });
});

describe('VerifyOutcome is observability only (round-2 finding 6)', () => {
  test('a lagging origin after-snapshot does not block a locally-verified fix', async () => {
    const world = defaultWorld();
    world.laggingOrigin = true; // the REST read keeps serving the OLD head
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
    });
    // The PR-wide verdict still computes (and reads NO PROGRESS against the
    // lagging read), but it never feeds hasFailures: the per-item commit
    // verification is the only resolve gate, and the commit IS real.
    expect(outcome.status).toBe('ok');
    expect(outcome.reasons).toEqual([]);
    expect(outcome.verify?.summary).toBe('NO PROGRESS');
    expect(outcome.actionsPosted).toBe(2);
    expect(outcome.reply?.posted.map((record) => record.kind)).toEqual([
      'review_reply',
      'resolve_thread',
    ]);
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

describe('per-item commit attribution (round-3 item 3)', () => {
  test('a commit naming only item A resolves A; item B gets the attribution reason', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, NEW_SHA, BEEF_SHA];
    // BOTH commits exist, but only T1's is named.
    world.commitMessages = {
      [NEW_SHA]: 'Fix review item T1 in src/a.ts',
      [BEEF_SHA]: 'Fix review item T1 in src/b.ts too',
    };
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Fixed.', [NEW_SHA])),
        completeWorker(fixLine(true, 'Fixed.', [BEEF_SHA])),
      ],
    });
    expect(outcome.status).toBe('needs-human');
    expect(
      outcome.reasons.some(
        (reason) => reason.includes('T2') && reason.includes('unverified-commits'),
      ),
    ).toBe(true);
    expect(outcome.actionsPosted).toBe(3); // reply+resolve for T1, bare reply for T2
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(true);
  });

  test('a commit naming item B resolves B', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, NEW_SHA, BEEF_SHA];
    world.commitMessages = {
      [NEW_SHA]: 'Fix review item T1 in src/a.ts',
      [BEEF_SHA]: 'Fix review item T2 in src/b.ts',
    };
    const { outcome } = await runLoop(world, {
      driverResults: [
        completeWorker(fixLine(true, 'Fixed A.', [NEW_SHA])),
        completeWorker(fixLine(true, 'Fixed B.', [BEEF_SHA])),
      ],
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(4);
  });
});

describe('blocked classification escalation (round-3 item 10)', () => {
  const outdatedThread = (): Record<string, unknown> => ({
    ...(actionableThread('T-b', 'src/c.ts', 1, 103) as Record<string, unknown>),
    isOutdated: true,
  });

  test('blocked-only → needs-human with the reason, zero mutations, driver uncalled', async () => {
    const world = defaultWorld();
    world.threads = [outdatedThread()];
    const ghLog: string[][] = [];
    const invocations: OpInvocation[] = [];
    const { outcome } = await runLoop(world, { driverResults: [], invocations, ghLog });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toEqual(['blocked: T-b requires human decision']);
    expect(outcome.fixReport?.counts.done).toBe(0);
    expect(invocations).toHaveLength(0);
    expect(ghLog.some((args) => isGhMutation(args))).toBe(false);
  });

  test('blocked + actionable → the actionable item fixes, outcome stays needs-human', async () => {
    const world = defaultWorld();
    world.threads = [outdatedThread(), actionableThread('T1', 'src/a.ts', 3, 101)];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toEqual(['blocked: T-b requires human decision']);
    expect(outcome.actionsPosted).toBe(2);
  });
});

describe('mixed-worktree publication (round-3 item 11)', () => {
  test('a failed sibling withholds the push — no push argv, no resolves, reasons present', async () => {
    const world = defaultWorld();
    world.threads = [
      actionableThread('T1', 'src/a.ts', 3, 101),
      actionableThread('T2', 'src/b.ts', 8, 102),
    ];
    world.knownShas = [SHA, BEEF_SHA];
    world.commitMessages = { [BEEF_SHA]: 'Fix review item T2 in src/b.ts' };
    const gitLog: string[][] = [];
    // A's worker answer is malformed (its worktree state is unknown); B is ok.
    const { outcome, gitLog: log } = await runLoop(world, {
      driverResults: [
        completeWorker('not json at all'),
        completeWorker(fixLine(true, 'Fixed B.', [BEEF_SHA])),
      ],
      gitLog,
    });
    void log;
    expect(outcome.status).toBe('needs-human');
    expect(
      outcome.reasons.some((reason) => reason.includes('publish-withheld-mixed-worktree')),
    ).toBe(true);
    expect(gitLog.some((args) => args[2] === 'push')).toBe(false);
    expect(outcome.actionsPosted).toBe(1); // B's reply; NO resolve
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });
});

describe('truncated-context resolve gate (round-3 item 13)', () => {
  test('a context-truncated worker → reply posts, resolve withheld, needs-human', async () => {
    const world = defaultWorld();
    const threadNode = actionableThread('T1', 'src/a.ts', 3, 101) as {
      comments: { nodes: Array<{ body: string }> };
    };
    // The ROOT COMMENT's body is what the fetch maps to item.body — an
    // oversized one trips the op's context cap (round-3 item 13).
    const root = threadNode.comments.nodes[0];
    if (root === undefined) {
      throw new Error('fixture: root comment missing');
    }
    root.body = 'x'.repeat(MAX_ITEM_BODY_CHARS + 1);
    world.threads = [threadNode];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed what I saw.', [NEW_SHA]))],
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons.some((reason) => reason.includes('truncated-context'))).toBe(true);
    expect(outcome.actionsPosted).toBe(1);
    expect(outcome.reply?.posted[0]?.kind).toBe('review_reply');
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });
});

describe('shipped fixer harness rides the plan (round-3 item 9)', () => {
  test('the plan default IS the shipped reviewFixHarness value', () => {
    expect(reviewFixHarness.tools.run.enabled).toBe(true);
    expect(reviewFixHarness.tools.run.commandPatterns[0]).toBe('git add');
  });

  test('the fix job input carries the git-commit-capable harness by default', async () => {
    const { outcome } = await runLoop(defaultWorld(), {
      driverResults: [completeWorker(fixLine(true, 's', [NEW_SHA]))],
    });
    const job = outcome.plan.jobs[0] as {
      input: { harness: { tools: { run: { commandPatterns: string[] } } } };
    };
    expect(job.input.harness.tools.run.commandPatterns).toEqual([
      'git add',
      'git commit',
      'git status',
      'git diff',
      'git log',
      'git rev-parse',
    ]);
  });
});

describe('package surface (round-3 item 12)', () => {
  test('src/index.js resolves the review-loop wiring, builder, and registry entry', async () => {
    const surface = (await import('../../src/index.js')) as Record<string, unknown>;
    expect(typeof surface['runReviewLoop']).toBe('function');
    expect(typeof surface['buildReviewLoopPlan']).toBe('function');
    expect(surface['plan']).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Slice 9 — attribution under override, observed worktree movement,
// round-versioned dispatch keys, already-answered skip
// ---------------------------------------------------------------------------

describe('attribution under promptOverride (slice 9 item 1)', () => {
  test('an override-run worker whose commit names the item resolves normally', async () => {
    const world = defaultWorld();
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
      promptOverride: 'OVERRIDE PROMPT',
    });
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(2);
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(true);
  });
});

describe('observed worktree movement (slice 9 item 2, drill-6 revision)', () => {
  test('a worker claiming no change while the worktree advanced → unreported-commit reason, no publish', async () => {
    // THE LYING-WORKER PIN (drill 6 revision): the worker claims
    // changed:false and claims NO commit, so the advanced tip is UNCLAIMED —
    // under HEAD-accountability the tip itself is the unreported commit and
    // publication stays blocked.
    const world = defaultWorld();
    world.worktreeAdvancesAt = 2; // a commit lands during the fix stage
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(false, 'Nothing to change.', []))],
      ghLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual(
      `unreported-commit: worktree tip ${'4444'.repeat(10)} is not a claimed fix — a worker committed without reporting it`,
    );
    expect(gitLogPushes(ghLog)).toBe(0); // no publish
    // The reply still posts and NOTES the observed commit.
    expect(outcome.actionsPosted).toBe(1);
    const post = ghLog.find((args) => args.includes('-X'));
    expect(post?.some((arg) => arg.includes('unreported commit'))).toBe(true);
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
        completeWorker(fixLine(false, 'Nothing to change for B.', [])),
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

  test('a dirty worktree at publish time → dirty-worktree reason, no push, no resolve', async () => {
    const world = defaultWorld();
    world.dirty = true;
    const gitLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(true, 'Fixed.', [NEW_SHA]))],
      gitLog,
    });
    expect(outcome.status).toBe('needs-human');
    expect(outcome.reasons).toContainEqual('dirty-worktree');
    expect(gitLog.some((args) => args[2] === 'push')).toBe(false);
    expect(outcome.actionsPosted).toBe(1); // the reply posts; the resolve is withheld
    expect(outcome.reply?.posted.some((record) => record.kind === 'resolve_thread')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Auto-generated sticky comment skip (drill 6) — the loop DEFAULT gains the
// pattern (defaultLoopClassifyConfig); config-as-data, no code branch. The
// author is deliberately a plain reviewer identity: only the BODY pattern
// may classify this skip.
// ---------------------------------------------------------------------------

describe('auto-generated sticky comment skip + self-reply marker (drills 6-8)', () => {
  test('housekeeping comments skip under the loop DEFAULT; a real human comment stays actionable; the reply carries the loop signature', async () => {
    // ALL THREE live-observed housekeeping shapes (drill 6: the GitHub
    // HTML-marker sticky; drill 7: the markerless checks summary, comment id
    // 5705054746; drill 8: the Codex review bot's sticky PR summary) plus
    // one REAL human comment. Authors are deliberately plain reviewer/bot
    // identities — only the BODY patterns may classify the skips, and the
    // human comment must stay actionable.
    const world = defaultWorld();
    world.threads = []; // ONLY the four issue comments ride the fetched state
    world.issueComments = [
      restComment(
        301,
        'reviewer',
        '<!-- This is an auto-generated comment -->\nThis comment shows the latest checks and updates itself.',
        iso(ROOT_AGE),
        null,
      ),
      restComment(
        302,
        'reviewer',
        'This comment shows the latest checks and was posted automatically.',
        iso(ROOT_AGE),
        null,
      ),
      restComment(
        303,
        'reviewer',
        '<!-- codex-pull-request-review-summary -->\n## Codex Review Summary\nThis comment shows the latest Codex review activity.',
        iso(ROOT_AGE),
        null,
      ),
      restComment(304, 'reviewer', 'Please also fix the typo in src/a.ts.', iso(ROOT_AGE), null),
    ];
    const ghLog: string[][] = [];
    const { outcome } = await runLoop(world, {
      driverResults: [completeWorker(fixLine(false, 'Noted; nothing to change in code.', []))],
      ghLog,
    });
    // ONLY the human comment plans a job — the three sticky shapes skip.
    expect(outcome.plan.jobs).toHaveLength(1);
    expect((outcome.plan.jobs[0] as { input: { item: { id: string } } }).input.item.id).toBe('304');
    expect(outcome.skipped).toEqual([]);
    expect(outcome.status).toBe('ok');
    expect(outcome.actionsPosted).toBe(1);
    // SELF-REPLY MARKER (drill 8): the reply body ends with the loop's
    // signature line — a re-run must recognize its own words, never answer
    // them again.
    const post = ghLog.find((args) => args.includes('-X'));
    expect(
      post?.some((arg) => arg.includes('<!-- cq-review-loop:octo/widget#7 -->')),
      `posted argv ${JSON.stringify(post)}`,
    ).toBe(true);
  });
});

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

    // Exact re-run of round two: the round-versioned ids are already
    // dispatched — the loop skips the item before building fix jobs.
    const invocations: OpInvocation[] = [];
    const run3 = await runLoop(world2, {
      driverResults: [],
      invocations,
      dispatchLogPath,
    });
    expect(run3.outcome.plan.jobs).toEqual([]);
    expect(run3.outcome.skipped).toEqual([{ id: 'T1', reason: 'already-answered-this-round' }]);
    expect(invocations).toHaveLength(0);
    expect(run3.outcome.actionsPosted).toBe(0);
    expect(run3.outcome.reply).toBeUndefined();
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
