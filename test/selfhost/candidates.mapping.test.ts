// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the wire-mapping subject: the happy-path candidate mapping,
// the review-state truncation OR, and the log summary line. Shared fixtures
// live in ./candidates.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchMergeCandidates, summarizeForLog } from '../../src/selfhost/candidates.js';
import {
  OWNER,
  REPO,
  REPO_PATH,
  fakeGh,
  graphqlPayload,
  pullRow,
  restComment,
  reviewNode,
  threadNode,
} from './candidates.helpers.js';

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
