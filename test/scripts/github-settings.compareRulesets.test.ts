// compareSettings over rulesets and classic protection: an equal live state is
// clean whatever its array order, a default-valued live parameter the file does
// not name is not drift, and every ruleset-level drift class produces its
// specific line (missing/extra ruleset, enforcement, conditions, rules, bypass
// actors, required checks and pull_request parameters).
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { describe, expect, it } from 'vitest';
import { compareSettings } from '../../scripts/lib/github-settings.mjs';
import {
  PROMOTER,
  VERDICT,
  driftOf,
  liveFrom,
  params,
  ruleset,
  target,
} from './github-settings.helpers.js';

describe('compareSettings', () => {
  it('reports nothing for a live state equal to the target', () => {
    expect(compareSettings(target(), liveFrom(target()))).toEqual({ drift: [], notices: [] });
  });

  it('is order-insensitive (shuffled arrays are not drift)', () => {
    const live = liveFrom(target());
    for (const r of [...live.rulesets, ...(live.actionsEventPolicies ?? [])]) {
      r.rules.reverse();
      r.bypass_actors?.reverse();
      for (const cond of Object.values(r.conditions)) cond.include.reverse();
      for (const rule of r.rules) {
        for (const value of Object.values(rule.parameters ?? {})) {
          if (Array.isArray(value)) value.reverse();
        }
      }
    }
    live.rulesets.reverse();
    const env = live.environments['automation'];
    env?.secrets.reverse();
    expect(compareSettings(target(), live)).toEqual({ drift: [], notices: [] });
  });

  it('ignores a default-valued live rule parameter the file does not name, not an enabled one', () => {
    const live = liveFrom(target());
    const r1 = ruleset(live, 'cq-r1-main');
    params(r1, 'pull_request')['optional_default'] = false;
    expect(driftOf(live)).toEqual([]);
    params(r1, 'pull_request')['optional_default'] = true;
    expect(driftOf(live)).toEqual([
      'ruleset cq-r1-main: rule pull_request: parameter optional_default differs: expected absent actual true',
    ]);
  });

  it('reports a missing and an extra ruleset', () => {
    const live = liveFrom(target());
    live.rulesets = live.rulesets.filter((r) => r.name !== 'cq-r1-main');
    live.rulesets.push({
      name: 'H-restrict-updates',
      target: 'branch',
      enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
      rules: [{ type: 'update' }],
      bypass_actors: [],
    });
    expect(driftOf(live)).toEqual([
      'ruleset cq-r1-main: missing',
      'ruleset H-restrict-updates: present live but not in the settings file',
    ]);
  });

  it('reports enforcement, conditions and rule differences', () => {
    const live = liveFrom(target());
    const r0 = ruleset(live, 'cq-r0-history');
    r0.enforcement = 'evaluate';
    r0.conditions = {
      ref_name: { include: ['refs/heads/main', 'refs/heads/obsolete'], exclude: [] },
    };
    r0.rules = r0.rules.filter((r) => r.type !== 'deletion');
    r0.rules.push({ type: 'creation' });
    expect(driftOf(live)).toEqual([
      'ruleset cq-r0-history: enforcement differs: expected "active" actual "evaluate"',
      'ruleset cq-r0-history: conditions differ: expected {"ref_name":{"exclude":[],"include":["refs/heads/main"]}} actual {"ref_name":{"exclude":[],"include":["refs/heads/main","refs/heads/obsolete"]}}',
      'ruleset cq-r0-history: rule deletion missing',
      'ruleset cq-r0-history: rule creation present live but not in the settings file',
    ]);
  });

  it('reports a bypass difference, with the exempt promoter called out', () => {
    const live = liveFrom(target());
    const r1 = ruleset(live, 'cq-r1-main');
    r1.bypass_actors = [
      { actor_id: PROMOTER, actor_type: 'Integration', bypass_mode: 'exempt' },
      { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
    ];
    expect(driftOf(live)).toEqual([
      `ruleset cq-r1-main: bypass_actors differ: expected [{"actor_id":${PROMOTER},"actor_type":"Integration","bypass_mode":"always"},{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}] actual [{"actor_id":${PROMOTER},"actor_type":"Integration","bypass_mode":"exempt"},{"actor_id":5,"actor_type":"RepositoryRole","bypass_mode":"always"}]`,
      `ruleset cq-r1-main: bypass actor Integration ${PROMOTER} has bypass_mode "exempt"; it must be "always" (an exempt bypass leaves no audit entry)`,
    ]);
  });

  it('reports an unexpected App bypass added to main and an unreadable bypass list', () => {
    const live = liveFrom(target());
    ruleset(live, 'cq-r1-main').bypass_actors?.push({
      actor_id: VERDICT,
      actor_type: 'Integration',
      bypass_mode: 'always',
    });
    delete ruleset(live, 'cq-r0-history').bypass_actors;
    const drift = driftOf(live);
    expect(drift).toHaveLength(2);
    expect(drift[0]).toMatch(/^ruleset cq-r0-history: bypass_actors unreadable/);
    expect(drift[1]).toMatch(/^ruleset cq-r1-main: bypass_actors differ: /);
  });

  it('reports a missing, re-pinned or extra required check', () => {
    const live = liveFrom(target());
    const p = params(ruleset(live, 'cq-r1-main'), 'required_status_checks');
    p['required_status_checks'] = [
      { context: 'static', integration_id: VERDICT },
      { context: 'cq/policy', integration_id: VERDICT },
    ];
    expect(driftOf(live)).toEqual([
      'ruleset cq-r1-main: rule required_status_checks: required check denylist (integration_id 15368) missing',
      `ruleset cq-r1-main: rule required_status_checks: required check static: integration_id differs: expected 15368 actual ${VERDICT}`,
      'ruleset cq-r1-main: rule required_status_checks: required check cq/policy present live but not in the settings file',
    ]);
  });

  it('reports a pull_request parameter difference as missing/extra members', () => {
    const live = liveFrom(target());
    const p = params(ruleset(live, 'cq-r1-main'), 'pull_request');
    p['allowed_merge_methods'] = ['squash', 'merge'];
    p['required_review_thread_resolution'] = true;
    expect(driftOf(live)).toEqual([
      'ruleset cq-r1-main: rule pull_request: parameter allowed_merge_methods differs: missing [] extra ["squash"]',
      'ruleset cq-r1-main: rule pull_request: parameter required_review_thread_resolution differs: expected false actual true',
    ]);
  });

  it('reports classic branch protection that is present', () => {
    const live = liveFrom(target());
    live.classicBranchProtection['main'] = { enforce_admins: { enabled: true } };
    expect(driftOf(live)).toEqual([
      'classic branch protection on main: present (target: absent; rulesets replace classic protection)',
    ]);
  });
});
