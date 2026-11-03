// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the payload-authority subject: the SINGLE-PR GET outranks the
// stale listing row for mergeable_state, the fork/draft gates and head/base
// fields, and state/authorLogin. Shared fixtures live in ./candidates.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchMergeCandidates } from '../../src/selfhost/candidates.js';
import {
  OWNER,
  REPO,
  REPO_PATH,
  commitPayload,
  fakeGh,
  pullRow,
  ranGraphqlFor,
  singlePullPayload,
} from './candidates.helpers.js';

// ---------------------------------------------------------------------------
// fetchMergeCandidates
// ---------------------------------------------------------------------------

describe('fetchMergeCandidates', () => {
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
});
