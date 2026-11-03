// environmentFromApi normalizes the API's environment, branch-policy and secret
// reads into the compared shape: reviewers from protection rules, wait timers,
// prevent_self_review, and unknown protection rules kept by type name.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { describe, expect, it } from 'vitest';
import { environmentFromApi } from '../../scripts/lib/github-settings.mjs';

describe('environmentFromApi', () => {
  it('normalizes the environment, branch-policy and secret reads', () => {
    const env = environmentFromApi(
      {
        id: 1,
        name: 'drill',
        can_admins_bypass: true,
        deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
        protection_rules: [
          { id: 2, type: 'wait_timer', wait_timer: 0 },
          {
            id: 3,
            type: 'required_reviewers',
            prevent_self_review: false,
            reviewers: [
              { type: 'User', reviewer: { login: 'owner', id: 9 } },
              { type: 'Team', reviewer: { slug: 'core', id: 10 } },
            ],
          },
          { id: 4, type: 'branch_policy' },
        ],
      },
      [{ id: 7, node_id: 'x', name: 'main', type: 'branch' }],
      ['GH_TOKEN'],
    );
    expect(env).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
      branch_policies: [{ name: 'main', type: 'branch' }],
      can_admins_bypass: true,
      reviewers: [
        { type: 'User', login: 'owner' },
        { type: 'Team', slug: 'core' },
      ],
      prevent_self_review: false,
      wait_timer: 0,
      other_rules: [],
      secrets: ['GH_TOKEN'],
      variables: [],
    });
    const guarded = environmentFromApi(
      {
        name: 'promote',
        can_admins_bypass: false,
        deployment_branch_policy: null,
        protection_rules: [
          { id: 2, type: 'wait_timer', wait_timer: 30 },
          { id: 3, type: 'required_reviewers', prevent_self_review: true, reviewers: [] },
          { id: 5, type: 'deployment_protection_rule', app: { slug: 'x' } },
          { id: 6 },
        ],
      },
      [],
      [],
    );
    expect(guarded).toMatchObject({
      prevent_self_review: true,
      wait_timer: 30,
      other_rules: ['deployment_protection_rule', 'unknown'],
    });
    expect(
      environmentFromApi(
        { name: 'x', can_admins_bypass: true, deployment_branch_policy: null },
        [],
        [],
      ),
    ).toMatchObject({
      deployment_branch_policy: null,
      prevent_self_review: false,
      wait_timer: 0,
      other_rules: [],
    });
  });
});
