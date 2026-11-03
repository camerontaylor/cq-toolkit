// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { checkDiffMonotonicity } from '../../../src/ops/ratchet/monotonicGuard.js';
import {
  COV_METRIC,
  COV_TARGET,
  METRIC,
  REL,
  REL_COV,
  TARGET,
  body,
  fullRewrite,
} from './monotonicGuard.helpers.js';

describe('checkDiffMonotonicity', () => {
  test('the thread scenario (0.8 ratio → 70 pct) fails as unit changed — never read as a tightening', () => {
    const diff = fullRewrite(
      REL_COV,
      body('higher-is-better', 0.8, { target: COV_TARGET, metric: COV_METRIC, unit: 'ratio' }),
      body('higher-is-better', 70, { target: COV_TARGET, metric: COV_METRIC, unit: 'pct' }),
    );
    // Raw numbers would "tighten" 0.8 → 70; across the scale change that is
    // meaningless — the section is terminal at 'unit changed', so no
    // loosened (or flipped) verdict rides along.
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_COV,
          target: COV_TARGET,
          metric: COV_METRIC,
          oldValue: 0.8,
          newValue: 70,
          why: 'unit changed',
          oldUnit: 'ratio',
          newUnit: 'pct',
        },
      ],
      filesChecked: 1,
    });
  });

  test('a unit flip at EQUAL values still fails as unit changed (scale moved, not the number)', () => {
    const diff = fullRewrite(
      REL,
      body('lower-is-better', 3),
      body('lower-is-better', 3, { unit: 'failures' }),
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL,
          target: TARGET,
          metric: METRIC,
          oldValue: 3,
          newValue: 3,
          why: 'unit changed',
          oldUnit: 'errors',
          newUnit: 'failures',
        },
      ],
      filesChecked: 1,
    });
  });

  test.each([
    {
      label: 'a unit ADDED between the sides (undefined → errors)',
      oldOverrides: { unit: null },
      newOverrides: {},
      oldUnit: undefined,
      newUnit: 'errors',
    },
    {
      label: 'a unit REMOVED between the sides (errors → undefined)',
      oldOverrides: {},
      newOverrides: { unit: null },
      oldUnit: 'errors',
      newUnit: undefined,
    },
  ])(
    '$label fails as unit changed — one-sided scale is a re-scale too',
    ({ oldOverrides, newOverrides, oldUnit, newUnit }) => {
      const diff = fullRewrite(
        REL,
        body('lower-is-better', 3, oldOverrides),
        body('lower-is-better', 3, newOverrides),
      );
      expect(checkDiffMonotonicity(diff)).toEqual({
        ok: false,
        violations: [
          {
            path: REL,
            target: TARGET,
            metric: METRIC,
            oldValue: 3,
            newValue: 3,
            why: 'unit changed',
            oldUnit,
            newUnit,
          },
        ],
        filesChecked: 1,
      });
    },
  );

  test('± unit occurrences win over context for their side (change visible despite unchanged context unit)', () => {
    // Context carries the OLD unit while the ± sides rename it: the new
    // side's ± unit must win over the shared context line, so the scale
    // change is detected. (If context won, newUnit would equal oldUnit and
    // the re-scale would slip through a same-unit pass.)
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      `--- a/${REL}`,
      `+++ b/${REL}`,
      '@@ -2,5 +2,5 @@',
      '  "metric": "typecheck-count",',
      '  "unit": "errors",',
      '-  "unit": "errors",',
      '-  "value": 3,',
      '+  "unit": "failures",',
      '+  "value": 3,',
      '  "capturedAt": "2026-09-15T00:00:00.000Z",',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      // The hand-built hunk carries no `"target"` line, so target stays
      // undefined while metric (context) is recovered.
      violations: [
        {
          path: REL,
          metric: METRIC,
          oldValue: 3,
          newValue: 3,
          why: 'unit changed',
          oldUnit: 'errors',
          newUnit: 'failures',
        },
      ],
      filesChecked: 1,
    });
  });
});
