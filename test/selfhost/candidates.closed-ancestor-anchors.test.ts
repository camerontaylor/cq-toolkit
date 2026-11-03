// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the closed-ancestor anchor subject: which merged parents ride
// along (regardless of age), the payload-wins state, and the pinned head SHA.
// Shared fixtures live in ./candidates.helpers.ts.
import { describe, expect, test } from 'vitest';
import { fetchMergeCandidates } from '../../src/selfhost/candidates.js';
import {
  CLOSED_NOW,
  OWNER,
  REPO,
  REPO_PATH,
  closedRow,
  fakeGh,
  pullRow,
  singlePullPayload,
} from './candidates.helpers.js';

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
    // A non-40-hex wire sha is DROPPED (review-debt #186): the fixture's
    // short 'sha-20' is not a valid pin, so the plan would carry none.
    expect(parent?.headSha).toBeUndefined();
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

  test('the observed head SHA rides the candidate when the wire reports a full 40-hex sha (#186 review r1)', async () => {
    const head = 'a'.repeat(40);
    const gh = fakeGh({
      list: () => [pullRow(60)],
      singlePull: () => singlePullPayload(60, 'clean', { headSha: head }),
    });
    const result = await fetchMergeCandidates({ gh, owner: OWNER, repo: REPO });
    const candidate = result.candidates.find((c) => c.pr === 60);
    // The authoritative single-PR payload's head.sha is captured verbatim, so
    // the plan can pin the server-side merge to it.
    expect(candidate?.headSha).toBe(head);
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
});
