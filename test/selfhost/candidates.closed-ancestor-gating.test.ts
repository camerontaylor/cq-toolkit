// Split provenance: test/selfhost/candidates.test.ts was split by subject into
// candidates.{mapping,gates,payload-authority,fault-isolation,closed-ancestor-anchors,closed-ancestor-gating,args,fixtures}.test.ts;
// this file keeps the closed-ancestor gating/fault subject: the draft and fork
// gates on structural rows, the degraded closed-page read, ancestor enrichment
// isolation, and the no-open-candidates early exit. Shared fixtures live in
// ./candidates.helpers.ts.
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
