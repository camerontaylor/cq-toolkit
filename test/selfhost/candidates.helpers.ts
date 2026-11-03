// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this module holds the fixtures they share and declares no tests.
//
// Slice 1 (goal T4.1) — tests for the self-hosting candidate fetch
// (src/selfhost/candidates.ts) and the entry arg parser
// (src/selfhost/config.ts).
//
// Pinned here:
//   1. Happy-path wire mapping: ONE open PR → a full MergePrsCandidate —
//      REST listing fields (number/author/draft/head/base), the computed
//      mergeable_state from the SINGLE-PR endpoint (the list rows carry it
//      only lazily-computed), the head-commit timestamp from the REST
//      commits read, and threads/reviews/issueComments from a faked
//      fetchReviewState payload (GraphQL wire shapes copied from
//      test/ops/review/fetchReviewState.test.ts, including reply-chain
//      reconstruction from REST).
//   2. The #142 fork contract: a cross-repository head is excluded with the
//      exact contract reason and costs zero review-state reads.
//   3. Draft exclusion, same shape.
//   4. Unbounded pagination carries NO listing truncation: a final page of
//      exactly 100 rows is an ordinary --paginate outcome (flagging it
//      would mislabel a fully-paginated fetch as truncated forever), so
//      candidates ride truncated=false at both 100 and 99 rows.
//   5. Per-PR fault isolation: a PR whose enrichment fails is excluded with
//      a one-line `fetch-failed: …` reason while its siblings survive.
//   6. mergeable_state comes from the SINGLE-PR payload, not the list row
//      (the test makes the two disagree); known states uppercase through;
//      anything unknown or uncomputed → 'UNKNOWN' (classifyPr then fails
//      closed to awaiting).
//   7. fetchReviewState's truncation flag is OR-ed into the candidate (the
//      reviews-lag trap), so a lagging GraphQL snapshot cannot read as
//      complete — the one real truncation signal, since the listing is
//      unbounded.
//   8. The listing call failing is NOT isolated: it throws (an empty result
//      would fabricate "nothing open").
//   9. parseSelfhostArgs: happy overrides, the zero cap, unknown-flag and
//      malformed/negative --max-usd throws with usage.
//  10. The fork/draft gates re-bind to the SINGLE-PR payload: when the
//      listing row and the payload disagree on draft/fork fields, the
//      payload wins (and the candidate's head/base fields ride the payload
//      too, the commits read included).
//  11. state and authorLogin ride the SINGLE-PR payload too: a PR closed
//      or re-authored between listing and GET enters with the payload's
//      values, never the listing row's stale ones.
//  12. The closed-ancestor sweep (#153): a merged parent whose head.ref is
//      an open candidate's base ref rides along as a `state: 'closed'`
//      STRUCTURAL candidate through the same single-PR enrichment (payload
//      state wins), REGARDLESS OF AGE — the old 24h recency window was
//      removed (review-debt #186) because it dropped a parent merged more
//      than a day before an open/draft child, so retarget-self never fired.
//      Unrelated closed rows (wrong branch, absent/garbage merged_at,
//      future merge, already-enriched number) are dropped by the bounded
//      filter before any enrichment; the closed read is ONE page (never
//      paginated); a failed closed-page read degrades to a `#0` audit row
//      while the open candidates survive; a failing ancestor enrichment is
//      isolated to its own `fetch-failed` row; no closed read at all when
//      nothing open exists to anchor.
//
// The gh seam is INJECTED (a fake GhFn routing on argv, recording every
// call) — no spawned process anywhere.
import type { GhFn, GhResult } from '../../src/adapters/forge-github/gh.js';

// ---------------------------------------------------------------------------
// Wire-shape fixture builders (gh payloads, camelCase/snake_case as gh
// returns them — shapes mirrored from test/ops/review/fetchReviewState.test.ts)
// ---------------------------------------------------------------------------

export const OWNER = 'octo';
export const REPO = 'widget';
export const REPO_PATH = `${OWNER}/${REPO}`;

/** Value of the `<name>=…` argv entry gh `-f/-F` args carry. */
export const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** One GraphQL reviewThread node with a root comment (carrying databaseId). */
export const threadNode = (id: string, rootDatabaseId = 100) => ({
  id,
  isResolved: false,
  isOutdated: false,
  path: 'src/a.ts',
  line: 3,
  comments: {
    nodes: [
      {
        databaseId: rootDatabaseId,
        author: { login: 'reviewer' },
        body: `root ${id}`,
        createdAt: '2026-01-01T00:00:00Z',
      },
    ],
  },
});

/** One GraphQL review node. */
export const reviewNode = (id: string, state = 'APPROVED') => ({
  id,
  author: { login: 'reviewer' },
  state,
  body: `review ${id}`,
  submittedAt: '2026-01-01T00:00:00Z',
});

/** A full graphql payload for one PR (single page, no cursors). */
export const graphqlPayload = (pr: number, threads: unknown[] = [], reviews: unknown[] = []) => ({
  data: {
    repository: {
      pullRequest: {
        author: { login: `pr-author-${String(pr)}` },
        headRefName: `pr-${String(pr)}`,
        headRefOid: `sha-${String(pr)}`,
        reviewThreads: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: threads },
        reviews: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: reviews },
      },
    },
  },
});

/** A REST review/issue comment wire object (snake_case). */
export const restComment = (id: number, inReplyTo?: number) => ({
  id,
  node_id: `N${String(id)}`,
  user: { login: 'reviewer' },
  body: `rest ${String(id)}`,
  created_at: '2026-01-01T01:00:00Z',
  ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
});

/** One REST listing row (`repos/…/pulls?state=open`), same-repo by default. */
export const pullRow = (
  n: number,
  overrides?: {
    draft?: boolean;
    mergeable_state?: string;
    headRepo?: string;
    state?: string;
    baseRef?: string;
  },
) => ({
  number: n,
  state: overrides?.state ?? 'open',
  draft: overrides?.draft ?? false,
  mergeable_state: overrides?.mergeable_state ?? 'clean',
  user: { login: `pr-author-${String(n)}` },
  head: {
    ref: `pr-${String(n)}`,
    sha: `sha-${String(n)}`,
    repo: { full_name: overrides?.headRepo ?? REPO_PATH },
  },
  base: { ref: overrides?.baseRef ?? 'merge-queue' },
});

/**
 * One REST closed-PR row (`repos/…/pulls?state=closed`) — the
 * closed-ancestor sweep's raw material. Merged 2h before CLOSED_NOW by
 * default; the overrides model every way a row can fail the bounded filter
 * (wrong branch, stale merge, absent/garbage merged_at, future merge).
 */
export const CLOSED_NOW = Date.parse('2026-01-02T03:00:00Z');
export const closedRow = (
  n: number,
  overrides?: { mergedAt?: string | null; headRef?: string; state?: string; draft?: boolean },
) => ({
  number: n,
  state: overrides?.state ?? 'closed',
  draft: overrides?.draft ?? false,
  ...(overrides?.mergedAt === null
    ? {}
    : { merged_at: overrides?.mergedAt ?? '2026-01-02T01:00:00Z' }),
  user: { login: `pr-author-${String(n)}` },
  head: {
    ref: overrides?.headRef ?? `pr-${String(n)}`,
    sha: `sha-${String(n)}`,
    repo: { full_name: REPO_PATH },
  },
  base: { ref: 'merge-queue' },
});

/** A REST commit wire object for the head-commit timestamp read. */
export const commitPayload = (date: string) => ({
  commit: { committer: { date }, author: { date } },
});

/**
 * The single-PR REST wire (`repos/…/pulls/{n}`) — the AUTHORITATIVE payload
 * for every per-PR eligibility field (mergeable_state, head SHA/ref, base
 * ref, draft, head repo, open/closed state, author login), not just
 * mergeability. Default: computed clean (the lazy-compute result an
 * uncontested PR carries) with the same-repo head/base, open state, and
 * author the listing row carries; the overrides model row/payload drift
 * (a draft conversion, a fork retarget, a rename, a close, a re-author —
 * any change between listing and GET).
 */
export const singlePullPayload = (
  pr: number,
  mergeableState: unknown,
  overrides?: {
    draft?: boolean;
    headRepo?: string;
    headRef?: string;
    headSha?: string;
    baseRef?: string;
    state?: string;
    userLogin?: string;
  },
) => ({
  state: overrides?.state ?? 'open',
  user: { login: overrides?.userLogin ?? `pr-author-${String(pr)}` },
  draft: overrides?.draft ?? false,
  mergeable: mergeableState === null ? null : true,
  mergeable_state: mergeableState,
  head: {
    ref: overrides?.headRef ?? `pr-${String(pr)}`,
    sha: overrides?.headSha ?? `sha-${String(pr)}`,
    repo: { full_name: overrides?.headRepo ?? REPO_PATH },
  },
  base: { ref: overrides?.baseRef ?? 'merge-queue' },
});

// ---------------------------------------------------------------------------
// The fake gh — routes on argv, records every call, fails on demand
// ---------------------------------------------------------------------------

interface FakeHandlers {
  /** The listing payload — a flat array OR --slurp page arrays, verbatim. */
  list?: () => unknown;
  /** The closed-ancestor page payload (a flat array — ONE page, no slurp). */
  closed?: () => unknown;
  /** pr → the single-PR REST payload (mergeable_state's real source). */
  singlePull?: (pr: number) => unknown;
  /** sha → commits payload. */
  commits?: (sha: string) => unknown;
  /** pr → graphql payload. */
  graphql?: (pr: number) => unknown;
  /** pr → REST pull review comments. */
  pullsComments?: (pr: number) => unknown;
  /** pr → REST issue comments. */
  issuesComments?: (pr: number) => unknown;
  /** pr → REST pull reviews (the lag cross-check collection). */
  pullReviews?: (pr: number) => unknown;
  /** When true for an invocation, gh exits 1 with a two-line stderr. */
  fail?: (args: string[]) => boolean;
}

const json = (value: unknown): GhResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '' });

export const fakeGh =
  (handlers: FakeHandlers, calls?: string[]): GhFn =>
  async (args: string[]): Promise<GhResult> => {
    calls?.push(args.join(' '));
    if (handlers.fail?.(args) === true) {
      return { code: 1, stdout: '', stderr: 'injected gh failure\nstderr continues here' };
    }
    const path = args[0] === 'api' && typeof args[1] === 'string' ? args[1] : '';
    if (path === 'graphql') {
      return json(handlers.graphql?.(Number(flagValue(args, 'pr'))) ?? graphqlPayload(0));
    }
    if (path === `repos/${REPO_PATH}/pulls?state=open&per_page=100`) {
      return json(handlers.list?.() ?? []);
    }
    if (path === `repos/${REPO_PATH}/pulls?state=closed&sort=updated&direction=desc&per_page=100`) {
      return json(handlers.closed?.() ?? []);
    }
    const single = /^repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
    if (single !== null) {
      return json(
        handlers.singlePull?.(Number(single[1])) ?? singlePullPayload(Number(single[1]), 'clean'),
      );
    }
    if (path.startsWith(`repos/${REPO_PATH}/commits/`)) {
      const sha = path.slice(`repos/${REPO_PATH}/commits/`.length);
      return json(handlers.commits?.(sha) ?? commitPayload('2026-01-02T00:00:00Z'));
    }
    const match = path.match(/^repos\/[^/]+\/[^/]+\/(pulls|issues)\/(\d+)\/(comments|reviews)/);
    if (match !== null) {
      const pr = Number(match[2]);
      if (match[1] === 'pulls' && match[3] === 'comments') {
        return json(handlers.pullsComments?.(pr) ?? []);
      }
      if (match[1] === 'issues' && match[3] === 'comments') {
        return json(handlers.issuesComments?.(pr) ?? []);
      }
      return json(handlers.pullReviews?.(pr) ?? []);
    }
    return { code: 1, stdout: '', stderr: `unrouted gh invocation: ${args.join(' ')}` };
  };

export const ranGraphqlFor = (calls: string[], pr: number): boolean =>
  calls.some((line) => line.includes('graphql') && flagValue(line.split(' '), 'pr') === String(pr));
