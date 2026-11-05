// Shared fixtures for the split of test/ops/review/verifyReviewOutcome.test.ts
// (round-2 pure-move split): the E3 slice 2 cases now live in the
// `verifyReviewOutcome.*.test.ts` subject files beside this module
// (src/ops/review/verifyReviewOutcome.ts; UC §2 row 37).
//
// The gh seam is INJECTED (a fake GhFn routing on argv) — no spawned
// process, no network, no real clocks.
import type {
  PrSnapshot,
  SnapshotPrStateOpts,
} from '../../../src/adapters/forge-github/snapshotPrState.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';

export const NOW = 1_750_000_000_000;
export const COORDS = { owner: 'octo', repo: 'widget', pr: 7 } as const;

/** What the routed fake serves per endpoint. */
export interface FakeGhFixture {
  /** undefined → a healthy default head; null → headless PR; number → a
   * non-string sha (the strict-payload fixtures). */
  headSha?: string | number | null;
  /** Raw JSON payloads for the two REST collections (either slurp shape). */
  pullsComments?: unknown;
  issuesComments?: unknown;
  /** GraphQL reviewThreads nodes (id/isResolved widened for bad fixtures). */
  threads?: Array<{ id: unknown; isResolved: unknown }>;
}

/** Build an injected GhFn that routes on argv and records every argv. */
export const fakeGh =
  (fixture: FakeGhFixture, calls?: string[][]): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    calls?.push(args);
    if (args.includes('graphql')) {
      return {
        code: 0,
        stdout: JSON.stringify({
          data: {
            repository: { pullRequest: { reviewThreads: { nodes: fixture.threads ?? [] } } },
          },
        }),
        stderr: '',
      };
    }
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path.includes('/comments')) {
      const body = path.includes('/issues/') ? fixture.issuesComments : fixture.pullsComments;
      return { code: 0, stdout: JSON.stringify(body ?? []), stderr: '' };
    }
    const prBody =
      fixture.headSha === undefined
        ? { head: { sha: 'abc123' } }
        : fixture.headSha === null
          ? { head: null }
          : { head: { sha: fixture.headSha } };
    return { code: 0, stdout: JSON.stringify(prBody), stderr: '' };
  };

export const snapshotOpts = (fixture: FakeGhFixture, calls?: string[][]): SnapshotPrStateOpts => ({
  ...COORDS,
  run: fakeGh(fixture, calls),
  nowMs: NOW,
});

/** A canonical before-snapshot the per-reason tests mutate one field at a time. */
export const baseSnapshot = (overrides?: Partial<PrSnapshot>): PrSnapshot => ({
  at: NOW,
  headSha: 'abc123',
  reviewComments: [{ id: 9001, author: 'pr-author' }],
  issueComments: [{ id: 5001, author: 'pr-author' }],
  resolvedThreadIds: ['PRRT_old'],
  ...overrides,
});
