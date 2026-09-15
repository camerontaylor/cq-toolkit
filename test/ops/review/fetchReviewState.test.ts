// E1 slice 2 — tests for fetchReviewState (src/ops/review/fetchReviewState.ts).
//
// Pinned here:
//   1. Single-page happy path: threads + reviews + BOTH REST collections
//      land in the shared vocabulary, and thread replies are reconstructed
//      from the flat REST review comments via attachRestReplies (GraphQL
//      thread comments are root-only by design).
//   2. The manual GraphQL cursor loop: both collections advance together
//      across pages, with the cursors carried as `threadsAfter`/`reviewsAfter`
//      -f strings (never a variable named `query` — the I11 collision rule).
//   3. Every cap truncates fail-closed (never throws): reviewThreadPages →
//      `reviewThreads.pageCap`, reviewPages → `reviews.pageCap`, restPages →
//      `restComments.pageCap` (review comments) / `issueComments.pageCap`
//      (issue comments) — data kept alongside the flag.
//   4. Null-safety: deleted accounts (GraphQL `author: null`) and absent REST
//      fields (`user`, `in_reply_to_id`, `node_id`, `created_at`) map to
//      null; snake_case maps explicitly to the shared camelCase vocabulary.
//   5. GhError propagation: a nonzero gh exit rejects with GhError.
//   6. Fail-closed hardening: a REST-only fresh thread (reviewThreads lag)
//      truncates with `reviewThreads.lag` and is never fabricated into a
//      thread; malformed --slurp shapes, missing collections, server-side
//      GraphQL errors, and unsafe owner/repo spellings all reject.
//
// The gh seam is INJECTED (a fake GhFn routing on argv) — no spawned
// process here; the CLI/fake-gh-script path is slice 3.
import { describe, expect, test } from 'vitest';
import { fetchReviewState } from '../../../src/ops/review/fetchReviewState.js';
import type { FetchReviewStateInput } from '../../../src/ops/review/fetchReviewState.js';
import { GhError } from '../../../src/ops/review/gh.js';
import type { GhFn, GhResult } from '../../../src/ops/review/gh.js';

// ---------------------------------------------------------------------------
// Fake gh — routes on argv: `graphql` → the fixture's page builder;
// a `repos/…` path → the matching REST collection array.
// ---------------------------------------------------------------------------

/** Value of the `<name>=…` argv entry gh `-f/-F` args carry. */
const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** The fake's fixtures: a GraphQL page builder plus the three REST arrays. */
interface FakeGhFixture {
  graphql: (cursors: { threadsAfter: string; reviewsAfter: string }) => unknown;
  pullsComments?: unknown;
  issuesComments?: unknown;
  /** REST PR reviews (page arrays) — used for the reviews-lag cross-check. */
  restReviews?: unknown;
}

/** Build an injected GhFn that records graphql (threadsAfter|reviewsAfter) calls. */
const fakeGh = (
  fixture: FakeGhFixture,
  calls?: string[],
): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    const restPath = args.find((a) => a.startsWith('repos/'));
    if (restPath !== undefined) {
      // '/reviews' first: the reviews path also contains '/pulls/'.
      const body = restPath.includes('/reviews')
        ? fixture.restReviews
        : restPath.includes('/pulls/')
          ? fixture.pullsComments
          : fixture.issuesComments;
      return { code: 0, stdout: JSON.stringify(body ?? []), stderr: '' };
    }
    if (calls !== undefined) {
      calls.push(`${flagValue(args, 'threadsAfter')}|${flagValue(args, 'reviewsAfter')}`);
    }
    return {
      code: 0,
      stdout: JSON.stringify(
        fixture.graphql({
          threadsAfter: flagValue(args, 'threadsAfter'),
          reviewsAfter: flagValue(args, 'reviewsAfter'),
        }),
      ),
      stderr: '',
    };
  };

// ---------------------------------------------------------------------------
// Payload builders (GraphQL wire shapes, camelCase as gh returns them)
// ---------------------------------------------------------------------------

const INPUT: FetchReviewStateInput = { owner: 'octo', repo: 'widget', pr: 7 };

/** One GraphQL reviewThread node with a root comment (carrying databaseId). */
const threadNode = (
  id: string,
  overrides?: { isResolved?: boolean; authorLogin?: string | null; rootDatabaseId?: number },
) => ({
  id,
  isResolved: overrides?.isResolved ?? false,
  isOutdated: false,
  path: 'src/a.ts',
  line: 3,
  comments: {
    nodes: [
      {
        databaseId: overrides?.rootDatabaseId ?? 100,
        author: overrides?.authorLogin === undefined ? { login: 'reviewer' } : overrides.authorLogin === null ? null : { login: overrides.authorLogin },
        body: `root ${id}`,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  },
});

/** One GraphQL review node. */
const reviewNode = (id: string, state = 'CHANGES_REQUESTED', authorLogin: string | null = 'reviewer') => ({
  id,
  author: authorLogin === null ? null : { login: authorLogin },
  state,
  body: `review ${id}`,
  submittedAt: '2026-01-01T00:00:00Z',
});

/** A full graphql payload from two page descriptors. */
const graphqlPayload = (
  threads: { hasNextPage: boolean; endCursor: string | null; nodes: ReturnType<typeof threadNode>[] },
  reviews: { hasNextPage: boolean; endCursor: string | null; nodes: ReturnType<typeof reviewNode>[] },
  prAuthorLogin: string | null = 'pr-author',
) => ({
  data: {
    repository: {
      pullRequest: {
        author: prAuthorLogin === null ? null : { login: prAuthorLogin },
        headRefName: 'feature/lantern',
        headRefOid: 'abc123',
        reviewThreads: { pageInfo: { hasNextPage: threads.hasNextPage, endCursor: threads.endCursor }, nodes: threads.nodes },
        reviews: { pageInfo: { hasNextPage: reviews.hasNextPage, endCursor: reviews.endCursor }, nodes: reviews.nodes },
      },
    },
  },
});

/** A REST review-comment wire object (snake_case as gh returns it). */
const restPullComment = (id: number, overrides?: { inReplyTo?: number; nodeId?: string | null; login?: string | null }) => ({
  id,
  node_id: overrides?.nodeId ?? `N${id}`,
  user: overrides?.login === undefined ? { login: 'reviewer' } : overrides.login === null ? null : { login: overrides.login },
  body: `rest ${id}`,
  created_at: '2026-01-01T01:00:00Z',
  ...(overrides?.inReplyTo === undefined ? {} : { in_reply_to_id: overrides.inReplyTo }),
});

// ---------------------------------------------------------------------------
// fetchReviewState
// ---------------------------------------------------------------------------

describe('fetchReviewState', () => {
  test('single page: threads + reviews + both REST collections, replies attached from REST', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [threadNode('T1', { rootDatabaseId: 100 })] },
          { hasNextPage: false, endCursor: null, nodes: [reviewNode('R1')] },
        ),
      pullsComments: [
        [
          { id: 100, node_id: 'PRRC_100', user: { login: 'reviewer' }, body: 'root', created_at: '2026-01-01T00:00:00Z' },
          restPullComment(101, { inReplyTo: 100 }),
        ],
      ],
      issuesComments: [
        [
          { id: 500, node_id: 'IC_500', user: { login: 'bystander' }, body: 'issue comment', created_at: '2026-01-01T02:00:00Z' },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.repo).toEqual({ owner: 'octo', name: 'widget' });
    expect(state.pr).toBe(7);
    expect(state.authorLogin).toBe('pr-author');
    expect(state.headRefName).toBe('feature/lantern');
    expect(state.headRefOid).toBe('abc123');
    expect(state.threads).toHaveLength(1);
    expect(state.threads[0]?.rootDatabaseId).toBe(100);
    expect(state.threads[0]?.body).toBe('root T1');
    expect(state.reviews).toHaveLength(1);
    expect(state.reviews[0]?.state).toBe('CHANGES_REQUESTED');
    expect(state.restReviewComments).toHaveLength(2);
    expect(state.restIssueComments).toHaveLength(1);
    expect(state.restIssueComments[0]?.inReplyToId).toBeNull();
    expect(state.truncated).toBe(false);
    expect(state.truncatedBecause).toEqual([]);
  });

  test('replies attach: REST in_reply_to_id chains anchor via the root databaseId ↔ REST id join', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          {
            hasNextPage: false,
            endCursor: null,
            nodes: [threadNode('T1', { rootDatabaseId: 100 }), threadNode('T2', { rootDatabaseId: 200 })],
          },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      pullsComments: [
        [
          { id: 100, node_id: 'PRRC_100', user: { login: 'reviewer' }, body: 'root', created_at: '2026-01-01T00:00:00Z' },
          restPullComment(101, { inReplyTo: 100 }),
          restPullComment(102, { inReplyTo: 101, login: 'author' }),
          { id: 200, node_id: 'PRRC_200', user: { login: 'other' }, body: 'root 2', created_at: '2026-01-01T00:00:00Z' },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.threads[0]?.replies.map((r) => [r.authorLogin, r.body])).toEqual([
      ['reviewer', 'rest 101'],
      ['author', 'rest 102'],
    ]);
    expect(state.threads[1]?.replies).toEqual([]);
  });

  test('GraphQL cursor loop: two pages per loop, cursors ride threadsAfter/reviewsAfter -f strings', async () => {
    const calls: string[] = [];
    const run = fakeGh(
      {
        graphql: ({ threadsAfter }) =>
          threadsAfter === ''
            ? graphqlPayload(
                { hasNextPage: true, endCursor: 't2', nodes: [threadNode('T1')] },
                { hasNextPage: true, endCursor: 'r2', nodes: [reviewNode('R1')] },
              )
            : graphqlPayload(
                { hasNextPage: false, endCursor: null, nodes: [threadNode('T2')] },
                { hasNextPage: false, endCursor: null, nodes: [reviewNode('R2')] },
              ),
      },
      calls,
    );
    const state = await fetchReviewState(INPUT, {}, run);
    expect(calls).toEqual(['|', 't2|r2']);
    expect(state.threads.map((t) => t.id)).toEqual(['T1', 'T2']);
    expect(state.reviews.map((r) => r.id)).toEqual(['R1', 'R2']);
    expect(state.truncated).toBe(false);
  });

  test('reviewThreadPages cap truncates with reviewThreads.pageCap and keeps page data', async () => {
    const calls: string[] = [];
    const run = fakeGh(
      {
        graphql: () =>
          graphqlPayload(
            { hasNextPage: true, endCursor: 't2', nodes: [threadNode('T1')] },
            { hasNextPage: false, endCursor: null, nodes: [] },
          ),
      },
      calls,
    );
    const state = await fetchReviewState(INPUT, { reviewThreadPages: 1 }, run);
    expect(calls).toEqual(['|']); // capped after page 1 — no second request
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.pageCap']);
    expect(state.threads).toHaveLength(1); // data still returned, fail closed downstream
  });

  test('reviewPages cap truncates with reviews.pageCap', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [] },
          { hasNextPage: true, endCursor: 'r2', nodes: [reviewNode('R1')] },
        ),
    });
    const state = await fetchReviewState(INPUT, { reviewPages: 1 }, run);
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviews.pageCap']);
    expect(state.reviews).toHaveLength(1);
  });

  test('malformed caps are rejected before any fetch — NaN/Infinity/negative/fractional never disable the limits', async () => {
    // PR #63 review (Codex P2): restPages: NaN makes the retention
    // comparison always false (every page kept, truncated: false) and
    // reviewThreadPages: Infinity removes the request bound — a malformed
    // cap must fail loud at entry, not silently disable the conservative
    // limit. Validation fires before the run seam is ever consulted.
    const neverRuns = () => {
      throw new Error('the run seam must not be consulted for malformed caps');
    };
    for (const caps of [
      { restPages: Number.NaN },
      { restPages: Number.POSITIVE_INFINITY },
      { restPages: -1 },
      { restPages: 1.5 },
      { reviewThreadPages: Number.NaN },
      { reviewThreadPages: Number.NEGATIVE_INFINITY },
      { reviewThreadPages: -2 },
      { reviewThreadPages: 0.5 },
      { reviewPages: Number.NaN },
      { reviewPages: Number.POSITIVE_INFINITY },
      { reviewPages: -1 },
      { reviewPages: 2.25 },
    ]) {
      await expect(fetchReviewState(INPUT, caps, neverRuns as never)).rejects.toThrow(
        /caps\.(restPages|reviewThreadPages|reviewPages) must be a nonnegative safe integer/,
      );
    }
  });

  test('restPages cap keeps the first pages of the --slurp output and truncates (both REST collections)', async () => {
    // --slurp yields an outer array of PAGE arrays; the cap is on pages.
    // The fillers reply to a dangling parent (999): unattributable chains
    // are dropped silently, so the ONLY reason here is the page cap.
    const pullPages = [
      [restPullComment(1000, { inReplyTo: 999 }), restPullComment(1001, { inReplyTo: 999 })],
      [restPullComment(1002, { inReplyTo: 999 }), restPullComment(1003, { inReplyTo: 999 })],
      [restPullComment(1004, { inReplyTo: 999 })],
    ];
    const issuePages = [
      [
        { id: 5000, node_id: 'IC_5000', user: { login: 'bystander' }, body: 'issue', created_at: '2026-01-01T02:00:00Z' },
      ],
    ];
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [] },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      pullsComments: pullPages,
      issuesComments: issuePages,
    });
    const state = await fetchReviewState(INPUT, { restPages: 2 }, run); // cap = 2 pages
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['restComments.pageCap']); // issues: 1 page, under cap
    expect(state.restReviewComments).toHaveLength(4); // first two pages kept, third dropped
    expect(state.restIssueComments).toHaveLength(1);
  });

  test('a REST-only fresh thread (reviewThreads lag) truncates with reviewThreads.lag and is not fabricated', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [threadNode('T1', { rootDatabaseId: 100 })] },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      pullsComments: [
        [
          { id: 100, node_id: 'PRRC_100', user: { login: 'reviewer' }, body: 'known root', created_at: '2026-01-01T00:00:00Z' },
          { id: 400, node_id: 'PRRC_400', user: { login: 'late-reviewer' }, body: 'fresh thread root', created_at: '2026-01-01T05:00:00Z' },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.threads.map((t) => t.rootDatabaseId)).toEqual([100]); // the fresh thread is NOT fabricated
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.lag']);
  });

  test('rejects an owner/repo that does not match ^[A-Za-z0-9_.-]+$', async () => {
    const run: GhFn = async () => ({ code: 0, stdout: '[]', stderr: '' });
    await expect(fetchReviewState({ owner: 'octo/x', repo: 'widget', pr: 7 }, {}, run)).rejects.toThrow(
      /owner\/repo must match/,
    );
    await expect(fetchReviewState({ owner: 'octo', repo: '../escape', pr: 7 }, {}, run)).rejects.toThrow(
      /owner\/repo must match/,
    );
    // DOT SEGMENTS: "." and ".." pass the charset but ride into the request
    // path as relative segments — rejected like any other bad spelling.
    await expect(fetchReviewState({ owner: '.', repo: 'widget', pr: 7 }, {}, run)).rejects.toThrow(
      /owner\/repo must match/,
    );
    await expect(fetchReviewState({ owner: 'octo', repo: '..', pr: 7 }, {}, run)).rejects.toThrow(
      /owner\/repo must match/,
    );
  });

  test('rejects a pr that is not a positive safe integer (string-pr JS callers included)', async () => {
    const run: GhFn = async () => ({ code: 0, stdout: '[]', stderr: '' });
    // A JS caller (or JSON.parse'd data) can smuggle a string past the type.
    const stringPr = '7?per_page=1#' as unknown as number;
    await expect(fetchReviewState({ owner: 'octo', repo: 'widget', pr: stringPr }, {}, run)).rejects.toThrow(
      /pr must be a positive safe integer/,
    );
    await expect(fetchReviewState({ owner: 'octo', repo: 'widget', pr: 0 }, {}, run)).rejects.toThrow(
      /pr must be a positive safe integer/,
    );
    await expect(fetchReviewState({ owner: 'octo', repo: 'widget', pr: -3 }, {}, run)).rejects.toThrow(
      /pr must be a positive safe integer/,
    );
  });

  test('a fresh REST-only review (reviews lag) truncates with exactly reviews.lag and is not fabricated', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [] },
          { hasNextPage: false, endCursor: null, nodes: [reviewNode('PRR_known')] },
        ),
      restReviews: [
        [
          { id: 700, node_id: 'PRR_known', user: { login: 'reviewer' }, state: 'CHANGES_REQUESTED', body: 'known', submitted_at: '2026-01-01T00:00:00Z' },
          { id: 701, node_id: 'PRR_fresh', user: { login: 'late-reviewer' }, state: 'APPROVED', body: 'fresh review', submitted_at: '2026-01-01T09:00:00Z' },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.reviews.map((r) => r.id)).toEqual(['PRR_known']); // the fresh review is NOT fabricated
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviews.lag']);
  });

  test('thread lag and review lag combine: both reasons, stable order', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [threadNode('T1', { rootDatabaseId: 100 })] },
          { hasNextPage: false, endCursor: null, nodes: [reviewNode('PRR_known')] },
        ),
      pullsComments: [
        [
          { id: 100, node_id: 'PRRC_100', user: { login: 'reviewer' }, body: 'known root', created_at: '2026-01-01T00:00:00Z' },
          { id: 400, node_id: 'PRRC_400', user: { login: 'late-reviewer' }, body: 'fresh thread root', created_at: '2026-01-01T05:00:00Z' },
        ],
      ],
      restReviews: [
        [
          { id: 700, node_id: 'PRR_fresh', user: { login: 'late-reviewer' }, state: 'APPROVED', body: 'fresh review', submitted_at: '2026-01-01T09:00:00Z' },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.lag', 'reviews.lag']);
  });

  test('a GraphQL errors payload fails closed carrying the server messages', async () => {
    const run = fakeGh({
      graphql: () => ({
        data: null,
        errors: [
          { message: 'Variable "$threadsAfter" of required type "String!" was not provided.' },
          { message: 'second problem' },
        ],
      }),
    });
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(
      /GraphQL errors: Variable "\$threadsAfter".*; second problem/,
    );
  });

  test.each([
    {
      name: 'a null reviewThreads collection fails closed naming it',
      omit: 'reviewThreads' as const,
      message: /no reviewThreads collection/,
    },
    {
      name: 'a null reviews collection fails closed naming it',
      omit: 'reviews' as const,
      message: /no reviews collection/,
    },
  ])('$name', async ({ omit, message }) => {
    const run = fakeGh({
      graphql: () => {
        const pullRequest: Record<string, unknown> = {
          author: { login: 'pr-author' },
          headRefName: 'x',
          headRefOid: 'abc',
          reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
          reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
        };
        delete pullRequest[omit];
        return { data: { repository: { pullRequest } } };
      },
    });
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(message);
  });

  test('asymmetric pagination: threads capped at page 1 while reviews walk 3 pages — no duplicate threads', async () => {
    const run = fakeGh({
      graphql: ({ reviewsAfter }) =>
        reviewsAfter === ''
          ? graphqlPayload(
              { hasNextPage: true, endCursor: 't2', nodes: [threadNode('T1', { rootDatabaseId: 100 })] },
              { hasNextPage: true, endCursor: 'r2', nodes: [reviewNode('R1')] },
            )
          : reviewsAfter === 'r2'
            ? graphqlPayload(
                // Threads are done (capped): this page comes back ignored.
                { hasNextPage: true, endCursor: 't2', nodes: [] },
                { hasNextPage: true, endCursor: 'r3', nodes: [reviewNode('R2')] },
              )
            : graphqlPayload(
                { hasNextPage: false, endCursor: null, nodes: [] },
                { hasNextPage: false, endCursor: null, nodes: [reviewNode('R3')] },
              ),
    });
    const state = await fetchReviewState(INPUT, { reviewThreadPages: 1 }, run);
    expect(state.threads.map((t) => t.id)).toEqual(['T1']); // capped once, never re-pushed
    expect(state.reviews.map((r) => r.id)).toEqual(['R1', 'R2', 'R3']);
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.pageCap']); // exactly one entry
  });

  test('null authors tolerated end to end (deleted accounts never throw)', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          {
            hasNextPage: false,
            endCursor: null,
            nodes: [threadNode('T1', { authorLogin: null }), threadNode('T2', { isResolved: true })],
          },
          { hasNextPage: false, endCursor: null, nodes: [reviewNode('R1', 'CHANGES_REQUESTED', null)] },
          null,
        ),
      pullsComments: [[{ id: 100, node_id: 'PRRC_100', user: null, body: 'anon root', created_at: null }]],
      issuesComments: [[{ id: 500, user: undefined, body: 'anon', created_at: '2026-01-01T02:00:00Z' }]],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.authorLogin).toBeNull();
    expect(state.threads[0]?.authorLogin).toBeNull();
    expect(state.reviews[0]?.authorLogin).toBeNull();
    expect(state.restReviewComments[0]?.authorLogin).toBeNull();
    expect(state.restReviewComments[0]?.createdAt).toBeNull();
    expect(state.restIssueComments[0]?.authorLogin).toBeNull();
  });

  test('snake_case REST wire format maps explicitly to the shared vocabulary', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [] },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      pullsComments: [
        [
          {
            id: 42,
            node_id: 'PRRC_42',
            user: { login: 'carol' },
            body: 'mapped',
            created_at: '2026-01-01T03:00:00Z',
            in_reply_to_id: 41,
          },
          { id: 43, node_id: null, user: { login: 'dave' }, body: 'bare', created_at: '2026-01-01T03:01:00Z' },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.restReviewComments[0]).toEqual({
      id: 42,
      nodeId: 'PRRC_42',
      authorLogin: 'carol',
      body: 'mapped',
      createdAt: '2026-01-01T03:00:00Z',
      inReplyToId: 41,
    });
    expect(state.restReviewComments[1]?.nodeId).toBeNull();
    expect(state.restReviewComments[1]?.inReplyToId).toBeNull();
  });

  test('a --slurp payload that is not an array of page arrays fails closed (R2-9a)', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [] },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      // A FLAT item array where the page-array shape is required.
      pullsComments: [restPullComment(1), restPullComment(2)],
    });
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(/non-page-array payload/);
  });

  test('hasNextPage with a null endCursor cannot continue: pageCap reason, data kept (R2-9b)', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: true, endCursor: null, nodes: [threadNode('T1', { rootDatabaseId: 100 })] },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.pageCap']);
    expect(state.threads).toHaveLength(1); // page data still returned
  });

  test('a nonzero gh exit rejects with GhError (fail closed, stderr carried)', async () => {
    const run: GhFn = async () => ({ code: 1, stdout: '', stderr: 'gh: permission denied' });
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(GhError);
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(/permission denied/);
  });
});
