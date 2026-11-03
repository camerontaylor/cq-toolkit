import { describe, expect, test } from 'vitest';
import type { GhFn } from '../../src/adapters/forge-github/gh.js';
import {
  CONSERVATIVE_TRUST_POLICY,
  SNAPSHOT_PAGE_CAP,
  fetchPrSnapshot,
  judgeAtHead,
  recheckBeforeMerge,
} from '../../src/selfhost/merge-recheck.js';
import { readSettleState } from '../../src/selfhost/state-branch.js';
import {
  BASE,
  BASE_NAME,
  LATER,
  PAGE,
  SHA_A,
  SHA_B,
  T0,
  flagValue,
  forgeDeps,
  gated,
  makeForge,
  okRes,
  prSpec,
  readAndMerge,
  recheckDeps,
  review,
  seedObservation,
  unprocessable,
} from './merge-recheck.helpers.js';
import type { ReviewSpec } from './merge-recheck.helpers.js';

describe('recheckBeforeMerge + gateMergeEffects', () => {
  test('approval at head B with settled state → inner mergePr called with the same opts', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    const { effects, mergeCalls } = gated(forge, LATER);
    const opts = { method: 'merge' as const, matchHeadCommit: SHA_B };
    const result = await readAndMerge(effects, 7, opts);
    expect(result.code).toBe(0);
    expect(mergeCalls).toEqual([{ pr: 7, opts }]);
    const direct = await recheckBeforeMerge(recheckDeps(forge, LATER + 1), 7, SHA_B, BASE_NAME);
    expect(direct).toMatchObject({
      ok: true,
      acceptedBy: ['user:carol'],
      tuple: { head: SHA_B, base: BASE, forcePushEpoch: 0 },
      firstObservedAt: new Date(T0).toISOString(),
    });
  });

  test('reviews are re-fetched immediately before merge; a late CHANGES_REQUESTED blocks', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    // "Classify": an earlier read sees a clean approval.
    const early = await fetchPrSnapshot(forgeDeps(forge), 7);
    expect(judgeAtHead(early, SHA_B, CONSERVATIVE_TRUST_POLICY).accepted).toBe(true);
    // Between classify and merge a trusted reviewer objects.
    forge.prs.set(
      7,
      prSpec({
        reviews: [
          review(),
          review({
            login: 'dave',
            state: 'CHANGES_REQUESTED',
            submittedAt: '2026-09-24T12:00:00Z',
          }),
        ],
      }),
    );
    const { effects, mergeCalls } = gated(forge, LATER);
    forge.log.length = 0;
    forge.log.push('merge-requested');
    const blocked = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(blocked.stderr).toMatch(/objection_outstanding/);
    expect(mergeCalls).toEqual([]);
    expect(forge.log[1]).toBe('graphql:7');

    // Once dave approves at head, the fresh read lets the merge through —
    // and the snapshot read sits between the request and the inner merge.
    forge.prs.set(
      7,
      prSpec({
        reviews: [
          review(),
          review({ login: 'dave', state: 'APPROVED', submittedAt: '2026-09-24T13:00:00Z' }),
        ],
      }),
    );
    forge.log.length = 0;
    forge.log.push('merge-requested');
    expect((await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B })).code).toBe(
      0,
    );
    const graphqlAt = forge.log.indexOf('graphql:7');
    expect(graphqlAt).toBeGreaterThan(forge.log.indexOf('merge-requested'));
    expect(graphqlAt).toBeLessThan(forge.log.indexOf('inner-merge:7'));
  });

  test('A → force-push → back to A: epoch bump invalidates the prior observation', async () => {
    const forge = makeForge({ 7: prSpec({ head: SHA_A, reviews: [review({ oid: SHA_A })] }) });
    await seedObservation(forge, [7]);
    // Force-pushed away and back to A: same head, epoch 1.
    forge.prs.set(7, prSpec({ head: SHA_A, forcePushes: 1, reviews: [review({ oid: SHA_A })] }));
    const result = await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_A, BASE_NAME);
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toMatch(
      /^settle: (tuple_changed|single_observation)$/,
    );
  });

  test('settle pending when the second observation is too soon', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    forge.log.length = 0;
    const result = await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({ ok: false, reason: 'settle: settle_pending' });
    // A refusal on an unchanged tuple writes nothing.
    expect(forge.log.filter((entry) => /^state:(POST|PATCH)/.test(entry))).toEqual([]);
  });

  const allClearReview = (over: Partial<ReviewSpec> = {}): ReviewSpec =>
    review({
      body: 'LGTM!',
      submittedAt: new Date(T0 + 100).toISOString(),
      ...over,
    });
  const allClearComment = () => ({
    author: { login: 'dave', __typename: 'User' },
    authorAssociation: 'COLLABORATOR',
    body: 'all clear',
    createdAt: new Date(T0 + 100).toISOString(),
  });

  test.each(['review', 'comment'] as const)(
    '%s all-clear bypasses only the wait and persists before merge',
    async (kind) => {
      const forge = makeForge({
        7: prSpec({
          reviews: [kind === 'review' ? allClearReview() : review()],
          issueComments: kind === 'comment' ? [allClearComment()] : [],
        }),
      });
      // No first observation: without all-clear even a first merge attempt refuses.
      const { effects, mergeCalls } = gated(forge, T0 + 1000);
      expect(
        (await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B })).code,
      ).toBe(0);
      expect(mergeCalls).toHaveLength(1);
      const { state } = await readSettleState(forgeDeps(forge));
      expect(state.prs['7']?.observations).toEqual([
        { observedAt: new Date(T0 + 1000).toISOString(), by: 'self-merge-prs:recheck' },
      ]);
      expect(forge.log.findIndex((entry) => entry.startsWith('state:POST'))).toBeLessThan(
        forge.log.indexOf('inner-merge:7'),
      );
    },
  );

  test.each([
    { body: 'not LGTM' },
    { body: 'LGTM\nexcept this bug' },
    { submittedAt: new Date(T0).toISOString() },
    { submittedAt: new Date(T0 - 1).toISOString() },
    { submittedAt: null },
    { submittedAt: 'invalid' },
    { submittedAt: new Date(T0 + 2000).toISOString() },
    { oid: SHA_A },
    { login: 'alice' },
    { login: null },
    { association: 'NONE' },
    { typename: 'Bot' },
    { state: 'DISMISSED' },
  ] satisfies Partial<ReviewSpec>[])(
    'invalid review all-clear cannot bypass settle: %j',
    async (over) => {
      const forge = makeForge({
        7: prSpec({ reviews: [review(), allClearReview({ login: 'dave', ...over })] }),
      });
      expect(await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME)).toEqual({
        ok: false,
        reason: 'settle: single_observation',
      });
    },
  );

  test('a superseded all-clear review cannot bypass settle', async () => {
    const forge = makeForge({
      7: prSpec({
        reviews: [allClearReview(), review({ submittedAt: new Date(T0 + 200).toISOString() })],
      }),
    });
    expect(await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME)).toEqual({
      ok: false,
      reason: 'settle: single_observation',
    });
  });

  test.each(['before', 'same-time', 'after'] as const)(
    'comment all-clear %s exact-head acceptance with a backdated commit',
    async (ordering) => {
      const forge = makeForge({
        7: prSpec({
          committedDate: new Date(T0 - 60_000).toISOString(),
          reviews: [review({ submittedAt: new Date(T0 + 200).toISOString() })],
          issueComments: [
            {
              ...allClearComment(),
              createdAt: new Date(
                T0 + (ordering === 'before' ? 100 : ordering === 'same-time' ? 200 : 300),
              ).toISOString(),
            },
          ],
        }),
      });
      const result = await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME);
      expect(result.ok).toBe(ordering === 'after');
    },
  );

  test.each(['later', 'unorderable'] as const)(
    'a %s comment cannot revive an earlier all-clear',
    async (kind) => {
      const forge = makeForge({
        7: prSpec({
          reviews: [review()],
          issueComments: [
            allClearComment(),
            {
              ...allClearComment(),
              body: 'Please wait for my follow-up',
              createdAt: kind === 'later' ? new Date(T0 + 200).toISOString() : null,
            },
          ],
        }),
      });
      expect(await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME)).toEqual({
        ok: false,
        reason: 'settle: single_observation',
      });
    },
  );

  test.each(['self', 'untrusted', 'unknown', 'old', 'missing', 'future'] as const)(
    'invalid %s comment all-clear cannot bypass settle',
    async (kind) => {
      const comment = allClearComment();
      if (kind === 'self') comment.author.login = 'alice';
      if (kind === 'untrusted') comment.authorAssociation = 'NONE';
      const forge = makeForge({
        7: prSpec({
          reviews: [review()],
          issueComments: [
            {
              ...comment,
              ...(kind === 'unknown' ? { author: null } : {}),
              ...(kind === 'old' ? { createdAt: new Date(T0).toISOString() } : {}),
              ...(kind === 'missing' ? { createdAt: null } : {}),
              ...(kind === 'future' ? { createdAt: new Date(T0 + 2000).toISOString() } : {}),
            },
          ],
        }),
      });
      expect(await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME)).toEqual({
        ok: false,
        reason: 'settle: single_observation',
      });
    },
  );

  test.each([null, 'invalid', new Date(T0 + 2000).toISOString()])(
    'invalid commit timestamp %s refuses bypass',
    async (committedDate) => {
      const forge = makeForge({ 7: prSpec({ committedDate, reviews: [allClearReview()] }) });
      expect(await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME)).toEqual({
        ok: false,
        reason: 'settle: single_observation',
      });
    },
  );

  test.each(['acceptance', 'objection', 'lag', 'write'] as const)(
    'all-clear never bypasses %s',
    async (guard) => {
      const forge = makeForge({
        7: prSpec({
          reviews:
            guard === 'acceptance'
              ? []
              : [
                  review(),
                  ...(guard === 'objection'
                    ? [review({ login: 'dave', state: 'CHANGES_REQUESTED' })]
                    : []),
                ],
          issueComments: [allClearComment()],
          threads: [],
          restExtraReviews: guard === 'lag' ? [{ node_id: 'unseen', state: 'APPROVED' }] : [],
        }),
      });
      if (guard === 'write')
        forge.hook = (args) => (args.includes('POST') ? unprocessable('write refused') : undefined);
      const { effects, mergeCalls } = gated(forge, T0 + 1000);
      const result = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain(
        {
          acceptance: 'no_head_bound_acceptance',
          objection: 'objection_outstanding',
          threads: 'unresolved external threads',
          lag: 'review data lag',
          write: 'not durable',
        }[guard],
      );
      expect(mergeCalls).toEqual([]);
    },
  );

  test.each(['complete', 'moved', 'capped'] as const)(
    'all-clear conversation pagination: %s',
    async (kind) => {
      const comments = Array.from(
        { length: kind === 'capped' ? PAGE * SNAPSHOT_PAGE_CAP + 1 : PAGE + 1 },
        () => ({ ...allClearComment(), body: '' }),
      );
      comments[kind === 'complete' ? comments.length - 1 : 0] = allClearComment();
      const forge = makeForge({
        7: prSpec({
          reviews: [review()],
          issueComments: comments,
          headOnLaterPages: kind === 'moved' ? SHA_A : null,
        }),
      });
      const result = await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME);
      expect(result.ok).toBe(kind === 'complete');
    },
  );

  test.each(['error', 'malformed', 'moved'] as const)(
    'all-clear fetch %s fails closed',
    async (kind) => {
      const forge = makeForge({ 7: prSpec({ reviews: [allClearReview()] }) });
      forge.hook = (args) =>
        flagValue(args, 'query').includes('commentsAfter')
          ? kind === 'error'
            ? { code: 1, stdout: '', stderr: 'offline fixture failure' }
            : okRes(
                kind === 'malformed'
                  ? { errors: [{ message: 'unavailable' }] }
                  : { data: { repository: { pullRequest: { headRefOid: SHA_A } } } },
              )
          : undefined;
      expect(
        (await recheckBeforeMerge(recheckDeps(forge, T0 + 1000), 7, SHA_B, BASE_NAME)).ok,
      ).toBe(false);
    },
  );

  test('a refusal that creates a new anchor writes it (best effort) so a later run can settle', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    const result = await recheckBeforeMerge(recheckDeps(forge, T0), 7, SHA_B, BASE_NAME);
    expect(result).toEqual({ ok: false, reason: 'settle: single_observation' });
    const { state } = await readSettleState(forgeDeps(forge));
    expect(state.prs['7']?.observations).toEqual([
      { observedAt: new Date(T0).toISOString(), by: 'self-merge-prs:recheck' },
    ]);
    // The anchor it wrote settles a recheck past the window.
    expect((await recheckBeforeMerge(recheckDeps(forge, LATER), 7, SHA_B, BASE_NAME)).ok).toBe(
      true,
    );
  });

  test('an ok recheck writes its observation BEFORE the inner mergePr', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    await seedObservation(forge, [7]);
    forge.log.length = 0;
    const { effects } = gated(forge, LATER);
    expect((await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B })).code).toBe(
      0,
    );
    const patchAt = forge.log.findIndex((entry) => entry.startsWith('state:PATCH'));
    expect(patchAt).toBeGreaterThan(forge.log.indexOf('graphql:7'));
    expect(patchAt).toBeLessThan(forge.log.indexOf('inner-merge:7'));
    const { state } = await readSettleState(forgeDeps(forge));
    expect(state.prs['7']?.observations.map((o) => o.observedAt)).toEqual([
      new Date(T0).toISOString(),
      new Date(LATER).toISOString(),
    ]);
  });

  test('the clock is read AFTER the snapshot fetch', async () => {
    const forge = makeForge({ 7: prSpec({ reviews: [review()] }) });
    const order: string[] = [];
    const gh: GhFn = (args) => {
      if (args[1] === 'graphql') order.push('fetch');
      return forge.gh(args);
    };
    await recheckBeforeMerge(
      {
        ...recheckDeps(forge, T0),
        gh,
        nowMs: () => {
          order.push('clock');
          return T0;
        },
      },
      7,
      SHA_B,
      BASE_NAME,
    );
    expect(order).toEqual(['fetch', 'clock']);
  });
});
