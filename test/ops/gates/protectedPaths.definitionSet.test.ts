// Split provenance: test/ops/gates/protectedPaths.test.ts was split by subject
// into protectedPaths.{definitionSet,patternLiveness,privilegedList,policyPath,trustedJobs,trustBuild,closure}.test.ts;
// this file holds the definition-set sync assertions.
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
import { isProtectedStagePath } from '../../../src/ops/gates/protectedPaths.js';
import { tsconfigGraphPaths } from '../../../src/ops/ratchet/internal/definitions.js';
import { REPO_ROOT } from './protectedPaths.helpers.js';

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
  '(?:^|/)pnpm-lock\\.yaml$': ['pnpm-lock.yaml'],
  // pnpm settings and install hooks decide what is installed.
  '(?:^|/)pnpm-workspace\\.yaml$': ['pnpm-workspace.yaml', 'packages/x/pnpm-workspace.yaml'],
  '(?:^|/)\\.pnpmfile\\.[cm]?js$': ['.pnpmfile.cjs', '.pnpmfile.mjs'],
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
