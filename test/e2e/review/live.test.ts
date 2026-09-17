// The LIVE review-loop e2e — E5 (goal E5; ws-e acceptance): the SHIPPED
// runReviewLoop driven END TO END against a scratch GitHub repo — real gh,
// real git, a spawned worker subprocess — no fakes anywhere in the loop's
// seams. Opt-in only: `describe.skipIf(!process.env.LIVE_GH)` — CI never
// sets LIVE_GH (the dispatch-gated .github/workflows/live-review.yml does),
// so an ordinary `npm test` SKIPS this file cleanly, and module scope stays
// inert (every live call happens inside beforeAll/tests, never at import).
//
// What it proves, in two runs against ONE seeded scratch repo:
//   1. Run 1 — a seeded review thread (an actionable misspelling on the PR
//      head) gets FIXED by the worker, the fix commit lands on the PR
//      branch, the thread gets REPLIED and RESOLVED — asserted through
//      FRESH gh REST/GraphQL reads, never the loop's own results.
//   2. Run 2 — the SAME loop re-run is a true NO-OP: zero fix jobs, the
//      verify stage never even runs (no manufactured NO PROGRESS verdict),
//      and ZERO gh mutations fly (the recorded argv holds none).
//
// THE FAKE FIXER AGENT: the loop's driver registry view binds
// `review.fixItem` through worktreeFixDriver's makeInner seam to a
// SubprocessDriver whose binary is `node <generated script>` — a real
// subprocess (cwd = the PR worktree, prompt on stdin, one stream-json
// result line out). This is the market-gap scenario: the loop CLOSES with
// a non-privileged arbitrary reviewer's thread.
//
// THE SINGLE-IDENTITY DEVIATION (recorded): the seeded thread is created
// via the REST API under the SAME token identity as the PR — flagged
// REVIEWER_ROLE_SIMULATED in test/e2e/helpers/review-live.ts, recorded in
// docs/drills/2026-09-e5.md. It interacts with classification: the thread
// author IS the responder (pr-author), so the loop runs with
// skipResponderAuthoredThreads: false for this drill (a classifyConfig
// flip — data, not a code change).
//
// LEAVE-BEHIND: the scratch repo is deliberately NOT deleted (the drill
// token holds no delete_repo scope); its URL is printed as the LAST line of
// the test output for the drill doc. The tmp clone/worktrees ARE cleaned.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { OpRegistryView } from '../../../src/kernel/runner.js';
import type { OpRegistryEntry } from '../../../src/kernel/types.js';
import { SubprocessDriver } from '../../../src/driver/subprocess/index.js';
import {
  FixReviewItemOutputSchema,
  makeFixReviewItem,
  worktreeFixDriver,
} from '../../../src/ops/review/fixReviewItem.js';
import { ghJson, makeGhRunner } from '../../../src/ops/review/gh.js';
import type { GhFn } from '../../../src/ops/review/gh.js';
import { FixReviewItemInputSchema } from '../../../src/ops/review/registry.js';
import { fileWorktreeRegistry } from '../../../src/ops/review/prWorktree.js';
import { runReviewLoop } from '../../../src/plans/review-loop.js';
import type { ReviewLoopOpts } from '../../../src/plans/review-loop.js';
import { defaultLoopClassifyConfig } from '../../../src/plans/review-loop.js';
import {
  FAKE_SUMMARY,
  FIXED_TEXT,
  FIXTURE_ENDPOINT,
  FIXTURE_KEY_ENV,
  FIXTURE_MODEL,
  MARKER_TEXT,
  REVIEWER_ROLE_SIMULATED,
  fixtureRoutingTable,
  isMutatingGhArgv,
  recordingGh,
  setupScratchRepo,
  writeFakeFixerAgent,
} from '../helpers/review-live.js';
import type { LiveScratchRepo } from '../helpers/review-live.js';

/** The seeded thread's GraphQL node, found by its root comment's REST id. */
interface ThreadNode {
  id: string;
  isResolved: boolean;
  comments: { nodes: Array<{ databaseId: number | null }> };
}

/** The same GraphQL document the setup poll uses — fresh reads only here. */
const THREADS_QUERY = `query ($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 50) {
        nodes { id isResolved path comments(first: 1) { nodes { databaseId } } }
      }
    }
  }
}`;

interface ThreadsPayload {
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: { nodes?: ThreadNode[] } | null;
      } | null;
    } | null;
  };
}

describe.skipIf(!process.env.LIVE_GH)('live review loop e2e (opt-in: LIVE_GH=1)', () => {
  // Real gh + a spawned agent + GitHub's own indexes: generous budgets.
  vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

  let fixture: LiveScratchRepo | undefined;
  let agentPath = '';
  // ONE dispatch log for BOTH runs, derived once from the shared fixture:
  // the already-answered skip (and replyAndResolve's dedupe) keys on the
  // actionIds recorded in THIS file — run 2 must load run 1's records or
  // answered items would re-open and re-dispatch (drill 7).
  let dispatchLogPath = '';

  beforeAll(async () => {
    // The fixture route never contacts an endpoint, but the SubprocessDriver
    // resolves the route's key env var pre-dispatch; a DUMMY value satisfies
    // it (the child is `node <script>`, never an API client — not a secret).
    process.env[FIXTURE_KEY_ENV] = 'fixture-only-dummy-value-not-a-secret';
    fixture = await setupScratchRepo({ runId: process.env.E5_RUN_ID ?? 'e5-live' });
    agentPath = await writeFakeFixerAgent(fixture.root);
    dispatchLogPath = join(fixture.root, 'dispatch-log.jsonl');
  });

  afterAll(async () => {
    if (fixture !== undefined) {
      // Clean the tmpdir machinery only — the scratch repo stays (module doc).
      await rm(fixture.root, { recursive: true, force: true });
      // The drill-doc pointer — intentionally the LAST line of the output.
      console.log(`E5 scratch repo (left behind): ${fixture.repoUrl}`);
    }
  });

  /** The seeded fixture, or a loud setup-failure signal in the test body. */
  const requireFixture = (): LiveScratchRepo => {
    if (fixture === undefined) {
      throw new Error('the beforeAll fixture setup did not complete');
    }
    return fixture;
  };

  /**
   * The shared loop opts — run 2 re-runs the SAME seams (registry file, THE
   * dispatch log, worktree root, clone) with a fresh clock, which is what
   * makes the no-op assertion meaningful (the dispatch memory and the
   * resolved thread both carry over). dispatchLogPath is the describe-level
   * singleton above — never per-run state.
   */
  const loopOpts = (overrides: { gh?: GhFn; nowMs?: number } = {}): ReviewLoopOpts => {
    const f = requireFixture();
    // The fix op dispatches through the governed runPlan seam exactly like
    // the CLI does (an OpRegistryEntry with the shipped input schema), but
    // the DRIVER seam is injected: worktreeFixDriver's makeInner binds a
    // SubprocessDriver over the fake agent (module doc).
    const driverRegistryView: OpRegistryView = {
      get: (name) =>
        name === 'review.fixItem'
          ? ({
              name: 'review.fixItem',
              inputSchema: FixReviewItemInputSchema,
              importer: async () =>
                makeFixReviewItem({
                  driver: {
                    perHarness: (harness, worktree) =>
                      worktreeFixDriver({
                        harnessConfig: harness,
                        worktreePath: worktree.path,
                        makeInner: (sessionsDir) =>
                          new SubprocessDriver({
                            binary: ['node', agentPath],
                            // The caller's harness reaches the INNER driver
                            // too — the perHarness argument is threaded, not
                            // hardcoded (the loop passes reviewFixHarness,
                            // so the live default is unchanged).
                            harnessConfig: harness,
                            outputSchema: FixReviewItemOutputSchema,
                            routingTable: fixtureRoutingTable(),
                            sessionsDir,
                          }),
                      }),
                  },
                }),
            } as unknown as OpRegistryEntry<never, never>)
          : undefined,
    };
    return {
      owner: f.owner,
      repo: f.repo,
      pr: f.pr,
      headRefName: f.headRefName,
      repoRoot: f.cloneDir,
      gh: overrides.gh ?? makeGhRunner(),
      git: makeGhRunner({ bin: 'git' }),
      registry: fileWorktreeRegistry(`${f.root}/worktree-registry.json`),
      driver: { provider: FIXTURE_ENDPOINT, model: FIXTURE_MODEL },
      // Derives from the LOOP default (defaultLoopClassifyConfig — its
      // auto-generated sticky-comment suppression rides along) with ONLY
      // the single-identity flip: the seeded thread's author IS the
      // responder (pr-author), so the shipped skipResponderAuthoredThreads
      // default would classify it skip (responder_authored) before any job
      // is planned (the recorded deviation, module doc).
      classifyConfig: { ...defaultLoopClassifyConfig, skipResponderAuthoredThreads: false },
      driverRegistryView,
      nowMs: overrides.nowMs ?? Date.now(),
      dispatchLogPath,
      worktreeRoot: `${f.root}/worktrees`,
    };
  };

  /** Fresh GraphQL read: OUR seeded thread, found by its root REST id. */
  const fetchSeededThread = async (
    gh: GhFn,
    f: LiveScratchRepo,
  ): Promise<ThreadNode | undefined> => {
    const payload = await ghJson<ThreadsPayload>(gh, [
      'api',
      'graphql',
      '-f',
      `query=${THREADS_QUERY}`,
      '-f',
      `owner=${f.owner}`,
      '-f',
      `name=${f.repo}`,
      '-F',
      `pr=${f.pr}`,
    ]);
    const nodes = payload.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
    return nodes.find((node) => (node.comments.nodes[0]?.databaseId ?? null) === f.threadRestId);
  };

  test('run 1: the seeded thread gets fixed, replied, and resolved; the comment gets its response', async () => {
    const f = requireFixture();
    expect(REVIEWER_ROLE_SIMULATED).toBe(true); // the recorded deviation flag rides
    const outcome = await runReviewLoop(loopOpts());
    // LIVE-DRILL DEBUGGABILITY (permanent): every outcome assertion carries
    // the whole payload in its vitest message — a live failure must say WHY
    // (reasons, fix rows, dispatch result), not just which assert died.
    const run1Dump = `run-1 outcome ${JSON.stringify(outcome, null, 1)}`;
    expect(outcome.status, run1Dump).toBe('ok');
    expect(outcome.reasons, run1Dump).toEqual([]);
    expect(outcome.fixReport?.counts.done, run1Dump).toBe(2); // thread + comment item
    expect(outcome.reply?.pushed, run1Dump).toBe(true);
    expect(outcome.actionsPosted, run1Dump).toBe(3); // reply AND response AND resolve
    expect(
      outcome.reply?.posted.map((record) => record.kind),
      run1Dump,
    ).toEqual(['review_reply', 'issue_comment', 'resolve_thread']);

    // FRESH evidence — the loop's own results are not the proof. The reply
    // exists on the thread (with the worker's summary), the thread reads
    // RESOLVED over GraphQL, the PR head moved to the reported fix commit,
    // and the PR diff carries the fixed spelling.
    const gh = makeGhRunner();
    const comments = await ghJson<
      Array<{ id: number; body: string; in_reply_to_id: number | null }>
    >(gh, ['api', `repos/${f.fullName}/pulls/${String(f.pr)}/comments?per_page=100`]);
    const reply = comments.find(
      (comment) => comment.in_reply_to_id === f.threadRestId && comment.body.includes(FAKE_SUMMARY),
    );
    expect(reply).toBeDefined();

    // Bounded REST convergence (round-2 low; the setup-poll pattern): the
    // fresh head read below must not false-fail on REST lag — wait (small,
    // bounded) for the head the LOOP reported before asserting on fresh
    // reads.
    const expectedHeadSha = outcome.fixReport?.jobs
      .flatMap((row) =>
        row.result.status === 'ok' ? (row.result.value as { commits: string[] }).commits : [],
      )
      .find((sha) => sha !== undefined);
    if (expectedHeadSha !== undefined) {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const probe = await ghJson<{ head?: { sha?: unknown } | null }>(gh, [
          'api',
          `repos/${f.fullName}/pulls/${String(f.pr)}`,
        ]);
        if (probe.head?.sha === expectedHeadSha) {
          break;
        }
        await new Promise((resolve: (value: void) => void) => {
          setTimeout(resolve, 2_000);
        });
      }
    }

    const pr = await ghJson<{ head: { ref: string; sha: string } }>(gh, [
      'api',
      `repos/${f.fullName}/pulls/${String(f.pr)}`,
    ]);
    expect(pr.head.sha).not.toBe(f.headSha); // the fix commit landed on the PR branch
    expect(reply?.body).toContain(pr.head.sha); // the pushed head IS the reported fix commit

    const thread = await fetchSeededThread(gh, f);
    expect(thread).toBeDefined();
    expect(thread?.isResolved).toBe(true);

    // ROUND-1 MEDIUM, fresh evidence: the loop's reply to the seeded
    // top-level comment exists over REST and LEADS with the signature —
    // the exact placement run 2's suppression depends on (a trailing
    // marker would never match the re-fetched reply).
    const issueComments = await ghJson<Array<{ id: number; body: string }>>(gh, [
      'api',
      `repos/${f.fullName}/issues/${String(f.pr)}/comments?per_page=100`,
    ]);
    const loopReply = issueComments.find((comment) =>
      comment.body.startsWith(`<!-- cq-review-loop:${f.owner}/${f.repo}#${String(f.pr)} -->`),
    );
    expect(loopReply, `issue comments ${JSON.stringify(issueComments)}`).toBeDefined();

    const diff = await gh(['pr', 'diff', String(f.pr), '-R', f.fullName]);
    expect(diff.code).toBe(0);
    expect(diff.stdout).toContain(FIXED_TEXT);
    expect(diff.stdout).not.toContain(MARKER_TEXT);
  });

  test('run 2: the re-run is a no-op — zero fix jobs, zero gh mutations', async () => {
    requireFixture();
    const argv: string[][] = [];
    // The shared dispatch log is the already-answered memory: snapshot it
    // before run 2 and assert ZERO appends after — the no-op pinned at the
    // dispatch mechanism itself, not just at the outcome fields (drill 7:
    // a split log re-opens answered items).
    const logBefore = await readFile(dispatchLogPath, 'utf8');
    const outcome = await runReviewLoop(
      loopOpts({ gh: recordingGh(makeGhRunner(), argv), nowMs: Date.now() }),
    );
    const logAfter = await readFile(dispatchLogPath, 'utf8');
    // Same permanent debuggability as run 1: the message carries the outcome
    // plus the fixReport counts and the recorded reasons.
    const run2Dump = `run-2 outcome ${JSON.stringify(outcome, null, 1)} counts ${JSON.stringify(
      outcome.fixReport?.counts,
    )} reasons ${JSON.stringify(outcome.reasons)}`;
    expect(outcome.status, run2Dump).toBe('ok');
    expect(outcome.reasons, run2Dump).toEqual([]);
    expect(outcome.fixReport?.counts.done, run2Dump).toBe(0);
    // Zero fix jobs via the suppression mechanisms, now ALL live-exercised:
    // the thread reads resolved (classify); the seeded reviewer comment is
    // already-answered-this-round (the shared dispatch log); the loop's OWN
    // run-1 issue_comment reply is skipped by the LEADING signature (round-1
    // medium — with the old trailing-marker bug run 2 planned a job on it
    // and failed here); any platform housekeeping matches the shipped
    // sticky patterns. Zero fix jobs → the verify stage must not even run
    // (a re-run no-op must not manufacture a NO PROGRESS verdict) and
    // nothing is dispatched.
    expect(outcome.verify, run2Dump).toBeUndefined();
    expect(outcome.reply, run2Dump).toBeUndefined();
    expect(outcome.actionsPosted, run2Dump).toBe(0);
    expect(JSON.stringify(outcome), run2Dump).not.toContain('NO PROGRESS');
    expect(
      logAfter,
      `run-2 dispatch log changed: before ${JSON.stringify(logBefore)} after ${JSON.stringify(logAfter)} (outcome ${JSON.stringify(outcome, null, 1)})`,
    ).toBe(logBefore);
    // Zero gh mutations: every recorded argv is a read (REST writes ride -X;
    // the resolve mutation is the family's only GraphQL write — see
    // isMutatingGhArgv).
    expect(
      argv.filter((args) => isMutatingGhArgv(args)),
      `run-2 mutating argv ${JSON.stringify(argv.filter((args) => isMutatingGhArgv(args)))} (all argv ${JSON.stringify(argv)})`,
    ).toEqual([]);
  });
});
