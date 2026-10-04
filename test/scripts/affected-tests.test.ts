// Mapping and fallback logic for the advisory affected-test selector
// (scripts/lib/affected-tests.mjs). Pure: no git, no vitest invocation.
import { describe, expect, it } from 'vitest';
import { selectAffected } from '../../scripts/lib/affected-tests.mjs';

const allTests = [
  'test/driver/a.test.ts',
  'test/kernel/b.test.ts',
  'test/scripts/c.test.ts',
  'test/workflows/d.test.ts',
];

describe('selectAffected', () => {
  it('unions the import-graph hits with the reviewed non-import map', () => {
    const result = selectAffected({
      changed: ['src/kernel/x.ts', 'policy/templates/gate.yml'],
      allTests,
      related: ['test/kernel/b.test.ts'],
    });
    expect(result).toEqual({
      files: ['test/kernel/b.test.ts', 'test/scripts/c.test.ts', 'test/workflows/d.test.ts'],
      fallback: false,
      reason: 'mapped',
    });
  });

  it('normalizes platform-separated import-graph hits to POSIX paths', () => {
    expect(
      selectAffected({
        changed: ['src/kernel/x.ts'],
        allTests,
        related: ['test\\kernel\\b.test.ts'],
      }).files,
    ).toEqual(['test/kernel/b.test.ts']);
  });

  it('selects a changed test file itself, and ignores unknown test paths', () => {
    expect(
      selectAffected({
        changed: ['test/driver/a.test.ts', 'test/gone.test.ts'],
        allTests,
        related: [],
      }).files,
    ).toEqual(['test/driver/a.test.ts']);
  });

  it('selects nothing for inert prose edits without falling back', () => {
    expect(
      selectAffected({ changed: ['README.md', 'docs/guide.md'], allTests, related: [] }),
    ).toEqual({
      files: [],
      fallback: false,
      reason: 'mapped',
    });
  });

  it('does not treat runtime-read Markdown as inert', () => {
    for (const path of ['docs/dd-1-abort-spike.md', 'src/ops/merge/prompts/conflict.default.md']) {
      expect(selectAffected({ changed: [path], allTests, related: [] }).files).toEqual(allTests);
    }
  });

  it('maps fixtures, dependency metadata and baselines to every consumer', () => {
    for (const path of [
      'test/fixtures/x.ts',
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.json',
    ]) {
      expect(selectAffected({ changed: [path], allTests, related: [] }).files).toEqual(allTests);
    }
    const gates = ['test/ops/gates/g.test.ts', 'test/workflows/d.test.ts'];
    for (const path of ['baselines/ratchets.json', 'policy/templates/github-settings.json']) {
      expect(
        selectAffected({ changed: [path], allTests: [...allTests, ...gates], related: [] }).files,
      ).toEqual(expect.arrayContaining(gates));
    }
  });

  it('includes lint suites in suite-wide mappings', () => {
    const withLint = [...allTests, 'lint/rules/r.test.ts'];
    for (const path of ['package.json', 'vitest.config.ts', 'test/helpers/h.ts']) {
      expect(selectAffected({ changed: [path], allTests: withLint, related: [] }).files).toEqual(
        [...withLint].sort(),
      );
    }
  });

  it('maps filesystem-read consumers that have no import-graph edge', () => {
    const consumers = [
      'test/cli/plans.smoke.test.ts',
      'test/cli/registry.test.ts',
      'test/kernel/driver-hygiene.test.ts',
      'test/scripts/static-conformance.test.ts',
      'test/cli/conformance.test.ts',
    ];
    const pool = [...allTests, ...consumers];
    const pick = (path: string) =>
      selectAffected({ changed: [path], allTests: pool, related: [] }).files;
    expect(pick('scripts/copy-prompt-assets.mjs')).toContain('test/cli/plans.smoke.test.ts');
    expect(pick('src/driver/new/x.ts')).toEqual(
      expect.arrayContaining([consumers[2], consumers[3]]),
    );
    expect(pick('src/ops/new/x.ts')).toContain('test/cli/registry.test.ts');
    expect(pick('src/ops/new/x.ts')).toContain('test/cli/conformance.test.ts');
  });

  it('maps root configs, lint sources and workflows to the suites that read them', () => {
    const pool = [
      ...allTests,
      'lint/rules/r.test.ts',
      'test/scripts/knip.test.ts',
      'test/scripts/oxlint-boundaries.test.ts',
      'test/ops/gates/protectedPaths.test.ts',
    ];
    const pick = (path: string) => selectAffected({ changed: [path], allTests: pool, related: [] });
    expect(pick('knip.json').files).toEqual([
      'test/ops/gates/protectedPaths.test.ts',
      'test/scripts/knip.test.ts',
    ]);
    for (const path of ['.oxlintrc.json', 'lint/plugin.mjs']) {
      expect(pick(path).files).toEqual([
        'lint/rules/r.test.ts',
        'test/ops/gates/protectedPaths.test.ts',
        'test/scripts/oxlint-boundaries.test.ts',
      ]);
    }
    expect(pick('.github/workflows/ci.yml')).toMatchObject({
      files: ['test/ops/gates/protectedPaths.test.ts', 'test/workflows/d.test.ts'],
      fallback: false,
    });
  });

  it('maps workflow and composite-action edits to every suite that reads them', () => {
    const readers = [
      'test/ops/gates/policyDiff.test.ts',
      'test/ops/gates/protectedPaths.test.ts',
      'test/ops/gates/workflowScan.test.ts',
      'test/ops/ratchet/definitions.test.ts',
      'test/scripts/github-settings.test.ts',
    ];
    for (const path of ['.github/workflows/ci.yml', '.github/actions/static-gate/action.yml']) {
      expect(
        selectAffected({ changed: [path], allTests: [...allTests, ...readers], related: [] }),
      ).toEqual({
        files: [...readers, 'test/workflows/d.test.ts'],
        fallback: false,
        reason: 'mapped',
      });
    }
    // Other .github metadata stays inert prose.
    expect(
      selectAffected({ changed: ['.github/PULL_REQUEST_TEMPLATE.md'], allTests, related: [] }),
    ).toEqual({ files: [], fallback: false, reason: 'mapped' });
  });

  it('falls back when a source file was deleted: its importers are unknown', () => {
    const result = selectAffected({
      changed: ['src/kernel/gone.ts', 'README.md'],
      allTests,
      related: [],
      missing: ['src/kernel/gone.ts'],
    });
    expect(result).toMatchObject({ fallback: true, reason: 'deleted source src/kernel/gone.ts' });
  });

  it('falls back to every test when a changed file has no mapping', () => {
    const result = selectAffected({ changed: ['mystery/file.bin'], allTests, related: [] });
    expect(result.fallback).toBe(true);
    expect(result.files).toEqual(allTests);
    expect(result.reason).toContain('mystery/file.bin');
  });

  it('falls back to every test when the import-graph query failed', () => {
    const result = selectAffected({ changed: ['src/x.ts'], allTests, related: null });
    expect(result).toMatchObject({ fallback: true, reason: 'import-graph query failed' });
    expect(result.files).toEqual(allTests);
  });
});
