// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the manifest and
// reserved-view immutability checks.
import { describe, expect, it } from 'vitest';
import {
  planReviewAreas,
  reserveCrossAreaPass,
  type ReservedReviewAreaPlan,
  type ReviewAreaResult,
} from '../../../src/ops/review/internal/reviewAreas.js';
import { plan, tracked } from './reviewAreas.helpers.js';

describe('manifest immutability', () => {
  it('freezes rows, the list and plans against mutation', () => {
    const result = planReviewAreas({ components: [tracked('src/a.ts')] });
    expect(Object.isFrozen(result.changedFiles)).toBe(true);
    expect(Object.isFrozen(result.changedFiles[0])).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    if (result.kind === 'areas') {
      expect(Object.isFrozen(result.areas)).toBe(true);
      expect(Object.isFrozen(result.areas[0])).toBe(true);
      expect(Object.isFrozen(result.areas[0]!.files)).toBe(true);
      expect(Object.isFrozen(result.areas[0]!.contracts)).toBe(true);
      expect(Object.isFrozen(result.crossAreaPass)).toBe(true);
      expect('text' in result.changedFiles[0]!).toBe(false);
      expect(JSON.stringify(result)).not.toContain('diff --git');
    }
    expect(() => {
      const mutable = result.changedFiles as unknown as { push: (value: string) => unknown };
      mutable.push('x');
    }).toThrow(TypeError);
  });
});

describe('reserved view immutability', () => {
  it('freezes the reserved view and shares the plan by reference', () => {
    const seeded = plan({
      components: [
        tracked('src/a.ts', ['export const a = 1;']),
        tracked('src/b.ts', ['export const b = 2;']),
      ],
    });
    const reserved = reserveCrossAreaPass(seeded, 10, []);
    expect(Object.isFrozen(reserved)).toBe(true);
    expect(reserved.plan).toBe(seeded);
    const view: ReviewAreaResult = planReviewAreas({ components: [tracked('src/a.ts')] });
    expect(view.kind).toBe('areas');
    const typed: ReservedReviewAreaPlan = reserved;
    expect(typed.primaryMaxChars).toBe(seeded.totalChars - 10);
  });
});
