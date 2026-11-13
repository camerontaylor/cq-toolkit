import { describe, expect, test } from 'vitest';
import {
  CONSERVATIVE_TRUST_POLICY,
  STRUCTURAL_EXCLUDED_LOGINS,
  judgeAtHead,
  trustPolicyFromConfig,
} from '../../src/selfhost/merge-recheck.js';
import { SHA_B, prSpec, review, snapshotOf } from './merge-recheck.helpers.js';

describe('trustPolicyFromConfig', () => {
  test('blank config = the conservative blanks plus the structural exclusions', () => {
    const blank = trustPolicyFromConfig({});
    expect([...blank.trustedAssociations]).toEqual(['OWNER', 'MEMBER', 'COLLABORATOR']);
    expect([...blank.trustedBots]).toEqual([]);
    expect([...blank.acceptStates]).toEqual(['APPROVED']);
    expect([...blank.excludedLogins].sort()).toEqual([...STRUCTURAL_EXCLUDED_LOGINS].sort());
    expect(CONSERVATIVE_TRUST_POLICY).toEqual(blank);
    expect(Object.isFrozen(CONSERVATIVE_TRUST_POLICY)).toBe(true);
  });

  test('the promotion reviewer bot is structurally excluded (cq-promotion-reviewer)', () => {
    expect(STRUCTURAL_EXCLUDED_LOGINS).toContain('cq-promotion-reviewer[bot]');
    const policy = trustPolicyFromConfig({
      trustedBots: ['cq-promotion-reviewer[bot]', 'cq-promotion-reviewer'],
    });
    expect([...policy.trustedBots]).toEqual([]);
    expect(policy.excludedLogins.has('cq-promotion-reviewer[bot]')).toBe(true);
  });

  test('bot logins normalize to the bare name; excluded identities are dropped', () => {
    const policy = trustPolicyFromConfig({
      trustedBots: [
        'coderabbitai[bot]',
        ' CodeRabbitAI ',
        'github-actions[bot]',
        'cq-verdict',
        'mybot[bot]',
        '',
      ],
      automationLogin: 'mybot[bot]',
    });
    expect([...policy.trustedBots]).toEqual(['coderabbitai']);
    expect(policy.excludedLogins.has('mybot[bot]')).toBe(true);
  });

  test('trustedAssociations may only narrow the blank set', () => {
    expect([
      ...trustPolicyFromConfig({ trustedAssociations: ['owner', 'CONTRIBUTOR', 'NONE'] })
        .trustedAssociations,
    ]).toEqual(['OWNER']);
    expect(
      trustPolicyFromConfig({ trustedAssociations: ['CONTRIBUTOR'] }).trustedAssociations.size,
    ).toBe(0);
    expect(trustPolicyFromConfig({ trustedAssociations: [] }).trustedAssociations.size).toBe(3);
  });

  test('acceptStates keeps only APPROVED/COMMENTED; blank → APPROVED', () => {
    expect([
      ...trustPolicyFromConfig({
        acceptReviewStates: ['APPROVED', 'COMMENTED', 'CHANGES_REQUESTED', 'DISMISSED'],
      }).acceptStates,
    ]).toEqual(['APPROVED', 'COMMENTED']);
    expect(trustPolicyFromConfig({ acceptReviewStates: ['DISMISSED'] }).acceptStates.size).toBe(0);
    expect([...trustPolicyFromConfig({ acceptReviewStates: [] }).acceptStates]).toEqual([
      'APPROVED',
    ]);
  });

  test('configured and automation logins never count, in either identity form', async () => {
    const snap = await snapshotOf(
      prSpec({
        reviews: [
          review({ login: 'robo', association: 'MEMBER' }),
          review({ login: 'ops-person', association: 'OWNER' }),
          review({ login: 'cq-automation', typename: 'Bot', association: 'NONE' }),
        ],
      }),
    );
    const policy = trustPolicyFromConfig({
      automationLogin: 'robo',
      excludedLogins: ['Ops-Person'],
      trustedBots: ['cq-automation[bot]'],
    });
    expect(judgeAtHead(snap, SHA_B, policy)).toMatchObject({ reason: 'no_head_bound_acceptance' });
  });
});

describe('latest CRQ exact-head evidence', () => {
  const crq = (verdict: string, at: string, head = SHA_B, refresh = false) =>
    review({
      login: 'cq-review',
      typename: 'Bot',
      association: 'NONE',
      state: 'COMMENTED',
      oid: head,
      submittedAt: at,
      body: `${refresh ? `<!-- crq-verdict-refresh head=${head} scan-run=scan -->` : '<!-- crq-findings run=scan -->'}\n**Independent review (CodeRabbit CLI via crq): ${verdict} for \`${head}\`**\n`,
    });
  test.each(['DISMISSED', 'PENDING'])('void %s ITERATE cannot hide PASS', async (state) => {
    const pass = crq('PASS', '2026-09-25T00:00:01Z');
    const voided = { ...crq('ITERATE', '2026-09-25T00:00:02Z'), state, submittedAt: null };
    expect(
      judgeAtHead(
        await snapshotOf(prSpec({ reviews: [voided, pass] })),
        SHA_B,
        CONSERVATIVE_TRUST_POLICY,
      ).accepted,
    ).toBe(true);
  });
  test('native changes requested with a CRQ header remains an objection', async () => {
    const objection = review({
      login: 'objector',
      state: 'CHANGES_REQUESTED',
      body: crq('ITERATE', '2026-09-25T00:00:02Z').body ?? '',
    });
    expect(
      judgeAtHead(
        await snapshotOf(prSpec({ reviews: [crq('PASS', '2026-09-25T00:00:01Z'), objection] })),
        SHA_B,
        CONSERVATIVE_TRUST_POLICY,
      ),
    ).toMatchObject({ accepted: false, reason: 'objection_outstanding' });
  });
  test('trusted non-author fallback supersedes App evidence and untrusted does not', async () => {
    const app = crq('PASS', '2026-09-25T00:00:01Z');
    const host = {
      ...crq('ITERATE', '2026-09-25T00:00:02Z'),
      login: 'queue-host',
      typename: 'User',
      association: 'OWNER',
    };
    expect(
      judgeAtHead(
        await snapshotOf(prSpec({ reviews: [app, host] })),
        SHA_B,
        CONSERVATIVE_TRUST_POLICY,
      ).accepted,
    ).toBe(false);
    expect(
      judgeAtHead(
        await snapshotOf(prSpec({ reviews: [{ ...host, body: app.body ?? '' }] })),
        SHA_B,
        CONSERVATIVE_TRUST_POLICY,
      ).accepted,
    ).toBe(true);
    expect(
      judgeAtHead(
        await snapshotOf(
          prSpec({ reviews: [{ ...host, body: app.body ?? '', association: 'NONE' }] }),
        ),
        SHA_B,
        CONSERVATIVE_TRUST_POLICY,
      ).accepted,
    ).toBe(false);
  });
  test.each([false, true])('uses full-history submission time (reverse=%s)', async (reverse) => {
    const old = crq('PASS', '2026-09-25T00:00:01Z');
    const newer = crq('ITERATE', '2026-09-25T00:00:02Z');
    const reviews = reverse ? [newer, old] : [old, newer];
    expect(
      judgeAtHead(await snapshotOf(prSpec({ reviews })), SHA_B, CONSERVATIVE_TRUST_POLICY).accepted,
    ).toBe(false);
    const refresh = crq('PASS', '2026-09-25T00:00:03Z', SHA_B, true);
    expect(
      judgeAtHead(
        await snapshotOf(prSpec({ reviews: [refresh, ...reviews] })),
        SHA_B,
        CONSERVATIVE_TRUST_POLICY,
      ).accepted,
    ).toBe(true);
  });
  test('stale CRQ verdict cannot borrow the current head from finding prose', async () => {
    const stale = crq('PASS', '2026-09-25T00:00:03Z', 'd'.repeat(40));
    stale.body += `Related ${SHA_B}`;
    expect(
      judgeAtHead(await snapshotOf(prSpec({ reviews: [stale] })), SHA_B, CONSERVATIVE_TRUST_POLICY)
        .accepted,
    ).toBe(false);
  });
  test('another independent reviewer remains usable', async () => {
    const reviews = [crq('ITERATE', '2026-09-25T00:00:03Z'), review()];
    expect(
      judgeAtHead(await snapshotOf(prSpec({ reviews })), SHA_B, CONSERVATIVE_TRUST_POLICY).accepted,
    ).toBe(true);
  });
});
