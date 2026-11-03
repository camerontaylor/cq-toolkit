// E3 slice 2 — tests for verifyReviewOutcome
// (src/ops/review/verifyReviewOutcome.ts; UC §2 row 37).
//
// Split provenance: the untrustworthy-fetch cases moved verbatim from
// test/ops/review/verifyReviewOutcome.test.ts; the shared fixtures live in
// `verifyReviewOutcome.helpers.ts`.
//
// Pinned here:
//   7. Untrustworthy fetches throw loudly (server-side GraphQL errors;
//      missing reviewThreads payload; non-array REST payload; MIXED page
//      payload `[[c1],"junk"]`; missing/non-string head sha; comment
//      entries without a numeric id; RESOLVED thread nodes without a
//      string id) — a throw can never be misread as NO PROGRESS.
import { describe, expect, test } from 'vitest';
import type { GhFn } from '../../../src/adapters/forge-github/gh.js';
import { snapshotPrState } from '../../../src/adapters/forge-github/snapshotPrState.js';
import { COORDS, NOW, fakeGh, snapshotOpts } from './verifyReviewOutcome.helpers.js';

// ---------------------------------------------------------------------------
// 7. Untrustworthy fetches throw (never silently "NO PROGRESS")
// ---------------------------------------------------------------------------

describe('untrustworthy fetches throw loudly', () => {
  test.each([
    [
      'server-side GraphQL errors',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            if (args.includes('graphql')) {
              return {
                code: 0,
                stdout: JSON.stringify({ errors: [{ message: 'Bad credentials' }] }),
                stderr: '',
              };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /GraphQL errors:/,
    ],
    [
      'missing reviewThreads payload',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            if (args.includes('graphql'))
              return {
                code: 0,
                stdout: JSON.stringify({ data: { repository: { pullRequest: {} } } }),
                stderr: '',
              };
            return run(args);
          },
          nowMs: NOW,
        }),
      /no reviewThreads payload/,
    ],
    [
      'non-array REST payload',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/comments'))
              return { code: 0, stdout: JSON.stringify({ oops: true }), stderr: '' };
            return run(args);
          },
          nowMs: NOW,
        }),
      /non-array payload/,
    ],
    [
      'MIXED page payload (array pages alongside junk — flat() would silently drop the pages)',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/comments')) {
              return { code: 0, stdout: JSON.stringify([[{ id: 9001 }], 'junk']), stderr: '' };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /MIXED page payload/,
    ],
    [
      'a PR payload with NO head (a headless snapshot could never see new-commit movement)',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/pulls/') && !path.includes('/comments')) {
              return { code: 0, stdout: JSON.stringify({ head: null }), stderr: '' };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /no usable head sha/,
    ],
    [
      'a PR payload with a NON-STRING head sha',
      async (run: GhFn) =>
        snapshotPrState({
          ...COORDS,
          run: async (args) => {
            const path = args.find((a) => a.startsWith('repos/')) ?? '';
            if (path.includes('/pulls/') && !path.includes('/comments')) {
              return { code: 0, stdout: JSON.stringify({ head: { sha: 123 } }), stderr: '' };
            }
            return run(args);
          },
          nowMs: NOW,
        }),
      /no usable head sha/,
    ],
  ])('%s → snapshotPrState rejects', async (_label, runWith, pattern) => {
    const base = fakeGh({ headSha: 'abc123' });
    await expect(runWith(base)).rejects.toThrow(pattern);
  });

  test('a REST comment entry WITHOUT a numeric id throws (filtering would silently shrink the reply evidence)', async () => {
    await expect(
      snapshotPrState(
        snapshotOpts({
          headSha: 'abc123',
          pullsComments: [{ id: 9001 }, { id: 'not-a-number' }],
        }),
      ),
    ).rejects.toThrow(/comment entry without a numeric id/);
  });

  test('a RESOLVED reviewThread node WITHOUT a string id throws (a filtered id would hide a resolved thread)', async () => {
    await expect(
      snapshotPrState(
        snapshotOpts({
          headSha: 'abc123',
          threads: [
            { id: 'PRRT_1', isResolved: true },
            { id: 456, isResolved: true },
          ],
        }),
      ),
    ).rejects.toThrow(/RESOLVED reviewThread node without a string id/);
  });

  test('a NON-ARRAY errors payload throws (the wire does not have to honor the types)', async () => {
    const base = fakeGh({ headSha: 'abc123' });
    const run: GhFn = async (args) => {
      if (args.includes('graphql')) {
        return {
          code: 0,
          stdout: JSON.stringify({ errors: { message: 'not an array' } }),
          stderr: '',
        };
      }
      return base(args);
    };
    await expect(snapshotPrState({ ...COORDS, run, nowMs: NOW })).rejects.toThrow(
      /non-array errors payload for octo\/widget#7/,
    );
  });

  test('a NON-ARRAY reviewThreads.nodes payload throws', async () => {
    const base = fakeGh({ headSha: 'abc123' });
    const run: GhFn = async (args) => {
      if (args.includes('graphql')) {
        return {
          code: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                pullRequest: { reviewThreads: { nodes: 'nope', pageInfo: { hasNextPage: false } } },
              },
            },
          }),
          stderr: '',
        };
      }
      return base(args);
    };
    await expect(snapshotPrState({ ...COORDS, run, nowMs: NOW })).rejects.toThrow(
      /non-array reviewThreads\.nodes for octo\/widget#7/,
    );
  });

  test('validation fails loud before any argv is built', async () => {
    const calls: string[][] = [];
    const run = fakeGh({ headSha: 'abc123' }, calls);
    await expect(snapshotPrState({ ...COORDS, owner: '../evil', run, nowMs: NOW })).rejects.toThrow(
      /snapshotPrState:/,
    );
    // DOT SEGMENTS: "." and ".." pass the charset but ride into the request
    // path as relative segments — rejected like any other bad spelling.
    await expect(snapshotPrState({ ...COORDS, owner: '.', run, nowMs: NOW })).rejects.toThrow(
      /snapshotPrState:/,
    );
    await expect(snapshotPrState({ ...COORDS, repo: '..', run, nowMs: NOW })).rejects.toThrow(
      /snapshotPrState:/,
    );
    await expect(snapshotPrState({ ...COORDS, pr: 0, run, nowMs: NOW })).rejects.toThrow(
      /snapshotPrState:/,
    );
    expect(calls).toEqual([]);
  });
});
