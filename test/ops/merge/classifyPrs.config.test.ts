// Split provenance: test/ops/merge/classifyPrs.test.ts was split by subject into
// classifyPrs.{rows,temporal,all-clear,allClearPattern,acceptance,config,objections}.test.ts
// plus classifyPrs.helpers.ts (shared fixtures). This file carries the
// config-override seam (settleWindowMs, allClearPattern) and the no-mutation
// guarantee.
import { describe, expect, test } from 'vitest';
import {
  REVIEW_ACCEPT_SETTLE_MS,
  defaultClassifyPrConfig,
} from '../../../src/ops/merge/classify.config.js';
import { classifyPr } from '../../../src/ops/merge/classifyPrs.js';
import { LAST_COMMIT_MS, PENDING_MS, approved, settleCandidate } from './classifyPrs.helpers.js';

// ---------------------------------------------------------------------------
// Config overrides — policy is data; the defaults stay untouched
// ---------------------------------------------------------------------------

describe('classifyPr — config overrides (the R3 seam)', () => {
  test('settleWindowMs: 1 flips pending→eligible at a nowMs where the default is still pending', () => {
    const c = settleCandidate();
    const nowMs = LAST_COMMIT_MS + 1;
    expect(classifyPr(c, nowMs).reason).toBe('settle_window_pending');
    const overridden = classifyPr(c, nowMs, { ...defaultClassifyPrConfig, settleWindowMs: 1 });
    expect(overridden.verdict).toBe('eligible');
    expect(overridden.reason).toBe('settle_window_elapsed');
  });

  test('a custom allClearPattern matches a body the default ignores', () => {
    const c = settleCandidate({ reviews: [approved({ body: 'SHIPIT' })] });
    expect(classifyPr(c, PENDING_MS).reason).toBe('settle_window_pending');
    const overridden = classifyPr(c, PENDING_MS, {
      ...defaultClassifyPrConfig,
      allClearPattern: /shipit/i,
    });
    expect(overridden.verdict).toBe('eligible');
    expect(overridden.reason).toBe('explicit_all_clear');
  });

  test('a /g-flagged allClearPattern override classifies identically across three consecutive calls', () => {
    // A /g RegExp keeps lastIndex across .test() calls; the read site must
    // strip it (evalPattern) so repeated classification stays pure. The
    // pattern keeps its `i` flag — stripping removes only g/y.
    const c = settleCandidate({ reviews: [approved({ body: 'SHIPIT' })] });
    const overridden = { ...defaultClassifyPrConfig, allClearPattern: /shipit/gi };
    const expected = {
      verdict: 'eligible',
      reason: 'explicit_all_clear',
      unresolvedExternalThreads: 0,
    };
    for (let i = 0; i < 3; i++) {
      expect(classifyPr(c, PENDING_MS, overridden)).toEqual(expected);
    }
  });

  test('an override call does not mutate defaultClassifyPrConfig', () => {
    const snapshot = (): string =>
      JSON.stringify({
        settleWindowMs: defaultClassifyPrConfig.settleWindowMs,
        allClearPattern: defaultClassifyPrConfig.allClearPattern.source,
        skipPatterns: defaultClassifyPrConfig.skipPatterns.map((p) => p.source),
      });
    const before = snapshot();
    classifyPr(settleCandidate(), PENDING_MS, {
      ...defaultClassifyPrConfig,
      settleWindowMs: 1,
      allClearPattern: /shipit/i,
    });
    expect(snapshot()).toBe(before);
    expect(defaultClassifyPrConfig.settleWindowMs).toBe(REVIEW_ACCEPT_SETTLE_MS);
  });
});
