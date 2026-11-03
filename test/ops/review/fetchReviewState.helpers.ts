// Split provenance: test/ops/review/fetchReviewState.test.ts was split by
// subject into the fetchReviewState.{pagination,caps,lag,inputValidation,
// wireMapping,slurpShapes,failClosed}.test.ts siblings in this directory.
// This module holds the shared injected gh seam and payload builders; it
// declares no tests.
import type { FetchReviewStateInput } from '../../../src/adapters/forge-github/fetchReviewState.js';
import type { GhFn, GhResult } from '../../../src/adapters/forge-github/gh.js';

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
export const fakeGh =
  (fixture: FakeGhFixture, calls?: string[]): GhFn =>
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

export const INPUT: FetchReviewStateInput = { owner: 'octo', repo: 'widget', pr: 7 };

/** One GraphQL reviewThread node with a root comment (carrying databaseId). */
export const threadNode = (
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
        author:
          overrides?.authorLogin === undefined
            ? { login: 'reviewer' }
            : overrides.authorLogin === null
              ? null
              : { login: overrides.authorLogin },
        body: `root ${id}`,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  },
});

/** One GraphQL review node. */
export const reviewNode = (
  id: string,
  state = 'CHANGES_REQUESTED',
  authorLogin: string | null = 'reviewer',
) => ({
  id,
  author: authorLogin === null ? null : { login: authorLogin },
  state,
  body: `review ${id}`,
  submittedAt: '2026-01-01T00:00:00Z',
});

/** A full graphql payload from two page descriptors. */
export const graphqlPayload = (
  threads: {
    hasNextPage: boolean;
    endCursor: string | null;
    nodes: ReturnType<typeof threadNode>[];
  },
  reviews: {
    hasNextPage: boolean;
    endCursor: string | null;
    nodes: ReturnType<typeof reviewNode>[];
  },
  prAuthorLogin: string | null = 'pr-author',
) => ({
  data: {
    repository: {
      pullRequest: {
        author: prAuthorLogin === null ? null : { login: prAuthorLogin },
        headRefName: 'feature/lantern',
        headRefOid: 'abc123',
        reviewThreads: {
          pageInfo: { hasNextPage: threads.hasNextPage, endCursor: threads.endCursor },
          nodes: threads.nodes,
        },
        reviews: {
          pageInfo: { hasNextPage: reviews.hasNextPage, endCursor: reviews.endCursor },
          nodes: reviews.nodes,
        },
      },
    },
  },
});

/** A REST review-comment wire object (snake_case as gh returns it). */
export const restPullComment = (
  id: number,
  overrides?: { inReplyTo?: number; nodeId?: string | null; login?: string | null },
) => ({
  id,
  node_id: overrides?.nodeId ?? `N${id}`,
  user:
    overrides?.login === undefined
      ? { login: 'reviewer' }
      : overrides.login === null
        ? null
        : { login: overrides.login },
  body: `rest ${id}`,
  created_at: '2026-01-01T01:00:00Z',
  ...(overrides?.inReplyTo === undefined ? {} : { in_reply_to_id: overrides.inReplyTo }),
});
