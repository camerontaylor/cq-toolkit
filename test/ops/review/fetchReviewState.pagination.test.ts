// fetchReviewState unit tests — the single-page happy path, the
// databaseId ↔ REST-id reply join, the manual GraphQL cursor loop (both
// collections advancing together), and asymmetric pagination.
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
  reviewNode,
  threadNode,
} from './fetchReviewState.helpers.js';

describe('fetchReviewState', () => {
  test('single page: threads + reviews + both REST collections, replies attached from REST', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          {
            hasNextPage: false,
            endCursor: null,
            nodes: [threadNode('T1', { rootDatabaseId: 100 })],
          },
          { hasNextPage: false, endCursor: null, nodes: [reviewNode('R1')] },
        ),
      pullsComments: [
        [
          {
            id: 100,
            node_id: 'PRRC_100',
            user: { login: 'reviewer' },
            body: 'root',
            created_at: '2026-01-01T00:00:00Z',
          },
          restPullComment(101, { inReplyTo: 100 }),
        ],
      ],
      issuesComments: [
        [
          {
            id: 500,
            node_id: 'IC_500',
            user: { login: 'bystander', type: 'Bot' },
            body: 'issue comment',
            created_at: '2026-01-01T02:00:00Z',
          },
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
    expect(state.restIssueComments[0]?.authorType).toBe('Bot');
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
            nodes: [
              threadNode('T1', { rootDatabaseId: 100 }),
              threadNode('T2', { rootDatabaseId: 200 }),
            ],
          },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
      pullsComments: [
        [
          {
            id: 100,
            node_id: 'PRRC_100',
            user: { login: 'reviewer' },
            body: 'root',
            created_at: '2026-01-01T00:00:00Z',
          },
          restPullComment(101, { inReplyTo: 100 }),
          restPullComment(102, { inReplyTo: 101, login: 'author' }),
          {
            id: 200,
            node_id: 'PRRC_200',
            user: { login: 'other' },
            body: 'root 2',
            created_at: '2026-01-01T00:00:00Z',
          },
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

  test('asymmetric pagination: threads capped at page 1 while reviews walk 3 pages — no duplicate threads', async () => {
    const run = fakeGh({
      graphql: ({ reviewsAfter }) =>
        reviewsAfter === ''
          ? graphqlPayload(
              {
                hasNextPage: true,
                endCursor: 't2',
                nodes: [threadNode('T1', { rootDatabaseId: 100 })],
              },
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
});
