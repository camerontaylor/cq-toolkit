// The shared review-thread vocabulary — E1 slice 1 (goal E1: address-review
// fetch lane).
//
// The SINGLE shared surface with the merge ops family: WS-F counts
// unresolved threads through countUnresolvedThreads and imports nothing else
// from review/. Pure data + pure functions only — no I/O, no gh calls; the
// shapes here are what the fetch layer (later E1 slices) fills from GraphQL
// reviewThreads / reviews and the flat REST review-comment collection.
//
// Fail-closed bias: wherever the data is ambiguous, the vocabulary counts it
// as blocking or drops it — it never guesses outward.

/** One comment in a review thread — the root or a reply — as fetched. */
export interface ThreadComment {
  /** GitHub login, or null when the account is unavailable/anonymized. */
  authorLogin: string | null;
  /** GitHub actor type when supplied. */
  authorType?: string | null | undefined;
  /** Markdown body. */
  body: string;
  /** ISO 8601 timestamp, or null when not resolvable. */
  createdAt: string | null;
}

/**
 * One review thread: the GraphQL reviewThread node plus its root comment
 * (`authorLogin`/`createdAt`/`body` are the ROOT comment's; replies carry
 * the rest of the conversation, reconstructed by attachRestReplies).
 */
export interface ReviewThread {
  /** The GraphQL reviewThread node id. */
  id: string;
  /**
   * The thread's ROOT comment's REST-side numeric id (GraphQL `databaseId`)
   * — the anchor attachRestReplies matches REST reply chains against (the
   * real GitHub join). Null when unavailable: the thread cannot anchor
   * replies, fail closed.
   */
  rootDatabaseId: number | null;
  /** File the thread anchors to, or null when it is a whole-review thread. */
  path: string | null;
  /** Line the thread anchors to, or null when unanchored/outdated. */
  line: number | null;
  /** Whether the thread has been resolved. */
  isResolved: boolean;
  /** Whether the diff the thread anchors to is outdated. */
  isOutdated: boolean;
  /** The ROOT comment's author login, or null when unavailable. */
  authorLogin: string | null;
  /** The ROOT comment's actor type, when supplied. */
  authorType?: string | null | undefined;
  /** The ROOT comment's ISO 8601 timestamp, or null when not resolvable. */
  createdAt: string | null;
  /** The ROOT comment's markdown body. */
  body: string;
  /** The thread's non-root comments, in createdAt order. */
  replies: ThreadComment[];
}

/**
 * One submitted review (the GraphQL review node): an approve/request-changes
 * verdict or a standalone review comment, kept for the summary-comment
 * surface the responder must address.
 */
export interface ReviewSummary {
  /** The GraphQL review node id. */
  id: string;
  /** Reviewer's GitHub login, or null when unavailable. */
  authorLogin: string | null;
  /** The review verdict, or null when still pending. */
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED' | null;
  /** The review's markdown body (may be empty for bare verdicts). */
  body: string;
  /** The head commit the review was submitted against, when GitHub supplied it. */
  commitOid?: string | null | undefined;
  /** The actor type returned by GitHub (User, Bot, Organization, …). */
  authorType?: string | null | undefined;
  /** The reviewer's association with the repository, when supplied. */
  authorAssociation?: string | null | undefined;
  /** ISO 8601 submission timestamp, or null when not resolvable. */
  submittedAt: string | null;
}

/** One review comment from the flat REST collection (root or reply). */
export interface RestComment {
  /** The REST numeric comment id. */
  id: number;
  /** The GraphQL node id, or null when unavailable (chain then unanchorable). */
  nodeId: string | null;
  /** Author's GitHub login, or null when unavailable. */
  authorLogin: string | null;
  /** Author's GitHub actor type, when supplied. */
  authorType?: string | null | undefined;
  /** Markdown body. */
  body: string;
  /** ISO 8601 timestamp, or null when not resolvable. */
  createdAt: string | null;
  /** The replied-to comment's REST id, or null for a chain root. */
  inReplyToId: number | null;
}

/**
 * The fail-closed flag every fetch result carries: when a page of data was
 * cut short, `truncated` is true and `truncatedBecause` names each cause —
 * a consumer that ignores the flag sees complete-looking data, so the flag
 * must never be silently dropped.
 */
export interface TruncationFlag {
  /** Whether any fetched page was cut short. */
  truncated: boolean;
  /** Machine-readable cause per truncation (e.g. a GraphQL page cap hit). */
  truncatedBecause: string[];
}

/**
 * Count UNRESOLVED threads whose root author is external to the responder —
 * the external-threads rule: in the merge-prs context the responder is the
 * PR author, so threads the PR author opened on their own PR do not block;
 * `opts.excludeAuthorLogin` names that responder. A thread with a null
 * author counts as external (fail closed: an unknown author could be an
 * external reviewer). Pure and total.
 */
export function countUnresolvedThreads(
  threads: readonly ReviewThread[],
  opts: { excludeAuthorLogin?: string | null },
): number {
  let count = 0;
  for (const thread of threads) {
    if (thread.isResolved) continue;
    if (opts.excludeAuthorLogin != null && thread.authorLogin === opts.excludeAuthorLogin) continue;
    count += 1;
  }
  return count;
}

/**
 * The attachRestReplies report. `attached` counts comments appended to
 * threads' replies. `unmatchedRoots` holds the chain-root REST comment of
 * every conversation that anchors to NO known thread — in fetchReviewState
 * terms that is reviewThreads lag (a fresh thread the GraphQL snapshot has
 * not caught up to), and the fetch layer turns a non-empty list into the
 * fail-closed `reviewThreads.lag` truncation reason.
 */
export interface AttachReport {
  /** Number of comments appended to threads' replies. */
  attached: number;
  /** Chain roots of conversations no known thread claims (deduped by id). */
  unmatchedRoots: RestComment[];
}

/**
 * Reconstruct reply chains from the flat REST review-comment collection.
 * GraphQL reviewThreads.comments(first: 1) yields only each thread's ROOT
 * comment, so the conversation's tail comes from REST: each reply chain is
 * walked inReplyToId up to its root REST comment, whose numeric `id` is
 * matched against a thread's `rootDatabaseId` (the real GitHub join: GraphQL
 * thread root comment `databaseId` ↔ REST comment `id`), and the chain's
 * non-root comments are appended to that thread's replies in createdAt order
 * (null timestamps last; ties keep REST order). A conversation whose chain
 * root matches no known thread is not attached — its root comment is
 * REPORTED in the return value (reviewThreads lag at thread granularity;
 * unresolvable chains — dangling parent or cycle — stay silently dropped,
 * they are attributable to nothing). Mutates the passed threads in place,
 * appending to each matched thread's replies.
 */
export function attachRestReplies(
  threads: ReviewThread[],
  restReviewComments: readonly RestComment[],
): AttachReport {
  const byId = new Map<number, RestComment>();
  for (const comment of restReviewComments) {
    byId.set(comment.id, comment);
  }
  const threadByRootDatabaseId = new Map<number, ReviewThread>();
  for (const thread of threads) {
    if (thread.rootDatabaseId !== null) {
      threadByRootDatabaseId.set(thread.rootDatabaseId, thread);
    }
  }

  /** A comment's chain root, or null when it cannot be resolved. */
  const chainRoot = (comment: RestComment): RestComment | null => {
    const seen = new Set<number>([comment.id]);
    let current = comment;
    for (;;) {
      if (current.inReplyToId === null) return current;
      if (seen.has(current.inReplyToId)) return null; // malformed cycle
      const parent = byId.get(current.inReplyToId);
      if (parent === undefined) return null; // dangling parent
      seen.add(current.inReplyToId);
      current = parent;
    }
  };

  const replies = new Map<ReviewThread, RestComment[]>();
  const unmatchedRoots: RestComment[] = [];
  const reportedRootIds = new Set<number>();
  let attached = 0;
  for (const comment of restReviewComments) {
    if (comment.inReplyToId === null) {
      // A chain root: it IS the thread body. Known → nothing to attach;
      // unknown → reviewThreads lag (the snapshot predates this thread).
      if (!threadByRootDatabaseId.has(comment.id) && !reportedRootIds.has(comment.id)) {
        reportedRootIds.add(comment.id);
        unmatchedRoots.push(comment);
      }
      continue;
    }
    const root = chainRoot(comment);
    if (root === null) continue;
    const thread = threadByRootDatabaseId.get(root.id);
    if (thread === undefined) {
      // The conversation anchors to no known thread: report its ROOT once.
      if (!reportedRootIds.has(root.id)) {
        reportedRootIds.add(root.id);
        unmatchedRoots.push(root);
      }
      continue;
    }
    const bucket = replies.get(thread);
    if (bucket === undefined) {
      replies.set(thread, [comment]);
    } else {
      bucket.push(comment);
    }
    attached += 1;
  }

  for (const [thread, chain] of replies) {
    chain.sort((a, b) => {
      if (a.createdAt === null || b.createdAt === null) {
        return a.createdAt === b.createdAt ? 0 : a.createdAt === null ? 1 : -1;
      }
      return a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
    });
    thread.replies.push(
      ...chain.map((reply) => ({
        authorLogin: reply.authorLogin,
        body: reply.body,
        createdAt: reply.createdAt,
      })),
    );
  }
  return { attached, unmatchedRoots };
}
