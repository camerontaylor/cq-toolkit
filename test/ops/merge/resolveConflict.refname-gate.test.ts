// Split provenance: test/ops/merge/resolveConflict.test.ts was split into
// resolveConflict.{factory-resolution,parse-decision,render-prompt,refname-gate,op-outcomes,op-failures,acted-verification,forge-fact,shipped-prompt,invocation-correlation}.test.ts
// plus the shared fixtures in resolveConflict.helpers.ts (which carries the
// original group-by-group header).
// Subject: the conservative git-refname gate.
// Fixtures and the full group header: ./resolveConflict.helpers.ts
import { describe, expect, test } from 'vitest';
import { MergeConflictInputSchema } from '../../../src/ops/merge/resolveConflict.js';
import { baseInput } from './resolveConflict.helpers.js';

// ---------------------------------------------------------------------------
// The conservative git-refname gate (the prompt-interpolation boundary)
// ---------------------------------------------------------------------------

describe('the conservative git-refname gate', () => {
  /** Parse a schema input whose headBranch/baseBranch are overridden. */
  const parses = (over: Record<string, unknown>): boolean =>
    MergeConflictInputSchema.safeParse({ ...baseInput(), ...over }).success;

  test('project branch names parse; hostile and exotic ones fail closed', () => {
    // Ordinary project branch names.
    expect(parses({ headBranch: 'feature/x-2.0' })).toBe(true);
    expect(parses({ baseBranch: 'release/2.0_hotfix' })).toBe(true);
    // THE injection class: shell metacharacters in prompt-interpolated
    // commands.
    expect(parses({ headBranch: 'topic$(touch x)' })).toBe(false);
    expect(parses({ baseBranch: 'topic$(touch x)' })).toBe(false);
    // Git-refname hygiene: no leading dash, no '..' sequence, no spaces,
    // non-empty.
    expect(parses({ headBranch: '-leading' })).toBe(false);
    expect(parses({ baseBranch: 'a..b' })).toBe(false);
    expect(parses({ headBranch: 'a b' })).toBe(false);
    expect(parses({ headBranch: '' })).toBe(false);
    expect(parses({ baseBranch: '' })).toBe(false);
    // Bounded at 250 characters.
    expect(parses({ headBranch: `f/${'x'.repeat(250)}` })).toBe(false);
    expect(parses({ headBranch: `f/${'x'.repeat(240)}` })).toBe(true);
  });

  test('rejections name the conservative-refname contract', () => {
    const parsed = MergeConflictInputSchema.safeParse({
      ...baseInput(),
      headBranch: 'topic$(touch x)',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(
        parsed.error.issues.some((issue) => issue.message.includes('conservative git refname')),
      ).toBe(true);
    }
  });
});
