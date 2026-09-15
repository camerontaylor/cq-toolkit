// fetchReviewState — E1 slice 2 (goal E1: address-review fetch lane): pull
// the FULL review state of one PR — GraphQL review threads (root comments
// only by design) + submitted reviews, and the flat REST review/issue
// comment collections — into the shared threads.ts vocabulary.
//
// Pagination is manual and fail-closed:
//   - GraphQL: ONE document, two independent `after` cursors
//     (threadsAfter/reviewsAfter) advanced in a single request loop under
//     per-collection page caps. THE COLLISION RULE (I11 trap): the document
//     itself rides gh's `-f query=` slot, so no GraphQL variable may be
//     named `query`. Cursor flags are sent ONLY when a real cursor exists —
//     never as empty strings (the first request omits them entirely).
//   - REST: `gh api --paginate --slurp` (I11 trap: without --paginate gh
//     silently returns page 1 only; and --paginate alone does NOT merge —
//     --slurp, gh >= 2.51, is what yields ONE outer array of page arrays).
//     Pages are fetched at the explicit `?per_page=100`, so the restPages
//     cap is a true PAGE cap, applied client-side before flattening.
// Any cap hit does NOT error: the result carries truncated=true plus a
// truncatedBecause reason per cause, and the data fetched so far still
// comes back — the caller decides (fail closed downstream).
//
// GraphQL thread comments are ROOT-ONLY (comments(first: 1)) AND stale —
// reply chains are reconstructed from REST by attachRestReplies, never from
// GraphQL, anchored on the thread root comment's databaseId ↔ REST id.
import { ghJson, makeGhRunner } from './gh.js';
import type { GhFn } from './gh.js';
import { attachRestReplies } from './threads.js';
import type { RestComment, ReviewSummary, ReviewThread, TruncationFlag } from './threads.js';

/** Which PR to fetch. */
export interface FetchReviewStateInput {
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Pull request number. */
  pr: number;
}

/**
 * Conservative fetch caps. Defaults: 10 pages per GraphQL loop, 20 REST
 * pages. A cap hit never throws — it marks the result truncated (the
 * fail-closed flag) and returns the data fetched so far.
 */
export interface FetchReviewStateCaps {
  /** Max reviewThreads pages (100 threads each) before fail-closed truncation. */
  reviewThreadPages?: number;
  /** Max reviews pages (100 reviews each) before fail-closed truncation. */
  reviewPages?: number;
  /** Max REST pages (fetched at per_page=100, per collection) before truncation. */
  restPages?: number;
}

/**
 * The fetched review state: full data plus the fail-closed truncation flag
 * (extends TruncationFlag — the shared vocabulary's flag shape). Every
 * consumer MUST consult `truncated`/`truncatedBecause` before trusting
 * counts — a cap hit means unknown data may be missing.
 */
export interface RestReviewState extends TruncationFlag {
  /** Repo coordinates, echoed for downstream tools. */
  repo: { owner: string; name: string };
  /** PR number, echoed. */
  pr: number;
  /** PR author login, or null (deleted account) — the external-threads responder. */
  authorLogin: string | null;
  /** Head branch name, or null when unavailable. */
  headRefName: string | null;
  /** Head commit oid, or null when unavailable. */
  headRefOid: string | null;
  /** Review threads with root comments; replies filled from REST below. */
  threads: ReviewThread[];
  /** Submitted reviews (verdicts + standalone review comments). */
  reviews: ReviewSummary[];
  /** Flat REST pull review comments (all conversations, roots included). */
  restReviewComments: RestComment[];
  /** Flat REST issue comments (the PR's general conversation). */
  restIssueComments: RestComment[];
}

/**
 * The one GraphQL document per fetch. Variable names are load-bearing (the
 * I11 collision rule): the document rides gh's `-f query=` slot, so no
 * GraphQL variable may be named `query` — the cursors are threadsAfter and
 * reviewsAfter, sent as `-f` strings ONLY when a real cursor exists (never
 * empty). Thread root comments carry `databaseId` — the REST-side numeric
 * id that anchors reply chains (see attachRestReplies).
 */
const PR_STATE_QUERY = `query ($owner: String!, $name: String!, $pr: Int!, $threadsAfter: String, $reviewsAfter: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      author { login }
      headRefName
      headRefOid
      reviewThreads(first: 100, after: $threadsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          comments(first: 1) {
            nodes { databaseId author { login } body createdAt }
          }
        }
      }
      reviews(first: 100, after: $reviewsAfter) {
        pageInfo { hasNextPage endCursor }
        nodes { id author { login } state body submittedAt }
      }
    }
  }
}`;

/** Minimal shape of the PR object inside the `gh api graphql` payload. */
interface GraphqlPullRequest {
  author: { login: string } | null;
  headRefName: string | null;
  headRefOid: string | null;
  reviewThreads: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      id: string;
      isResolved: boolean;
      isOutdated: boolean;
      path: string | null;
      line: number | null;
      comments: {
        nodes: Array<{
          databaseId: number | null;
          author: { login: string } | null;
          body: string;
          createdAt: string | null;
        }>;
      };
    }[];
  };
  reviews: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      id: string;
      author: { login: string } | null;
      state: string | null;
      body: string;
      submittedAt: string | null;
    }[];
  };
}

/** Minimal shape of the `gh api graphql` payload this function reads. */
interface GraphqlPayload {
  data?: {
    repository?: {
      pullRequest?: GraphqlPullRequest | null;
    } | null;
  };
}

/** Minimal shape of one REST review/issue comment (snake_case wire format). */
interface RawRestComment {
  id: number;
  node_id?: string | null;
  user?: { login?: string } | null;
  body: string;
  created_at?: string | null;
  in_reply_to_id?: number | null;
}

/** Review verdicts the shared vocabulary carries; anything else → null. */
const REVIEW_STATES: readonly string[] = ['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED'];

const isKnownReviewState = (state: string | null): state is Exclude<ReviewSummary['state'], null> =>
  state !== null && REVIEW_STATES.includes(state);

/** GraphQL thread node → ReviewThread (root comment only; replies come from REST). */
const toReviewThread = (node: {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: {
    nodes: Array<{
      databaseId: number | null;
      author: { login: string } | null;
      body: string;
      createdAt: string | null;
    }>;
  };
}): ReviewThread => {
  const root = node.comments.nodes[0];
  return {
    id: node.id,
    // The REST-side anchor for reply chains (root comment's databaseId).
    rootDatabaseId: root?.databaseId ?? null,
    path: node.path ?? null,
    line: node.line ?? null,
    isResolved: node.isResolved,
    isOutdated: node.isOutdated,
    // Deleted root comment (no nodes) → nulls/empty body; never throw.
    authorLogin: root?.author?.login ?? null,
    createdAt: root?.createdAt ?? null,
    body: root?.body ?? '',
    replies: [],
  };
};

/** GraphQL review node → ReviewSummary; unknown verdict states → null. */
const toReviewSummary = (node: {
  id: string;
  author: { login: string } | null;
  state: string | null;
  body: string;
  submittedAt: string | null;
}): ReviewSummary => ({
  id: node.id,
  authorLogin: node.author?.login ?? null,
  state: isKnownReviewState(node.state) ? node.state : null,
  body: node.body,
  submittedAt: node.submittedAt ?? null,
});

/** REST comment wire format → shared RestComment (explicit snake_case map; absent fields → null). */
const toRestComment = (raw: RawRestComment): RestComment => ({
  id: raw.id,
  nodeId: raw.node_id ?? null,
  authorLogin: raw.user?.login ?? null,
  body: raw.body,
  createdAt: raw.created_at ?? null,
  inReplyToId: raw.in_reply_to_id ?? null,
});

/**
 * Fetch one REST collection with `--paginate --slurp` and map it. The path
 * pins `?per_page=100`, so `restPages` is a true PAGE cap: it is applied
 * client-side on the outer array of page arrays that `--slurp` (gh >= 2.51)
 * produces, BEFORE flattening — an oversized fetch keeps its first
 * `restPages` pages and is reported truncated with `reason`.
 */
async function fetchRestComments(
  run: GhFn,
  path: string,
  restPages: number,
  reason: string,
  truncatedBecause: string[],
): Promise<RestComment[]> {
  const raw = await ghJson<RawRestComment[][]>(run, ['api', path, '--paginate', '--slurp']);
  if (!Array.isArray(raw) || raw.some((page) => !Array.isArray(page))) {
    throw new Error(`gh api ${path} --paginate --slurp returned a non-page-array payload`);
  }
  let pages = raw;
  if (pages.length > restPages) {
    truncatedBecause.push(reason);
    pages = pages.slice(0, restPages);
  }
  return pages.flat().map(toRestComment);
}

/**
 * Fetch the full review state of one PR over an injected gh seam (`run` —
 * the tests inject a fake; the CLI passes makeGhRunner(), the default here).
 *
 * GraphQL pagination is a single request loop advancing the two cursors
 * independently, each under its own page cap; a `hasNextPage` observed at
 * the cap (or a missing endCursor) records `reviewThreads.pageCap` /
 * `reviews.pageCap` and stops that loop — never an error. Cursor flags are
 * sent only when a real cursor exists (never as empty strings), and a
 * finished collection stops advancing (and re-reporting) while its sibling
 * keeps paginating. REST collections ride `--paginate --slurp` under a true
 * page cap, recording `restComments.pageCap` / `issueComments.pageCap`.
 * Thread replies are reconstructed from the REST review comments (GraphQL
 * thread comments are root-only by design AND stale — the lag trap).
 * Null-safety: deleted accounts (`author: null`) and absent REST fields map
 * to null, never throw.
 */
export async function fetchReviewState(
  input: FetchReviewStateInput,
  caps?: FetchReviewStateCaps,
  run: GhFn = makeGhRunner(),
): Promise<RestReviewState> {
  const threadPagesCap = caps?.reviewThreadPages ?? 10;
  const reviewPagesCap = caps?.reviewPages ?? 10;
  const restPagesCap = caps?.restPages ?? 20;

  const threads: ReviewThread[] = [];
  const reviews: ReviewSummary[] = [];
  const truncatedBecause: string[] = [];
  // PR-level fields are read off the FIRST page (they do not vary per page).
  let firstPage: GraphqlPullRequest | null = null;

  // Per-collection cursor state: null = first page (the cursor flag is
  // OMITTED entirely — never sent as an empty string), a cursor = next page,
  // done = stop advancing (its page-1 nodes then come back on every further
  // request and are IGNORED — both collections ride one document, so a
  // still-paginating sibling re-fetches the finished one).
  let threadsCursor: string | null = null;
  let reviewsCursor: string | null = null;
  let threadsDone = false;
  let reviewsDone = false;

  for (let page = 1; ; page++) {
    const args = [
      'api',
      'graphql',
      '-f',
      `query=${PR_STATE_QUERY}`,
      '-F',
      `owner=${input.owner}`,
      '-F',
      `name=${input.repo}`,
      '-F',
      `pr=${input.pr}`,
    ];
    if (threadsCursor !== null) {
      args.push('-f', `threadsAfter=${threadsCursor}`);
    }
    if (reviewsCursor !== null) {
      args.push('-f', `reviewsAfter=${reviewsCursor}`);
    }
    const payload = await ghJson<GraphqlPayload>(run, args);
    const pullRequest = payload.data?.repository?.pullRequest ?? null;
    if (pullRequest === null) {
      throw new Error(`gh api graphql returned no pullRequest payload for ${input.owner}/${input.repo}#${input.pr}`);
    }
    if (firstPage === null) {
      firstPage = pullRequest;
    }
    if (!threadsDone) {
      threads.push(...pullRequest.reviewThreads.nodes.map(toReviewThread));
    }
    if (!reviewsDone) {
      reviews.push(...pullRequest.reviews.nodes.map(toReviewSummary));
    }

    // Advance each live cursor under its own cap: a hasNextPage past the cap
    // is the fail-closed truncation (data kept, reason recorded ONCE, loop
    // for this collection ends). A hasNextPage with no endCursor cannot
    // continue and counts the same. Done collections skip advancing entirely
    // — no re-fetch accounting, no duplicate reasons.
    if (!threadsDone) {
      const threadPageInfo = pullRequest.reviewThreads.pageInfo;
      if (threadPageInfo.hasNextPage && page < threadPagesCap && threadPageInfo.endCursor !== null) {
        threadsCursor = threadPageInfo.endCursor;
      } else {
        if (threadPageInfo.hasNextPage) {
          truncatedBecause.push('reviewThreads.pageCap');
        }
        threadsDone = true;
      }
    }
    if (!reviewsDone) {
      const reviewPageInfo = pullRequest.reviews.pageInfo;
      if (reviewPageInfo.hasNextPage && page < reviewPagesCap && reviewPageInfo.endCursor !== null) {
        reviewsCursor = reviewPageInfo.endCursor;
      } else {
        if (reviewPageInfo.hasNextPage) {
          truncatedBecause.push('reviews.pageCap');
        }
        reviewsDone = true;
      }
    }

    if (threadsDone && reviewsDone) {
      break;
    }
  }

  const restReviewComments = await fetchRestComments(
    run,
    `repos/${input.owner}/${input.repo}/pulls/${input.pr}/comments?per_page=100`,
    restPagesCap,
    'restComments.pageCap',
    truncatedBecause,
  );
  const restIssueComments = await fetchRestComments(
    run,
    `repos/${input.owner}/${input.repo}/issues/${input.pr}/comments?per_page=100`,
    restPagesCap,
    'issueComments.pageCap',
    truncatedBecause,
  );

  // GraphQL thread comments are root-only and stale; the reply chains come
  // from the flat REST collection (mutates threads in place).
  attachRestReplies(threads, restReviewComments);

  // The loop body ran at least once (it exits only via its own break, after
  // the first-page snapshot), so firstPage is set here.
  const first = firstPage;

  return {
    repo: { owner: input.owner, name: input.repo },
    pr: input.pr,
    authorLogin: first.author?.login ?? null,
    headRefName: first.headRefName ?? null,
    headRefOid: first.headRefOid ?? null,
    threads,
    reviews,
    restReviewComments,
    restIssueComments,
    truncated: truncatedBecause.length > 0,
    truncatedBecause,
  };
}
