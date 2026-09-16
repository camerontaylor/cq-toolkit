// verifyReviewOutcome — E3 slice 2 (goal E3; UC §2 row 37): the
// anti-hallucination snapshot diff. A responder run CLAIMS it addressed the
// review; this module checks whether the PR actually MOVED — a new head
// commit, a new comment, a newly resolved thread — and refuses to say
// progress happened without evidence.
//
// The contract (each clause pinned in test/ops/review/verifyReviewOutcome.test.ts):
//   - snapshotPrState captures the before/after evidence (I/O through the
//     gh seam only; `at` is the injected nowMs, never Date.now). STRICT
//     payloads: a PR object without a usable head.sha, a REST comment
//     entry without a numeric id, or a RESOLVED reviewThread node without
//     a string id each THROW — filtering would silently shrink the
//     evidence and a shrunk snapshot can only ever under-report movement
//     (a missed responder reply reads as NO PROGRESS).
//   - verifyPrOutcome is PURE: same snapshots (+ responder option) →
//     deep-equal outcome. Progress needs ANY ONE signal:
//       new-commit      — after.headSha !== before.headSha (snapshots are
//                         head-sha VERIFIED at capture time — snapshotPrState
//                         throws without one — so identical shas mean no
//                         signal and any difference means the PR moved).
//       responder-reply — a review- or issue-comment entry present in
//                         `after` and absent from `before` (REST-counted:
//                         GraphQL lags fresh writes, REST does not — the
//                         workstream contract counts comments over REST).
//                         Entries carry their author (REST snake_case
//                         user.login; absent → null). When the caller
//                         KNOWS the responder login, attribution is
//                         STRICT: a new comment counts as responder-reply
//                         evidence only if its author === responderLogin —
//                         a null author does NOT count, because
//                         certifying progress from an unattributable
//                         comment is exactly the hallucination this module
//                         exists to refuse (fail toward NOT certifying).
//                         When responderLogin is null the diff stays
//                         AUTHOR-BLIND by necessity: there is no claimed
//                         identity to check against, so any new id
//                         counts (a new comment is never nothing).
//       thread-resolved — a thread id in `after`'s resolved set that was
//                         not in `before`'s.
//   - summary: progress → "PROGRESS: " + kinds joined ", "; no evidence →
//     the EXACT literal "NO PROGRESS" (a hallucinated "done" with no
//     commit/reply/resolution lands here — explicit, greppable, machine-
//     checkable by the workstream).
//
// Snapshot mechanics (the E1 lessons applied):
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

/** One observed movement, with a human-readable detail line. */
export interface ProgressReason {
  kind: 'new-commit' | 'responder-reply' | 'thread-resolved';
  detail: string;
}

/** The verify verdict: progress with evidence, or the explicit NO PROGRESS. */
export interface VerifyOutcome {
  /** True iff at least one signal fired. */
  progress: boolean;
  /** Every signal observed, in the fixed order new-commit → responder-reply → thread-resolved. */
  reasons: ProgressReason[];
  /** "PROGRESS: <kinds>" or the exact literal "NO PROGRESS". */
  summary: string;
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

/**
 * The PURE snapshot diff: compare before/after and name every movement.
 * Progress needs ANY ONE signal; no signal → progress=false and the exact
 * literal summary "NO PROGRESS" (the anti-hallucination contract: an
 * explicit, greppable refusal — never a guessed "done"). The reply signal
 * is AUTHOR-BLIND id-novelty (any new comment is evidence the PR moved;
 * see module doc); responderLogin, when known, is recorded in the detail
 * but never filters. Same inputs → deep-equal output; inputs are read,
 * never mutated.
 */
export function verifyPrOutcome(
  before: PrSnapshot,
  after: PrSnapshot,
  opts: { responderLogin: string | null },
): VerifyOutcome {
  const reasons: ProgressReason[] = [];

  // new-commit: plain !== — snapshots are head-sha VERIFIED at capture
  // time (snapshotPrState throws without one), so identical shas → no
  // signal; any difference → the PR moved.
  if (before.headSha !== after.headSha) {
    reasons.push({
      kind: 'new-commit',
      detail: `head sha moved ${JSON.stringify(before.headSha)} → ${JSON.stringify(after.headSha)}`,
    });
  }

  // responder-reply: a REST comment entry (either collection) present in
  // `after` and absent from `before` — gated by ATTRIBUTION when the
  // responder login is known (strict author === responderLogin; a null
  // author never counts: progress must not be certified from an
  // unattributable comment) and blind when it is null (any new id counts —
  // there is no claimed identity to check against).
  const newReviewEntries = after.reviewComments.filter(
    (entry) => !before.reviewComments.some((prior) => prior.id === entry.id),
  );
  const newIssueEntries = after.issueComments.filter(
    (entry) => !before.issueComments.some((prior) => prior.id === entry.id),
  );
  const countsAsReply = (entry: { author: string | null }): boolean =>
    opts.responderLogin === null || entry.author === opts.responderLogin;
  const countedReview = newReviewEntries.filter(countsAsReply);
  const countedIssue = newIssueEntries.filter(countsAsReply);
  if (countedReview.length > 0 || countedIssue.length > 0) {
    const who =
      opts.responderLogin === null
        ? 'responder unknown (id-novelty is author-blind)'
        : `responder ${opts.responderLogin} recorded (attribution strict: author === responderLogin)`;
    reasons.push({
      kind: 'responder-reply',
      detail: `${who}; new review comment ids [${countedReview.map((entry) => entry.id).join(', ')}]; new issue comment ids [${countedIssue.map((entry) => entry.id).join(', ')}]`,
    });
  }

  // thread-resolved: a thread id newly in the resolved set.
  const newResolvedIds = after.resolvedThreadIds.filter(
    (id) => !before.resolvedThreadIds.includes(id),
  );
  if (newResolvedIds.length > 0) {
    reasons.push({
      kind: 'thread-resolved',
      detail: `newly resolved thread ids [${newResolvedIds.join(', ')}]`,
    });
  }

  const progress = reasons.length > 0;
  return {
    progress,
    reasons,
    summary: progress
      ? `PROGRESS: ${reasons.map((reason) => reason.kind).join(', ')}`
      : 'NO PROGRESS',
  };
}
