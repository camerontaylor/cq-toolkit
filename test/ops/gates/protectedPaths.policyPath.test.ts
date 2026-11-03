// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this file holds the isProtectedPolicyPath (D11) assertions.
import { describe, expect, test } from 'vitest';
import {
  isProtectedPolicyPath,
  isProtectedStagePath,
} from '../../../src/ops/gates/protectedPaths.js';

describe('isProtectedPolicyPath (D11, ADR-0004 D-G.1)', () => {
  test.each([
    'policy/DOCTRINE.md',
    'policy/templates/cq-policy.yml',
    'lint/x',
    'lint/rules/no-vendor-sdk-in-kernel.mjs',
    '.github/workflows/ci.yml',
    'baselines/ratchets.json',
    'pkg/conftest.py',
    'tests/conftest.py',
  ])('%s is a protected policy path', (path) => {
    expect(isProtectedPolicyPath(path)).toBe(true);
  });

  test.each([
    // Tests and snapshots are worker evidence, not enforcement definitions.
    'src/foo.test.ts',
    'test_widget.py',
    'widget_test.py',
    'apps/crq-python/test_crq.py',
    'pkg/widget_test.py',
    '__snapshots__/a.snap',
    'test/unit/a.ts',
    'src/index.ts',
    // Anchored at the repo root: a nested `policy/` or `lint/` is content.
    'src/policy/index.ts',
    'src/lint/index.ts',
    'policyish/a.md',
  ])('%s is not a protected policy path', (path) => {
    expect(isProtectedPolicyPath(path)).toBe(false);
  });

  test('policy and lint paths are also denied to sweep workers', () => {
    expect(isProtectedStagePath('policy/templates/ratchet.yml')).toBe(true);
    expect(isProtectedStagePath('lint/plugin.mjs')).toBe(true);
  });
});
