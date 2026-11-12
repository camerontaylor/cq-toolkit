import { HistoryInputSchema, HistorySchema } from './internal/reviewOperation.js';
import { QueueUnsupported, ReviewInputError } from './internal/queueClient.js';
import { git, reviewOp } from './internal/localReview.js';
import type { QueueTransport } from './internal/queueProtocol.js';

async function resolveCommit(cwd: string, ref: string) {
  return git(cwd, 'rev-parse', '--verify', '--end-of-options', ref + '^{commit}');
}

/** Attached branch is an observation; a detached head simply omits it. */
async function observedBranch(cwd: string): Promise<string | undefined> {
  try {
    const branch = await git(cwd, 'symbolic-ref', '--short', '-q', 'HEAD');
    return branch || undefined;
  } catch {
    return undefined;
  }
}

export const makeHistory = (transport?: QueueTransport) =>
  reviewOp(
    HistoryInputSchema,
    async (i, getClient) => {
      const client = getClient();
      const capabilities = await client.capabilities();
      if (
        !capabilities.operations.includes('review-history') ||
        !capabilities.features.includes('review-history-v1')
      )
        throw new QueueUnsupported('review-history capability unavailable');
      const page = { limit: i.limit, cursor: i.cursor };
      let wire;
      if (i.requestId !== undefined) {
        wire = { v: 1 as const, op: 'review-history' as const, request_id: i.requestId, ...page };
      } else {
        const head = i.head ?? (await git(i.cwd, 'rev-parse', '--verify', 'HEAD^{commit}'));
        const base =
          i.base === undefined
            ? await git(i.cwd, 'merge-base', i.target, head)
            : await resolveCommit(i.cwd, i.base);
        if (i.base !== undefined && (await git(i.cwd, 'merge-base', base, head)) !== base)
          throw new ReviewInputError('explicit base must be an ancestor of HEAD');
        const branch = i.branch ?? (await observedBranch(i.cwd));
        wire = {
          v: 1 as const,
          op: 'review-history' as const,
          repo: i.repo,
          target: i.target,
          base_commit: base,
          base_tree: await git(i.cwd, 'rev-parse', base + '^{tree}'),
          head_commit: head,
          head_tree: await git(i.cwd, 'rev-parse', head + '^{tree}'),
          ...(i.task === undefined ? {} : { task: i.task }),
          ...(branch === undefined ? {} : { branch }),
          ...(i.predecessor === undefined ? {} : { predecessor: i.predecessor }),
          ...page,
        };
      }
      return HistorySchema.parse(await client.request(wire));
    },
    transport,
  );
