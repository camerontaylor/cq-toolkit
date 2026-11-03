// fetchReviewState unit tests — --slurp payload shape tolerance and
// rejection: an already-FLAT item array is one retained page, while a
// non-array payload or mixed pages-and-junk fails closed.
// Split provenance: test/ops/review/fetchReviewState.test.ts was split by
// subject into fetchReviewState.{pagination,caps,lag,inputValidation,
// wireMapping,slurpShapes,failClosed}.test.ts; the injected gh seam and
// payload builders live in fetchReviewState.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchReviewState } from '../../../src/adapters/forge-github/fetchReviewState.js';
import {
  fakeGh,
  graphqlPayload,
  INPUT,
  restPullComment,
  threadNode,
} from './fetchReviewState.helpers.js';

describe('fetchReviewState', () => {
  test('a --slurp payload that is ALREADY FLAT is tolerated as ONE retained page (R2-9a under the shared normalizer)', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          {
            hasNextPage: false,
            endCursor: null,
            nodes: [threadNode('T1', { rootDatabaseId: 100 })],
          },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      // A FLAT item array where the page-array shape is expected — an older
      // gh variant (or pages merged WITHOUT --slurp): read as ONE retained
      // page, never a throw. (The root comment's id anchors to T1's
      // rootDatabaseId so the lag trap stays out of the picture — this test
      // pins the SHAPE, not lag.)
      pullsComments: [
        restPullComment(100, { nodeId: 'PRRC_100' }),
        restPullComment(101, { inReplyTo: 100, nodeId: null }),
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.restReviewComments).toHaveLength(2);
    expect(state.truncated).toBe(false);
  });

  test.each([
    ['a NON-ARRAY payload', { oops: true }, /non-array payload/],
    ['a MIXED pages-and-junk payload', [[restPullComment(1)], 'junk'], /MIXED page payload/],
  ])('%s satisfies neither slurp shape → fails closed', async (_label, pullsComments, pattern) => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          { hasNextPage: false, endCursor: null, nodes: [] },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      pullsComments,
    });
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(pattern);
  });
});
