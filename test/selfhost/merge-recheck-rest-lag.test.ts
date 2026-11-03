import { describe, expect, test } from 'vitest';
import {
  REST_LAG_PAGE_CAP,
  observeOpenPrs,
  recheckBeforeMerge,
} from '../../src/selfhost/merge-recheck.js';
import { readSettleState } from '../../src/selfhost/state-branch.js';
import {
  BASE_NAME,
  LATER,
  PREFIX,
  SHA_B,
  T0,
  forgeDeps,
  makeForge,
  okRes,
  prSpec,
  recheckDeps,
  review,
  seedObservation,
} from './merge-recheck.helpers.js';
import type { Forge, PrSpec } from './merge-recheck.helpers.js';

describe('recheckBeforeMerge — the I11 REST lag cross-check', () => {
  /** A seeded, otherwise-mergeable PR 7 whose spec `over` shapes REST/threads. */
  const settledForge = async (over: Partial<PrSpec> = {}): Promise<Forge> => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()], ...over }) });
    await seedObservation(forge, [7]);
    forge.log.length = 0;
    return forge;
  };
  const writes = (forge: Forge): string[] =>
    forge.log.filter((entry) => /^state:(POST|PATCH)/.test(entry));

  test('consistent REST and GraphQL passes', async () => {
    const forge = await settledForge({ threads: [{ isResolved: true, root: 'dave' }] });
    const calls: string[][] = [];
    const result = await recheckBeforeMerge(
      {
        ...recheckDeps(forge, LATER),
        gh: (args) => {
          calls.push(args);
          return forge.gh(args);
        },
      },
      7,
      SHA_B,
      BASE_NAME,
    );
    expect(result.ok).toBe(true);
    // fetchReviewState's exact REST argv, both collections, after the snapshot.
    for (const collection of ['reviews', 'comments']) {
      expect(calls).toContainEqual([
        'api',
        `${PREFIX}pulls/7/${collection}?per_page=100`,
        '--paginate',
        '--slurp',
      ]);
    }
    expect(forge.log.indexOf('rest:reviews:7')).toBeGreaterThan(forge.log.indexOf('graphql:7'));
    expect(forge.log.indexOf('rest:comments:7')).toBeGreaterThan(forge.log.indexOf('graphql:7'));
  });

  test('a REST review missing from the GraphQL snapshot refuses (reviews lag)', async () => {
    const forge = await settledForge({
      restExtraReviews: [{ node_id: 'R_fresh', state: 'CHANGES_REQUESTED' }],
    });
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({
      ok: false,
      reason:
        'review data lag: reviews.lag (1 of 2 REST review(s) missing from 1 snapshot review(s))',
    });
    // Unchanged tuple: the lag refusal writes nothing.
    expect(writes(forge)).toEqual([]);
  });

  test('a review whose REST state disagrees with the snapshot refuses (a lagging dismissal)', async () => {
    const forge = await settledForge({ restStateOverride: 'DISMISSED' });
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({
      ok: false,
      reason:
        'review data lag: reviews.stateMismatch (1 review(s) whose REST state or commit disagrees with the snapshot)',
    });
  });

  test('PENDING REST reviews are ignored; a node_id-less REST review is no lag evidence', async () => {
    const forge = await settledForge({
      restExtraReviews: [{ node_id: 'R_draft', state: 'PENDING' }, { state: 'COMMENTED' }],
    });
    expect((await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME)).ok).toBe(
      true,
    );
  });

  test('a REST thread root missing from the GraphQL snapshot refuses (reviewThreads lag)', async () => {
    const forge = await settledForge({
      threads: [{ isResolved: true, root: 'dave' }],
      // A fresh thread (root 9001) plus a reply to it: ONE unmatched root.
      restExtraComments: [
        { id: 9001, in_reply_to_id: null },
        { id: 9002, in_reply_to_id: 9001 },
      ],
    });
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({
      ok: false,
      reason:
        'review data lag: reviewThreads.lag (1 REST thread root(s) missing from 1 snapshot thread(s))',
    });
  });

  test('both traps firing are named together; the refusal precedes the thread and review judgments', async () => {
    const forge = await settledForge({
      threads: [{ isResolved: false, root: 'dave' }],
      restExtraReviews: [{ node_id: 'R_fresh', state: 'APPROVED' }],
      restExtraComments: [{ id: 9001 }],
    });
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toBe(
      'review data lag: reviews.lag (1 of 2 REST review(s) missing from 1 snapshot review(s)); reviewThreads.lag (1 REST thread root(s) missing from 1 snapshot thread(s))',
    );
  });

  test('REST read failure refuses', async () => {
    const forge = await settledForge();
    forge.hook = (args) =>
      (args[1] ?? '').endsWith('/reviews?per_page=100')
        ? { code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 502)' }
        : undefined;
    expect(await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME)).toEqual({
      ok: false,
      reason: 'review data lag: restReviews read failed: gh exit 1: gh: Server Error (HTTP 502)',
    });
    // A MIXED (untrustworthy) comments payload refuses too.
    forge.hook = (args) =>
      (args[1] ?? '').endsWith('/comments?per_page=100') ? okRes([[], { id: 1 }]) : undefined;
    const mixed = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect((mixed as { reason: string }).reason).toMatch(
      /^review data lag: restComments read failed: .*MIXED page payload/,
    );
    // A malformed comment id is unparseable, not silently skipped.
    forge.hook = (args) =>
      (args[1] ?? '').endsWith('/comments?per_page=100') ? okRes([[{ id: 'x' }]]) : undefined;
    expect(await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME)).toEqual({
      ok: false,
      reason: 'review data lag: restComments unparseable (1 entry(ies) with a malformed id)',
    });
    expect(writes(forge)).toEqual([]);
  });

  test('a REST collection past the page cap refuses (restReviews.pageCap)', async () => {
    const forge = await settledForge();
    forge.hook = (args) =>
      (args[1] ?? '').endsWith('/reviews?per_page=100')
        ? okRes(Array.from({ length: REST_LAG_PAGE_CAP + 1 }, () => []))
        : undefined;
    expect(await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME)).toEqual({
      ok: false,
      reason: `review data lag: restReviews.pageCap (${String(REST_LAG_PAGE_CAP + 1)} pages > ${String(REST_LAG_PAGE_CAP)})`,
    });
  });

  test('a lag refusal that creates a new anchor still writes it; observeOpenPrs reads no REST', async () => {
    const forge = makeForge({
      7: prSpec({ reviews: [review()], restExtraReviews: [{ node_id: 'R_fresh' }] }),
    });
    const result = await recheckBeforeMerge(recheckDeps(forge, T0), 7, SHA_B, BASE_NAME);
    expect((result as { reason: string }).reason).toMatch(/^review data lag: reviews\.lag/);
    const { state } = await readSettleState(forgeDeps(forge));
    expect(state.prs['7']?.observations).toHaveLength(1);
    forge.log.length = 0;
    await observeOpenPrs({ ...forgeDeps(forge), nowMs: () => LATER }, [7]);
    expect(forge.log.filter((entry) => entry.startsWith('rest:'))).toEqual([]);
  });
});
