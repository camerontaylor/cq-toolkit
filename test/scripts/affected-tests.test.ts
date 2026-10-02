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
