// compareSettings over credentials: an unlisted environment secret is drift and
// an interim one is a notice until the C3 attestation, both drill PAT names are
// rejected at every stage, optional environment variable names must be on the
// allowlist, and a repository-level secret is always drift.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { describe, expect, it } from 'vitest';
import { compareSettings } from '../../scripts/lib/github-settings.mjs';
import { driftOf, liveFrom, target } from './github-settings.helpers.js';

describe('compareSettings', () => {
  it('reports an unlisted environment secret as drift and an interim one as a notice', () => {
    const live = liveFrom(target());
    live.environments['automation']?.secrets.push('GH_TOKEN', 'CQ_AUTOMATION_TOKEN');
    live.environments['cq-verdict']?.secrets.push('PROMOTE_TOKEN');
    expect(compareSettings(target(), live)).toEqual({
      drift: ['environment cq-verdict: secret PROMOTE_TOKEN is not in the allowlist'],
      notices: [
        'environment automation: interim secret CQ_AUTOMATION_TOKEN present (allowed until the ADR-0004 D-H.3 C3 attestation)',
        'environment automation: interim secret GH_TOKEN present (allowed until the ADR-0004 D-H.3 C3 attestation)',
      ],
    });
  });

  it('rejects every interim secret after C3 and both drill PAT names at every stage', () => {
    const settings = target();
    const live = liveFrom(settings);
    for (const [name, env] of Object.entries(settings.environments)) {
      live.environments[name]?.secrets.push(...env.interimSecrets);
    }
    live.environments['drill']?.secrets.push('CQ_DRILL_MERGE_TOKEN', 'GH_TOKEN');
    const result = compareSettings(settings, live, { c3Attested: true });
    expect(result.notices).toEqual([]);
    expect(result.drift).toHaveLength(
      Object.values(settings.environments).reduce((n, env) => n + env.interimSecrets.length, 2),
    );
    expect(compareSettings(settings, live).drift).toEqual([
      'environment drill: secret CQ_DRILL_MERGE_TOKEN is not in the allowlist',
      'environment drill: secret GH_TOKEN is not in the allowlist',
    ]);
  });

  it('allows optional environment variable names and rejects unlisted names deterministically', () => {
    const live = liveFrom(target());
    live.environments['automation']?.variables.push('UNLISTED_B', 'UNLISTED_A');
    live.environments['drill']?.variables.push('UNLISTED');
    live.environments['adversarial-scratch']!.variables = [];
    expect(driftOf(live)).toEqual([
      'environment automation: variable UNLISTED_A is not in the allowlist',
      'environment automation: variable UNLISTED_B is not in the allowlist',
      'environment drill: variable UNLISTED is not in the allowlist',
    ]);
  });

  it('reports a repository-level secret', () => {
    const live = liveFrom(target());
    live.repositorySecrets = ['PROMOTE_TOKEN'];
    expect(driftOf(live)).toEqual([
      'repository secret PROMOTE_TOKEN: present (target: no repository-level secrets)',
    ]);
  });
});
