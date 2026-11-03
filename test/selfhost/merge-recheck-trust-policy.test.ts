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
