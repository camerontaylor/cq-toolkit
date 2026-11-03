// fetchReviewState unit tests — REST-vs-GraphQL lag: a fresh REST thread or
// review that GraphQL has not seen yet truncates with reviewThreads.lag /
// reviews.lag and is never fabricated; a capped loop records its pageCap
// instead of misattributing lag; thread and review lag combine in a stable
// order.
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
  test('a REST-only fresh thread (reviewThreads lag) truncates with reviewThreads.lag and is not fabricated', async () => {
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
      pullsComments: [
        [
          {
            id: 100,
            node_id: 'PRRC_100',
            user: { login: 'reviewer' },
            body: 'known root',
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 400,
            node_id: 'PRRC_400',
            user: { login: 'late-reviewer' },
            body: 'fresh thread root',
            created_at: '2026-01-01T05:00:00Z',
          },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.threads.map((t) => t.rootDatabaseId)).toEqual([100]); // the fresh thread is NOT fabricated
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.lag']);
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
          {
            id: 700,
            node_id: 'PRR_known',
            user: { login: 'reviewer' },
            state: 'CHANGES_REQUESTED',
            body: 'known',
            submitted_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 701,
            node_id: 'PRR_fresh',
            user: { login: 'late-reviewer' },
            state: 'APPROVED',
            body: 'fresh review',
            submitted_at: '2026-01-01T09:00:00Z',
          },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.reviews.map((r) => r.id)).toEqual(['PRR_known']); // the fresh review is NOT fabricated
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviews.lag']);
  });

  test('a CAPPED reviews loop does not misattribute reviews.lag — pageCap is the recorded cause, the lag check is skipped', async () => {
    // The GraphQL reviews loop caps at page 1 while MORE GraphQL pages
    // exist, so the loop provably under-saw. REST carries a review whose
    // node_id lives on the UNSEEN page: the cap is the actual cause —
    // flagging reviews.lag on top would misattribute the known failure
    // mode.
    const run = fakeGh({
      graphql: (cursors: { threadsAfter: string; reviewsAfter: string }) =>
        cursors.reviewsAfter === ''
          ? graphqlPayload(
              { hasNextPage: false, endCursor: null, nodes: [] },
              { hasNextPage: true, endCursor: 'r2', nodes: [reviewNode('PRR_known')] },
            )
          : graphqlPayload(
              { hasNextPage: false, endCursor: null, nodes: [] },
              {
                hasNextPage: false,
                endCursor: null,
                nodes: [reviewNode('PRR_known'), reviewNode('PRR_unseen')],
              },
            ),
      restReviews: [
        [
          {
            id: 701,
            node_id: 'PRR_unseen',
            user: { login: 'late-reviewer' },
            state: 'APPROVED',
            body: 'on the unseen page',
            submitted_at: '2026-01-01T09:00:00Z',
          },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, { reviewPages: 1 }, run);
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toContain('reviews.pageCap');
    expect(state.truncatedBecause).not.toContain('reviews.lag');
  });

  test('thread lag and review lag combine: both reasons, stable order', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          {
            hasNextPage: false,
            endCursor: null,
            nodes: [threadNode('T1', { rootDatabaseId: 100 })],
          },
          { hasNextPage: false, endCursor: null, nodes: [reviewNode('PRR_known')] },
        ),
      pullsComments: [
        [
          {
            id: 100,
            node_id: 'PRRC_100',
            user: { login: 'reviewer' },
            body: 'known root',
            created_at: '2026-01-01T00:00:00Z',
          },
          {
            id: 400,
            node_id: 'PRRC_400',
            user: { login: 'late-reviewer' },
            body: 'fresh thread root',
            created_at: '2026-01-01T05:00:00Z',
          },
        ],
      ],
      restReviews: [
        [
          {
            id: 700,
            node_id: 'PRR_fresh',
            user: { login: 'late-reviewer' },
            state: 'APPROVED',
            body: 'fresh review',
            submitted_at: '2026-01-01T09:00:00Z',
          },
        ],
      ],
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.lag', 'reviews.lag']);
  });
});
