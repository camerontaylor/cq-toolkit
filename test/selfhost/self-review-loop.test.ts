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
//
// The loop fn is injected (deps.loop — the documented DI seam): a recording
// fake returning a minimal ReviewLoopOutcome. The gh seam is a fake GhFn
// routing on argv (candidates.test.ts's fixture style) — no spawned process
// anywhere, and the REAL listOpenPrs/fetchReviewState parse the fake's wire
// payloads.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
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
 * The fake gh: routes the shared REST listing plus (optionally) the
 * review-state reads the dry run makes. `stateRoutes` false leaves every
 * non-listing route failing — the dry run's per-PR state reads then fail
 * and must be isolated into the wouldRun lines.
 */
const fakeGh =
  (rows: unknown[], opts?: { failListing?: boolean; stateRoutes?: boolean }): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    const path = args[0] === 'api' && typeof args[1] === 'string' ? args[1] : '';
    if (path === LIST_PATH) {
      if (opts?.failListing === true) {
        return { code: 1, stdout: '', stderr: 'injected listing failure' };
      }
      return json(rows);
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
    behavior: (pr: number) => Promise<ReviewLoopOutcome>,
  ): typeof runReviewLoop =>
  async (opts: ReviewLoopOpts): Promise<ReviewLoopOutcome> => {
    calls.push({ opts });
    return behavior(opts.pr);
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

describe('runSelfReviewLoop — real run', () => {
  test('loops exactly the open same-repo non-draft PRs; passthrough of responderLogin, driver, and journal shapes', async () => {
    const calls: RecordedCall[] = [];
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
      baseCfg({ journalRoot: '/journal' }),
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
    expect(first.runOptions?.journalDir).toBe('/journal/7-1700000000000');
    expect(first.runOptions?.maxUsd).toBe(SelfhostDefaults.maxUsd);
    expect(first.dispatchLogPath).toBe('/journal/dispatch-7.ndjson');
    // Worktrees live under the gitignored runtime root.
    expect(first.worktreeRoot).toBe('/checkout/.selfhost/worktrees');
    // THE CLASSIFY DEFAULT RIDES UNCHANGED: no override is passed, so
    // runReviewLoop's defaultLoopClassifyConfig (bot suppression ON) applies.
    expect(first.classifyConfig).toBeUndefined();
    // No registry-view injection → absent (runReviewLoop builds its default).
    expect(first.driverRegistryView).toBeUndefined();
  });

  test('responderLogin and maxUsd overrides reach the loop opts; the clock is read per PR', async () => {
    const calls: RecordedCall[] = [];
    let tick = 0;
    const gh = fakeGh([pullRow(7), pullRow(8)]);
    const summary = await runSelfReviewLoop(
      {
        gh,
        git: async (): Promise<GhResult> => ({ code: 0, stdout: '', stderr: '' }),
        nowMs: () => (tick += 1),
        loop: fakeLoop(calls, async (pr) => fakeOutcome(pr)),
      },
      baseCfg({ responderLogin: 'cq-loop-bot', maxUsd: 2, journalRoot: '/j' }),
    );

    expect(summary.results).toHaveLength(2);
    expect(calls[0]?.opts.responderLogin).toBe('cq-loop-bot');
    expect(calls[0]?.opts.runOptions?.maxUsd).toBe(2);
    // One stamp read before the loop, one clock read per PR for the loop's
    // own nowMs — the per-PR stamps differ (fresh snapshots).
    expect(calls[0]?.opts.nowMs).toBe(2);
    expect(calls[1]?.opts.nowMs).toBe(3);
    expect(calls[0]?.opts.runOptions?.journalDir).toBe('/j/7-1');
    expect(calls[1]?.opts.runOptions?.journalDir).toBe('/j/8-1');
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
      baseCfg({ journalRoot: '/j' }),
    );

    expect(summary.results.map((row) => row.pr)).toEqual([7]);
    expect(summary.failures).toEqual([
      { pr: 8, error: 'injected loop boom' }, // ONE line — a log fact, not the dump
    ]);
    expect(calls).toHaveLength(2); // the sibling was still attempted
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
      baseCfg({ journalRoot: '/j' }),
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
      baseCfg({ journalRoot: '/j' }),
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
      baseCfg({ maxUsd: 1.5, journalRoot: '/j' }),
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
      baseCfg({ maxUsd: 3, journalRoot: '/j' }),
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
      baseCfg({ journalRoot: '/j' }),
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
});

describe('runSelfReviewLoop — dry run', () => {
  test('returns empty results and NEVER calls the loop; wouldRun carries the structural summary', async () => {
    const calls: RecordedCall[] = [];
    const gh = fakeGh([pullRow(7), pullRow(9, { draft: true })], { stateRoutes: true });
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
