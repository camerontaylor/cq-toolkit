// fetchReviewState unit tests — fail-closed hardening: server-side GraphQL
// errors, missing thread/review collections, and a nonzero gh exit all
// reject (never return partial state), with the server/stderr text carried.
// Split provenance: test/ops/review/fetchReviewState.test.ts was split by
// subject into fetchReviewState.{pagination,caps,lag,inputValidation,
// wireMapping,slurpShapes,failClosed}.test.ts; the injected gh seam and
// payload builders live in fetchReviewState.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchReviewState } from '../../../src/adapters/forge-github/fetchReviewState.js';
import { GhError } from '../../../src/adapters/forge-github/gh.js';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import { fakeGh, INPUT } from './fetchReviewState.helpers.js';

describe('fetchReviewState', () => {
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

  test('a nonzero gh exit rejects with GhError (fail closed, stderr carried)', async () => {
    const run: GhFn = async () => ({ code: 1, stdout: '', stderr: 'gh: permission denied' });
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(GhError);
    await expect(fetchReviewState(INPUT, {}, run)).rejects.toThrow(/permission denied/);
  });
});
