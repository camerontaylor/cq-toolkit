// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the listing-gate subject: #142 fork exclusion, draft
// exclusion, and the unbounded-pagination non-truncation contract. Shared
// fixtures live in ./candidates.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchMergeCandidates } from '../../src/selfhost/candidates.js';
import { OWNER, REPO, REPO_PATH, fakeGh, pullRow, ranGraphqlFor } from './candidates.helpers.js';

// ---------------------------------------------------------------------------
// fetchMergeCandidates
// ---------------------------------------------------------------------------

describe('fetchMergeCandidates', () => {
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
    const calls: string[] = [];
    const full = await fetchMergeCandidates({
      gh: fakeGh({ list: () => hundred }, calls), // FLAT payload — the slurpedComments tolerance
      owner: OWNER,
      repo: REPO,
    });
    expect(full.candidates).toHaveLength(100);
    // A full last page is an ordinary --paginate outcome (gh simply fetches
    // the next page): flagging it truncated would permanently await a
    // fully-paginated fetch. The contract is "no candidate is truncated" —
    // asserted positively so a partial regression cannot slip through.
    expect(full.candidates.every((candidate) => !candidate.truncated)).toBe(true);
    // The non-truncation contract depends on the listing actually paginating:
    // without --paginate a 100-row page IS the whole fetch. Name the flag on
    // the open-listing call itself, not on some unrelated invocation.
    expect(
      calls.some(
        (line) =>
          line.includes(`repos/${REPO_PATH}/pulls?state=open&per_page=100`) &&
          line.includes('--paginate'),
      ),
    ).toBe(true);

    const ninetyNine = await fetchMergeCandidates({
      gh: fakeGh({ list: () => hundred.slice(0, 99) }),
      owner: OWNER,
      repo: REPO,
    });
    expect(ninetyNine.candidates).toHaveLength(99);
    expect(ninetyNine.candidates.every((candidate) => !candidate.truncated)).toBe(true);
  });
});
