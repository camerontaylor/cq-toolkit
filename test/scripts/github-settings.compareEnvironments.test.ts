// compareSettings over environments: missing and unlisted environments, the
// protected_branches D-D.1 refusal, deployment branch policies, admin bypass,
// required reviewers, prevent_self_review and wait timers, and the pin that
// every environment keeps wait_timer 0 and prevent_self_review false.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { describe, expect, it } from 'vitest';
import { driftOf, liveFrom, target } from './github-settings.helpers.js';

describe('compareSettings', () => {
  it('reports a missing and an unlisted environment', () => {
    const live = liveFrom(target());
    delete live.environments['promote'];
    live.environments['github-pages'] = {
      deployment_branch_policy: null,
      branch_policies: [],
      can_admins_bypass: true,
      reviewers: [],
      prevent_self_review: false,
      wait_timer: 0,
      other_rules: [],
      secrets: [],
      variables: [],
    };
    expect(driftOf(live)).toEqual([
      'environment promote: missing',
      'environment github-pages: present live but not in the settings file',
    ]);
  });

  it('reports protected_branches: true with the D-D.1 reason', () => {
    const live = liveFrom(target());
    const env = live.environments['cq-verdict'];
    if (env === undefined) throw new Error('no env');
    env.deployment_branch_policy = { protected_branches: true, custom_branch_policies: false };
    env.branch_policies = [];
    expect(driftOf(live)).toEqual([
      'environment cq-verdict: deployment_branch_policy differs: expected {"custom_branch_policies":true,"protected_branches":false} actual {"custom_branch_policies":false,"protected_branches":true} (protected_branches admits every protected branch, not just the named deployment branch)',
      'environment cq-verdict: deployment branch policy {"name":"main","type":"branch"} missing',
    ]);
  });

  it('reports an extra branch policy, admin bypass and reviewers', () => {
    const live = liveFrom(target());
    const env = live.environments['promote'];
    if (env === undefined) throw new Error('no env');
    env.branch_policies.push({ name: 'obsolete', type: 'branch' });
    env.can_admins_bypass = true;
    env.reviewers = [{ type: 'User', login: 'owner' }];
    const drill = live.environments['drill'];
    if (drill === undefined) throw new Error('no env');
    drill.reviewers = [{ type: 'User', login: 'owner' }];
    expect(driftOf(live)).toEqual([
      'environment promote: deployment branch policy {"name":"obsolete","type":"branch"} present live but not in the settings file',
      'environment promote: can_admins_bypass differs: expected false actual true',
      'environment promote: required reviewers differ: expected [] actual [{"login":"owner","type":"User"}]',
    ]);
  });

  it('reports prevent_self_review, a wait timer and a custom protection rule', () => {
    const live = liveFrom(target());
    const promote = live.environments['promote'];
    const drill = live.environments['drill'];
    if (promote === undefined || drill === undefined) throw new Error('no env');
    promote.wait_timer = 30;
    promote.other_rules = ['deployment_protection_rule'];
    drill.prevent_self_review = true;
    expect(driftOf(live)).toEqual([
      'environment drill: prevent_self_review differs: expected false actual true',
      'environment promote: wait_timer differs: expected 0 actual 30',
      'environment promote: protection rule of type "deployment_protection_rule" present live (the target has no custom deployment protection rules)',
    ]);
  });

  it('pins wait_timer 0 and prevent_self_review false on every environment', () => {
    for (const [name, env] of Object.entries(target().environments)) {
      expect([name, env.wait_timer, env.prevent_self_review]).toEqual([name, 0, false]);
    }
  });
});
