// Mapping and fallback logic for the advisory affected-test selector
// (scripts/lib/affected-tests.mjs). Pure: no git, no vitest invocation.
import { describe, expect, it } from 'vitest';
import { isTest, selectAffected } from '../../scripts/lib/affected-tests.mjs';

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

  it('recognizes test files by the vitest include globs, .mjs tests included', () => {
    expect(isTest('test/api-report.test.mjs')).toBe(true);
    expect(isTest('test/kernel/b.test.ts')).toBe(true);
    expect(isTest('lint/rules/x.test.ts')).toBe(true);
    expect(isTest('lint/rules/x.test.mjs')).toBe(false); // lint/** includes .ts only
    expect(isTest('test/helpers/git-env.ts')).toBe(false);
    const withMjs = [...allTests, 'test/api-report.test.mjs'];
    expect(
      selectAffected({ changed: ['test/api-report.test.mjs'], allTests: withMjs, related: [] }),
    ).toEqual({ files: ['test/api-report.test.mjs'], fallback: false, reason: 'mapped' });
    expect(
      selectAffected({
        changed: ['src/kernel/x.ts'],
        allTests: withMjs,
        related: ['test/api-report.test.mjs'],
      }).files,
    ).toEqual(['test/api-report.test.mjs']);
  });

  it('maps sources that suites read or spawn by path, with no import edge', () => {
    const suites = [
      'test/api-report.test.mjs',
      'test/driver/harness-parity.test.ts',
      'test/driver/served-model-sites.test.ts',
      'test/driver/subprocess.test.ts',
      'test/harness/mcp-bin.test.ts',
      'test/ops/gates/protectedPaths.test.ts',
      'test/workflows/default-ref-guards.test.ts',
    ];
    const pick = (changed: string) =>
      selectAffected({ changed: [changed], allTests: suites, related: [] }).files;
    expect(pick('src/selfhost/promote-gate.ts')).toEqual([
      'test/ops/gates/protectedPaths.test.ts',
      'test/workflows/default-ref-guards.test.ts',
    ]);
    // The protected closure crosses directories: any source may join it.
    expect(pick('src/kernel/types.ts')).toEqual(['test/ops/gates/protectedPaths.test.ts']);
    expect(pick('src/ops/merge/classifyPrs.ts')).toEqual([
      'test/driver/served-model-sites.test.ts',
      'test/ops/gates/protectedPaths.test.ts',
    ]);
    expect(pick('src/harness/mcp/server.ts')).toEqual([
      'test/driver/harness-parity.test.ts',
      'test/harness/mcp-bin.test.ts',
      'test/ops/gates/protectedPaths.test.ts',
    ]);
    expect(pick('src/cli/main.ts')).toEqual([
      'test/driver/subprocess.test.ts',
      'test/ops/gates/protectedPaths.test.ts',
    ]);
    expect(pick('scripts/api-report.mjs')).toEqual(['test/api-report.test.mjs']);
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
    expect(result).toMatchObject({ fallback: true, reason: 'deleted module src/kernel/gone.ts' });
  });

  it('falls back when a scripts/ module was deleted: its importers are unknown too', () => {
    // e.g. scripts/api-report.mjs, imported by test/api-report.test.mjs,
    // which the generic scripts/ row would not select.
    const result = selectAffected({
      changed: ['scripts/api-report.mjs'],
      allTests,
      related: [],
      missing: ['scripts/api-report.mjs'],
    });
    expect(result).toMatchObject({
      fallback: true,
      reason: 'deleted module scripts/api-report.mjs',
    });
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
