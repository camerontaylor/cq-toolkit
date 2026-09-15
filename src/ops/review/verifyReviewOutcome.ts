// verifyReviewOutcome — E3 slice 2 (goal E3; UC §2 row 37): the
// anti-hallucination snapshot diff. A responder run CLAIMS it addressed the
// review; this module checks whether the PR actually MOVED — a new head
// commit, a new comment, a newly resolved thread — and refuses to say
// progress happened without evidence.
//
// The contract (each clause pinned in test/ops/review/verifyReviewOutcome.test.ts):
//   - snapshotPrState captures the before/after evidence (I/O through the
//     gh seam only; `at` is the injected nowMs, never Date.now).
//   - verifyPrOutcome is PURE: same snapshots (+ responder option) →
//     deep-equal outcome. Progress needs ANY ONE signal:
//       new-commit      — after.headSha !== before.headSha (both null → no
//                         signal; one null → counts as moved — a null can
//                         never EQUAL a sha, and treating null-vs-sha as a
//                         move fails toward "something happened").
//       responder-reply — a review- or issue-comment id present in `after`
//                         and absent from `before` (REST-counted: GraphQL
//                         lags fresh writes, REST does not — the workstream
//                         contract counts comments over REST). The diff is
//                         AUTHOR-BLIND by choice: REST ids carry no author
//                         here, and any new comment IS evidence the PR
//                         moved — the conservative anti-hallucination
//                         direction (we never claim progress from nothing;
//                         a new comment is never nothing). responderLogin,
//                         when the caller knows it, is recorded in the
//                         reason detail — never used to filter.
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
//     → used as-is); neither is failed.
//   - Resolution state is the ONE field REST cannot give us, so it comes
//     from a single GraphQL query — first page only (reviewThreads(first:
//     100)). The 100-thread cap is acceptable for verify's purpose: commit
//     and comment signals are REST and uncapped, progress needs ANY ONE
//     signal, and the full-fidelity path remains E1's fetch lane. THE
//     COLLISION RULE (I11 trap): the document rides `-f query=`, so no
//     GraphQL variable may be named `query` (the variables are owner/name/
//     pr, exactly as in fetchReviewState).
//   - Any fetch that cannot produce a trustworthy snapshot (server-side
//     GraphQL errors, missing payload pieces, non-array REST payloads)
//     THROWS — a throw can never be mistaken for "NO PROGRESS".
import { ghJson } from './gh.js';
import type { GhFn } from './gh.js';

/** The before/after evidence for one PR at one instant. */
export interface PrSnapshot {
  /** When the snapshot was taken: the injected nowMs. */
  at: number;
  /** Head commit sha, or null when unresolvable. */
  headSha: string | null;
  /** REST review-comment ids (the pulls/{pr}/comments collection). */
  reviewCommentIds: number[];
  /** REST issue-comment ids (the issues/{pr}/comments collection). */
  issueCommentIds: number[];
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

/** The only owner/repo spellings allowed near a gh REST path (E1 convention). */
const GH_NAME_OK = /^[A-Za-z0-9_.-]+$/;

/**
 * The resolved-threads query. Variable names are load-bearing (the I11
 * collision rule): the document rides `-f query=`, so no variable may be
 * named `query` — owner/name/pr, mirroring fetchReviewState (`-F pr=` for
 * the Int! coercion).
 */
const RESOLVED_THREADS_QUERY = `query ($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes { id isResolved }
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
        } | null;
      } | null;
    } | null;
  };
}

/**
 * Normalize a `--paginate --slurp` REST payload to one flat list of raw
 * comment objects. TWO shapes arrive in the wild and BOTH are accepted:
 *   - `[[page1…], [page2…]]` — the --slurp shape (gh >= 2.51): ONE outer
 *     array of page arrays;
 *   - `[c1, c2, …]` — the already-flat shape (an older gh variant, or pages
 *     merged flat WITHOUT slurp).
 * An empty array satisfies both readings (flat() of [] is []). Anything
 * else — or a page list containing a non-array page — is a payload this
 * module cannot trust and throws (a bad snapshot must never become a
 * silent "NO PROGRESS").
 */
const slurpedComments = (payload: unknown, path: string): Array<{ id?: unknown }> => {
  if (!Array.isArray(payload)) {
    throw new Error(`gh api ${path} returned a non-array payload — snapshot untrustworthy`);
  }
  const flat = payload.every((entry) => Array.isArray(entry))
    ? (payload as unknown[][]).flat()
    : (payload as Array<{ id?: unknown }>);
  return flat as Array<{ id?: unknown }>;
};

/** Extract the numeric REST ids from a raw comment list (non-numeric ids skipped). */
const commentIds = (raws: Array<{ id?: unknown }>): number[] =>
  raws
    .map((raw) => raw.id)
    .filter((id): id is number => typeof id === 'number' && Number.isSafeInteger(id));

/** Fetch one REST comment collection paginated, tolerant of both slurp shapes. */
const fetchRestCommentIds = async (run: GhFn, path: string): Promise<number[]> =>
  commentIds(slurpedComments(await ghJson<unknown>(run, ['api', path, '--paginate', '--slurp']), path));

/**
 * Capture one instant of the PR's state: REST head sha, REST comment id
 * collections (both `--paginate --slurp`, both payload shapes accepted),
 * and the GraphQL resolved-thread set (first page only — REST cannot carry
 * resolution state, and progress needs any ONE signal, so the 100-thread
 * page cap is acceptable here; see module doc). Throws loudly on any
 * payload it cannot trust.
 */
export async function snapshotPrState(opts: SnapshotPrStateOpts): Promise<PrSnapshot> {
  // Validation before any argv is built (E1/E3-s1 convention).
  if (!GH_NAME_OK.test(opts.owner) || !GH_NAME_OK.test(opts.repo)) {
    throw new Error(
      `snapshotPrState: owner/repo must match ${String(GH_NAME_OK)} — got owner ${JSON.stringify(opts.owner)}, repo ${JSON.stringify(opts.repo)}`,
    );
  }
  if (!Number.isSafeInteger(opts.pr) || opts.pr <= 0) {
    throw new Error(`snapshotPrState: pr must be a positive safe integer — got ${JSON.stringify(opts.pr)}`);
  }

  // Head sha: the plain PR REST object; absent/unusable → null.
  const pr = await ghJson<{ head?: { sha?: unknown } | null }>(opts.run, [
    'api',
    `repos/${opts.owner}/${opts.repo}/pulls/${opts.pr}`,
  ]);
  const headSha =
    typeof pr?.head?.sha === 'string' && pr.head.sha !== '' ? pr.head.sha : null;

  const reviewCommentIds = await fetchRestCommentIds(
    opts.run,
    `repos/${opts.owner}/${opts.repo}/pulls/${opts.pr}/comments?per_page=100`,
  );
  const issueCommentIds = await fetchRestCommentIds(
    opts.run,
    `repos/${opts.owner}/${opts.repo}/issues/${opts.pr}/comments?per_page=100`,
  );

  // Resolution state — GraphQL only (REST cannot see it). First page only;
  // see the module doc for why the cap is acceptable here.
  const payload = await ghJson<GraphqlPayload>(opts.run, [
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
  ]);
  if (payload.errors !== undefined && payload.errors.length > 0) {
    const messages = payload.errors.map((error) => error.message ?? JSON.stringify(error)).join('; ');
    throw new Error(`gh api graphql returned GraphQL errors: ${messages}`);
  }
  const nodes = payload.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (nodes === undefined || nodes === null) {
    throw new Error(
      `gh api graphql returned no reviewThreads payload for ${opts.owner}/${opts.repo}#${opts.pr} — snapshot untrustworthy`,
    );
  }
  const resolvedThreadIds = nodes
    .filter((node) => node.isResolved === true && typeof node.id === 'string')
    .map((node) => node.id as string);

  return {
    at: opts.nowMs,
    headSha,
    reviewCommentIds,
    issueCommentIds,
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

  // new-commit: plain !== is exactly the null rule — both null → equal →
  // no signal; null vs sha (either side) → moved; sha vs different sha → moved.
  if (before.headSha !== after.headSha) {
    reasons.push({
      kind: 'new-commit',
      detail: `head sha moved ${JSON.stringify(before.headSha)} → ${JSON.stringify(after.headSha)}`,
    });
  }

  // responder-reply: a REST comment id (either collection) present in
  // `after` and absent from `before`.
  const newReviewIds = after.reviewCommentIds.filter((id) => !before.reviewCommentIds.includes(id));
  const newIssueIds = after.issueCommentIds.filter((id) => !before.issueCommentIds.includes(id));
  if (newReviewIds.length > 0 || newIssueIds.length > 0) {
    const who =
      opts.responderLogin === null
        ? 'responder unknown'
        : `responder ${opts.responderLogin} recorded (id-novelty is author-blind)`;
    reasons.push({
      kind: 'responder-reply',
      detail: `${who}; new review comment ids [${newReviewIds.join(', ')}]; new issue comment ids [${newIssueIds.join(', ')}]`,
    });
  }

  // thread-resolved: a thread id newly in the resolved set.
  const newResolvedIds = after.resolvedThreadIds.filter((id) => !before.resolvedThreadIds.includes(id));
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
    summary: progress ? `PROGRESS: ${reasons.map((reason) => reason.kind).join(', ')}` : 'NO PROGRESS',
  };
}
