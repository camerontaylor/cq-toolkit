// snapshotPrState — the E3 anti-hallucination CAPTURE half (extracted from
// ops/review/verifyReviewOutcome.ts by Phase 1.4; the PURE diff half,
// verifyPrOutcome, stayed in ops/review). A responder run CLAIMS it
// addressed the review; this module captures the before/after evidence so
// verifyPrOutcome can check whether the PR actually MOVED — a new head
// commit, a new comment, a newly resolved thread.
//
// Capture mechanics (the E1 lessons applied):
//   - REST collections ride `--paginate --slurp`: WITHOUT --paginate gh
//     silently returns page 1 only, and WITHOUT --slurp merged pages come
//     back as a FLAT array, while with it (gh >= 2.51) they arrive as ONE
//     outer array of page arrays. Real gh variants differ — BOTH shapes are
//     accepted defensively (array of pages → flattened; already-flat array
//     → used as-is); neither is failed. A MIXED payload (array pages next
//     to non-array entries) is neither shape and THROWS — flat() would
//     silently drop the pages.
//   - Resolution state is the ONE field REST cannot give us, so it comes
//     from a PAGINATED GraphQL walk: reviewThreads(first: 100, after:
//     $threadsCursor), advancing on pageInfo.endCursor until hasNextPage
//     is false (like E1's fetch loops — the loop terminates on pageInfo,
//     never on a counter). NO artificial cap: verify's evidence must not
//     be page-limited, because a resolved thread hiding beyond page 1
//     would read as "not resolved" — under-seeing is exactly the
//     anti-hallucination direction that must not happen. Thread counts
//     are bounded in practice. THE COLLISION RULE (I11 trap): the
//     document rides `-f query=`, so no GraphQL variable may be named
//     `query` (the variables are owner/name/pr/threadsCursor).
//   - Any fetch that cannot produce a trustworthy snapshot (server-side
//     GraphQL errors, missing payload pieces, non-array or MIXED REST
//     payloads, a PR object without a usable head sha, comment entries
//     without numeric ids, resolved threads without string ids) THROWS —
//     a throw can never be mistaken for "NO PROGRESS".
// Owner/repo spellings are validated by gh.ts's shared ghNameOk (GH_NAME_OK
// charset + the dot-segment rule); this module keeps only its own
// module-prefixed fail-loud error message. REST payload normalization
// (slurp shape / flat tolerance / mixed-throw) is also gh.ts's shared
// slurpedComments guard — both hoisted so the seams cannot drift apart.
import { GH_NAME_OK, ghJson, ghNameOk, slurpedComments } from './gh.js';
import type { GhFn } from './gh.js';

/** The before/after evidence for one PR at one instant. */
export interface PrSnapshot {
  /** When the snapshot was taken: the injected nowMs. */
  at: number;
  /**
   * REST head commit sha — VERIFIED present: snapshotPrState throws on a
   * PR payload without a usable head.sha rather than snapshot headless
   * (a headless snapshot could not see new-commit movement).
   */
  headSha: string;
  /**
   * REST review comments (the pulls/{pr}/comments collection): numeric id
   * plus the author's login (snake_case `user.login`; absent → null).
   */
  reviewComments: Array<{ id: number; author: string | null }>;
  /**
   * REST issue comments (the issues/{pr}/comments collection): numeric id
   * plus the author's login (snake_case `user.login`; absent → null).
   */
  issueComments: Array<{ id: number; author: string | null }>;
  /** GraphQL thread node ids that ARE resolved at snapshot time. */
  resolvedThreadIds: string[];
}

/** What snapshotPrState needs — the gh seam and the injected clock. */
export interface SnapshotPrStateOpts {
  /** Repository owner (org or user login). */
  owner: string;
  /** Repository name. */
  repo: string;
  /** Pull request number. */
  pr: number;
  /** The gh seam — every fetch rides it; no other I/O exists. */
  run: GhFn;
  /** The injected clock stamping PrSnapshot.at — never Date.now. */
  nowMs: number;
}

// Owner/repo spellings and REST payload normalization are validated at the
// gh.ts transport layer (see the imports at the top of this file).

/**
 * The resolved-threads query, PAGINATED (see the module doc for why verify
 * must walk every page). Variable names are load-bearing (the I11 collision
 * rule): the document rides `-f query=`, so no variable may be named
 * `query` — the variables are owner/name/pr (mirroring fetchReviewState)
 * plus `threadsCursor`, the page cursor fed to `after` (page 1 omits it:
 * a null/absent cursor variable reads as the first page).
 */
const RESOLVED_THREADS_QUERY = `query ($owner: String!, $name: String!, $pr: Int!, $threadsCursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100, after: $threadsCursor) {
        nodes { id isResolved }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
}`;

/** Minimal shape of the `gh api graphql` payload this function reads. */
interface GraphqlPayload {
  /** Server-side GraphQL errors — non-empty means the snapshot cannot be trusted. */
  errors?: Array<{ message?: string }>;
  data?: {
    repository?: {
      pullRequest?: {
        reviewThreads?: {
          nodes: Array<{ id?: unknown; isResolved?: unknown }>;
          pageInfo?: {
            hasNextPage?: unknown;
            endCursor?: unknown;
          } | null;
        } | null;
      } | null;
    } | null;
  };
}

/**
 * Extract one REST comment entry per raw comment: the numeric id (STRICT —
 * an entry without a safe-integer id is a payload this module cannot
 * trust; filtering it out would silently shrink the reply-novelty
 * evidence) plus the author's login (snake_case `user.login`;
 * absent/non-string → null — attribution then simply cannot match a known
 * responder, which is the conservative direction).
 */
const commentEntries = (
  raws: Array<{ id?: unknown; user?: unknown }>,
  path: string,
): Array<{ id: number; author: string | null }> =>
  raws.map((raw, index) => {
    if (typeof raw?.id !== 'number' || !Number.isSafeInteger(raw.id)) {
      throw new Error(
        `gh api ${path} returned a comment entry without a numeric id (entry ${index}) — snapshot untrustworthy`,
      );
    }
    const login = (raw.user as { login?: unknown } | null | undefined)?.login;
    return { id: raw.id, author: typeof login === 'string' && login !== '' ? login : null };
  });

/** Fetch one REST comment collection paginated (normalized by gh.ts's shared
 * slurpedComments guard), mapped to id+author entries. */
const fetchRestComments = async (
  run: GhFn,
  path: string,
): Promise<Array<{ id: number; author: string | null }>> => {
  const payload = await ghJson<unknown>(run, ['api', path, '--paginate', '--slurp']);
  return commentEntries(
    slurpedComments<{ id?: unknown; user?: unknown }>(payload, path).flat(),
    path,
  );
};

/**
 * Capture one instant of the PR's state: REST head sha, REST comment
 * collections with their authors (both `--paginate --slurp`, both payload
 * shapes accepted), and the GraphQL resolved-thread set (paginated to the
 * end — see module doc). Throws loudly on any payload it cannot trust.
 */
export async function snapshotPrState(opts: SnapshotPrStateOpts): Promise<PrSnapshot> {
  // Validation before any argv is built (E1/E3-s1 convention).
  if (!ghNameOk(opts.owner) || !ghNameOk(opts.repo)) {
    throw new Error(
      `snapshotPrState: owner/repo must match ${String(GH_NAME_OK)} (never "." or "..") — got owner ${JSON.stringify(opts.owner)}, repo ${JSON.stringify(opts.repo)}`,
    );
  }
  if (!Number.isSafeInteger(opts.pr) || opts.pr <= 0) {
    throw new Error(
      `snapshotPrState: pr must be a positive safe integer — got ${JSON.stringify(opts.pr)}`,
    );
  }

  // Head sha: the plain PR REST object. STRICT — a payload without a
  // usable head.sha is a snapshot that could never see new-commit
  // movement, i.e. an untrustworthy one: throw, never a silent null.
  const pr = await ghJson<{ head?: { sha?: unknown } | null }>(opts.run, [
    'api',
    `repos/${opts.owner}/${opts.repo}/pulls/${opts.pr}`,
  ]);
  const sha = pr?.head?.sha;
  if (typeof sha !== 'string' || sha === '') {
    throw new Error(
      `gh api repos/${opts.owner}/${opts.repo}/pulls/${opts.pr} returned no usable head sha — snapshot untrustworthy`,
    );
  }
  const headSha: string = sha;

  const reviewComments = await fetchRestComments(
    opts.run,
    `repos/${opts.owner}/${opts.repo}/pulls/${opts.pr}/comments?per_page=100`,
  );
  const issueComments = await fetchRestComments(
    opts.run,
    `repos/${opts.owner}/${opts.repo}/issues/${opts.pr}/comments?per_page=100`,
  );

  // Resolution state — GraphQL only (REST cannot see it), and PAGINATED to
  // the end: a resolved thread hiding beyond page 1 must not read as "not
  // resolved" (see the module doc). Each page rides the SAME mutation-
  // shaped argv — exactly one `-f query=`; page 1 carries no cursor, later
  // pages feed `threadsCursor=<endCursor>` as a raw `-f`.
  const resolvedThreadIds: string[] = [];
  let threadsCursor: string | null = null;
  for (;;) {
    const args: string[] = [
      'api',
      'graphql',
      '-f',
      `query=${RESOLVED_THREADS_QUERY}`,
      '-f',
      `owner=${opts.owner}`,
      '-f',
      `name=${opts.repo}`,
      '-F',
      `pr=${opts.pr}`,
    ];
    // Page 1 rides no cursor (an absent cursor variable reads as the first
    // page); every later page feeds the previous endCursor as a raw `-f`.
    if (threadsCursor !== null) {
      args.push('-f', `threadsCursor=${threadsCursor}`);
    }
    // Explicit annotation: the loop-carried cursor must never leak into the
    // payload's inferred type (the annotation severs the flow).
    const payload: GraphqlPayload = await ghJson<GraphqlPayload>(opts.run, args);
    // Runtime shape guards: a non-array errors or nodes payload is not a
    // GraphQL document this module can trust (the types promise arrays;
    // the wire does not have to).
    if (
      payload.errors === null ||
      (payload.errors !== undefined && !Array.isArray(payload.errors))
    ) {
      throw new Error(
        `gh api graphql returned a non-array errors payload for ${opts.owner}/${opts.repo}#${opts.pr} — snapshot untrustworthy`,
      );
    }
    if (payload.errors !== undefined && payload.errors.length > 0) {
      const messages = payload.errors
        .map((error) => error.message ?? JSON.stringify(error))
        .join('; ');
      throw new Error(`gh api graphql returned GraphQL errors: ${messages}`);
    }
    const threads = payload.data?.repository?.pullRequest?.reviewThreads;
    if (threads === undefined || threads === null) {
      throw new Error(
        `gh api graphql returned no reviewThreads payload for ${opts.owner}/${opts.repo}#${opts.pr} — snapshot untrustworthy`,
      );
    }
    if (!Array.isArray(threads.nodes)) {
      throw new Error(
        `gh api graphql returned non-array reviewThreads.nodes for ${opts.owner}/${opts.repo}#${opts.pr} — snapshot untrustworthy`,
      );
    }
    // Resolution state is STRICT too: a RESOLVED node without a string id
    // would be silently dropped by a filter — shrinking the thread-resolved
    // evidence — so it throws instead.
    for (const node of threads.nodes) {
      if (node.isResolved !== true) {
        continue;
      }
      if (typeof node.id !== 'string' || node.id === '') {
        throw new Error(
          `gh api graphql returned a RESOLVED reviewThread node without a string id — snapshot untrustworthy`,
        );
      }
      resolvedThreadIds.push(node.id);
    }
    // The loop terminates on pageInfo, never on a counter (E1 fetch-loop
    // shape); a hasNextPage without an endCursor is a broken pagination
    // payload — untrustworthy, throw.
    if (threads.pageInfo?.hasNextPage !== true) {
      break;
    }
    const endCursor = threads.pageInfo.endCursor;
    if (typeof endCursor !== 'string' || endCursor === '') {
      throw new Error(
        `gh api graphql reviewThreads pagination is broken (hasNextPage without an endCursor) — snapshot untrustworthy`,
      );
    }
    threadsCursor = endCursor;
  }

  return {
    at: opts.nowMs,
    headSha,
    reviewComments,
    issueComments,
    resolvedThreadIds,
  };
}
