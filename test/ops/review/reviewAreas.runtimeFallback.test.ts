// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the runtime
// fallback check.
import { describe, expect, it } from 'vitest';
import { createAreaReviewPlan } from '../../../src/ops/review/internal/areaReviewPlan.js';
import { createReviewPlan } from '../../../src/ops/review/internal/reviewPlan.js';
import { plan, tracked } from './reviewAreas.helpers.js';

describe('area review runtime fallback', () => {
  it('preserves the normal plan when contract descriptors are truncated', () => {
    const components = [
      tracked(
        'src/large.ts',
        Array.from({ length: 2000 }, (_, i) => `export const value${i} = ${i};`),
      ),
      tracked('docs/guide.md'),
    ];
    expect(plan({ components }).areas.some((area) => area.contractsTruncated)).toBe(true);
    const input = {
      head: 'head',
      base: 'base',
      scope: 'full' as const,
      components,
      session: { maxInputChars: 1_000_000 },
      size: { medium: { maxChangedLines: 10_000, maxFiles: 100 } },
    };
    const normal = createReviewPlan(input);
    const result = createAreaReviewPlan(input);
    expect(result.coverage.mode).not.toBe('partitioned');
    expect(result.sessions).toEqual(normal.sessions);
    expect(result.coverage).toEqual(normal.coverage);
    expect(result.advisories).toContain('area review fallback: contract descriptors truncated');
  });
  it('merges area advisories only when area sessions are returned', () => {
    const components = [
      tracked('src/a.ts', ['a', 'b', 'c']),
      tracked('docs/b.md', ['d', 'e', 'f']),
    ];
    const input = {
      head: 'head',
      base: 'base',
      scope: 'full' as const,
      components,
      partitionTools: false as const,
      size: {
        small: { maxChangedLines: 0, maxFiles: 0 },
        medium: { maxChangedLines: 1, maxFiles: 1 },
      },
    };
    const areaAdvisories = components.flatMap(
      (component) => createReviewPlan({ ...input, components: [component] }).advisories,
    );
    expect(areaAdvisories.length).toBeGreaterThan(0);
    const normal = createAreaReviewPlan({ ...input, session: { maxInputChars: 1_000_000 } });
    for (const advisory of areaAdvisories) expect(normal.advisories).toContain(advisory);

    const bounded = { ...input, session: { maxInputChars: 500 } };
    const original = createReviewPlan(bounded);
    const fallback = createAreaReviewPlan(bounded);
    expect(fallback.sessions).toEqual(original.sessions);
    expect(fallback.advisories).toEqual([
      ...original.advisories,
      'area review fallback: cross-area context exceeds session prompt bound',
    ]);
  });
});
