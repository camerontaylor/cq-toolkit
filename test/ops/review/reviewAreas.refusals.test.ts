// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the unsafe-input
// refusals.
import { describe, expect, it } from 'vitest';
import type { ScanComponentInput } from '../../../src/ops/dev/denylist.js';
import { planReviewAreas } from '../../../src/ops/review/internal/reviewAreas.js';

describe('planReviewAreas refusals', () => {
  it('refuses empty reviewed input as unsafe with an empty manifest', () => {
    const result = planReviewAreas({ components: [] });
    if (result.kind !== 'unsafe') throw new Error(`expected unsafe, got ${result.kind}`);
    expect(result.reason).toBe('review areas: no reviewed components');
    expect(result.changedFiles).toEqual([]);
    expect(result.totalChars).toBe(0);
  });

  it('refuses duplicate identities and duplicate changed paths as unsafe', () => {
    const duplicated: ScanComponentInput = {
      component: 'tracked:src/a.ts',
      path: 'src/a.ts',
      text: 'same',
    };
    const sameIdentity = planReviewAreas({ components: [duplicated, { ...duplicated }] });
    if (sameIdentity.kind !== 'unsafe')
      throw new Error(`expected unsafe, got ${sameIdentity.kind}`);
    expect(sameIdentity.reason).toContain("duplicate component identity 'tracked:src/a.ts'");

    const aliased = planReviewAreas({
      components: [
        duplicated,
        { component: 'untracked:src/a.ts', path: 'src/a.ts', text: 'other' },
      ],
    });
    if (aliased.kind !== 'unsafe') throw new Error(`expected unsafe, got ${aliased.kind}`);
    expect(aliased.reason).toContain("duplicate changed path 'src/a.ts'");
    expect(aliased.changedFiles).toHaveLength(2);
  });

  it('refuses empty component identities as unsafe', () => {
    const result = planReviewAreas({
      components: [{ component: '', path: 'src/a.ts', text: 'x' }],
    });
    if (result.kind !== 'unsafe') throw new Error(`expected unsafe, got ${result.kind}`);
    expect(result.reason).toContain('identities must not be empty');
  });
});
