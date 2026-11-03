// E3 slice 2 — tests for verifyReviewOutcome
// (src/ops/review/verifyReviewOutcome.ts; UC §2 row 37).
//
// Split provenance: the snapshotPrState cases moved verbatim from
// test/ops/review/verifyReviewOutcome.test.ts; the shared gh fixtures live in
// `verifyReviewOutcome.helpers.ts`.
//
// Pinned here:
//   5. snapshotPrState against a routed fake GhFn: head.sha extracted,
//      both REST collections collected, resolved ids from GraphQL, `at` =
//      injected nowMs; the graphql call passes EXACTLY ONE `-f query=`
//      whose document declares no `$query` variable (the collision rule);
//      REST calls carry --paginate --slurp.
import { describe, expect, test } from 'vitest';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import { snapshotPrState } from '../../../src/adapters/forge-github/snapshotPrState.js';
import { COORDS, NOW, fakeGh, snapshotOpts } from './verifyReviewOutcome.helpers.js';

/** Value of the `<name>=…` argv entry gh `-f/-F` args carry. */
const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** The recorded gh invocations, as compact labels. */
const labelsOf = (calls: string[][]): string[] =>
  calls.map((args) => {
    if (args.includes('graphql')) return 'graphql';
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path.includes('/comments'))
      return path.includes('/issues/') ? 'issue-comments' : 'review-comments';
    return 'pr-object';
  });

// ---------------------------------------------------------------------------
// 5. snapshotPrState against the routed fake
// ---------------------------------------------------------------------------

describe('snapshotPrState', () => {
  test('head sha, both REST collections, resolved ids, and the injected clock land in the snapshot', async () => {
    const calls: string[][] = [];
    const snapshot = await snapshotPrState(
      snapshotOpts(
        {
          headSha: 'abc123',
          pullsComments: [{ id: 9001 }, { id: 9002 }],
          issuesComments: [{ id: 5001 }],
          threads: [
            { id: 'PRRT_1', isResolved: true },
            { id: 'PRRT_2', isResolved: false },
            { id: 'PRRT_3', isResolved: true },
          ],
        },
        calls,
      ),
    );
    expect(snapshot).toEqual({
      at: NOW,
      headSha: 'abc123',
      // The fake serves no user field → authors are null in the snapshot.
      reviewComments: [
        { id: 9001, author: null },
        { id: 9002, author: null },
      ],
      issueComments: [{ id: 5001, author: null }],
      resolvedThreadIds: ['PRRT_1', 'PRRT_3'],
    });
    // The invocation plan: PR object → review comments → issue comments → graphql.
    expect(labelsOf(calls)).toEqual(['pr-object', 'review-comments', 'issue-comments', 'graphql']);
    // E1 lesson: both REST fetches ride --paginate --slurp.
    const reviewArgs = calls[1] ?? [];
    const issueArgs = calls[2] ?? [];
    expect(reviewArgs).toContain('--paginate');
    expect(reviewArgs).toContain('--slurp');
    expect(issueArgs).toContain('--paginate');
    expect(issueArgs).toContain('--slurp');
  });

  test('comment AUTHORS land in the snapshot (snake_case user.login; absent → null)', async () => {
    const snapshot = await snapshotPrState(
      snapshotOpts({
        headSha: 'abc123',
        pullsComments: [
          { id: 9001, user: { login: 'reviewer-1' } },
          { id: 9002, user: {} },
        ],
        issuesComments: [{ id: 5001 }],
      }),
    );
    expect(snapshot.reviewComments).toEqual([
      { id: 9001, author: 'reviewer-1' },
      { id: 9002, author: null },
    ]);
    expect(snapshot.issueComments).toEqual([{ id: 5001, author: null }]);
  });

  test('the graphql call passes EXACTLY ONE `-f query=` whose document declares NO `$query` variable (the collision rule) and paginates via `$threadsCursor`', async () => {
    const calls: string[][] = [];
    await snapshotPrState(snapshotOpts({ threads: [{ id: 'PRRT_1', isResolved: true }] }, calls));
    const graphqlArgs = calls.find((args) => args.includes('graphql')) ?? [];
    const querySlots = graphqlArgs.filter((a) => a.startsWith('query='));
    expect(querySlots).toHaveLength(1);
    const doc = flagValue(graphqlArgs, 'query');
    expect(doc).toContain('reviewThreads');
    expect(doc).toContain('isResolved');
    expect(doc).not.toMatch(/\$query\b/);
    // The pagination walk: the cursor variable is `threadsCursor` (never
    // `query`), fed to `after`, and the page carries its pageInfo.
    expect(doc).toContain('$threadsCursor');
    expect(doc).toContain('after: $threadsCursor');
    expect(doc).toContain('pageInfo');
    expect(flagValue(graphqlArgs, 'owner')).toBe('octo');
    expect(flagValue(graphqlArgs, 'name')).toBe('widget');
    expect(flagValue(graphqlArgs, 'pr')).toBe('7');
    // Page 1 rides NO cursor (an absent cursor variable reads as first page).
    expect(graphqlArgs.some((a) => a.startsWith('threadsCursor='))).toBe(false);
    // Every flag value rides `-f` (pr rides `-F` for the Int! coercion).
    expect(graphqlArgs).toContain('-F');
    const queryIndex = graphqlArgs.indexOf(querySlots[0] ?? '');
    expect(graphqlArgs[queryIndex - 1]).toBe('-f');
  });

  test('reviewThreads PAGINATION: resolved ids aggregate across pages; every page rides exactly one -f query=; later pages carry threadsCursor', async () => {
    const calls: string[][] = [];
    let graphqlPage = 0;
    const base = fakeGh({ headSha: 'abc123' });
    const run: GhFn = async (args) => {
      calls.push(args);
      if (args.includes('graphql')) {
        graphqlPage += 1;
        const page =
          graphqlPage === 1
            ? {
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [
                          { id: 'PRRT_1', isResolved: true },
                          { id: 'PRRT_open', isResolved: false },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: 'CUR1' },
                      },
                    },
                  },
                },
              }
            : {
                data: {
                  repository: {
                    pullRequest: {
                      reviewThreads: {
                        nodes: [{ id: 'PRRT_2', isResolved: true }],
                        pageInfo: { hasNextPage: false, endCursor: 'CUR2' },
                      },
                    },
                  },
                },
              };
        return { code: 0, stdout: JSON.stringify(page), stderr: '' };
      }
      return base(args);
    };
    const snapshot = await snapshotPrState({ ...COORDS, run, nowMs: NOW });
    // Resolved ids aggregated ACROSS pages — the page-1-only read would
    // have hidden PRRT_2 (a "not resolved" lie this walk exists to prevent).
    expect(snapshot.resolvedThreadIds).toEqual(['PRRT_1', 'PRRT_2']);
    expect(graphqlPage).toBe(2);
    const graphqlArgv = calls.filter((args) => args.includes('graphql'));
    // THE COLLISION RULE on EVERY page: exactly one `-f query=`, the
    // document never declares a `$query` variable, the cursor rides its
    // own `threadsCursor` name, and the page carries pageInfo.
    for (const args of graphqlArgv) {
      expect(args.filter((a) => a.startsWith('query='))).toHaveLength(1);
      const doc = flagValue(args, 'query');
      expect(doc).not.toMatch(/\$query\b/);
      expect(doc).toContain('$threadsCursor');
      expect(doc).toContain('pageInfo');
    }
    // Page 1 carries NO cursor; page 2 follows the endCursor via the raw
    // `-f threadsCursor=` slot.
    expect(graphqlArgv[0]?.some((a) => a.startsWith('threadsCursor='))).toBe(false);
    const page2 = graphqlArgv[1] ?? [];
    expect(flagValue(page2, 'threadsCursor')).toBe('CUR1');
    expect(page2[page2.indexOf('threadsCursor=CUR1') - 1]).toBe('-f');
  });

  test('a page advertising hasNextPage WITHOUT an endCursor throws (broken pagination is untrustworthy)', async () => {
    const base = fakeGh({ headSha: 'abc123' });
    const run: GhFn = async (args) => {
      if (args.includes('graphql')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: [],
                    pageInfo: { hasNextPage: true, endCursor: null },
                  },
                },
              },
            },
          }),
          stderr: '',
        };
      }
      return base(args);
    };
    await expect(snapshotPrState({ ...COORDS, run, nowMs: NOW })).rejects.toThrow(
      /hasNextPage without an endCursor/,
    );
  });
});
