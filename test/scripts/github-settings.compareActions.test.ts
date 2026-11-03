// compareSettings over Actions: workflow permissions that differ, a missing
// event policy, allowed events that differ, and an unchecked (null) event
// policy, which is a notice and never drift or a match.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { describe, expect, it } from 'vitest';
import {
  ACTIONS_EVENT_POLICY_UNCHECKED,
  compareSettings,
} from '../../scripts/lib/github-settings.mjs';
import { driftOf, liveFrom, params, target } from './github-settings.helpers.js';

describe('compareSettings', () => {
  it('reports Actions workflow permissions that differ', () => {
    const live = liveFrom(target());
    live.actions = {
      default_workflow_permissions: 'write',
      can_approve_pull_request_reviews: true,
    };
    expect(driftOf(live)).toEqual([
      'actions can_approve_pull_request_reviews differs: expected false actual true',
      'actions default_workflow_permissions differs: expected "read" actual "write"',
    ]);
  });

  it('reports a missing event policy', () => {
    const live = liveFrom(target());
    live.actionsEventPolicies = [];
    expect(driftOf(live)).toEqual(['actions event policy cq-allowed-events: missing']);
  });

  it('reports allowed events that differ', () => {
    const live = liveFrom(target());
    const policy = live.actionsEventPolicies?.[0];
    if (policy === undefined) throw new Error('no policy');
    const p = params(policy, 'restrict_action_events');
    p['allowed_events'] = (p['allowed_events'] as string[])
      .filter((e) => e !== 'schedule')
      .concat('pull_request_target');
    expect(driftOf(live)).toEqual([
      'actions event policy cq-allowed-events: rule restrict_action_events: parameter allowed_events differs: missing ["schedule"] extra ["pull_request_target"]',
    ]);
  });

  it('reports an unchecked event policy (null) as a notice, never drift or a match', () => {
    const live = liveFrom(target());
    live.actionsEventPolicies = null;
    expect(compareSettings(target(), live)).toEqual({
      drift: [],
      notices: [ACTIONS_EVENT_POLICY_UNCHECKED],
    });
  });
});
