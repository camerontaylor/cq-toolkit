// Slice 2 (goal T4.1) — tests for the scheduled review-loop ENTRY module
// (src/selfhost/self-review-loop.ts).
//
// Pinned here (the loop itself is already pinned by the review family's and
// the e2e lanes' suites — this file pins the DEPLOYMENT WIRING):
//   1. The real listing path: the injected fake gh answers the shared REST
//      listing (candidates.ts's listOpenPrs) and the entry loops exactly the
//      open, same-repo, non-draft PRs (forks/drafts/no-number rows are
//      RECORDED as `excluded` rows — the real run's payload carries the same
//      reason strings the dry run surfaces in wouldRun).
//   2. Per-PR fault isolation: the first PR's loop resolves, the second
//      THROWS — one result row, one failure row with the message, no crash.
//   3. Opt passthrough: responderLogin, the maxUsd default AND override, the
//      journalDir/dispatchLogPath shapes under journalRoot, worktreeRoot
//      under `<repoRoot>/.selfhost/worktrees`, the frozen SelfhostDefaults
//      driver, and the one-run stamp namespace in journalDir.
//   4. THE CLASSIFY CONFIG IS NEVER OVERRIDDEN: opts.classifyConfig stays
//      absent so defaultLoopClassifyConfig (bot-authored suppression ON)
//      rides unchanged — the drills' skipResponderAuthoredThreads flip is
//      not a deployment setting.
//   5. Dry run: results and failures stay empty, the loop fn is NEVER
//      called, and the wouldRun lines carry the structural summary (with a
//      state-read failure isolated into an excluded line, never fatal).
//   6. A failing LISTING call throws (the candidates contract — no
//      fabricated "nothing open").
//   7. The maxUsd cap is SWEEP-LEVEL: carried forward across the PRs in
//      order (each loop gets the REMAINING budget, decremented by its fix
//      run's fixReport.costUSD rollup); a PR reached at ≤ 0 remaining is
//      recorded `sweep budget exhausted (I9)`, never looped, never silent.
//   8. A PR whose head is the protected branch (SelfhostDefaults.protected-
//      Branch) is excluded BEFORE the loop — a review fix would push worker
//      commits to it.
//   9. The bounded prune: after a real run only the newest 5 `<pr>-<stamp>`
//      audit dirs remain under the journal root; the flat dispatch-<pr>
//      .ndjson dedupe logs ride untouched.
//  10. First-run journal root (CodeRabbit KyA): a real run points journalRoot
//      at a NON-EXISTENT nested path and still succeeds — the entry creates
//      the root recursively before the registry/journal writers need it.
//  11. The wall-clock ladder rides the loop opts (CodeRabbit KyE): every
//      loop's limits carry SelfhostDefaults.perJobWallClockMs (the #137
//      review-path arming; merge-path symmetric).
//  12. Fail-closed sweep budget (CodeRabbit KyI), SPEND-EVIDENCE-GATED: a
//      loop that THROWS after its dispatch log gained a line burns the
//      sweep — the failure row says so and the later PRs are recorded
//      exhausted instead of re-spending an unaccounted allowance; a loop
//      that throws BEFORE any dispatch-log line (a pre-spend fault) spent
//      nothing, so its budget carries forward and its siblings still run.
//  13. Head-ref revalidation (CodeRabbit P1): immediately before each
//      dispatch the single-PR endpoint re-vouches for the head ref — a
//      renamed head is an excluded row (`head ref renamed since listing
//      (<old> -> <new>)`) and a failed revalidation read is a failure row
//      (`head revalidation failed: …`); NEITHER ever dispatches the loop,
//      a failed revalidation does not burn the sweep budget (nothing was
//      spent), and the dry run makes no revalidation reads at all. The
//      same payload's `state`/`draft` are re-required (`open`, `false`) —
//      a PR closed or converted to draft after the listing is an excluded
//      row (`closed after listing` / `converted to draft after listing`),
//      never a dispatch.
//
// The loop fn is injected (deps.loop — the documented DI seam): a recording
// fake returning a minimal ReviewLoopOutcome. The gh seam is a fake GhFn
// routing on argv (candidates.test.ts's fixture style) — no spawned process
// anywhere, and the REAL listOpenPrs/fetchReviewState parse the fake's wire
// payloads.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import type { RunReport } from '../../src/kernel/types.js';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import type { ReviewLoopOpts, ReviewLoopOutcome } from '../../src/plans/review-loop.js';
import type { SelfReviewLoopCfg, SelfReviewLoopDeps } from '../../src/selfhost/self-review-loop.js';
import { runSelfReviewLoop } from '../../src/selfhost/self-review-loop.js';
import type { runReviewLoop } from '../../src/plans/review-loop.js';
import { SelfhostDefaults } from '../../src/selfhost/config.js';

const OWNER = 'octo';
const REPO = 'widget';
const REPO_PATH = `${OWNER}/${REPO}`;
const LIST_PATH = `repos/${REPO_PATH}/pulls?state=open&per_page=100`;

/** One REST listing row (`repos/…/pulls?state=open`), same-repo by default. */
const pullRow = (n: number, overrides?: { draft?: boolean; headRepo?: string; ref?: string }) => ({
  number: n,
  state: 'open',
  draft: overrides?.draft ?? false,
  head: {
    ref: overrides?.ref ?? `pr-${String(n)}`,
    sha: `sha-${String(n)}`,
    repo: { full_name: overrides?.headRepo ?? REPO_PATH },
  },
  base: { ref: 'merge-queue' },
});

/** The empty GraphQL review-state payload for one PR (single page, no nodes). */
const emptyGraphql = (pr: number) => ({
  data: {
    repository: {
      pullRequest: {
        author: { login: `pr-author-${String(pr)}` },
        headRefName: `pr-${String(pr)}`,
        headRefOid: `sha-${String(pr)}`,
        reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
      },
    },
  },
});

const json = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

/**
 * The fake gh: routes the shared REST listing, the per-PR single-pull GET
 * (the pre-dispatch head-ref revalidation read), plus — optionally — the
 * review-state reads the dry run makes. `stateRoutes` false leaves every
 * review-state route failing — the dry run's per-PR state reads then fail
 * and must be isolated into the wouldRun lines. The single-pull route
 * defaults to a payload that VOUCHES for each row's listed head ref AND its
 * open, non-draft status (the ordinary world: nothing renamed, closed, or
 * drafted between listing and dispatch); returning the string 'fail' makes
 * that PR's GET exit 1.
 */
const fakeGh =
  (
    rows: unknown[],
    opts?: {
      failListing?: boolean;
      stateRoutes?: boolean;
      singlePull?: (pr: number) => unknown | 'fail';
      calls?: string[];
    },
  ): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    opts?.calls?.push(args.join(' '));
    const path = args[0] === 'api' && typeof args[1] === 'string' ? args[1] : '';
    if (path === LIST_PATH) {
      if (opts?.failListing === true) {
        return { code: 1, stdout: '', stderr: 'injected listing failure' };
      }
      return json(rows);
    }
    const single = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
    if (single !== null) {
      const pr = Number(single[1]);
      const payload = opts?.singlePull?.(pr) ?? {
        state: 'open',
        draft: false,
        head: { ref: `pr-${String(pr)}` },
      };
      if (payload === 'fail') {
        return { code: 1, stdout: '', stderr: 'injected gh failure' };
      }
      return json(payload);
    }
    if (opts?.stateRoutes === true) {
      if (path === 'graphql') {
        const prEntry = args.find((a) => a.startsWith('pr='));
        const pr = prEntry === undefined ? 0 : Number(prEntry.slice('pr='.length));
        return json(emptyGraphql(pr));
      }
      if (/^repos\/[^/]+\/[^/]+\/(pulls|issues)\/\d+\/(comments|reviews)(\?.*)?$/.test(path)) {
        return json([]);
      }
    }
    return { code: 1, stdout: '', stderr: `unrouted gh invocation: ${args.join(' ')}` };
  };

/** A minimal ReviewLoopOutcome (the fake loop's return — shape-complete). */
const fakeOutcome = (pr: number, status: 'ok' | 'needs-human' = 'ok'): ReviewLoopOutcome => ({
  status,
  reasons: status === 'ok' ? [] : ['injected reason'],
  worktree: { path: `/wt/pr-${String(pr)}`, branch: `cq-review/pr-${String(pr)}`, reused: false },
  batches: [],
  skipped: [],
  plan: { id: 'review-loop', jobs: [] },
  actionsPosted: 0,
});

/** A minimal fix-run report carrying one derived cost rollup (the sweep cap's input). */
const fixReportWithCost = (costUSD: number): RunReport => ({
  runId: 'fix-run',
  stoppedEarly: false,
  counts: { queued: 0, running: 0, blocked: 0, done: 0, failed: 0, 'budget-exhausted': 0 },
  jobs: [],
  costUSD,
});

/** A loop outcome whose fix run spent `costUSD` — the sweep cap's evidence. */
const outcomeWithFixCost = (pr: number, costUSD: number): ReviewLoopOutcome => ({
  ...fakeOutcome(pr),
  fixReport: fixReportWithCost(costUSD),
});

interface RecordedCall {
  opts: ReviewLoopOpts;
}

/** The DI fake loop: records every opts, resolves or throws per PR. */
const fakeLoop =
  (
    calls: RecordedCall[],
    behavior: (pr: number, opts: ReviewLoopOpts) => Promise<ReviewLoopOutcome>,
  ): typeof runReviewLoop =>
  async (opts: ReviewLoopOpts): Promise<ReviewLoopOutcome> => {
    calls.push({ opts });
    return behavior(opts.pr, opts);
  };

const baseDeps = (gh: GhFn, loop: typeof runReviewLoop): SelfReviewLoopDeps => ({
  gh,
  git: async (): Promise<GhResult> => ({ code: 0, stdout: '', stderr: '' }),
  nowMs: () => 1_700_000_000_000,
  loop,
});

const baseCfg = (over: Partial<SelfReviewLoopCfg> = {}) => ({
  owner: OWNER,
  repo: REPO,
  repoRoot: '/checkout',
  responderLogin: null,
  ...over,
});

/**
 * A REAL temp directory per real-run test: the entry now CREATES the journal
 * root on first run (KyA), so real-run journal roots must live where mkdir
 * is allowed — a fake literal like '/j' would be an EACCES crash, not a
 * test. Dry-run tests keep the fake literals (the dry run touches nothing).
 */
const tempRoots: string[] = [];
const tempJournalRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'self-review-loop-journal-'));
  tempRoots.push(root);
  return root;
};
afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

describe('runSelfReviewLoop — real run', () => {
  test('loops exactly the open same-repo non-draft PRs; passthrough of responderLogin, driver, and journal shapes', async () => {
    const calls: RecordedCall[] = [];
    const journalRoot = tempJournalRoot();
    const gh = fakeGh([
      pullRow(7),
      pullRow(8, { draft: true }), // skipped: draft
      pullRow(9, { headRepo: 'octo/fork' }), // skipped: fork (#142)
      pullRow(10),
    ]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot }),
    );

    // Only PRs 7 and 10 were loopable; both resolved. The skipped rows are
    // RECORDED, not silently dropped: the real run's `excluded` rows carry
    // the same reason strings the dry run surfaces.
    expect(summary.results.map((row) => row.pr)).toEqual([7, 10]);
    expect(summary.failures).toEqual([]);
    expect(summary.excluded).toEqual([
      { pr: 8, reason: 'draft' },
      { pr: 9, reason: 'forked-pr (head repo octo/fork)' },
    ]);
    expect(calls).toHaveLength(2);

    const first = calls[0]?.opts;
    if (first === undefined) throw new Error('the first loop call never happened');
    // Identity passthrough (the round-3 deployment requirement).
    expect(first.responderLogin).toBeNull(); // baseCfg default; overridden in the next test
    // The frozen driver binding, never a vendor choice invented here.
    expect(first.driver).toEqual(SelfhostDefaults.driver);
    expect(first.owner).toBe(OWNER);
    expect(first.repo).toBe(REPO);
    expect(first.pr).toBe(7);
    expect(first.headRefName).toBe('pr-7');
    expect(first.repoRoot).toBe('/checkout');
    // Journal shapes: one dir per PR namespaced by the ONE run stamp; the
    // dispatch log persists per PR directly under the journal root.
    expect(first.runOptions?.journalDir).toBe(join(journalRoot, '7-1700000000000'));
    expect(first.runOptions?.maxUsd).toBe(SelfhostDefaults.maxUsd);
    expect(first.dispatchLogPath).toBe(join(journalRoot, 'dispatch-7.ndjson'));
    // Worktrees live under the gitignored runtime root.
    expect(first.worktreeRoot).toBe('/checkout/.selfhost/worktrees');
    // THE CLASSIFY DEFAULT RIDES UNCHANGED: no override is passed, so
    // runReviewLoop's defaultLoopClassifyConfig (bot suppression ON) applies.
    expect(first.classifyConfig).toBeUndefined();
    // No registry-view injection → absent (runReviewLoop builds its default).
    expect(first.driverRegistryView).toBeUndefined();
    // The wall-clock ladder rides every loop (KyE / #137): the frozen
    // default, wrapped in the LIMITS half's one-field shape.
    expect(first.limits).toEqual({ perJobWallClockMs: SelfhostDefaults.perJobWallClockMs });
  });

  test('responderLogin and maxUsd overrides reach the loop opts; the clock is read per PR', async () => {
    const calls: RecordedCall[] = [];
    let tick = 0;
    const journalRoot = tempJournalRoot();
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      {
        gh,
        git: async (): Promise<GhResult> => ({ code: 0, stdout: '', stderr: '' }),
        nowMs: () => (tick += 1),
        loop: fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      },
      baseCfg({ responderLogin: 'cq-loop-bot', maxUsd: 2, journalRoot }),
    );

    expect(summary.results).toHaveLength(2);
    expect(calls[0]?.opts.responderLogin).toBe('cq-loop-bot');
    expect(calls[0]?.opts.runOptions?.maxUsd).toBe(2);
    // One stamp read before the loop, one clock read per PR for the loop's
    // own nowMs — the per-PR stamps differ (fresh snapshots).
    expect(calls[0]?.opts.nowMs).toBe(2);
    expect(calls[1]?.opts.nowMs).toBe(3);
    expect(calls[0]?.opts.runOptions?.journalDir).toBe(join(journalRoot, '7-1'));
    expect(calls[1]?.opts.runOptions?.journalDir).toBe(join(journalRoot, '8-1'));
  });

  test('per-PR fault isolation: a throwing loop records the failure, its siblings continue', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => {
          if (pr === 8) throw new Error('injected loop boom\nsecond line of spew');
          return fakeOutcome(pr);
        }),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(summary.failures).toEqual([
      {
        // ONE line — a log fact, not the dump. No dispatch-log line was
        // written, so the throw carried NO spend evidence and the sweep
        // budget was NOT burned (the spend-evidence-gated rule, KyI) — the
        // fail-closed suffix rides only a burn that happened.
        pr: 8,
        error: 'injected loop boom',
      },
    ]);
    expect(calls).toHaveLength(2); // the sibling was still attempted
  });

  test('first-run journal root: a NON-EXISTENT nested journalRoot is created and the run succeeds (KyA)', async () => {
    const calls: RecordedCall[] = [];
    // Point journalRoot at a path whose PARENT does not exist either — the
    // first-run / cache-miss shape. Before the fix the registry's withLock
    // needed `<journalRoot>/worktree-registry.json.lock` here and every PR
    // failed at resolvePrWorktree; the entry must create the root itself.
    const base = tempJournalRoot();
    const journalRoot = join(base, 'first', 'run', 'journal');
    expect(existsSync(journalRoot)).toBe(false);
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot }),
    );

    expect(summary.results.map((row) => row.pr)).toEqual([7, 8]);
    expect(summary.failures).toEqual([]);
    expect(existsSync(journalRoot)).toBe(true); // created, recursively
  });

  test('a thrown loop burns the sweep budget (KyI): the failure row says so and the next PR is recorded exhausted', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8), pullRow(9)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr, opts) => {
          if (pr === 7) {
            // Spend the budget and THROW before the entry can read the
            // rollup: the cost is real but unaccountable. The spend is
            // EVIDENCED by the dispatch log's first line — the loop's own
            // write, as the real loop does at its first dispatch — so the
            // throw must burn the sweep; PR 8/9 must not re-spend.
            writeFileSync(opts.dispatchLogPath, '{}\n');
            throw new Error('injected loop boom after spend');
          }
          return outcomeWithFixCost(pr, 1);
        }),
      ),
      baseCfg({ maxUsd: 3, journalRoot: tempJournalRoot() }),
    );

    // PR 7 was invoked (it spent, then threw); PR 8 never dispatched — the
    // zeroed remaining skipped it with the RECORDED exhausted row, and PR 9
    // rode the same skip (remaining is already ≤ 0).
    expect(calls.map((call) => call.opts.pr)).toEqual([7]);
    expect(summary.failures).toEqual([
      {
        pr: 7,
        error:
          'injected loop boom after spend — sweep budget exhausted (fail-closed: a thrown loop may have unaccounted spend)',
      },
    ]);
    expect(summary.excluded).toEqual([
      { pr: 8, reason: 'sweep budget exhausted (I9)' },
      { pr: 9, reason: 'sweep budget exhausted (I9)' },
    ]);
  });

  test('a loop that throws BEFORE any dispatch-log line carries the budget forward (spend-evidence-gated burn)', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => {
          if (pr === 7) {
            // Throw at entry — a worktree/registry-style fault, BEFORE any
            // dispatch-log line exists: nothing was spent, so the budget
            // must carry forward and the sibling must still run (an
            // ungated burn would let this PR starve every later PR).
            throw new Error('injected pre-spend fault');
          }
          return outcomeWithFixCost(pr, 1);
        }),
      ),
      baseCfg({ maxUsd: 2, journalRoot: tempJournalRoot() }),
    );

    // PR 8 was dispatched against the FULL remaining allowance, and PR 7's
    // failure row is the plain message — no fail-closed burn suffix.
    expect(calls.map((call) => call.opts.pr)).toEqual([7, 8]);
    expect(calls[1]?.opts.runOptions?.maxUsd).toBe(2);
    expect(summary.results.map((row) => row.pr)).toEqual([8]);
    expect(summary.failures).toEqual([{ pr: 7, error: 'injected pre-spend fault' }]);
    expect(summary.excluded).toEqual([]);
  });

  test('a listing row without a PR number is recorded as excluded, not silently skipped', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([
      { state: 'open', draft: false, head: { ref: 'x', sha: 's', repo: { full_name: REPO_PATH } } },
      pullRow(7),
    ]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );
    expect(summary.excluded).toEqual([
      { pr: 0, reason: 'fetch-failed: listing row without a PR number' },
    ]);
    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(calls).toHaveLength(1); // only the numbered PR reached the loop
  });

  test('driverRegistryView injection rides through to the loop opts', async () => {
    const calls: RecordedCall[] = [];
    const view: OpRegistryView = { get: () => undefined };
    const gh = fakeGh([pullRow(7)]);
    await runSelfReviewLoop(
      {
        ...baseDeps(
          gh,
          fakeLoop(calls, async (pr) => fakeOutcome(pr)),
        ),
        driverRegistryView: view,
      },
      baseCfg({ journalRoot: tempJournalRoot() }),
    );
    expect(calls[0]?.opts.driverRegistryView).toBe(view);
  });

  test('the maxUsd cap is sweep-level: a PR reached at zero remaining is recorded, not looped', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => outcomeWithFixCost(pr, 2)),
      ),
      baseCfg({ maxUsd: 1.5, journalRoot: tempJournalRoot() }),
    );

    // PR 7's fix run spent 2 of the 1.5 sweep cap; PR 8 never dispatches —
    // and the skip is a RECORDED row, never a silent one.
    expect(calls).toHaveLength(1);
    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(summary.excluded).toEqual([{ pr: 8, reason: 'sweep budget exhausted (I9)' }]);
  });

  test('the sweep cap carries forward: each loop gets the remaining budget, not a fresh cap', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8), pullRow(9)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => outcomeWithFixCost(pr, 1)),
      ),
      baseCfg({ maxUsd: 3, journalRoot: tempJournalRoot() }),
    );

    // Per-PR maxUsd is the REMAINING sweep budget after each prior fix
    // run's cost rollup: 3 − 1 → 2 − 1 → 1. Three looped PRs, one cap.
    expect(calls.map((call) => call.opts.runOptions?.maxUsd)).toEqual([3, 2, 1]);
    expect(summary.results.map((row) => row.pr)).toEqual([7, 8, 9]);
    expect(summary.excluded).toEqual([]);
  });

  test('a PR whose head is the protected branch is excluded before the loop', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7, { ref: 'main' }), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // The recorded reason names the rule: a review fix would push worker
    // commits to the protected branch.
    expect(summary.excluded).toEqual([
      {
        pr: 7,
        reason: `protected-branch head (a review fix would push worker commits to ${SelfhostDefaults.protectedBranch})`,
      },
    ]);
    expect(summary.results.map((row) => row.pr)).toEqual([8]);
    expect(calls.map((call) => call.opts.pr)).toEqual([8]); // the loop never ran for 7
  });

  test('the bounded prune keeps the newest 5 audit dirs and never touches the dispatch logs', async () => {
    const calls: RecordedCall[] = [];
    const journalRoot = mkdtempSync(join(tmpdir(), 'self-review-loop-'));
    try {
      // 7 prior-run audit dirs (oldest stamp first) plus the flat dedupe
      // log and a non-matching journal resident the prune must leave alone.
      for (let i = 0; i < 7; i++) {
        mkdirSync(join(journalRoot, `7-${String(1_700_000_000_000 + i)}`), { recursive: true });
      }
      writeFileSync(join(journalRoot, 'dispatch-7.ndjson'), '{}\n');
      writeFileSync(join(journalRoot, 'worktree-registry.json'), '{}\n');

      const gh = fakeGh([pullRow(7)]);
      const summary = await runSelfReviewLoop(
        baseDeps(
          gh,
          fakeLoop(calls, async (pr) => fakeOutcome(pr)),
        ),
        baseCfg({ journalRoot }),
      );
      expect(summary.results).toHaveLength(1);

      // Exactly the five NEWEST stamps survive; the flat dispatch log (the
      // cross-run dedupe memory) and the registry never match the
      // `<pr>-<stamp>` directory pattern and ride untouched.
      const expected = [
        ...[2, 3, 4, 5, 6].map((i) => `7-${String(1_700_000_000_000 + i)}`),
        'dispatch-7.ndjson',
        'worktree-registry.json',
      ].sort();
      expect(readdirSync(journalRoot).sort()).toEqual(expected);
    } finally {
      rmSync(journalRoot, { recursive: true, force: true });
    }
  });

  test('a head renamed since the listing is caught by the pre-dispatch revalidation — excluded row, loop never invoked', async () => {
    const calls: RecordedCall[] = [];
    const ghCalls: string[] = [];
    // The listing says head `pr-7`; the single-PR payload disagrees — the
    // branch was renamed between the listing read and this dispatch.
    const gh = fakeGh([pullRow(7)], {
      singlePull: () => ({ head: { ref: 'pr-7-renamed' } }),
      calls: ghCalls,
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // Recorded, not silent — and the loop was NEVER dispatched against the
    // stale name (no fixes pushed to a branch the forge no longer names).
    expect(summary.results).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.excluded).toEqual([
      { pr: 7, reason: 'head ref renamed since listing (pr-7 -> pr-7-renamed)' },
    ]);
    expect(calls).toHaveLength(0);
    // The revalidation rode the single-PR endpoint (the candidates argv
    // pattern), not some GraphQL detour.
    expect(ghCalls.some((line) => line.endsWith(`repos/${REPO_PATH}/pulls/7`))).toBe(true);
  });

  test('a PR closed or drafted after the listing is caught by the revalidation payload — excluded row, loop never invoked', async () => {
    const calls: RecordedCall[] = [];
    // Both payloads vouch for the LISTED head ref, so only the state/draft
    // half of the revalidation can stop these dispatches: PR 7 reads
    // closed, PR 8 reads converted-to-draft.
    const gh = fakeGh([pullRow(7), pullRow(8)], {
      singlePull: (pr) =>
        pr === 7
          ? { state: 'closed', draft: false, head: { ref: 'pr-7' } }
          : { state: 'open', draft: true, head: { ref: 'pr-8' } },
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // Recorded exclusion-style rows naming the reason; the loop is never
    // dispatched against a PR the forge no longer shows open and non-draft.
    expect(summary.results).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.excluded).toEqual([
      { pr: 7, reason: 'closed after listing' },
      { pr: 8, reason: 'converted to draft after listing' },
    ]);
    expect(calls).toHaveLength(0);
  });

  test('a failed head-revalidation read fails closed: a failure row, no dispatch, and the sibling still runs on an unburned budget', async () => {
    const calls: RecordedCall[] = [];
    // PR 7's revalidation GET exits 1; PR 8's vouches for its listed head
    // and its open, non-draft status.
    const gh = fakeGh([pullRow(7), pullRow(8)], {
      singlePull: (pr) =>
        pr === 7 ? 'fail' : { state: 'open', draft: false, head: { ref: `pr-${String(pr)}` } },
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // PR 7: an unverifiable head is not a dispatchable head — failed row,
    // never dispatched.
    expect(summary.failures).toHaveLength(1);
    expect(summary.failures[0]?.pr).toBe(7);
    expect(summary.failures[0]?.error.startsWith('head revalidation failed: ')).toBe(true);
    // PR 8: the sibling carried on — and the sweep budget was NOT burned by
    // the skip (nothing was spent), so it ran against the full default cap.
    expect(summary.results.map((row) => row.pr)).toEqual([8]);
    expect(summary.excluded).toEqual([]);
    const eighth = calls.find((call) => call.opts.pr === 8);
    expect(eighth?.opts.runOptions?.maxUsd).toBe(SelfhostDefaults.maxUsd);
  });

  test('matching heads: every dispatched loop is preceded by exactly one vouching single-PR read', async () => {
    const calls: RecordedCall[] = [];
    const ghCalls: string[] = [];
    const gh = fakeGh([pullRow(7), pullRow(8)], { calls: ghCalls });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: tempJournalRoot() }),
    );

    // The ordinary world is unchanged: vouching payloads, both loops run.
    expect(summary.results.map((row) => row.pr)).toEqual([7, 8]);
    expect(summary.excluded).toEqual([]);
    expect(summary.failures).toEqual([]);
    // One revalidation GET per dispatched PR, in listing order.
    expect(ghCalls.filter((line) => /^api repos\/octo\/widget\/pulls\/\d+$/.test(line))).toEqual([
      `api repos/${REPO_PATH}/pulls/7`,
      `api repos/${REPO_PATH}/pulls/8`,
    ]);
  });
});

describe('runSelfReviewLoop — dry run', () => {
  test('returns empty results and NEVER calls the loop; wouldRun carries the structural summary', async () => {
    const calls: RecordedCall[] = [];
    const ghCalls: string[] = [];
    const gh = fakeGh([pullRow(7), pullRow(9, { draft: true })], {
      stateRoutes: true,
      calls: ghCalls,
    });
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async () => {
          throw new Error('the loop must not run in dry-run mode');
        }),
      ),
      baseCfg({ journalRoot: '/j', dryRun: true }),
    );

    expect(calls).toHaveLength(0); // no loop, no worktree, no dispatch
    expect(summary.results).toEqual([]);
    expect(summary.failures).toEqual([]);
    expect(summary.dryRun).toBe(true);
    // No head-ref revalidation either: the dry run dispatches nothing, so
    // it cannot push to a stale branch and makes no single-PR reads (the
    // strict shape excludes the review-state comments/reviews routes).
    expect(ghCalls.some((line) => /^api repos\/octo\/widget\/pulls\/\d+$/.test(line))).toBe(false);
    // Dry-run mode carries NO excluded rows — the exclusions ride the
    // wouldRun lines (the real run's shape, mirrored below).
    expect(summary.excluded).toBeUndefined();
    expect(summary.wouldRun).toEqual([
      '#7 would-run head=pr-7 threads=0 reviews=0 issueComments=0 truncated=false',
      '#9 excluded draft',
    ]);
  });

  test('a dry-run state-read failure is isolated into the wouldRun lines, never fatal', async () => {
    const calls: RecordedCall[] = [];
    // stateRoutes omitted — every review-state read fails against the
    // unrouted-argv stub, and each PR degrades to an excluded line.
    const gh = fakeGh([pullRow(7)]);
    const summary = await runSelfReviewLoop(
      baseDeps(
        gh,
        fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      ),
      baseCfg({ journalRoot: '/j', dryRun: true }),
    );
    expect(summary.wouldRun?.[0]).toMatch(/^#7 excluded fetch-failed: /);
  });
});

describe('runSelfReviewLoop — listing failures', () => {
  test('a failing listing call throws (never a fabricated empty run)', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([], { failListing: true });
    await expect(
      runSelfReviewLoop(
        baseDeps(
          gh,
          fakeLoop(calls, async (pr) => fakeOutcome(pr)),
        ),
        baseCfg(),
      ),
    ).rejects.toThrow(/injected listing failure/);
    expect(calls).toHaveLength(0);
  });
});
