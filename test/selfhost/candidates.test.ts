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
import { describe, expect, test } from 'vitest';
import { fetchMergeCandidates, summarizeForLog } from '../../src/selfhost/candidates.js';
import { parseSelfhostArgs } from '../../src/selfhost/config.js';
import { fetchReviewState } from '../../src/ops/review/fetchReviewState.js';
import { GhError } from '../../src/ops/review/gh.js';
import type { GhFn, GhResult } from '../../src/ops/review/gh.js';

// ---------------------------------------------------------------------------
// Wire-shape fixture builders (gh payloads, camelCase/snake_case as gh
// returns them — shapes mirrored from test/ops/review/fetchReviewState.test.ts)
// ---------------------------------------------------------------------------

const OWNER = 'octo';
const REPO = 'widget';
const REPO_PATH = `${OWNER}/${REPO}`;

/** Value of the `<name>=…` argv entry gh `-f/-F` args carry. */
const flagValue = (args: string[], name: string): string => {
  const entry = args.find((a) => a.startsWith(`${name}=`));
  return entry === undefined ? '' : entry.slice(name.length + 1);
};

/** One GraphQL reviewThread node with a root comment (carrying databaseId). */
const threadNode = (id: string, rootDatabaseId = 100) => ({
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
const reviewNode = (id: string, state = 'APPROVED') => ({
  id,
  author: { login: 'reviewer' },
  state,
  body: `review ${id}`,
  submittedAt: '2026-01-01T00:00:00Z',
});

/** A full graphql payload for one PR (single page, no cursors). */
const graphqlPayload = (pr: number, threads: unknown[] = [], reviews: unknown[] = []) => ({
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
const restComment = (id: number, inReplyTo?: number) => ({
  id,
  node_id: `N${String(id)}`,
  user: { login: 'reviewer' },
  body: `rest ${String(id)}`,
  created_at: '2026-01-01T01:00:00Z',
  ...(inReplyTo === undefined ? {} : { in_reply_to_id: inReplyTo }),
});

/** One REST listing row (`repos/…/pulls?state=open`), same-repo by default. */
const pullRow = (
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
const CLOSED_NOW = Date.parse('2026-01-02T03:00:00Z');
const closedRow = (
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
const commitPayload = (date: string) => ({
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
const singlePullPayload = (
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

const fakeGh =
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

const ranGraphqlFor = (calls: string[], pr: number): boolean =>
  calls.some((line) => line.includes('graphql') && flagValue(line.split(' '), 'pr') === String(pr));

// ---------------------------------------------------------------------------
// fetchMergeCandidates
// ---------------------------------------------------------------------------

describe('fetchMergeCandidates', () => {
  test('happy path: one PR maps to a full candidate, threads from the faked review state', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        list: () => [pullRow(7)],
        graphql: (pr) =>
          graphqlPayload(pr, [threadNode('T1', 100)], [reviewNode('R1', 'CHANGES_REQUESTED')]),
        // The REST collection carries the root (id 100 — the real GitHub
        // join key) plus its reply; a reply without its REST root is a
        // dangling parent and stays unattached by design.
        pullsComments: () => [restComment(100), restComment(200, 100)],
        issuesComments: () => [restComment(300)],
        pullReviews: () => [{ node_id: 'R1' }], // matches the GraphQL review id — no lag
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.excluded).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate?.pr).toBe(7);
    expect(candidate?.authorLogin).toBe('pr-author-7');
    expect(candidate?.draft).toBe(false);
    expect(candidate?.mergeState).toBe('CLEAN');
    expect(candidate?.truncated).toBe(false);
    expect(candidate?.threads).toHaveLength(1);
    expect(candidate?.threads[0]?.id).toBe('T1');
    expect(candidate?.threads[0]?.rootDatabaseId).toBe(100);
    expect(candidate?.threads[0]?.replies).toHaveLength(1); // REST reply chain attached
    expect(candidate?.reviews).toHaveLength(1);
    expect(candidate?.reviews[0]?.state).toBe('CHANGES_REQUESTED');
    expect(candidate?.issueComments).toHaveLength(1);
    expect(candidate?.issueComments[0]?.id).toBe(300);
    expect(candidate?.lastCommitAt).toBe('2026-01-02T00:00:00Z');
    expect(candidate?.headRefName).toBe('pr-7');
    expect(candidate?.baseRefName).toBe('merge-queue');
    expect(candidate?.state).toBe('open');
    // The listing rode the documented REST path with per_page pinned.
    expect(
      calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls?state=open&per_page=100`)),
    ).toBe(true);
    expect(calls.some((line) => line.includes('/commits/sha-7'))).toBe(true);
  });

  test('fork exclusion: cross-repository head excluded with the #142 contract reason, zero review reads', async () => {
    const calls: string[] = [];
    const gh = fakeGh({ list: () => [pullRow(8, { headRepo: 'octo/fork' })] }, calls);

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual([
      {
        pr: 8,
        reason:
          'forked-pr (head repo octo/fork) — #142 contract: forked PRs are excluded and must be handled by a human',
      },
    ]);
    expect(ranGraphqlFor(calls, 8)).toBe(false);
    expect(calls.some((line) => line.includes('/commits/sha-8'))).toBe(false);
    // Zero enrichment reads of any kind: the single-PR GET is enrichment too.
    expect(calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls/8`))).toBe(false);
  });

  test('draft exclusion: a draft PR is excluded before any enrichment', async () => {
    const calls: string[] = [];
    const gh = fakeGh({ list: () => [pullRow(9, { draft: true })] }, calls);

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual([{ pr: 9, reason: 'draft' }]);
    expect(ranGraphqlFor(calls, 9)).toBe(false);
  });

  test('unbounded pagination: a final page of exactly 100 rows is NOT truncation — candidates ride truncated=false', async () => {
    const hundred = Array.from({ length: 100 }, (_unused, i) => pullRow(i + 1));
    const full = await fetchMergeCandidates({
      gh: fakeGh({ list: () => hundred }), // FLAT payload — the slurpedComments tolerance
      owner: OWNER,
      repo: REPO,
    });
    expect(full.candidates).toHaveLength(100);
    // A full last page is an ordinary --paginate outcome (gh simply fetches
    // the next page): flagging it truncated would permanently await a
    // fully-paginated fetch. The contract is "no candidate is truncated" —
    // asserted positively so a partial regression cannot slip through.
    expect(full.candidates.every((candidate) => !candidate.truncated)).toBe(true);

    const ninetyNine = await fetchMergeCandidates({
      gh: fakeGh({ list: () => hundred.slice(0, 99) }),
      owner: OWNER,
      repo: REPO,
    });
    expect(ninetyNine.candidates).toHaveLength(99);
    expect(ninetyNine.candidates.every((candidate) => !candidate.truncated)).toBe(true);
  });

  test('per-PR fault isolation: a failing enrichment excludes that PR alone, one-line reason', async () => {
    const gh = fakeGh({
      list: () => [pullRow(1), pullRow(2), pullRow(3)],
      fail: (args) =>
        args.some((a) => a.includes('/commits/sha-2')) ||
        (args[0] === 'api' && args[1] === 'graphql' && flagValue(args, 'pr') === '3'),
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.candidates.map((candidate) => candidate.pr)).toEqual([1]);
    expect(result.excluded).toHaveLength(2);
    const commitsFailure = result.excluded.find((row) => row.pr === 2);
    expect(commitsFailure?.reason.startsWith('fetch-failed: gh exit 1: injected gh failure')).toBe(
      true,
    );
    expect(commitsFailure?.reason.includes('stderr continues')).toBe(false); // ONE line only
    const graphqlFailure = result.excluded.find((row) => row.pr === 3);
    expect(graphqlFailure?.reason.startsWith('fetch-failed:')).toBe(true);
  });

  test('mergeable_state comes from the SINGLE-PR endpoint, not the list row; unknown/uncomputed → UNKNOWN', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        list: () => [
          // The list rows' lazy values DISAGREE with the single-PR payloads
          // below — the candidates must carry the single endpoint's values.
          pullRow(11, { mergeable_state: 'dirty' }),
          pullRow(12, { mergeable_state: 'clean' }),
          pullRow(13, { mergeable_state: 'clean' }),
        ],
        singlePull: (pr) =>
          pr === 11
            ? singlePullPayload(11, 'blocked')
            : pr === 12
              ? singlePullPayload(12, 'has_hooks')
              : singlePullPayload(13, null), // uncomputed mergeability (mergeable null, no state)
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.candidates.map((candidate) => candidate.mergeState)).toEqual([
      'BLOCKED', // the single endpoint's value — not the list row's DIRTY
      'HAS_HOOKS', // likewise — not the list row's CLEAN
      'UNKNOWN', // null/uncomputed fails closed
    ]);
    // Each enriched PR was read through the single-PR REST endpoint.
    expect(calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls/11`))).toBe(true);
    expect(calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls/13`))).toBe(true);
  });

  test('fork/draft gates and head/base fields ride the SINGLE-PR payload when the listing row disagrees', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        // The listing says all three are same-repo, non-draft, head
        // `pr-<n>`/`sha-<n>`, base merge-queue. The single-PR payloads
        // DISAGREE — the payload must win everywhere.
        list: () => [pullRow(21), pullRow(22), pullRow(23)],
        singlePull: (pr) => {
          if (pr === 21) return singlePullPayload(21, 'clean', { headRepo: 'octo/fork' }); // rebased onto a fork head after the listing
          if (pr === 22) return singlePullPayload(22, 'clean', { draft: true }); // converted to draft after the listing
          // Head renamed/re-based since the listing — the candidate and the
          // commits read must ride the payload's refs, not the row's.
          return singlePullPayload(23, 'clean', {
            headRef: 'pr-23-renamed',
            headSha: 'sha-23-fresh',
            baseRef: 'rebase-target',
          });
        },
        commits: (sha) => commitPayload(sha === 'sha-23-fresh' ? '2026-01-03T00:00:00Z' : 'x'),
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    // The fresh fork and draft gates fired, with the SAME reason strings the
    // listing-row gates carry.
    expect(result.candidates.map((candidate) => candidate.pr)).toEqual([23]);
    expect(result.excluded).toEqual([
      {
        pr: 21,
        reason:
          'forked-pr (head repo octo/fork) — #142 contract: forked PRs are excluded and must be handled by a human',
      },
      { pr: 22, reason: 'draft' },
    ]);
    // Both re-gates fired AFTER the single-PR GET but BEFORE any further
    // enrichment read (the GET is the one read a stale-row survivor pays).
    expect(calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls/21`))).toBe(true);
    expect(calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls/22`))).toBe(true);
    expect(ranGraphqlFor(calls, 21)).toBe(false);
    expect(ranGraphqlFor(calls, 22)).toBe(false);
    // The surviving candidate's structural fields came from the PAYLOAD:
    expect(result.candidates[0]?.headRefName).toBe('pr-23-renamed');
    expect(result.candidates[0]?.baseRefName).toBe('rebase-target');
    expect(result.candidates[0]?.lastCommitAt).toBe('2026-01-03T00:00:00Z');
    // ...including the head SHA the commits read rode (never the row's
    // stale sha-23).
    expect(calls.some((line) => line.endsWith(`/commits/sha-23-fresh`))).toBe(true);
    expect(calls.some((line) => line.endsWith(`/commits/sha-23`))).toBe(false);
  });

  test('state and authorLogin ride the SINGLE-PR payload when the listing row disagrees', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        // The listing says both are open under pr-author-<n>; the single-PR
        // payloads DISAGREE — PR 31 was closed after the listing, PR 32 was
        // re-authored. The candidates must carry the payload's values: a
        // stale row must not enter a closed PR as open, nor keep a
        // superseded login (classifyPr's external-thread/self-review rows
        // key on it).
        list: () => [pullRow(31), pullRow(32)],
        singlePull: (pr) =>
          pr === 31
            ? singlePullPayload(31, 'clean', { state: 'closed' }) // closed/merged after the listing
            : singlePullPayload(32, 'clean', { userLogin: 'author-b' }), // author changed after the listing
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.excluded).toEqual([]);
    expect(result.candidates).toHaveLength(2);
    // PR 31: the payload's closed state wins over the row's open.
    expect(result.candidates[0]?.state).toBe('closed');
    expect(result.candidates[0]?.authorLogin).toBe('pr-author-31');
    // PR 32: the payload's fresh login wins over the row's stale one.
    expect(result.candidates[1]?.state).toBe('open');
    expect(result.candidates[1]?.authorLogin).toBe('author-b');
    // Each surviving PR was read through the single-PR REST endpoint.
    expect(calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls/31`))).toBe(true);
    expect(calls.some((line) => line.includes(`repos/${REPO_PATH}/pulls/32`))).toBe(true);
  });

  test('fetchReviewState truncation is OR-ed into the candidate (reviews lag → truncated)', async () => {
    const gh = fakeGh({
      list: () => [pullRow(7)], // listing NOT truncated (single row)
      graphql: (pr) => graphqlPayload(pr, [], [reviewNode('R1')]),
      pullReviews: () => [{ node_id: 'R-ghost' }], // REST saw a review GraphQL did not → reviews.lag
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.excluded).toEqual([]);
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]?.truncated).toBe(true);
  });

  test('a failing listing call throws (never a fabricated empty success)', async () => {
    const gh = fakeGh({ fail: (args) => args.some((a) => a.includes('pulls?state=open')) });

    await expect(fetchMergeCandidates({ gh, owner: OWNER, repo: REPO })).rejects.toThrow(GhError);
  });

  test('owner/repo are validated before any gh call', async () => {
    const calls: string[] = [];
    const gh = fakeGh({}, calls);

    await expect(fetchMergeCandidates({ gh, owner: '../evil', repo: REPO })).rejects.toThrow(
      /owner\/repo must match/,
    );
    expect(calls).toEqual([]);
  });

  test('summarizeForLog: one structural line per candidate and exclusion, no titles or bodies', async () => {
    const gh = fakeGh({
      list: () => [pullRow(7), pullRow(9, { draft: true })],
      graphql: (pr) => graphqlPayload(pr, [threadNode('T1')], [reviewNode('R1')]),
    });

    const lines = summarizeForLog(await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO }));

    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(
      '#7 candidate state=open mergeState=CLEAN draft=false truncated=false threads=1 reviews=1 issueComments=0 head=pr-7 base=merge-queue lastCommitAt=2026-01-02T00:00:00Z',
    );
    expect(lines[1]).toBe('#9 excluded draft');
  });
});

// ---------------------------------------------------------------------------
// fetchMergeCandidates — the closed-ancestor sweep (#153)
// ---------------------------------------------------------------------------

describe('fetchMergeCandidates — closed-ancestor sweep (#153)', () => {
  test('a parent merged 2h ago whose head.ref is an open child’s base rides along as a state=closed structural candidate', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        // Child 21 stacks on the merged parent's head branch pr-20 — the
        // stack relation planMergeOrder matches (child.base === parent.head).
        // The base rides the LISTING row AND the single-PR payload (the
        // payload is the authoritative base ref the ancestor set is built
        // from), so both carry the stack position.
        list: () => [pullRow(21, { baseRef: 'pr-20' })],
        closed: () => [closedRow(20)], // merged 2h before CLOSED_NOW
        singlePull: (pr) =>
          pr === 20
            ? singlePullPayload(20, 'clean', { state: 'closed' }) // the payload stays authoritative for a merged row
            : singlePullPayload(pr, 'clean', { baseRef: 'pr-20' }),
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    expect(result.excluded).toEqual([]);
    // The open child first (the listing loop), the closed parent appended
    // by the sweep — the plan sorts internally by number either way.
    expect(result.candidates.map((c) => [c.pr, c.state])).toEqual([
      [21, 'open'],
      [20, 'closed'],
    ]);
    const parent = result.candidates[1];
    expect(parent?.headRefName).toBe('pr-20');
    expect(parent?.baseRefName).toBe('merge-queue');
    expect(parent?.mergeState).toBe('CLEAN');
    expect(parent?.lastCommitAt).toBe('2026-01-02T00:00:00Z');
    // The closed read is ONE bounded page — a single request, never
    // paginated, never slurped.
    const closedCalls = calls.filter((line) => line.includes('state=closed'));
    expect(closedCalls).toHaveLength(1);
    expect(closedCalls[0]).toContain('state=closed&sort=updated&direction=desc&per_page=100');
    expect(closedCalls[0]).not.toContain('--paginate');
    // The parent rode the SAME single-PR enrichment as the open child.
    expect(calls.some((line) => line.endsWith(`repos/${REPO_PATH}/pulls/20`))).toBe(true);
    expect(calls.some((line) => line.endsWith('/commits/sha-20'))).toBe(true);
  });

  test('the closed row rides the single-PR enrichment and the payload state wins (re-opened between page and GET → open)', async () => {
    const gh = fakeGh({
      list: () => [pullRow(31, { baseRef: 'pr-30' })],
      closed: () => [closedRow(30)],
      singlePull: (pr) =>
        pr === 30
          ? singlePullPayload(30, 'clean', { state: 'open' }) // re-opened after the closed page was read
          : singlePullPayload(pr, 'clean', { baseRef: 'pr-30' }),
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    // The authoritative payload outranks the page's state=closed premise —
    // the same payload-wins rule every other field rides.
    expect(result.excluded).toEqual([]);
    expect(result.candidates.map((c) => [c.pr, c.state])).toEqual([
      [31, 'open'],
      [30, 'open'],
    ]);
  });

  test('ancestors are retained REGARDLESS OF AGE; unrelated/unmerged/skewed closed rows are dropped before enrichment (#186)', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        list: () => [pullRow(41)],
        closed: () => [
          closedRow(42, { headRef: 'unrelated-branch' }), // wrong branch — anchors nothing
          closedRow(43, { headRef: 'merge-queue', mergedAt: '2025-12-30T03:00:00Z' }), // merged 3 days ago — RETAINED (#186)
          closedRow(44, { headRef: 'merge-queue', mergedAt: '2026-01-01T03:00:00Z' }), // exactly 24h — RETAINED (#186)
          closedRow(45, { mergedAt: null }), // no merged_at (closed unmerged) — dropped
          closedRow(46, { headRef: 'merge-queue', mergedAt: 'not-a-timestamp' }), // NaN-guarded parse
          closedRow(47, { headRef: 'merge-queue', mergedAt: '2026-01-02T09:00:00Z' }), // future — a skewed wire
          closedRow(41, { headRef: 'merge-queue' }), // name match, but 41 is already an open candidate
        ],
        singlePull: (pr) =>
          pr === 41
            ? singlePullPayload(41, 'clean')
            : singlePullPayload(pr, 'clean', { state: 'closed', baseRef: 'merge-queue' }),
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    // The old 24h window dropped 43/44 (the exact #186 bug: a parent merged
    // >24h before an open child never anchored retarget-self); both now ride
    // along as closed structural rows.
    expect(result.candidates.map((c) => [c.pr, c.state])).toEqual([
      [41, 'open'],
      [43, 'closed'],
      [44, 'closed'],
    ]);
    expect(result.excluded).toEqual([]);
    // The dropped rows cost no enrichment read; the retained ancestors do.
    for (const n of [42, 45, 46, 47]) {
      expect(calls.some((line) => line.endsWith(`repos/${REPO_PATH}/pulls/${String(n)}`))).toBe(
        false,
      );
    }
    for (const n of [41, 43, 44]) {
      expect(calls.some((line) => line.endsWith(`repos/${REPO_PATH}/pulls/${String(n)}`))).toBe(
        true,
      );
    }
  });

  test('a closed structural row skips the draft gate (a draft can never merge — the flag gates nothing for a never-merge row)', async () => {
    const gh = fakeGh({
      list: () => [pullRow(81, { baseRef: 'pr-80' })],
      closed: () => [closedRow(80, { draft: true })],
      singlePull: (pr) =>
        pr === 80
          ? singlePullPayload(80, 'clean', { state: 'closed', draft: true })
          : singlePullPayload(pr, 'clean', { baseRef: 'pr-80' }),
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    expect(result.excluded).toEqual([]);
    expect(result.candidates.map((c) => [c.pr, c.state, c.draft])).toEqual([
      [81, 'open', false],
      [80, 'closed', true],
    ]);
  });

  test('the fork gate stays ON for a closed structural row (#142 binds to the payload whatever the state)', async () => {
    const gh = fakeGh({
      list: () => [pullRow(91, { baseRef: 'pr-90' })],
      closed: () => [closedRow(90)],
      singlePull: (pr) =>
        pr === 90
          ? singlePullPayload(90, 'clean', { state: 'closed', headRepo: 'octo/fork' })
          : singlePullPayload(pr, 'clean', { baseRef: 'pr-90' }),
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    expect(result.candidates.map((c) => c.pr)).toEqual([91]);
    expect(result.excluded).toEqual([
      {
        pr: 90,
        reason:
          'forked-pr (head repo octo/fork) — #142 contract: forked PRs are excluded and must be handled by a human',
      },
    ]);
  });

  test('a failed closed-page read degrades honestly: the open candidates survive and a #0 audit row explains the skip', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        list: () => [pullRow(51, { baseRef: 'pr-50' })],
        closed: () => [closedRow(50)],
        fail: (args) => args.some((a) => a.includes('state=closed')),
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    // The listing succeeded — there IS a page of truth — so the sweep's
    // failure must not orphan the open candidates (the module-doc fault
    // contract); the degradation is a recorded row, never silence.
    expect(result.candidates.map((c) => c.pr)).toEqual([51]);
    expect(result.excluded).toEqual([
      { pr: 0, reason: 'fetch-failed: closed-ancestor sweep: gh exit 1: injected gh failure' },
    ]);
  });

  test('a failing ancestor enrichment is isolated: a fetch-failed row for the closed PR, open siblings unaffected', async () => {
    const gh = fakeGh({
      list: () => [pullRow(61, { baseRef: 'pr-60' })],
      closed: () => [closedRow(60)],
      singlePull: (pr) =>
        singlePullPayload(pr, 'clean', { baseRef: pr === 61 ? 'pr-60' : 'merge-queue' }),
      fail: (args) => args.some((a) => a.endsWith(`repos/${REPO_PATH}/pulls/60`)),
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    expect(result.candidates.map((c) => c.pr)).toEqual([61]);
    expect(result.excluded).toHaveLength(1);
    expect(result.excluded[0]?.pr).toBe(60);
    expect(result.excluded[0]?.reason.startsWith('fetch-failed: gh exit 1:')).toBe(true);
  });

  test('no closed-page read at all when nothing open exists to anchor', async () => {
    const calls: string[] = [];
    const gh = fakeGh(
      {
        list: () => [],
        closed: () => [closedRow(70, { headRef: 'merge-queue' })],
      },
      calls,
    );

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO, nowMs: CLOSED_NOW });

    expect(result.candidates).toEqual([]);
    // No open base refs → no ancestor can matter → the read is never made
    // (an idle sweep costs zero requests).
    expect(calls.some((line) => line.includes('state=closed'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// parseSelfhostArgs
// ---------------------------------------------------------------------------

describe('parseSelfhostArgs', () => {
  test('happy path: every override is honored; empty argv means dryRun false only', () => {
    expect(parseSelfhostArgs(['--max-usd', '2', '--journal-root', '/tmp/j', '--dry-run'])).toEqual({
      maxUsd: 2,
      journalRoot: '/tmp/j',
      dryRun: true,
    });
    expect(parseSelfhostArgs([])).toEqual({ dryRun: false });
    expect(parseSelfhostArgs(['--max-usd', '0']).maxUsd).toBe(0); // zero is a legal cap
    expect(parseSelfhostArgs(['--dry-run'])).toEqual({ dryRun: true });
  });

  test('unknown flags and bare arguments throw with usage', () => {
    expect(() => parseSelfhostArgs(['--wat'])).toThrow(/unknown argument "--wat".*usage:/s);
    expect(() => parseSelfhostArgs(['stray-positional'])).toThrow(/usage:/);
    expect(() => parseSelfhostArgs(['--max-usd'])).toThrow(/requires a value/);
    expect(() => parseSelfhostArgs(['--journal-root', ''])).toThrow(/non-empty/);
  });

  test('--max-usd rejects negative and non-finite values fail-loud', () => {
    expect(() => parseSelfhostArgs(['--max-usd', '-1'])).toThrow(/finite number >= 0/);
    expect(() => parseSelfhostArgs(['--max-usd', 'abc'])).toThrow(/finite number >= 0/);
    expect(() => parseSelfhostArgs(['--max-usd', 'Infinity'])).toThrow(/finite number >= 0/);
    expect(() => parseSelfhostArgs(['--max-usd', 'NaN'])).toThrow(/finite number >= 0/);
  });

  test('slice 2 flags: --repo validates the owner/name shape; --responder-login is an optional string', () => {
    expect(parseSelfhostArgs(['--repo', 'octo/widget', '--responder-login', 'cq-bot'])).toEqual({
      repo: 'octo/widget',
      responderLogin: 'cq-bot',
      dryRun: false,
    });
    // Absent → undefined (the entry falls back to GH_REPOSITORY / null).
    const bare = parseSelfhostArgs([]);
    expect(bare.repo).toBeUndefined();
    expect(bare.responderLogin).toBeUndefined();
    // Malformed repository specs throw with usage.
    expect(() => parseSelfhostArgs(['--repo', 'octo'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', 'octo/widget/extra'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', '/widget'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', 'octo/'])).toThrow(/--repo must be/);
    expect(() => parseSelfhostArgs(['--repo', ''])).toThrow(/non-empty/);
    expect(() => parseSelfhostArgs(['--responder-login'])).toThrow(/requires a value/);
  });
});

// Keep the direct-import guard honest: fetchReviewState is reachable only
// through the candidates module above; this assertion pins that the fake's
// graphql shapes stay compatible with the real consumer's document.
describe('fixture compatibility', () => {
  test('the test graphql fixtures satisfy the real fetchReviewState', async () => {
    const pr = 7;
    const gh = fakeGh({
      graphql: () => graphqlPayload(pr, [threadNode('T1')], [reviewNode('R1')]),
    });
    const state = await fetchReviewState({ owner: OWNER, repo: REPO, pr }, undefined, gh);
    expect(state.truncated).toBe(false);
    expect(state.threads.map((thread) => thread.id)).toEqual(['T1']);
  });
});
