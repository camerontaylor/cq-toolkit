import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  DEFAULT_RANK,
  parseRepos,
  RepoRegistryError,
  sameRepoIdentity,
} from '../../../src/policy/crq/repoRegistry.js';

// Vectors mirror apps/crq-python/test_repo_registry.py (ParseTests).
const PRIMARY = 'camerontaylor/cq-toolkit';
const entry = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  repo: 'camerontaylor/infra',
  clone: '/srv/crq/infra',
  ...over,
});
const config = (repos: unknown): JsonObject =>
  parseJsonValue(JSON.stringify({ repo: PRIMARY, repos })) as JsonObject;

describe('repo registry parse', () => {
  it('keeps the single-repo shape when repos is absent or empty', () => {
    expect(parseRepos(parseJsonValue(JSON.stringify({ repo: PRIMARY })) as JsonObject)).toEqual([]);
    expect(parseRepos(config([]))).toEqual([]);
  });

  it('applies the Python defaults', () => {
    const [cfg] = parseRepos(config([entry()]));
    expect(cfg).toEqual({
      repo: 'camerontaylor/infra',
      name: 'infra',
      clone: '/srv/crq/infra',
      defaultBranch: 'main',
      defaultRef: 'origin/main',
      push: true,
      pr: false,
      floor: null,
      quietMinutes: null,
      include: ['**'],
      exclude: [],
      rankTier: DEFAULT_RANK,
      findings: 'issue',
      scanExtraClasses: [],
    });
  });

  it('reads explicit values and strips the clone path', () => {
    const [cfg] = parseRepos(
      config([
        entry({
          default_branch: 'trunk',
          discovery: { push: false, pr: true },
          clone: '  /srv/crq/infra  ',
          floor: '2026-11-10T00:00:00Z',
          quiet_minutes: 15,
          include: ['bin/**'],
          exclude: ['**/*.png', 'secrets/*'],
          rank_tier: 2,
          findings: 'none',
          scan_extra_classes: ['x'],
        }),
      ]),
    );
    expect(cfg).toMatchObject({
      defaultRef: 'origin/trunk',
      clone: '/srv/crq/infra',
      push: false,
      pr: true,
      floor: '2026-11-10T00:00:00Z',
      quietMinutes: 15,
      include: ['bin/**'],
      exclude: ['**/*.png', 'secrets/*'],
      rankTier: 2,
      findings: 'none',
      scanExtraClasses: ['x'],
    });
  });

  it('refuses duplicates and primary repeats case-insensitively', () => {
    expect(() => parseRepos(config([entry(), entry()]))).toThrow(/duplicated/);
    expect(() =>
      parseRepos(config([entry(), entry({ repo: 'CameronTaylor/Infra', clone: '/x' })])),
    ).toThrow(/duplicated/);
    expect(() => parseRepos(config([entry({ repo: PRIMARY.toUpperCase() })]))).toThrow(
      /primary repo/,
    );
    expect(() =>
      parseRepos(config([entry(), entry({ repo: 'other/Infra', clone: '/x' })])),
    ).toThrow(/name collides/);
    expect(() =>
      parseRepos(config([entry(), entry({ repo: 'other/infra', clone: '/x' })])),
    ).toThrow(/name collides/);
  });

  const bad: [string, unknown][] = [
    ['not a list', { repo: 'a/b' }],
    ['not an object', ['camerontaylor/infra']],
    ['unknown key', [entry({ priority: 1 })]],
    ['not owner/name', [entry({ repo: 'infra' })]],
    ['space in slug', [entry({ repo: 'camerontaylor/a b' })]],
    ['missing clone', [entry({ clone: '' })]],
    ['blank clone', [entry({ clone: '   ' })]],
    ['leading-dash branch', [entry({ default_branch: '-main' })]],
    ['dotdot branch', [entry({ default_branch: 'a..b' })]],
    ['double slash branch', [entry({ default_branch: 'a//b' })]],
    ['.lock branch', [entry({ default_branch: 'refs.lock' })]],
    ['unknown discovery key', [entry({ discovery: { pushes: true } })]],
    ['non-bool discovery', [entry({ discovery: { push: 'yes' } })]],
    ['null push (Python dict.get keeps the null)', [entry({ discovery: { push: null } })]],
    ['null pr', [entry({ discovery: { pr: null } })]],
    ['discovery not an object', [entry({ discovery: true })]],
    ['date-only floor', [entry({ floor: '2026-11-10' })]],
    ['impossible floor', [entry({ floor: '2026-13-40T99:00:00Z' })]],
    ['feb 30 floor', [entry({ floor: '2026-02-30T00:00:00Z' })]],
    ['leap second floor', [entry({ floor: '2026-06-30T23:59:60Z' })]],
    ['year 0 floor', [entry({ floor: '0000-01-01T00:00:00Z' })]],
    ['dot-leading branch segment', [entry({ default_branch: 'release/.hidden/stable' })]],
    ['.lock branch segment', [entry({ default_branch: 'release.lock/stable' })]],
    ['zero quiet', [entry({ quiet_minutes: 0 })]],
    ['string quiet', [entry({ quiet_minutes: '30' })]],
    ['bool quiet', [entry({ quiet_minutes: true })]],
    ['float quiet', [entry({ quiet_minutes: 1.5 })]],
    ['rank below', [entry({ rank_tier: 1 })]],
    ['rank above', [entry({ rank_tier: 5 })]],
    ['null rank', [entry({ rank_tier: null })]],
    ['bad findings', [entry({ findings: 'comment' })]],
    ['null findings', [entry({ findings: null })]],
    ['empty include', [entry({ include: [] })]],
    ['newline glob', [entry({ exclude: ['a\nb'] })]],
    ['bad scan class', [entry({ scan_extra_classes: [''] })]],
  ];
  it.each(bad)('refuses %s', (_why, repos) => {
    expect(() => parseRepos(config(repos))).toThrow(RepoRegistryError);
  });

  it('still accepts a hierarchical default branch', () => {
    expect(parseRepos(config([entry({ default_branch: 'release/stable' })]))[0]?.defaultRef).toBe(
      'origin/release/stable',
    );
  });

  it('refuses a present null repos (Python get returns None, not the default)', () => {
    // Differential vector: repo_registry.parse({'repo': 'o/p', 'repos': None}) -> ValueError
    // 'repos must be a list of per-repo objects'; the same config without the key -> [].
    expect(parseRepos(parseJsonValue(`{"repo":"${PRIMARY}"}`) as JsonObject)).toEqual([]);
    expect(() => parseRepos(config(null))).toThrow('repos must be a list of per-repo objects');
  });

  it('refuses a quiet_minutes integer beyond 2^53 (documented, stricter than Python)', () => {
    const raw = `{"repo":"${PRIMARY}","repos":[{"repo":"a/b","clone":"/c","quiet_minutes":100000000000000000000}]}`;
    expect(() => parseRepos(parseJsonValue(raw) as JsonObject)).toThrow(RepoRegistryError);
  });

  it('refuses a float rank even when integral (Python isinstance int)', () => {
    const raw = `{"repo":"${PRIMARY}","repos":[{"repo":"a/b","clone":"/c","rank_tier":3.0}]}`;
    expect(() => parseRepos(parseJsonValue(raw) as JsonObject)).toThrow(RepoRegistryError);
  });

  it('accepts a leap day and a null floor/quiet', () => {
    const [cfg] = parseRepos(
      config([entry({ floor: '2024-02-29T00:00:00Z', quiet_minutes: null })]),
    );
    expect(cfg?.floor).toBe('2024-02-29T00:00:00Z');
    expect(cfg?.quietMinutes).toBeNull();
  });

  it('compares repo identities case-insensitively and never matches empty', () => {
    expect(sameRepoIdentity('A/b', 'a/B')).toBe(true);
    expect(sameRepoIdentity('', '')).toBe(false);
    expect(sameRepoIdentity(undefined, 'a/b')).toBe(false);
  });
});
