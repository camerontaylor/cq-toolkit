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
});
