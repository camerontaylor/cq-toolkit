// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the area
// splitting and bound refusals.
import { describe, expect, it } from 'vitest';
import {
  REVIEW_AREA_DEFAULTS,
  planReviewAreas,
} from '../../../src/ops/review/internal/reviewAreas.js';
import { plan, tracked } from './reviewAreas.helpers.js';

describe('planReviewAreas splitting and bounds', () => {
  it('splits an oversized directory into bounded areas without reordering', () => {
    const components = Array.from({ length: 30 }, (_, index) =>
      tracked(`src/big/f${String(index).padStart(2, '0')}.ts`, [
        `const v${String(index)} = ${String(index)};`,
      ]),
    );
    const result = plan({ components });
    expect(result.areas.length).toBeGreaterThan(2);
    expect(result.areas.length).toBeLessThanOrEqual(REVIEW_AREA_DEFAULTS.maxAreas);
    for (const area of result.areas)
      expect(area.files.length).toBeLessThanOrEqual(REVIEW_AREA_DEFAULTS.maxFilesPerArea);
    const owned = result.areas.flatMap((area) => area.files);
    expect(owned).toEqual([...owned].sort((a, b) => a - b));
    expect(new Set(owned).size).toBe(components.length);
  });

  it('keeps one component larger than the char cap in its own area', () => {
    const big = tracked('src/huge.ts', [`${'x'.repeat(40_000)}`]);
    const small = tracked('src/tiny.ts', ['const tiny = 1;']);
    const result = plan({ components: [big, small] });
    expect(result.areas.map((area) => area.files)).toEqual([[1], [2]]);
    expect(result.crossAreaPass.required).toBe(true);
  });

  it('returns oversized with the full manifest when directories exceed maxAreas', () => {
    const components = Array.from({ length: REVIEW_AREA_DEFAULTS.maxAreas + 1 }, (_, index) =>
      tracked(`d${String(index)}/f.ts`),
    );
    const result = planReviewAreas({ components });
    if (result.kind !== 'oversized') throw new Error(`expected oversized, got ${result.kind}`);
    expect(result.reason).toContain(
      `over the maxAreas bound ${String(REVIEW_AREA_DEFAULTS.maxAreas)}`,
    );
    expect(result.changedFiles).toHaveLength(components.length);
    expect(result.changedFiles[0]).toMatchObject({ path: 'd0/f.ts', index: 1 });
    expect(result.totalChars).toBe(
      components.reduce((total, component) => total + component.text.length, 0),
    );
  });

  it('returns oversized when one directory needs more areas than maxAreas allows', () => {
    const components = Array.from(
      { length: REVIEW_AREA_DEFAULTS.maxFilesPerArea * REVIEW_AREA_DEFAULTS.maxAreas + 1 },
      (_, index) => tracked(`one/dir/f${String(index)}.ts`),
    );
    const result = planReviewAreas({ components });
    if (result.kind !== 'oversized') throw new Error(`expected oversized, got ${result.kind}`);
    expect(result.reason).toContain('maxAreas');
  });
});
