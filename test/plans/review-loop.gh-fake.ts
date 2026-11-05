// Split provenance: test/plans/review-loop.helpers.ts was split by subject;
// this module carries the routed gh fake (snapshots, the review-state fetch,
// replies and resolves).
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import { flagValue, ok } from './review-loop.argv.js';
import { BEFORE_SHA, COORDS, HEAD_REF, type LoopWorld } from './review-loop.fixtures.js';

/** The routed gh fake: snapshots, the review-state fetch, replies, resolves. */
export const fakeGh =
  (world: LoopWorld, log: string[][]): GhFn =>
  async (args) => {
    log.push(args);
    if (args.includes('graphql')) {
      const query = flagValue(args, 'query');
      if (query.includes('resolveReviewThread')) {
        // The fake echoes the REQUESTED thread and fails loudly on a
        // missing or unexpected one — a resolve can only ever target a
        // thread the world actually served.
        const threadId = flagValue(args, 'threadId');
        const known = world.threads.flatMap((node) =>
          typeof node === 'object' && node !== null && 'id' in node
            ? [String((node as { id: unknown }).id)]
            : [],
        );
        if (threadId === '' || !known.includes(threadId)) {
          return {
            code: 1,
            stdout: '',
            stderr: `fake gh: resolveReviewThread for unexpected threadId ${JSON.stringify(threadId)}`,
          };
        }
        // The pending-resolve carry pin (codex P2): run 1 refuses the
        // resolve so it stays unrecorded behind a posted reply.
        if (world.resolveReviewThreadFails === true) {
          return { code: 1, stdout: '', stderr: 'resolve failed (world-driven)' };
        }
        return ok(
          JSON.stringify({
            data: { resolveReviewThread: { thread: { id: threadId, isResolved: true } } },
          }),
        );
      }
      if (query.includes('threadsCursor')) {
        return ok(
          JSON.stringify({
            data: {
              repository: {
                pullRequest: {
                  reviewThreads: {
                    nodes: world.resolvedThreads,
                    pageInfo: { hasNextPage: false, endCursor: null },
                  },
                },
              },
            },
          }),
        );
      }
      return ok(
        JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                author: { login: 'prauthor' },
                headRefName: HEAD_REF,
                headRefOid: world.sha,
                reviewThreads: {
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: world.threads,
                },
                reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] },
              },
            },
          },
        }),
      );
    }
    const path = args.find((a) => a.startsWith('repos/')) ?? '';
    if (path === `repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}`) {
      return ok(JSON.stringify({ head: { sha: world.laggingOrigin ? BEFORE_SHA : world.sha } }));
    }
    if (
      path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}/reviews`)
    ) {
      return ok('[]');
    }
    if (path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/pulls/${String(COORDS.pr)}/`)) {
      return ok(JSON.stringify(world.pullsComments));
    }
    if (path.startsWith(`repos/${COORDS.owner}/${COORDS.repo}/issues/${String(COORDS.pr)}/`)) {
      return ok(JSON.stringify(world.issueComments));
    }
    return { code: 1, stdout: '', stderr: `unexpected gh argv: ${args.join(' ')}` };
  };
