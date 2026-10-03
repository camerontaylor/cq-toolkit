import { describe, expect, test } from 'vitest';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';
import { judgeAcceptance } from '../../src/selfhost/acceptance.js';
import { CONSERVATIVE_TRUST_POLICY } from '../../src/selfhost/merge-recheck.js';

const HEAD = 'a'.repeat(40);
const BASE = 'b'.repeat(40);
const THREAD_ID = 'PRRT_123456789';
const ok = (body: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });

describe('§7 A4 empty-commit thread-ID forgery', () => {
  test('a commit named after a still-open thread cannot substitute for reviewer resolution', async () => {
    const calls: string[] = [];
    const gh: GhFn = (args) => {
      calls.push(args.join(' '));
      if (args[0] !== 'api') throw new Error(`unexpected gh command: ${args.join(' ')}`);
      if (args[1] === 'graphql') {
        return Promise.resolve(
          ok({
            data: {
              repository: {
                pullRequest: {
                  state: 'OPEN',
                  isDraft: false,
                  author: { login: 'author', __typename: 'User' },
                  headRefOid: HEAD,
                  baseRefOid: BASE,
                  baseRefName: 'merge-queue',
                  reviewThreads: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: THREAD_ID,
                        isResolved: false,
                        comments: {
                          nodes: [
                            {
                              databaseId: 123456789,
                              author: { login: 'reviewer' },
                            },
                          ],
                        },
                      },
                    ],
                  },
                  reviews: {
                    pageInfo: { hasNextPage: false, endCursor: null },
                    nodes: [
                      {
                        id: 'review-1',
                        author: { login: 'reviewer', __typename: 'User' },
                        authorAssociation: 'MEMBER',
                        state: 'APPROVED',
                        submittedAt: '2026-09-26T00:10:00Z',
                        commit: { oid: HEAD },
                        body: 'LGTM',
                      },
                    ],
                  },
                  timelineItems: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
                },
              },
            },
          }),
        );
      }
      if (args[1]?.endsWith('/reviews?per_page=100')) {
        return Promise.resolve(ok([[{ node_id: 'review-1', state: 'APPROVED' }]]));
      }
      if (args[1]?.endsWith('/comments?per_page=100')) {
        return Promise.resolve(ok([[{ id: 123456789, in_reply_to_id: null }]]));
      }
      throw new Error(`unexpected gh API: ${args.join(' ')}`);
    };
    // The attacker has pushed `git commit --allow-empty -m PRRT_123456789`.
    // The resulting head is the subject; the API still reports the thread as open.
    const verdict = await judgeAcceptance(
      { gh, owner: 'octo', repo: 'widget', policy: CONSERVATIVE_TRUST_POLICY },
      { pr: 7, subject: HEAD, base: 'merge-queue', state: 'open' },
    );
    expect(verdict.verdict).toBe('fail');
    expect(verdict.report.some((line) => line.includes('unresolved external threads: 1'))).toBe(
      true,
    );
    expect(calls).toHaveLength(3);
  });
});
