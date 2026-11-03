import { describe, expect, test } from 'vitest';
import {
  CONSERVATIVE_TRUST_POLICY,
  PR_SNAPSHOT_QUERY,
  SNAPSHOT_PAGE_CAP,
  fetchPrSnapshot,
  judgeAtHead,
  recheckBeforeMerge,
} from '../../src/selfhost/merge-recheck.js';
import {
  BASE_NAME,
  LATER,
  OWNER,
  REPO,
  SHA_A,
  SHA_B,
  forgeDeps,
  makeForge,
  prSpec,
  recheckDeps,
  review,
  snapshotOf,
} from './merge-recheck.helpers.js';
import type { ThreadSpec } from './merge-recheck.helpers.js';

describe('fetchPrSnapshot', () => {
  test('mirrors fetchReviewState argv; no GraphQL variable is named query', async () => {
    const forge = makeForge({ 7: prSpec() });
    const calls: string[][] = [];
    await fetchPrSnapshot(
      {
        ...forgeDeps(forge),
        gh: (args) => {
          calls.push(args);
          return forge.gh(args);
        },
      },
      7,
    );
    expect(calls[0]).toEqual([
      'api',
      'graphql',
      '-f',
      `query=${PR_SNAPSHOT_QUERY}`,
      '-f',
      `owner=${OWNER}`,
      '-f',
      `name=${REPO}`,
      '-F',
      'pr=7',
      '-F',
      'allClear=false',
    ]);
    expect(PR_SNAPSHOT_QUERY).not.toMatch(/\$query\b/);
    expect(PR_SNAPSHOT_QUERY).toMatch(
      /\$reviewsAfter: String, \$threadsAfter: String, \$timelineAfter: String/,
    );
    expect(PR_SNAPSHOT_QUERY).toMatch(/baseRefName/);
    expect(PR_SNAPSHOT_QUERY).not.toMatch(/totalCount/);
    expect(calls).toHaveLength(1); // one page: no cursor flag ever sent
  });

  test.each([false, true])(
    'sends a typed allClear=%s on every snapshot page',
    async (includeAllClear) => {
      const reviews = Array.from({ length: 101 }, () => review());
      const forge = makeForge({ 7: prSpec({ reviews }) });
      const calls: string[][] = [];
      const snapshot = await fetchPrSnapshot(
        {
          ...forgeDeps(forge),
          gh: (args) => {
            calls.push(args);
            return forge.gh(args);
          },
        },
        7,
        includeAllClear,
      );
      expect(calls).toHaveLength(2);
      for (const args of calls) {
        const binding = `allClear=${String(includeAllClear)}`;
        expect(args.filter((arg) => arg.startsWith('allClear='))).toEqual([binding]);
        expect(args[args.indexOf(binding) - 1]).toBe('-F');
      }
      expect(snapshot.truncated).toBe(false);
      expect(snapshot.allClear === undefined).toBe(!includeAllClear);
    },
  );

  test('>100 reviews page across 2 requests; a trusted approval on page 2 is accepted', async () => {
    const crowd = Array.from({ length: 140 }, (_, i) =>
      review({ login: `drive-by-${String(i)}`, association: 'NONE', state: 'COMMENTED' }),
    );
    const forge = makeForge({ 7: prSpec({ reviews: [...crowd, review({ login: 'carol' })] }) });
    const calls: string[][] = [];
    const snap = await fetchPrSnapshot(
      {
        ...forgeDeps(forge),
        gh: (args) => {
          calls.push(args);
          return forge.gh(args);
        },
      },
      7,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(-2)).toEqual(['-f', 'reviewsAfter=100']);
    expect(calls[1]?.some((arg) => arg.startsWith('timelineAfter='))).toBe(false);
    expect(snap.truncated).toBe(false);
    expect(snap.reviews).toHaveLength(141);
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
  });

  test('more pages than the cap → truncated, and the recheck refuses', async () => {
    const many = Array.from({ length: SNAPSHOT_PAGE_CAP * 100 + 1 }, () => review());
    const forge = makeForge({ 7: prSpec({ reviews: many }) });
    const snap = await fetchPrSnapshot(forgeDeps(forge), 7);
    expect(snap.truncated).toBe(true);
    expect(forge.log.filter((entry) => entry === 'graphql:7')).toHaveLength(SNAPSHOT_PAGE_CAP);
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({
      ok: false,
      reason:
        'snapshot truncated: reviews, review threads or force-push timeline incomplete, or the pr moved mid-read',
    });
  });

  test('a base oid or base name that changes between pages → truncated (fail closed)', async () => {
    const crowd = Array.from({ length: 150 }, () => review());
    const movedOid = await snapshotOf(prSpec({ reviews: crowd, baseOnLaterPages: SHA_A }));
    expect(movedOid.truncated).toBe(true);
    const retargeted = await snapshotOf(
      prSpec({ reviews: crowd, baseNameOnLaterPages: 'release' }),
    );
    expect(retargeted.truncated).toBe(true);
    expect(retargeted.baseRefName).toBe(BASE_NAME); // PR-level fields: first page
    expect((await snapshotOf(prSpec({ reviews: crowd }))).truncated).toBe(false);
  });

  test('review threads page with their own cursor; resolution and root author fail closed', async () => {
    const threads: ThreadSpec[] = [
      ...Array.from({ length: 140 }, () => ({ isResolved: true, root: 'dave' })),
      { isResolved: 'yes', root: 'dave' },
      { isResolved: false, root: undefined },
      { isResolved: false, root: null },
    ];
    const forge = makeForge({ 7: prSpec({ threads }) });
    const calls: string[][] = [];
    const snap = await fetchPrSnapshot(
      {
        ...forgeDeps(forge),
        gh: (args) => {
          calls.push(args);
          return forge.gh(args);
        },
      },
      7,
    );
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(-2)).toEqual(['-f', 'threadsAfter=100']);
    expect(snap.truncated).toBe(false);
    expect(snap.threads).toHaveLength(143);
    expect(snap.threads.slice(-3)).toEqual([
      { isResolved: false, rootAuthorLogin: 'dave', rootDatabaseId: 1140 },
      { isResolved: false, rootAuthorLogin: null, rootDatabaseId: null },
      { isResolved: false, rootAuthorLogin: null, rootDatabaseId: 1142 },
    ]);
    // A missing reviewThreads connection is truncated.
    expect((await snapshotOf(prSpec({ omitThreads: true }))).truncated).toBe(true);
  });

  test('a head that moves between pages → truncated (the PR moved mid-read)', async () => {
    const crowd = Array.from({ length: 150 }, () => review());
    const snap = await snapshotOf(prSpec({ reviews: crowd, headOnLaterPages: SHA_A }));
    expect(snap.truncated).toBe(true);
    expect(snap.headRefOid).toBe(SHA_B); // head/base come from the first page
  });

  test('force-push epoch is counted from nodes, never the unfiltered totalCount', async () => {
    const snap = await snapshotOf(prSpec({ forcePushes: 1, timelineTotalCount: 987_654 }));
    expect(snap.forcePushEpoch).toBe(1);
    // Paged: 130 events over two timeline pages all count.
    expect((await snapshotOf(prSpec({ forcePushes: 130 }))).forcePushEpoch).toBe(130);
  });

  test('a malformed timeline node fails closed (an uncounted force-push must not reuse a settled tuple)', async () => {
    for (const junk of [{}, { __typename: 'IssueComment' }, null, 'x']) {
      const snap = await snapshotOf(prSpec({ forcePushes: 1, extraTimelineNodes: [junk] }));
      expect(snap.truncated).toBe(true);
    }
  });

  test('an unknown PR author trusts nobody: acceptance fails closed', async () => {
    const snap = await snapshotOf(prSpec({ author: null, reviews: [review()] }));
    expect(snap.authorLogin).toBeNull();
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'no_head_bound_acceptance',
    });
  });

  test('truncated on hasNextPage or a missing connection; malformed oids → null', async () => {
    expect((await snapshotOf(prSpec({ reviewsHasNext: true }))).truncated).toBe(true);
    expect((await snapshotOf(prSpec({ omitReviews: true }))).truncated).toBe(true);
    const bad = await snapshotOf(prSpec({ head: 'not-a-sha', base: SHA_A.slice(1) }));
    expect(bad.headRefOid).toBeNull();
    expect(bad.baseRefOid).toBeNull();
  });

  test('GraphQL errors, missing pullRequest, and a bad owner throw', async () => {
    await expect(snapshotOf(prSpec({ errors: ['boom'] }))).rejects.toThrow(/boom/);
    await expect(snapshotOf(prSpec({ missing: true }))).rejects.toThrow(/no pullRequest/);
    await expect(
      fetchPrSnapshot({ gh: makeForge({}).gh, owner: '..', repo: REPO }, 7),
    ).rejects.toThrow(/charset/);
  });
});
