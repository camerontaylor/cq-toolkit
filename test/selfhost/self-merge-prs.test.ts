// Slice 2 (goal T4.1) — tests for the scheduled merge-dispatch ENTRY module
// (src/selfhost/self-merge-prs.ts).
//
// Pinned here (the pipeline itself is pinned by test/ops/merge/runPrs.test.ts
// — this file pins the DEPLOYMENT WIRING):
//   1. buildRunInput, the exported pure input builder: every field comes
//      from the frozen SelfhostDefaults or the cfg — baseBranch
//      'merge-queue', protectedBranch 'main', wallClockMs 300000 (the #137
//      ladder arming), the served driver ModelSpec, sessionsDir under the
//      journal root, and the injected clock — nothing invented.
//   2. The real run: candidates come from the REAL fetchMergeCandidates over
//      a faked gh wire (candidates.test.ts's fixture style), and the merge
//      runs THROUGH the governed composition — the injected registry view's
//      merge.runPrs op receives the built input (parsed at the dispatch
//      boundary) and its MergePrsOutcome passes through with the RunReport
//      riding alongside; the fetch's exclusions ride through too.
//   3. A non-ok job result → outcome null, report the evidence (never a
//      fabricated outcome).
//   4. Dry run: the pure decision table classifies WITHOUT dispatch — the
//      injected op is never consulted, no plan is built; the verdicts and
//      exclusions are the whole payload.
//   5. A failing listing fetch throws (the candidates contract).
import { describe, expect, test } from 'vitest';
import type { OpRegistryView } from '../../src/kernel/runner.js';
import type { OpRegistryEntry, OpResult } from '../../src/kernel/types.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import { RunMergePrsInputSchema } from '../../src/ops/merge/registry.js';
import type { MergePrsOutcome, RunMergePrsInput } from '../../src/ops/merge/runPrs.js';
import { buildRunInput, runSelfMergePrs } from '../../src/selfhost/self-merge-prs.js';
import { SelfhostDefaults } from '../../src/selfhost/config.js';

const OWNER = 'octo';
const REPO = 'widget';
const REPO_PATH = `${OWNER}/${REPO}`;
const LIST_PATH = `repos/${REPO_PATH}/pulls?state=open&per_page=100`;

// -- Wire fixtures (candidates.test.ts's style, minimal) ---------------------

const pullRow = (n: number, overrides?: { draft?: boolean; mergeable_state?: string }) => ({
  number: n,
  state: 'open',
  draft: overrides?.draft ?? false,
  mergeable_state: overrides?.mergeable_state ?? 'dirty',
  user: { login: `pr-author-${String(n)}` },
  head: { ref: `pr-${String(n)}`, sha: `sha-${String(n)}`, repo: { full_name: REPO_PATH } },
  base: { ref: 'merge-queue' },
});

const commitPayload = (date: string) => ({ commit: { committer: { date }, author: { date } } });

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

/** The fake gh serving a canned candidates fetch (one DIRTY pr, one draft). */
const fetchGh =
  (opts?: { failListing?: boolean }): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    const path = args[0] === 'api' && typeof args[1] === 'string' ? args[1] : '';
    if (path === LIST_PATH) {
      if (opts?.failListing === true) {
        return { code: 1, stdout: '', stderr: 'injected listing failure' };
      }
      return json([pullRow(7), pullRow(9, { draft: true })]);
    }
    if (path.startsWith(`repos/${REPO_PATH}/commits/`)) {
      return json(commitPayload('2026-01-02T00:00:00Z'));
    }
    if (/^repos\/[^/]+\/[^/]+\/pulls\/\d+$/.test(path)) {
      // The single-PR enrichment GET — the authoritative payload for
      // mergeable_state AND every eligibility field (candidates.ts
      // re-binds its fork/draft gates to it), so the fake carries the full
      // same-repo, non-draft wire shape, not just the state.
      const pr = Number(path.slice(path.lastIndexOf('/') + 1));
      return json({
        state: 'open',
        draft: false,
        mergeable: false,
        mergeable_state: 'dirty',
        head: { ref: `pr-${String(pr)}`, sha: `sha-${String(pr)}`, repo: { full_name: REPO_PATH } },
        base: { ref: 'merge-queue' },
      });
    }
    if (path === 'graphql') {
      const prEntry = args.find((a) => a.startsWith('pr='));
      const pr = prEntry === undefined ? 0 : Number(prEntry.slice('pr='.length));
      return json(emptyGraphql(pr));
    }
    if (/^repos\/[^/]+\/[^/]+\/(pulls|issues)\/\d+\/(comments|reviews)(\?.*)?$/.test(path)) {
      return json([]);
    }
    return { code: 1, stdout: '', stderr: `unrouted gh invocation: ${args.join(' ')}` };
  };

/** A canned pipeline outcome (what merge.runPrs would return). */
const cannedOutcome: MergePrsOutcome = {
  firstPass: { merged: [7], retargeted: [], stale: [], failed: [], blocked: [] },
  secondPass: null,
  resolutions: [],
  needsHuman: [],
  diagnosis: { summary: 'merged 1; needs-human 0; causes 0', needsHuman: [], causes: [] },
};

/**
 * The scripted registry view: merge.runPrs resolves to an op that records
 * the PARSED input it was dispatched with and returns `result` (a frozen
 * OpResult). Everything else is absent (the composition may only ever reach
 * merge.runPrs).
 */
const scriptedView = (seen: RunMergePrsInput[], result: OpResult<unknown>): OpRegistryView => ({
  get: (name) =>
    name === 'merge.runPrs'
      ? ({
          name: 'merge.runPrs',
          inputSchema: RunMergePrsInputSchema,
          importer: async (): Promise<(input: RunMergePrsInput) => Promise<OpResult<unknown>>> => {
            return async (input: RunMergePrsInput) => {
              seen.push(input);
              return result;
            };
          },
        } as unknown as OpRegistryEntry<never, never>)
      : undefined,
});

const baseCfg = { owner: OWNER, repo: REPO, repoRoot: '/checkout', journalRoot: '/j' };

describe('buildRunInput (the pure input builder)', () => {
  test('every field rides the frozen defaults or the cfg — nothing invented', () => {
    const input = buildRunInput([], { repoRoot: '/checkout', journalRoot: '/j' }, 1234);
    expect(input).toEqual({
      baseBranch: 'merge-queue', // SelfhostDefaults.baseBranch
      repoRoot: '/checkout',
      prs: [],
      protectedBranch: 'main', // SelfhostDefaults.protectedBranch
      wallClockMs: 300_000, // SelfhostDefaults.perJobWallClockMs (the #137 ladder)
      modelSpec: { provider: 'ai-sdk', model: 'glm-5.3-flash' }, // SelfhostDefaults.driver
      sessionsDir: '/j/sessions',
      nowMs: 1234,
    });
    // The default journal root applies when no override was passed.
    expect(buildRunInput([], { repoRoot: '/checkout' }, 0).sessionsDir).toBe(
      '/checkout/.selfhost/journal/sessions',
    );
  });
});

describe('runSelfMergePrs — real run', () => {
  test('fetches candidates, dispatches the built input through the scripted op, rides the outcome + report + exclusions', async () => {
    const seen: RunMergePrsInput[] = [];
    const view = scriptedView(seen, { status: 'ok', value: cannedOutcome });
    const result = await runSelfMergePrs(
      { gh: fetchGh(), driverRegistryView: view, nowMs: () => 5_000 },
      baseCfg,
    );

    expect(result.dryRun).toBeUndefined(); // the real-run branch
    if (result.dryRun === true) throw new Error('unreachable');
    // The ONE scripted op got the built input (post-parse).
    expect(seen).toHaveLength(1);
    const input = seen[0];
    if (input === undefined) throw new Error('unreachable');
    expect(input.baseBranch).toBe('merge-queue');
    expect(input.protectedBranch).toBe('main');
    expect(input.wallClockMs).toBe(SelfhostDefaults.perJobWallClockMs);
    expect(input.modelSpec).toEqual(SelfhostDefaults.driver);
    expect(input.sessionsDir).toBe('/j/sessions');
    expect(input.nowMs).toBe(5_000);
    expect(input.prs.map((candidate) => candidate.pr)).toEqual([7]); // the draft never enters
    expect(input.repoRoot).toBe('/checkout');
    // The outcome passes through verbatim; the governed report rides along.
    expect(result.outcome).toEqual(cannedOutcome);
    expect(result.report.counts.done).toBe(1);
    expect(result.report.stoppedEarly).toBe(false);
    // The fetch's exclusion bookkeeping rides through for the workflow log.
    expect(result.excluded).toEqual([{ pr: 9, reason: 'draft' }]);
  });

  test('a non-ok job result → outcome null, the report is the evidence', async () => {
    const seen: RunMergePrsInput[] = [];
    const view = scriptedView(seen, { status: 'failed', error: 'git refused' });
    const result = await runSelfMergePrs(
      { gh: fetchGh(), driverRegistryView: view, nowMs: () => 0 },
      baseCfg,
    );
    if (result.dryRun === true) throw new Error('unreachable');
    expect(result.outcome).toBeNull();
    expect(result.report.counts.failed).toBe(1);
    expect(result.report.jobs[0]?.result).toEqual({ status: 'failed', error: 'git refused' });
  });
});

describe('runSelfMergePrs — dry run', () => {
  test('classifies without dispatch: the op is never consulted, verdicts + exclusions are the payload', async () => {
    const seen: RunMergePrsInput[] = [];
    const view = scriptedView(seen, { status: 'ok', value: cannedOutcome });
    const result = await runSelfMergePrs(
      { gh: fetchGh(), driverRegistryView: view, nowMs: () => 5_000 },
      { ...baseCfg, dryRun: true },
    );

    expect(seen).toEqual([]); // no plan was ever built — the op never consulted
    expect(result).toEqual({
      dryRun: true,
      excluded: [{ pr: 9, reason: 'draft' }],
      candidateCount: 1,
      // DIRTY → row 2 fires before any evidence row: deterministic verdict.
      classification: [
        { pr: 7, verdict: 'conflicting', reason: 'merge_conflicts', unresolvedExternalThreads: 0 },
      ],
    });
  });
});

describe('runSelfMergePrs — fetch failures', () => {
  test('a failing listing call throws (never a fabricated empty run)', async () => {
    await expect(
      runSelfMergePrs({ gh: fetchGh({ failListing: true }), nowMs: () => 0 }, baseCfg),
    ).rejects.toThrow(/injected listing failure/);
  });
});
