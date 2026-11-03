// github-settings-drift CLI: the Actions event policy read, the read side end
// to end. A fake `gh` (CQ_GH_BIN) serving the target state as the REST API
// would; status.txt overrides one path's HTTP status (e.g. the 403 GitHub
// returns for `actions/policies` to a credential without Administration: write).
// This file covers the environment-variable pages and their refusal, the C3
// trust-ref checkout, and a clean live state.
// Split provenance: test/scripts/github-settings.test.ts was split into
// github-settings.target.test.ts, github-settings.compareRulesets.test.ts,
// github-settings.compareEnvironments.test.ts, github-settings.compareSecrets.test.ts,
// github-settings.compareActions.test.ts, github-settings.fromApi.test.ts,
// github-settings.cliFailClosed.test.ts, github-settings.cliReads.test.ts and
// github-settings.cliEventPolicy.test.ts.
import { describe, expect, it } from 'vitest';
import { runFake } from './github-settings.helpers.js';

describe('github-settings-drift CLI: the Actions event policy read', () => {
  const REPO = 'repos/o/r';

  it('compares all environment variables across 30-item pages', () => {
    const base = `${REPO}/environments/drill/variables?per_page=30&page=`;
    const names = Array.from({ length: 31 }, (_, i) => `UNLISTED_${String(i).padStart(2, '0')}`);
    const result = runFake([], {}, false, {
      [`${base}1`]: { total_count: 31, variables: names.slice(0, 30).map((name) => ({ name })) },
      [`${base}2`]: { total_count: 31, variables: [{ name: names[30] }] },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toBe('');
    for (const name of names) {
      expect(result.stdout).toContain(
        `drift: environment drill: variable ${name} is not in the allowlist`,
      );
    }
    expect(result.stdout).toContain('31 drift line(s), 0 notice(s)');
  });

  it('rejects malformed or incomplete variable pagination', () => {
    const base = `${REPO}/environments/drill/variables?per_page=30&page=`;
    const first = { total_count: 2, variables: [{ name: 'FIRST' }] };
    for (const second of [
      { total_count: 2, variables: [] },
      { total_count: 3, variables: [{ name: 'SECOND' }] },
      { variables: [{ name: 'SECOND' }] },
      { total_count: 1, variables: [{ name: 'SECOND' }] },
      { total_count: 2, variables: [{ name: 'SECOND' }, { name: 'THIRD' }] },
    ]) {
      const result = runFake([], {}, false, { [`${base}1`]: first, [`${base}2`]: second });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain('environment drill variables:');
      expect(result.stdout).toBe('');
    }
  });

  it('reads C3 from its trust-ref checkout and rejects an interim secret', () => {
    const result = runFake([], {}, true);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(
      'drift: environment promote: secret PROMOTE_TOKEN is not in the allowlist',
    );
    expect(result.stdout).not.toContain('notice:');
  });

  it('fails closed when the environment-variable read is refused', () => {
    const result = runFake([], {
      [`${REPO}/environments/drill/variables?per_page=30&page=1`]: 403,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('variables');
  });

  it('a readable live state equal to the target is clean (exit 0)', { timeout: 180_000 }, () => {
    const res = runFake([], {});
    expect(res.stderr).toBe('');
    expect(res.stdout).toBe('github-settings-drift: o/r: 0 drift line(s), 0 notice(s)\n');
    expect(res.status).toBe(0);
  });
});
