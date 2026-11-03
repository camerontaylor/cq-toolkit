// fetchReviewState unit tests — every cap truncates fail-closed (never
// throws): reviewThreadPages → reviewThreads.pageCap, reviewPages →
// reviews.pageCap, restPages → restComments.pageCap (data kept alongside the
// flag), malformed caps refuse at entry, and an uncontinuable cursor is a
// pageCap rather than a crash.
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
        {
          id: 5000,
          node_id: 'IC_5000',
          user: { login: 'bystander' },
          body: 'issue',
          created_at: '2026-01-01T02:00:00Z',
        },
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

  test('hasNextPage with a null endCursor cannot continue: pageCap reason, data kept (R2-9b)', async () => {
    const run = fakeGh({
      graphql: () =>
        graphqlPayload(
          {
            hasNextPage: true,
            endCursor: null,
            nodes: [threadNode('T1', { rootDatabaseId: 100 })],
          },
          { hasNextPage: false, endCursor: null, nodes: [] },
        ),
    });
    const state = await fetchReviewState(INPUT, {}, run);
    expect(state.truncated).toBe(true);
    expect(state.truncatedBecause).toEqual(['reviewThreads.pageCap']);
    expect(state.threads).toHaveLength(1); // page data still returned
  });
});
