// Split provenance: test/ops/sweep/unit-registry.test.ts was split into
// unit-registry.{registry,schema,bindings,install-hooks,staging-policy,push,run-state,task-worker}.test.ts
// plus unit-registry.helpers.ts (shared fixtures). This file carries the
// staged-path default-deny taxonomy and the case-sensitive allowlist.
import { describe, expect, test } from 'vitest';
import { classifyStagePaths, compileStagePathPatterns } from '../../../src/ops/sweep/unit.js';

describe('sweep.unit registry entry (jSKJF)', () => {
  test('the shared default-deny taxonomy protects whole evidence/config roots', () => {
    for (const path of [
      'packages/a/test/helpers/setup.ts',
      'packages/a/__mocks__/fs.ts',
      'vitest.setup.ts',
      '.oxlintrc.json',
      '.mocharc.json',
      '.gitignore',
      'package-lock.json',
      '.github/workflows/ci.yml',
    ]) {
      expect(classifyStagePaths([path]).kind, path).toBe('protected');
    }
  });

  test('non-.snap files under __snapshots__/ stay protected when protectTests is false (#1188)', () => {
    // Vitest `toMatchFileSnapshot` outputs carry arbitrary extensions; the
    // directory is the snapshot signal in either protectTests mode.
    const refused = classifyStagePaths(['src/__snapshots__/out.txt'], undefined, false, false);
    expect(refused.kind).toBe('protected');
    expect(refused.paths).toContain('src/__snapshots__/out.txt');
    expect(classifyStagePaths(['src/foo.ts'], undefined, false, false).kind).toBe('clean');
    expect(classifyStagePaths(['src/__snapshots__/out.txt']).kind).toBe('protected');
  });

  test('propose-only routes every non-empty staged set to human review', () => {
    expect(classifyStagePaths(['src/production.ts'], undefined, true).kind).toBe('propose-only');
    expect(classifyStagePaths([], undefined, true).kind).toBe('clean');
  });

  test('the staged-path allowlist compiles CASE-SENSITIVELY (#175 item 3)', () => {
    const compiled = compileStagePathPatterns(['^packages/alpha/']);
    expect(compiled.some((regex) => regex.test('packages/alpha/test/suite.test.js'))).toBe(true);
    // A case-differing sibling package must NOT match on a case-sensitive
    // checkout (the old `i` flag admitted it).
    expect(compiled.some((regex) => regex.test('packages/Alpha/test/suite.test.js'))).toBe(false);
  });
});
