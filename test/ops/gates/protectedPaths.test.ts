// W1.7 fix-forward (composition F1) — the worker's default-deny taxonomy
// (`src/ops/gates/protectedPaths.ts`) and the ratchet DEFINITION SET
// (`baselines/ratchets.json`, read at the trust ref) are two lists that must
// not drift: a shape only one of them names is either worker-editable with no
// human in the loop, or needlessly need-human.
//
// This test reads the REAL manifest and asserts:
//   1. every `definitionSet` source has a representative path, and each
//      representative is protected by `isProtectedStagePath`;
//   2. the shapes ADR-0004 D-G.1 names that no static pattern can enumerate —
//      the tsconfig `extends`/`references` graph — are protected too;
//   3. the paths that carry the protected-path list and the required-check
//      list are in the definition set (D-C.4's last bullet).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  PROTECTED_STAGE_PATTERNS,
  isProtectedPolicyPath,
  isProtectedStagePath,
} from '../../../src/ops/gates/protectedPaths.js';
import { tsconfigGraphPaths } from '../../../src/ops/ratchet/internal/definitions.js';

const REPO_ROOT = join(__dirname, '..', '..', '..');

/** The committed manifest, read from the working tree (this is a repo-shape test, not a trust test). */
const MANIFEST = JSON.parse(
  readFileSync(join(REPO_ROOT, 'baselines', 'ratchets.json'), 'utf8'),
) as { definitionSet: string[] };

/** A path each definition-set source is meant to catch. Keyed BY SOURCE: a new source with no entry here fails the test. */
const REPRESENTATIVES: Readonly<Record<string, readonly string[]>> = {
  '^\\.github/': ['.github/workflows/ci.yml', '.github/actions/setup/action.yml'],
  '(?:^|/)vitest\\.config\\.[^/]+$': ['vitest.config.ts', 'packages/x/vitest.config.mts'],
  '(?:^|/)vite\\.config\\.[^/]+$': ['vite.config.ts'],
  '(?:^|/)vitest\\.workspace\\.[^/]+$': ['vitest.workspace.json'],
  '(?:^|/)tsconfig[^/]*\\.json$': ['tsconfig.json', 'tsconfig.base.json'],
  '(?:^|/)package\\.json$': ['package.json'],
  '(?:^|/)package-lock\\.json$': ['package-lock.json'],
  '(?:^|/)npm-shrinkwrap\\.json$': ['npm-shrinkwrap.json'],
  '(?:^|/)\\.npmrc$': ['.npmrc', 'packages/x/.npmrc'],
  '(?:^|/)\\.nvmrc$': ['.nvmrc'],
  '(?:^|/)\\.node-version$': ['.node-version'],
  '(?:^|/)\\.gitattributes$': ['.gitattributes'],
  '^\\.cq/tool/': ['.cq/tool/lint.sh'],
  // F1: the whole ratchet-evidence tree, not just the manifest.
  '^baselines/': ['baselines/coverage--coverage--a8ceec8f7024.json', 'baselines/nested/x.json'],
  // F2: the protected-path list and the required-check list ARE definitions.
  '^src/ops/gates/protectedPaths\\.ts$': ['src/ops/gates/protectedPaths.ts'],
  '^scripts/denylist-scan$': ['scripts/denylist-scan'],
  // W1.9 (ADR-0004 D-C.4): the D11 protected-path / required-check list and
  // the C3 attestation that activates override records are definitions.
  '^policy/protected-paths\\.json$': ['policy/protected-paths.json'],
  '^policy/attestations/': ['policy/attestations/c3.json'],
  // W1.9 H3: what the required checks run is measurement configuration.
  '(?:^|/)\\.oxlintrc\\.json$': ['.oxlintrc.json'],
  '(?:^|/)\\.oxfmtrc\\.json$': ['.oxfmtrc.json'],
  '^knip\\.json$': ['knip.json'],
  '^lint/': ['lint/plugin.mjs', 'lint/rules/x.mjs'],
  '^scripts/ratchet-[^/]+\\.mjs$': ['scripts/ratchet-typecheck.mjs', 'scripts/ratchet-lib.mjs'],
  '^scripts/gen-op-docs\\.mjs$': ['scripts/gen-op-docs.mjs'],
  '^scripts/copy-prompt-assets\\.mjs$': ['scripts/copy-prompt-assets.mjs'],
  '^policy/denylist/': ['policy/denylist/patterns.yml'],
};

describe('worker gate / ratchet definition-set sync (F1, F2)', () => {
  test('every definition-set source has a representative path', () => {
    expect(Object.keys(REPRESENTATIVES).sort()).toEqual([...MANIFEST.definitionSet].sort());
  });

  test.each(
    Object.entries(REPRESENTATIVES).flatMap(([source, paths]) =>
      paths.map((path) => [source, path] as const),
    ),
  )('%s protects %s', (_source, path) => {
    expect(isProtectedStagePath(path)).toBe(true);
  });

  test('the trust tsconfig graph is protected (a static pattern cannot enumerate it)', async () => {
    // Read from git, exactly as the verifier does, so a graph target that is
    // not even on disk is still counted.
    const graph = await tsconfigGraphPaths(REPO_ROOT, 'HEAD');
    expect(graph.length).toBeGreaterThan(0);
    for (const path of graph) expect(isProtectedStagePath(path)).toBe(true);
  });

  test('the definition set is not merely the old workflows-only subset (F6)', () => {
    expect(MANIFEST.definitionSet).toContain('^\\.github/');
    expect(MANIFEST.definitionSet).not.toContain('^\\.github/workflows/');
  });
});

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
  '(^|\\/)(?:test|tests|spec|specs|__tests__|__mocks__|__fixtures__|__snapshots__)\\/': [
    'test/unit/a.ts',
    'src/__mocks__/fs.ts',
  ],
  '\\.(?:test|spec)\\.[cm]?[jt]sx?$': ['src/a.test.ts', 'src/b.spec.mts'],
  '\\.config\\.[^/]+$': ['vitest.config.ts', 'packages/a/vite.config.js'],
  '^baselines(?:\\/|$)': ['baselines/coverage--coverage--a8ceec8f7024.json'],
  '(?:^|\\/)\\.node-version$': ['.node-version'],
  '^\\.cq\\/tool(?:\\/|$)': ['.cq/tool/lint.sh'],
  '^src\\/ops\\/gates\\/protectedPaths\\.ts$': ['src/ops/gates/protectedPaths.ts'],
  '^scripts\\/denylist-scan$': ['scripts/denylist-scan'],
  '^scripts\\/ratchet-[^/]+\\.mjs$': ['scripts/ratchet-typecheck.mjs'],
  '^scripts\\/(?:gen-op-docs|copy-prompt-assets)\\.mjs$': [
    'scripts/gen-op-docs.mjs',
    'scripts/copy-prompt-assets.mjs',
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
  '\\.snap$': ['src/__snapshots__/a.snap'],
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

describe('isProtectedPolicyPath (D11, ADR-0004 D-G.1)', () => {
  test.each([
    'policy/DOCTRINE.md',
    'policy/templates/cq-policy.yml',
    'lint/x',
    'lint/rules/no-vendor-sdk-in-kernel.mjs',
    '.github/workflows/ci.yml',
    'baselines/ratchets.json',
  ])('%s is a protected policy path', (path) => {
    expect(isProtectedPolicyPath(path)).toBe(true);
  });

  test.each([
    // Tests and snapshots are worker evidence, not enforcement definitions.
    'src/foo.test.ts',
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
