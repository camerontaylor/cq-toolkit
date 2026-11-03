// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import {
  checkDiffMonotonicity,
  formatViolations,
} from '../../../src/ops/ratchet/monotonicGuard.js';
import { METRIC, REL, TARGET, body, hunkDiff, modifiedSection } from './monotonicGuard.helpers.js';

describe('checkDiffMonotonicity', () => {
  test('removing the direction while tightening 3 → 2 fails as direction changed (schema-invalid file)', () => {
    // The minus side declares the direction, the plus side has dropped it:
    // the committed file would be schema-invalid (parseBaseline rejects it)
    // and the ratchet's semantics would be undefined — terminal violation,
    // never a compare-under-the-surviving-direction pass.
    const diff = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 3,'],
      ['  "value": 2,'],
    );
    const verdict = checkDiffMonotonicity(diff);
    expect(verdict).toEqual({
      ok: false,
      violations: [
        {
          path: REL,
          oldValue: 3,
          newValue: 2,
          why: 'direction changed',
          oldDirection: 'lower-is-better',
          newDirection: undefined,
        },
      ],
      filesChecked: 1,
    });
    // The absent side renders as 'undefined'.
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: direction changed lower-is-better → undefined`,
    ]);
  });

  test('adding the direction while tightening 3 → 2 fails as direction changed the same way', () => {
    const diff = modifiedSection(
      REL,
      ['  "value": 3,'],
      ['  "direction": "lower-is-better",', '  "value": 2,'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL,
          oldValue: 3,
          newValue: 2,
          why: 'direction changed',
          oldDirection: undefined,
          newDirection: 'lower-is-better',
        },
      ],
      filesChecked: 1,
    });
  });

  test('a value-only hunk — the real git-diff shape — is judged via context: tighten passes', () => {
    // The direction line of an unchanged renderBaseline body rides in
    // space-prefixed hunk context, not as ±. The guard recovers it there, so
    // a legitimate tighten PR passes and H4's propose-PR flow is unblocked.
    const diff = hunkDiff(REL, body('lower-is-better', 3), body('lower-is-better', 2), 1);
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a value-only hunk loosen fails via context, naming file + metric + values', () => {
    // Same shape, lowered the wrong way, at git's default -U3: context
    // supplies direction AND metric/target, ± lines supply old/new, and the
    // violation names everything. (At -U1 only the direction is reachable —
    // enough to fail the diff, with '(unknown)' for the metric.)
    const diff = hunkDiff(REL, body('lower-is-better', 2), body('lower-is-better', 3), 3);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, target: TARGET, metric: METRIC, oldValue: 2, newValue: 3, why: 'loosened' },
      ],
      filesChecked: 1,
    });
  });

  test('a baselines body with NO direction on any line (± or context) still fails closed', () => {
    // Hand-written minimal JSON whose body omits direction entirely: even
    // with hunk context there is no direction to judge under — non-passing
    // evidence, never a pass.
    const oldBody =
      '{\n  "schemaVersion": 1,\n  "target": "hand",\n  "metric": "m",\n  "value": 3\n}\n';
    const newBody =
      '{\n  "schemaVersion": 1,\n  "target": "hand",\n  "metric": "m",\n  "value": 4\n}\n';
    const diff = hunkDiff(REL, oldBody, newBody, 1);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('± occurrences win over context for their side (flip visible despite unchanged context)', () => {
    // Context carries the OLD direction while the ± sides flip it: the new
    // side's ± direction must win over the shared context line, so the flip
    // is detected. (If context won, newDir would equal oldDir and the flip
    // would be missed.)
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      `--- a/${REL}`,
      `+++ b/${REL}`,
      '@@ -2,5 +2,5 @@',
      '  "metric": "typecheck-count",',
      '  "direction": "lower-is-better",',
      '-  "direction": "lower-is-better",',
      '-  "value": 3,',
      '+  "direction": "higher-is-better",',
      '+  "value": 3,',
      '  "unit": "errors",',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL,
          metric: METRIC,
          oldValue: 3,
          newValue: 3,
          why: 'direction changed',
          oldDirection: 'lower-is-better',
          newDirection: 'higher-is-better',
        },
      ],
      filesChecked: 1,
    });
  });

  test('a hunk carrying BOTH the direction and value lines is judged: tighten passes, loosen fails', () => {
    const tighten = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 3,'],
      ['  "direction": "lower-is-better",', '  "value": 2,'],
    );
    expect(checkDiffMonotonicity(tighten)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    const loosen = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 2,'],
      ['  "direction": "lower-is-better",', '  "value": 3,'],
    );
    expect(checkDiffMonotonicity(loosen)).toEqual({
      ok: false,
      // The hunk carries only direction+value, so target/metric are not
      // reconstructable and stay undefined (rendered as '(unknown)' by
      // formatViolations).
      violations: [{ path: REL, oldValue: 2, newValue: 3, why: 'loosened' }],
      filesChecked: 1,
    });
  });
});
