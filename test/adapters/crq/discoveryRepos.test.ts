import { describe, expect, it } from 'vitest';
import { buildDiscoveryRepos } from '../../../src/adapters/crq/discoveryRepos.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { DISCOVERY_BRANCHES } from '../../../src/policy/crq/reconcileInventory.js';
import { RepoRegistryError } from '../../../src/policy/crq/repoRegistry.js';

const build = (config: Record<string, unknown>) =>
  buildDiscoveryRepos(parseJsonValue(JSON.stringify(config)) as JsonObject);
const base = { repo: 'o/primary', clone: '/srv/primary', quiet_minutes: 10 };
const other = (over: Record<string, unknown> = {}) => ({
  repo: 'o/infra',
  clone: '/srv/infra',
  ...over,
});

describe('discovery repos builder', () => {
  it('lists only the primary for PRs and nothing for push when repos is absent', () => {
    const built = build(base);
    expect(built.push).toEqual([]);
    expect(built.pr).toEqual([
      {
        repo: 'o/primary',
        name: 'primary',
        primary: true,
        enabled: true,
        clone: '/srv/primary',
        defaultBranch: 'main',
        branches: DISCOVERY_BRANCHES,
      },
    ]);
  });

  it('uses the global quiet window unless the repo overrides it', () => {
    const built = build({
      ...base,
      repos: [other(), other({ repo: 'o/second', quiet_minutes: 25 })],
    });
    expect(built.push.map((r) => [r.repo, r.quietMinutes, r.enabled])).toEqual([
      ['o/infra', 10, true],
      ['o/second', 25, true],
    ]);
  });

  it('keeps flag-off repos in the lists with enabled:false', () => {
    const built = build({
      ...base,
      repos: [other({ discovery: { push: false, pr: true }, default_branch: 'trunk' })],
    });
    expect(built.push[0]).toMatchObject({ enabled: false, defaultBranch: 'trunk' });
    expect(built.pr[1]).toMatchObject({
      repo: 'o/infra',
      primary: false,
      enabled: true,
      branches: ['trunk'],
      defaultBranch: 'trunk',
    });
    const off = build({ ...base, repos: [other()] });
    expect(off.pr[1]?.enabled).toBe(false);
  });

  it('refuses a pushing repo with no usable quiet window, but not a non-pushing one', () => {
    const noQuiet = { repo: 'o/primary', clone: '/srv/primary' };
    expect(() => build({ ...noQuiet, repos: [other()] })).toThrow(RepoRegistryError);
    expect(() => build({ ...noQuiet, quiet_minutes: 0, repos: [other()] })).toThrow(
      RepoRegistryError,
    );
    expect(() =>
      build({ ...noQuiet, repos: [other({ discovery: { push: false } })] }),
    ).not.toThrow();
  });

  it('refuses a config without a primary repo or clone', () => {
    expect(() => build({ clone: '/x' })).toThrow(RepoRegistryError);
    expect(() => build({ repo: 'o/p' })).toThrow(RepoRegistryError);
  });

  it('propagates registry refusals (fail closed)', () => {
    expect(() => build({ ...base, repos: [other({ bogus: 1 })] })).toThrow(RepoRegistryError);
  });
});
