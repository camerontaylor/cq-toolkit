// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this file holds the reverse-direction pattern liveness assertions.
import { describe, expect, test } from 'vitest';
import {
  PROTECTED_STAGE_PATTERNS,
  isProtectedStagePath,
} from '../../../src/ops/gates/protectedPaths.js';

/**
 * A path each protected pattern is meant to catch, keyed by that pattern's
 * exact `.source`. This is the REVERSE direction of the table above: keyed by
 * pattern, so a pattern added to the taxonomy with no representative here
 * fails the test instead of going untested.
 *
 * It is a LIVENESS guard, not a pairing proof. The taxonomy is deliberately
 * broader than the ratchet definition set (test evidence is worker-controlled
 * but is not a ratchet definition), so "every representative is a definition
 * path" is neither true nor wanted — see the RATCHET-SET SYNC note on
 * `PROTECTED_CONFIG_PATH_PATTERNS`.
 */
const PATTERN_REPRESENTATIVES: Readonly<Record<string, readonly string[]>> = {
  '(^|\\/)(?:test|tests|spec|specs|__tests__|__mocks__|__fixtures__|__snapshots__|cypress|e2e|test-utils)\\/':
    [
      'test/unit/a.ts',
      'src/__mocks__/fs.ts',
      'cypress/support/commands.ts',
      'e2e/login.ts',
      'src/test-utils/render.ts',
    ],
  '\\.(?:test|spec)\\.[cm]?[jt]sx?$': ['src/a.test.ts', 'src/b.spec.mts'],
  '(?:^|\\/)(?:test_[^/]*|[^/]*_test)\\.py$': [
    'test_widget.py',
    'widget_test.py',
    'apps/crq-python/test_crq_slot.py',
    'pkg/widget_test.py',
  ],
  '\\.config\\.[^/]+$': ['vitest.config.ts', 'packages/a/vite.config.js'],
  '(?:^|\\/)(?:setupTests|globalSetup|global[-.]setup|conftest)\\.(?:[cm]?[jt]sx?|py)$': [
    'src/setupTests.ts',
    'globalSetup.ts',
    'test/globalSetup.mts',
    'global-setup.ts',
    'global.setup.mjs',
    'conftest.py',
    'pkg/conftest.py',
    'tests/conftest.py',
  ],
  '(?:^|\\/)\\.env\\.test(?:\\.[^/]+)?$': ['.env.test', 'packages/a/.env.test.local'],
  '(?:^|\\/)(?:oxlint\\.json|karma\\.conf\\.[cm]?[jt]s)$': [
    'oxlint.json',
    'karma.conf.js',
    'karma.conf.ts',
    'karma.conf.mts',
  ],
  '^baselines(?:\\/|$)': ['baselines/coverage--coverage--a8ceec8f7024.json'],
  '(?:^|\\/)\\.node-version$': ['.node-version'],
  '^\\.cq\\/tool(?:\\/|$)': ['.cq/tool/lint.sh'],
  '^src\\/ops\\/gates\\/protectedPaths\\.ts$': ['src/ops/gates/protectedPaths.ts'],
  '^\\.gitleaks\\.toml$': ['.gitleaks.toml'],
  '^scripts\\/ratchet-[^/]+\\.mjs$': ['scripts/ratchet-typecheck.mjs'],
  '^scripts\\/(?:build|gen-op-docs|copy-prompt-assets|lib\\/resource-scope)\\.mjs$': [
    'scripts/gen-op-docs.mjs',
    'scripts/copy-prompt-assets.mjs',
    'scripts/build.mjs',
    'scripts/lib/resource-scope.mjs',
  ],
  '(?:^|\\/)knip\\.jsonc?$': ['knip.json', 'packages/a/knip.jsonc'],
  '^policy(?:\\/|$)': ['policy/DOCTRINE.md', 'policy/templates/ratchet.yml'],
  '^lint(?:\\/|$)': ['lint/plugin.mjs', 'lint/rules/x.mjs'],
  '(?:^|\\/)[^/]*\\.setup\\.[^/]+$': ['vitest.setup.ts'],
  '(?:^|\\/)\\.[^/]*rc(?:\\.[^/]*)?$': ['.npmrc', 'packages/a/.npmrc'],
  '(?:^|\\/)\\.gitignore$': ['.gitignore', 'packages/a/.gitignore'],
  '(?:^|\\/)\\.gitattributes$': ['.gitattributes'],
  '(?:^|\\/)(?:tsconfig(?:\\.[^/]+)?\\.json|package\\.json|biome\\.jsonc?)$': [
    'tsconfig.json',
    'package.json',
  ],
  '^\\.github(?:\\/|$)': ['.github/workflows/ci.yml', '.github/actions/a/action.yml'],
  '^\\.husky(?:\\/|$)': ['.husky/pre-commit'],
  '(?:^|\\/)vitest\\.(?:workspace|projects)\\.(?:[cm]?[jt]sx?|json)$': ['vitest.workspace.json'],
  '(?:^|\\/)(?:package(?:-lock)?\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|poetry\\.lock|uv\\.lock|pdm\\.lock|Pipfile\\.lock|Gemfile\\.lock|Cargo\\.lock|composer\\.lock|mix\\.lock|go\\.sum)$':
    ['package-lock.json', 'npm-shrinkwrap.json'],
  '(?:^|\\/)(?:pnpm-workspace\\.yaml|\\.pnpmfile\\.[cm]?js)$': [
    'pnpm-workspace.yaml',
    '.pnpmfile.cjs',
  ],
  '\\.snap$': ['src/__snapshots__/a.snap'],
  // Vitest file-snapshot outputs carry arbitrary extensions: the directory,
  // not the extension, is the snapshot signal (issue #1188).
  '(?:^|\\/)__snapshots__\\/': ['src/__snapshots__/out.txt'],
};

describe('worker gate pattern liveness (reverse direction)', () => {
  const sources = [...new Set(PROTECTED_STAGE_PATTERNS.map((pattern) => pattern.source))];

  test('every protected pattern has a representative path', () => {
    // Keyed by source, so a NEW pattern without an entry here fails loudly.
    expect(Object.keys(PATTERN_REPRESENTATIVES).sort()).toEqual([...sources].sort());
  });

  test.each(
    PROTECTED_STAGE_PATTERNS.flatMap((pattern) => {
      const reps = PATTERN_REPRESENTATIVES[pattern.source] ?? [];
      return reps.map((path) => [pattern.source, path] as const);
    }),
  )('%s actually matches %s', (source, path) => {
    // The representative is matched by ITS OWN pattern (all are built with
    // the `i` flag), so a pattern that can never match anything is caught.
    expect(new RegExp(source, 'i').test(path)).toBe(true);
    // …and the stage path gate really does protect it.
    expect(isProtectedStagePath(path)).toBe(true);
  });
});

test.each([
  'testing.py',
  'contest.py',
  'latest_test_data.json',
  'apps/crq-python/ops/prepare-host.py',
  'pkg/contest_widget.py',
  'pkg/widget_testing.py',
  'pkg/test_widget.py.bak',
  'pkg/test_helpers/widget.py',
])('%s remains ordinary Python source outside test roots', (path) => {
  expect(isProtectedStagePath(path)).toBe(false);
});

test.each(['tests/widget.py', 'pkg/test/widget.py', 'pkg/__fixtures__/widget.py'])(
  '%s remains protected by its root regardless of Python basename',
  (path) => {
    expect(isProtectedStagePath(path)).toBe(true);
  },
);
