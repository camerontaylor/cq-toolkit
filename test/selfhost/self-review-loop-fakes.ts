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
//  12. Propagated sweep spend (#186): a loop that THROWS after spending
//      reports its accounted spend through opts.onSpend; the entry deducts
//      exactly that known amount and carries the remainder (no whole-sweep
//      burn, no dispatch-log proxy). A loop that throws BEFORE any spend
//      deducts nothing, so its budget carries forward and its siblings run.
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
// Split from self-review-loop.test.ts (pure move): the suite's test files import these fakes from here.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunReport } from '../../src/kernel/types.js';
import type { GhFn, GhResult } from '../../src/adapters/forge-github/gh.js';
import type { ReviewLoopOpts, ReviewLoopOutcome } from '../../src/plans/review-loop.js';
import type { SelfReviewLoopCfg, SelfReviewLoopDeps } from '../../src/selfhost/self-review-loop.js';
import type { runReviewLoop } from '../../src/plans/review-loop.js';

export const OWNER = 'octo';
export const REPO = 'widget';
export const REPO_PATH = `${OWNER}/${REPO}`;
export const LIST_PATH = `repos/${REPO_PATH}/pulls?state=open&per_page=100`;

/** One REST listing row (`repos/…/pulls?state=open`), same-repo by default. */
export const pullRow = (
  n: number,
  overrides?: { draft?: boolean; headRepo?: string; ref?: string },
) => ({
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
export const fakeGh =
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
export const fakeOutcome = (
  pr: number,
  status: 'ok' | 'needs-human' = 'ok',
): ReviewLoopOutcome => ({
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

/** A loop outcome whose fix run spent `tokens` (unpriced: no costUSD) — the token cap's evidence. */
export const outcomeWithFixTokens = (pr: number, tokens: number): ReviewLoopOutcome => ({
  ...fakeOutcome(pr),
  fixReport: {
    ...fixReportWithCost(0),
    usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
});

/** A loop outcome whose fix run spent `costUSD` — the sweep cap's evidence. */
export const outcomeWithFixCost = (pr: number, costUSD: number): ReviewLoopOutcome => ({
  ...fakeOutcome(pr),
  fixReport: fixReportWithCost(costUSD),
});

export interface RecordedCall {
  opts: ReviewLoopOpts;
}

/** The DI fake loop: records every opts, resolves or throws per PR. */
export const fakeLoop =
  (
    calls: RecordedCall[],
    behavior: (pr: number, opts: ReviewLoopOpts) => Promise<ReviewLoopOutcome>,
  ): typeof runReviewLoop =>
  async (opts: ReviewLoopOpts): Promise<ReviewLoopOutcome> => {
    calls.push({ opts });
    return behavior(opts.pr, opts);
  };

export const baseDeps = (gh: GhFn, loop: typeof runReviewLoop): SelfReviewLoopDeps => ({
  gh,
  git: async (): Promise<GhResult> => ({ code: 0, stdout: tempJournalRoot(), stderr: '' }),
  nowMs: () => 1_700_000_000_000,
  loop,
});

export const baseCfg = (over: Partial<SelfReviewLoopCfg> = {}) => ({
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
export const tempJournalRoot = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'self-review-loop-journal-'));
  tempRoots.push(root);
  return root;
};

/** Drains the temp journal roots tempJournalRoot registered (one afterEach per test file). */
export const cleanupTempRoots = (): void => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
};
