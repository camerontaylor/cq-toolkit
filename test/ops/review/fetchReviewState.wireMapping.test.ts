// fetchReviewState unit tests — null-safety and wire mapping: deleted
// accounts (GraphQL `author: null`) and absent REST fields (`user`,
// `in_reply_to_id`, `node_id`, `created_at`) map to null, and snake_case
// REST fields map explicitly to the shared camelCase vocabulary.
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
  reviewNode,
  threadNode,
} from './fetchReviewState.helpers.js';

describe('fetchReviewState', () => {
  test('null authors tolerated end to end (deleted accounts never throw)', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          {
            hasNextPage: false,
            endCursor: null,
            nodes: [
              threadNode('T1', { authorLogin: null }),
              threadNode('T2', { isResolved: true }),
            ],
          },
          {
            hasNextPage: false,
            endCursor: null,
            nodes: [reviewNode('R1', 'CHANGES_REQUESTED', null)],
          },
          null,
        ),
      pullsComments: [
        [{ id: 100, node_id: 'PRRC_100', user: null, body: 'anon root', created_at: null }],
      ],
      issuesComments: [
        [{ id: 500, user: undefined, body: 'anon', created_at: '2026-01-01T02:00:00Z' }],
      ],
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
          {
            id: 43,
            node_id: null,
            user: { login: 'dave' },
            body: 'bare',
            created_at: '2026-01-01T03:01:00Z',
          },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.restReviewComments[0]).toEqual({
      id: 42,
      nodeId: 'PRRC_42',
      authorLogin: 'carol',
      authorType: null,
      body: 'mapped',
      createdAt: '2026-01-01T03:00:00Z',
      inReplyToId: 41,
    });
    expect(state.restReviewComments[1]?.nodeId).toBeNull();
    expect(state.restReviewComments[1]?.inReplyToId).toBeNull();
  });
});
