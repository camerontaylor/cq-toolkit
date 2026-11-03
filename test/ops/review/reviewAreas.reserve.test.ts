// Split provenance: test/ops/review/reviewAreas.test.ts was split into
// reviewAreas.{grouping,contracts,splitting,refusals,immutability,reserve,
// primaryCoverage,runtimeFallback}.test.ts; this file holds the cross-area
// reserve checks.
import { describe, expect, it } from 'vitest';
import {
  REVIEW_AREA_DEFAULTS,
  reserveCrossAreaPass,
  type ReviewAreaPlan,
} from '../../../src/ops/review/internal/reviewAreas.js';
import { plan, tracked } from './reviewAreas.helpers.js';

describe('cross-area reserve', () => {
  const seeded: ReviewAreaPlan = plan({
    intent: 'Seeded change.',
    components: [
      tracked('src/a.ts', ['export const a = 1;']),
      tracked('src/b.ts', ['export const b = 2;']),
    ],
  });

  it('holds a reserve before any area completes and bounds primary chars', () => {
    const reserved = reserveCrossAreaPass(seeded, 100, []);
    expect(reserved).toMatchObject({
      kind: 'areas',
      plan: seeded,
      reserveChars: 100,
      primaryMaxChars: seeded.totalChars - 100,
    });
  });

  it('refuses invalid reserves and a hold after any area completed', () => {
    expect(() => reserveCrossAreaPass(seeded, -1, [])).toThrow(/within 0\./);
    expect(() => reserveCrossAreaPass(seeded, 1.5, [])).toThrow(/must be an integer/);
    expect(() => reserveCrossAreaPass(seeded, seeded.totalChars + 1, [])).toThrow(/within 0\./);
    expect(() => reserveCrossAreaPass(seeded, 100, ['area-1'])).toThrow(
      /before the first area completes/,
    );
    expect(() => reserveCrossAreaPass(seeded, 0, [])).not.toThrow();
  });

  it('holds zero reserve on a no-pass plan and never mints one out of nothing', () => {
    const single = plan({ components: [tracked('src/plain.ts', ['const v = 1;'])] });
    expect(single.crossAreaPass.required).toBe(false);
    expect(() => reserveCrossAreaPass(single, 0, [])).not.toThrow();
    expect(reserveCrossAreaPass(single, 0, []).primaryMaxChars).toBe(single.totalChars);
    expect(single.crossAreaPass.promptReserveChars).toBe(
      REVIEW_AREA_DEFAULTS.crossAreaPromptReserveChars,
    );
  });
});
