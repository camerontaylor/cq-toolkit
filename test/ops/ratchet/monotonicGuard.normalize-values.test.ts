// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { normalizeBaselineDiffValues } from '../../../src/ops/ratchet/format.js';
import {
  checkDiffMonotonicity,
  formatViolations,
} from '../../../src/ops/ratchet/monotonicGuard.js';
import { REL_COV, REL_CX, covBody, cxBody, fullRewrite } from './monotonicGuard.helpers.js';

// ---------------------------------------------------------------------------
// Coverage diff re-basis (review finding 1): the ONE normalizer shared by
// the ratchet.monotonicGuard CLI op and the local ratchet scripts.
// ---------------------------------------------------------------------------

describe('normalizeBaselineDiffValues (coverage one-decimal comparison basis)', () => {
  test('a fractional re-basis 93.54 → 93.5 reads as the equal no-op it is', () => {
    const raw = fullRewrite(REL_COV, covBody(93.54), covBody(93.5));
    // Without a uniform basis the fractional old side reads as a loosening.
    expect(checkDiffMonotonicity(raw).ok).toBe(false);
    const normalized = normalizeBaselineDiffValues(raw, REL_COV);
    expect(checkDiffMonotonicity(normalized)).toEqual({
      ok: true,
      violations: [],
      filesChecked: 1,
    });
  });

  test('a TRUE loosening 93 → 92 still fails after normalization', () => {
    const normalized = normalizeBaselineDiffValues(
      fullRewrite(REL_COV, covBody(93), covBody(92)),
      REL_COV,
    );
    const verdict = checkDiffMonotonicity(normalized);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL_COV}: metric coverage loosened 93 → 92 — only tightening diffs pass`,
    ]);
  });

  test('a fractional tighten 92.4 → 93 still passes (old side normalizes to 92)', () => {
    const normalized = normalizeBaselineDiffValues(
      fullRewrite(REL_COV, covBody(92.4), covBody(93)),
      REL_COV,
    );
    expect(checkDiffMonotonicity(normalized)).toEqual({
      ok: true,
      violations: [],
      filesChecked: 1,
    });
  });

  test('non-coverage sections are byte-identical: complexity keeps full precision', () => {
    const raw = fullRewrite(REL_CX, cxBody(2.4), cxBody(2.49));
    expect(normalizeBaselineDiffValues(raw, REL_COV)).toBe(raw);
    // The real 2.40 → 2.49 loosening is NOT rounded into an equal no-op.
    const verdict = checkDiffMonotonicity(normalizeBaselineDiffValues(raw, REL_COV));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.violations[0]?.why).toBe('loosened');
  });
});
