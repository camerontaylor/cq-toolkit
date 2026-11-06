// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this file holds the privileged-list (advisory posture) assertions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { REPO_ROOT } from './protectedPaths.helpers.js';

// The project list is the PRIVILEGED list (advisory development posture,
// 2026-10-20; docs/protected-scope.md "Advisory posture"): under
// `CQ_MERGE_PROTECTED_PATHS=advisory` a path it names is a `privileged-path`
// finding and still needs a human; the trusted closure, the settle schema
// and the D11 check code are no longer listed, so a change to them is an
// `advisory:` annotation (the built-in taxonomy still reports them as
// `protected-path`).
describe('the privileged list (advisory development posture)', () => {
  const patterns = (
    JSON.parse(readFileSync(join(REPO_ROOT, 'policy/protected-paths.json'), 'utf8')) as {
      protectedPaths: string[];
    }
  ).protectedPaths;
  const privileged = (path: string): boolean =>
    patterns.some((pattern) => new RegExp(pattern).test(path));

  test.each([
    'policy/protected-paths.json',
    '.github/workflows/denylist.yml',
    'policy/promotion-reviewer.json',
    'policy/denylist/patterns.yml',
    '.gitleaks.toml',
    'scripts/github-settings-drift.mjs',
    'scripts/lib/github-settings.mjs',
    'policy/templates/github-settings.json',
    'policy/attestations/c3.json',
    'apps/crq-python/signer/signer.py',
    'apps/crq-python/ops/systemd/crq.service',
    'apps/crq-python/config.json',
  ])('%s is privileged', (path) => {
    expect(privileged(path)).toBe(true);
  });

  test.each([
    'src/selfhost/settle-state.ts',
    '.github/workflows/ci.yml',
    'src/selfhost/acceptance.ts',
    'src/ops/gates/policyDiff.ts',
    'src/ops/gates/registry.ts',
    'src/shared/messageOf.ts',
    'scripts/ratchet-check.mjs',
    'apps/crq-python/ops/prepare-host.py',
    'src/selfhost/promote-gate.tsx',
    'apps/crq-python/config.json.bak',
  ])('%s is not privileged', (path) => {
    expect(privileged(path)).toBe(false);
  });
});
