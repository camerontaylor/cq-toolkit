// Slice 1 (goal T4.1) — tests for the self-hosting candidate fetch
// (src/selfhost/candidates.ts) and the entry arg parser
// (src/selfhost/config.ts).
//
// Pinned here:
//   1. Happy-path wire mapping: ONE open PR → a full MergePrsCandidate —
//      REST listing fields (number/author/draft/mergeable_state/head/base),
//      the head-commit timestamp from the REST commits read, and
//      threads/reviews/issueComments from a faked fetchReviewState payload
//      (GraphQL wire shapes copied from
//      test/ops/review/fetchReviewState.test.ts, including reply-chain
//      reconstruction from REST).
//   2. The #142 fork contract: a cross-repository head is excluded with the
//      exact contract reason and costs zero review-state reads.
//   3. Draft exclusion, same shape.
//   4. Fail-closed pagination: a full 100-row page rides truncated=true into
//      every candidate (and a 99-row page does not) — the flat-array payload
//      tolerance included.
//   5. Per-PR fault isolation: a PR whose enrichment fails is excluded with
//      a one-line `fetch-failed: …` reason while its siblings survive.
//   6. mergeable_state mapping: known states uppercase through; anything
//      unknown → 'UNKNOWN' (classifyPr then fails closed to awaiting).
//   7. fetchReviewState's truncation flag is OR-ed into the candidate (the
//      reviews-lag trap), so a lagging GraphQL snapshot cannot read as
//      complete.
//   8. The listing call failing is NOT isolated: it throws (an empty result
//      would fabricate "nothing open").
//   9. parseSelfhostArgs: happy overrides, the zero cap, unknown-flag and
//      malformed/negative --max-usd throws with usage.
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
  overrides?: { draft?: boolean; mergeable_state?: string; headRepo?: string; state?: string },
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
  base: { ref: 'merge-queue' },
});

/** A REST commit wire object for the head-commit timestamp read. */
const commitPayload = (date: string) => ({
  commit: { committer: { date }, author: { date } },
});

// ---------------------------------------------------------------------------
// The fake gh — routes on argv, records every call, fails on demand
// ---------------------------------------------------------------------------

interface FakeHandlers {
  /** The listing payload — a flat array OR --slurp page arrays, verbatim. */
  list?: () => unknown;
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
  });

  test('draft exclusion: a draft PR is excluded before any enrichment', async () => {
    const calls: string[] = [];
    const gh = fakeGh({ list: () => [pullRow(9, { draft: true })] }, calls);

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.candidates).toEqual([]);
    expect(result.excluded).toEqual([{ pr: 9, reason: 'draft' }]);
    expect(ranGraphqlFor(calls, 9)).toBe(false);
  });

  test('pagination truncation: a full 100-row page flags truncated on every candidate; 99 rows do not', async () => {
    const hundred = Array.from({ length: 100 }, (_unused, i) => pullRow(i + 1));
    const full = await fetchMergeCandidates({
      gh: fakeGh({ list: () => hundred }), // FLAT payload — the slurpedComments tolerance
      owner: OWNER,
      repo: REPO,
    });
    expect(full.candidates).toHaveLength(100);
    expect(full.candidates.every((candidate) => candidate.truncated)).toBe(true);

    const ninetyNine = await fetchMergeCandidates({
      gh: fakeGh({ list: () => hundred.slice(0, 99) }),
      owner: OWNER,
      repo: REPO,
    });
    expect(ninetyNine.candidates).toHaveLength(99);
    expect(ninetyNine.candidates.every((candidate) => candidate.truncated)).toBe(false);
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

  test('mergeable_state mapping: known states uppercase through, unknown strings → UNKNOWN', async () => {
    const gh = fakeGh({
      list: () => [
        pullRow(11, { mergeable_state: 'dirty' }),
        pullRow(12, { mergeable_state: 'has_hooks' }),
        pullRow(13, { mergeable_state: 'some-future-state' }),
      ],
    });

    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });

    expect(result.candidates.map((candidate) => candidate.mergeState)).toEqual([
      'DIRTY',
      'HAS_HOOKS',
      'UNKNOWN',
    ]);
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
