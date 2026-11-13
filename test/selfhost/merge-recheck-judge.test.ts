import { describe, expect, test } from 'vitest';
import {
  CONSERVATIVE_TRUST_POLICY,
  actorKey,
  fetchPrSnapshot,
  foldLatestOpinionated,
  judgeAtHead,
  trustPolicyFromConfig,
} from '../../src/selfhost/merge-recheck.js';
import type { TrustPolicy } from '../../src/selfhost/merge-recheck.js';
import {
  LATER,
  SHA_A,
  SHA_B,
  agentMarker,
  forgeDeps,
  gated,
  makeForge,
  prSpec,
  readAndMerge,
  review,
  seedObservation,
  snapshotOf,
} from './merge-recheck.helpers.js';

describe('actorKey + foldLatestOpinionated', () => {
  test('both CodeRabbit identity forms are one actor; a human coderabbitai is distinct', () => {
    expect(actorKey('coderabbitai', 'Bot')).toBe('bot:coderabbitai');
    expect(actorKey('coderabbitai[bot]', 'User')).toBe('bot:coderabbitai');
    expect(actorKey('CodeRabbitAI', 'User')).toBe('user:coderabbitai');
    expect(actorKey(null, 'User')).toBe('unknown:');
  });

  test('COMMENTED and PENDING never supersede an opinion', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'CHANGES_REQUESTED', submittedAt: '2026-09-24T01:00:00Z' }),
          review({ state: 'COMMENTED', submittedAt: '2026-09-24T02:00:00Z' }),
          review({ state: 'PENDING', submittedAt: null }),
        ],
      }),
    );
    expect(foldLatestOpinionated(snap.reviews).get('user:carol')?.state).toBe('CHANGES_REQUESTED');
  });
});

describe('judgeAtHead', () => {
  test.each([{ typename: 'Bot' }, { login: 'reviewer[bot]' }])(
    'ignores bot SHA/PASS comments: %j',
    async (author) => {
      const snap = await snapshotOf(
        prSpec({ reviews: [review({ state: 'COMMENTED', body: `${SHA_B} PASS`, ...author })] }),
      );
      expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
        accepted: false,
      });
    },
  );

  test.each([
    { typename: 'Bot', login: 'cq-review' },
    { typename: 'Bot', login: 'cq-review[bot]' },
  ])('accepts a cq-review App PASS comment: %j', async (author) => {
    const snap = await snapshotOf(
      prSpec({ reviews: [review({ state: 'COMMENTED', body: `${SHA_B} PASS`, ...author })] }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({ accepted: true });
  });

  test.each([
    { login: 'cq-review', source: 'review' },
    { login: 'cq-review[bot]', source: 'review' },
    { login: 'cq-review', source: 'comment' },
    { login: 'cq-review[bot]', source: 'comment' },
  ])(
    'accepts App PASS from $login via $source with an unknown PR author',
    async ({ login, source }) => {
      const snap = await snapshotOf(
        prSpec({
          author: null,
          reviews: [review({ typename: 'Bot', login, state: 'COMMENTED', body: `${SHA_B} PASS` })],
        }),
      );
      if (source === 'comment') {
        snap.allClear = { committedAt: null, complete: true, comments: snap.reviews };
        snap.reviews = [];
      }
      expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
        accepted: true,
        authenticatedR4: { reviewCommitOid: SHA_B },
      });
    },
  );

  test('accepts a top-level plain SHA/PASS PR comment', async () => {
    const snap = await snapshotOf(
      prSpec({ reviews: [review({ state: 'COMMENTED', body: `opus ${SHA_B} PASS` })] }),
    );
    const plain = snap.reviews[0];
    if (plain === undefined) throw new Error('missing fixture comment');
    snap.reviews = [];
    snap.allClear = { committedAt: null, complete: true, comments: [plain] };
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({ accepted: true });
  });

  test.each(['review', 'comment'])(
    'refuses PASS %s evidence when the PR author is unknown',
    async (source) => {
      const snap = await snapshotOf(
        prSpec({
          author: null,
          reviews: [review({ state: 'COMMENTED', body: `opus ${SHA_B} PASS` })],
        }),
      );
      if (source === 'comment') {
        snap.allClear = { committedAt: null, complete: true, comments: snap.reviews };
        snap.reviews = [];
      }
      expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
        accepted: false,
      });
      expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).not.toHaveProperty(
        'authenticatedR4',
      );
    },
  );

  test('plain exact-head PASS accepts shared accounts without opt-in', async () => {
    const snap = await snapshotOf(
      prSpec({
        author: 'alice',
        reviews: [
          review({
            login: 'alice',
            association: 'OWNER',
            state: 'COMMENTED',
            body: `opus ${SHA_B} PASS`,
          }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: true,
      by: ['user:alice'],
    });
    expect(judgeAtHead(snap, SHA_A, CONSERVATIVE_TRUST_POLICY)).toMatchObject({ accepted: false });
  });

  test.each([
    { name: 'CONTRIBUTOR', login: 'eve', association: 'CONTRIBUTOR' },
    { name: 'NONE', login: 'mallory', association: 'NONE' },
    { name: 'excluded login', login: 'carol', association: 'OWNER' },
  ])('refuses a plain exact-head PASS comment from an untrusted actor: $name', async (who) => {
    const snap = await snapshotOf(
      prSpec({
        author: 'alice',
        reviews: [
          review({
            login: who.login,
            association: who.association,
            state: 'COMMENTED',
            body: `opus ${SHA_B} PASS`,
          }),
        ],
      }),
    );
    const policy: TrustPolicy = {
      ...CONSERVATIVE_TRUST_POLICY,
      excludedLogins: new Set([...CONSERVATIVE_TRUST_POLICY.excludedLogins, 'carol']),
    };
    expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({ accepted: false });
  });

  test('marker evidence is a fresh frozen copy bound to the selected review', async () => {
    const snapshot = await snapshotOf(
      prSpec({
        author: 'alice',
        reviews: [
          review({
            login: 'alice',
            association: 'OWNER',
            state: 'COMMENTED',
            body: agentMarker('PASS'),
          }),
        ],
      }),
    );
    const policy = trustPolicyFromConfig({});
    const result = judgeAtHead(snapshot, SHA_B, policy);
    const repeated = judgeAtHead(snapshot, SHA_B, policy);
    if (!result.accepted || !repeated.accepted)
      throw new Error('expected existing marker acceptance');
    const evidence = result.authenticatedR4;
    expect(evidence).toEqual({
      actorKey: 'user:alice',
      reviewNodeId: 'R_0',
      reviewCommitOid: SHA_B,
      submittedAt: '2026-09-24T10:00:00Z',
      attestation: {
        headSha: SHA_B,
        verdict: 'PASS',
      },
    });
    if (evidence === undefined) throw new Error('expected marker evidence');
    expect(Object.isFrozen(evidence)).toBe(true);
    expect(Object.isFrozen(evidence.attestation)).toBe(true);
    expect(evidence).not.toBe(repeated.authenticatedR4);
    expect(evidence.attestation).not.toBe(repeated.authenticatedR4?.attestation);
    expect(Reflect.set(evidence, 'actorKey', 'user:mallory')).toBe(false);
    expect(Reflect.set(evidence.attestation, 'verdict', 'HOLD')).toBe(false);
    const selected = snapshot.reviews[0];
    if (selected === undefined) throw new Error('expected source review');
    selected.nodeId = null;
    selected.commitOid = SHA_A;
    selected.body = agentMarker('HOLD');
    expect(evidence.reviewNodeId).toBe('R_0');
    expect(evidence.reviewCommitOid).toBe(SHA_B);
    expect(evidence.attestation.verdict).toBe('PASS');
    // Missing node identity was never an acceptance predicate.
    selected.commitOid = SHA_B;
    selected.body = agentMarker('PASS');
    expect(judgeAtHead(snapshot, SHA_B, policy)).toMatchObject({
      accepted: true,
      by: ['user:alice'],
      authenticatedR4: { reviewNodeId: null },
    });
  });

  test.each(['HOLD', 'RETRACT'])('ignores %s without PASS', async (verdict) => {
    const snap = await snapshotOf(
      prSpec({
        author: 'alice',
        reviews: [
          review({
            login: 'alice',
            state: 'COMMENTED',
            body: `${SHA_B} ${verdict}`,
          }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({ accepted: false });
  });

  test('an approval whose commit.oid ≠ headRefOid at merge time is not acceptance', async () => {
    // SYNTHETIC TIMELINE: COLLABORATOR approves sha A; the author pushes sha
    // B; the merge-time snapshot reports headRefOid B.
    const forge = makeForge({ 7: prSpec({ head: SHA_A, reviews: [review({ oid: SHA_A })] }) });
    const atA = await fetchPrSnapshot(forgeDeps(forge), 7);
    expect(judgeAtHead(atA, SHA_A, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
    forge.prs.set(7, prSpec({ head: SHA_B, reviews: [review({ oid: SHA_A })] })); // the push
    const atB = await fetchPrSnapshot(forgeDeps(forge), 7);
    const verdict = judgeAtHead(atB, SHA_B, CONSERVATIVE_TRUST_POLICY);
    expect(verdict).toMatchObject({ accepted: false, reason: 'no_head_bound_acceptance' });

    // End to end: settled tuple at B, yet the stale approval can never merge.
    await seedObservation(forge, [7]);
    const { effects, mergeCalls } = gated(forge, LATER);
    const result = await readAndMerge(effects, 7, { method: 'merge', matchHeadCommit: SHA_B });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/refused pr 7: no_head_bound_acceptance/);
    expect(mergeCalls).toEqual([]);
  });

  test('trusted CHANGES_REQUESTED on an OLD sha still blocks', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: 'dave', state: 'CHANGES_REQUESTED', oid: SHA_A }),
          review({ login: 'carol', oid: SHA_B, submittedAt: '2026-09-24T11:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'objection_outstanding',
      detail: expect.stringContaining('user:dave') as unknown,
    });
  });

  test("superseded by the same actor's later APPROVED at head → accepted", async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'CHANGES_REQUESTED', oid: SHA_A, submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'APPROVED', oid: SHA_B, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
  });

  test('a later COMMENTED does not supersede CHANGES_REQUESTED', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({
            login: 'dave',
            state: 'CHANGES_REQUESTED',
            oid: SHA_A,
            submittedAt: '2026-09-24T09:00:00Z',
          }),
          review({
            login: 'dave',
            state: 'COMMENTED',
            oid: SHA_B,
            submittedAt: '2026-09-24T12:00:00Z',
          }),
          review({ login: 'carol', oid: SHA_B }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      reason: 'objection_outstanding',
    });
  });

  test('CodeRabbit APPROVED at head: refused conservatively, accepted when allowlisted; one actor', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({
            login: 'coderabbitai',
            typename: 'Bot',
            association: 'NONE',
            submittedAt: '2026-09-24T09:00:00Z',
          }),
          review({ login: 'coderabbitai[bot]', typename: 'User', association: 'NONE' }),
        ],
      }),
    );
    expect(new Set(snap.reviews.map((r) => r.actorKey))).toEqual(new Set(['bot:coderabbitai']));
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'no_head_bound_acceptance',
    });
    const withBot: TrustPolicy = {
      ...CONSERVATIVE_TRUST_POLICY,
      trustedBots: new Set(['coderabbitai']),
    };
    expect(judgeAtHead(snap, SHA_B, withBot)).toEqual({ accepted: true, by: ['bot:coderabbitai'] });
  });

  test('PR author self-approval and excludedLogins actors never count', async () => {
    const snap = await snapshotOf(
      prSpec({
        author: 'alice',
        reviews: [
          review({ login: 'alice', association: 'OWNER' }),
          review({ login: 'cq-automation', association: 'MEMBER' }),
        ],
      }),
    );
    const policy: TrustPolicy = {
      ...CONSERVATIVE_TRUST_POLICY,
      excludedLogins: new Set(['cq-automation']),
    };
    expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({ reason: 'no_head_bound_acceptance' });
  });

  test('a null author or a non-User/Bot author type (Organization) is never trusted', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: null, association: 'OWNER' }),
          review({ login: 'acme', typename: 'Organization', association: 'OWNER' }),
          review({ login: 'coderabbitai', typename: 'Organization', association: 'NONE' }),
          review({ login: 'ghost', typename: undefined, association: 'MEMBER' }),
        ],
      }),
    );
    const withBot = trustPolicyFromConfig({ trustedBots: ['coderabbitai[bot]'] });
    for (const policy of [CONSERVATIVE_TRUST_POLICY, withBot]) {
      expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({
        accepted: false,
        reason: 'no_head_bound_acceptance',
        detail: expect.stringContaining('trusted=0') as unknown,
      });
    }
  });

  test('APPROVED at head then a later DISMISSED review by the same actor → not an acceptor', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'APPROVED', submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'DISMISSED', submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      accepted: false,
      reason: 'no_head_bound_acceptance',
    });
  });

  test('an approval node GitHub rewrote to DISMISSED (state mutated in place) never counts', async () => {
    const snap = await snapshotOf(prSpec({ reviews: [review({ state: 'DISMISSED' })] }));
    const both = trustPolicyFromConfig({ acceptReviewStates: ['APPROVED', 'COMMENTED'] });
    for (const policy of [CONSERVATIVE_TRUST_POLICY, both]) {
      expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({
        reason: 'no_head_bound_acceptance',
      });
    }
  });

  test('APPROVED at head then COMMENTED (not an accept state) → still an acceptor', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'APPROVED', submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'COMMENTED', oid: SHA_A, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toEqual({
      accepted: true,
      by: ['user:carol'],
    });
  });

  test('with COMMENTED accepted, the LATEST accept-state review decides (current opinion)', async () => {
    const policy = trustPolicyFromConfig({ acceptReviewStates: ['APPROVED', 'COMMENTED'] });
    // APPROVED of an old sha, then COMMENTED at head → the head comment counts.
    const current = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'APPROVED', oid: SHA_A, submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'COMMENTED', oid: SHA_B, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(current, SHA_B, policy)).toEqual({ accepted: true, by: ['user:carol'] });
    // COMMENTED at head, then APPROVED of an old sha → the actor's current
    // opinion is bound to the old sha: no acceptance.
    const stale = await snapshotOf(
      prSpec({
        reviews: [
          review({ state: 'COMMENTED', oid: SHA_B, submittedAt: '2026-09-24T09:00:00Z' }),
          review({ state: 'APPROVED', oid: SHA_A, submittedAt: '2026-09-24T10:00:00Z' }),
        ],
      }),
    );
    expect(judgeAtHead(stale, SHA_B, policy)).toMatchObject({
      reason: 'no_head_bound_acceptance',
    });
  });

  test('an acceptance needs a PARSEABLE submittedAt', async () => {
    const snap = await snapshotOf(prSpec({ reviews: [review({ submittedAt: 'not-a-date' })] }));
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      reason: 'no_head_bound_acceptance',
    });
  });

  test('an untrusted association never counts; a pending review never counts', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: 'eve', association: 'CONTRIBUTOR' }),
          review({ login: 'carol', state: 'PENDING', submittedAt: null }),
        ],
      }),
    );
    expect(judgeAtHead(snap, SHA_B, CONSERVATIVE_TRUST_POLICY)).toMatchObject({
      reason: 'no_head_bound_acceptance',
    });
  });
});
