// monotonicGuard tests — lane H slice 2 (goal H2, ws-h item 6), for
// src/ops/ratchet/monotonicGuard.ts.
//
// Pinned here (synthetic unified diffs as template literals; the module is
// pure — no fs, no sources, no clock):
//   1. Thresholds only tighten, on BOTH directions, judged from real
//      renderBaseline bodies: a full-file rewrite lowering the value
//      (lower-is-better 3 → 2, higher-is-better 80 → 85 pct) passes; a
//      raising one fails with a 'loosened' violation carrying path + metric
//      + old/new values.
//   2. A direction flip with an equal value fails 'direction changed' (a
//      flip redefines which way tighten points — fail-closed). A same-value
//      re-capture with NO flip (captureBaseline legitimately rewriting an
//      equal-value baseline when only the clock moves) is skipped silently
//      — no loosening is possible without a value change.
//   2b. A section can carry BOTH violations at once (loosened under the new
//       direction AND the flip itself), loosened first.
//   3. File lifecycle comes from METADATA markers (`new file mode` /
//      `--- /dev/null` for added; `deleted file mode` / `+++ /dev/null` for
//      deleted), never from content-line counts — an unpaired add passes, an
//      UNREPLACED delete fails (W1.7; the pairing block below pins the rest) —
//      counted in filesChecked via the `+++ b/` path, falling back to the
//      `diff --git` b-side for /dev/null new-sides. One-sided content
//      WITHOUT a lifecycle marker fails closed (Codex P1: a plus-only
//      duplicate-`"value"` insertion would otherwise ride the added-file
//      skip to a silent threshold raise); non-baseline sections are ignored
//      entirely (filesChecked 0).
//   4. Identity fields (direction/metric/target) are recovered from hunk
//      CONTEXT lines when the ± lines do not carry them — so the REAL git
//      diff shape, a value-only hunk over a renderBaseline body, is judged
//      normally: a tighten passes (the H4 propose-PR flow stays unblocked)
//      and a loosen fails naming file + metric + values. ± occurrences win
//      over context for their side.
//   5. FAIL-CLOSED (I5) remains for what context cannot cure: a value pair
//      that is missing/unpairable (truncated hunk, renamed field, ±count
//      mismatch, garbage content), a non-Direction string on the governing
//      side, and a baselines body with NO direction on any line (± or
//      context) all yield 'unparsable baseline diff', NEVER a pass.
//   5b. Unit rides in the identity set with the same ±-then-context
//       precedence (Codex P1): a unit change between the sides — including
//       the unit appearing or vanishing, undefined counting as a value — is
//       why:'unit changed' (incomparable scale) and TERMINAL: the loosens
//       comparison never runs across units, so `0.8 ratio → 70 pct` can
//       never read as an 87.5× tightening. Same unit both sides (± or
//       context) leaves the tighten/loosen paths untouched.
//   6. A hunk that carries the direction and value lines as ± pairs is
//      judged from the ± sides directly (rule 3's new-side preference).
//   6. Whitespace-only rewrites and index/mode-only sections are skipped.
//   7. formatViolations renders the three violation kinds verbatim.
//
// Round-2 additions: the whitespace check is IN-ORDER (a duplicate-`"value"`
// reorder is a movement, judged — never a "reformat" skip); a value that
// rides in undiffed context counts as UNMOVED (the real -U3 clock-only
// re-capture shape skips silently); path extraction accepts every git
// dialect prefix (b/, a/, i/, w/, c/, o/, noprefix) and a content-bearing
// section with no extractable path fails closed naming the raw header;
// lifecycle /dev/null markers are honored only in the header region (before
// the first @@); and a describe block feeds LITERAL `git diff` output
// (real temp repo) through the guard for tighten/loosen/lifecycle/clock
// fixtures.

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
  covBody,
  fullRewrite,
  hunkDiff,
  modifiedSection,
} from './monotonicGuard.helpers.js';

describe('checkDiffMonotonicity', () => {
  test('an empty diff passes with nothing checked', () => {
    expect(checkDiffMonotonicity('')).toEqual({ ok: true, violations: [], filesChecked: 0 });
  });

  test('tighten passes (lower-is-better): value 3 → 2 in a real full-file rewrite, filesChecked 1', () => {
    const diff = fullRewrite(REL, body('lower-is-better', 3), body('lower-is-better', 2));
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('loosen fails (lower-is-better): value 2 → 3 names path + metric + values', () => {
    const diff = fullRewrite(REL, body('lower-is-better', 2), body('lower-is-better', 3));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, target: TARGET, metric: METRIC, oldValue: 2, newValue: 3, why: 'loosened' },
      ],
      filesChecked: 1,
    });
  });

  test('tighten passes (higher-is-better): pct 80 → 85', () => {
    const diff = fullRewrite(REL_COV, covBody(80), covBody(85));
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('loosen fails (higher-is-better): pct 85 → 80', () => {
    const diff = fullRewrite(REL_COV, covBody(85), covBody(80));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_COV,
          target: COV_TARGET,
          metric: COV_METRIC,
          oldValue: 85,
          newValue: 80,
          why: 'loosened',
        },
      ],
      filesChecked: 1,
    });
  });

  test('direction flip with an equal value fails "direction changed" (flip redefines tighten)', () => {
    const diff = fullRewrite(REL, body('lower-is-better', 3), body('higher-is-better', 3));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL,
          target: TARGET,
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

  test('a same-value re-capture (capturedAt-only rewrite) is skipped silently, filesChecked counted', () => {
    // Real full-file rewrite from a clock-changed re-capture: every line is
    // ±, the value lines are IDENTICAL on both sides, and the capturedAt
    // lines differ (so this is not the whitespace-only skip). No loosening
    // is possible at equal values — ok, and the section still counts.
    const diff = fullRewrite(
      REL,
      body('lower-is-better', 2),
      body('lower-is-better', 2, { capturedAt: '2026-09-15T01:00:00.000Z' }),
    );
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a section can carry BOTH violations: loosened AND direction changed, in that order', () => {
    // lower(3) → higher(2): under the NEW higher-is-better direction the
    // value DROPPED (2 < 3 → loosened), and the flip itself redefines the
    // ratchet — both violations fire, loosened first.
    const diff = fullRewrite(REL, body('lower-is-better', 3), body('higher-is-better', 2));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, target: TARGET, metric: METRIC, oldValue: 3, newValue: 2, why: 'loosened' },
        {
          path: REL,
          target: TARGET,
          metric: METRIC,
          oldValue: 3,
          newValue: 2,
          why: 'direction changed',
          oldDirection: 'lower-is-better',
          newDirection: 'higher-is-better',
        },
      ],
      filesChecked: 1,
    });
  });

  test('a same-value re-capture in the real -U3 git shape (value only in context) is skipped silently', () => {
    // hunkDiff with context 3: only the capturedAt line is ±; the value,
    // direction, and unit lines ride in undiffed context. The value is
    // UNMOVED (never Number(undefined)) — the same-value skip contract
    // holds for the shape real git diffs actually produce.
    const diff = hunkDiff(
      REL,
      body('lower-is-better', 2),
      body('lower-is-better', 2, { capturedAt: '2026-09-15T01:00:00.000Z' }),
      3,
    );
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a duplicate-"value" key REORDER is judged, not skipped as a reformat (sort-free whitespace check)', () => {
    // Same line multiset, different order: the LAST key JSON.parse honors
    // moves the effective threshold 5 → 100 (a loosening under
    // lower-is-better). The in-order whitespace check refuses to call this
    // a reformat; counts match (2/2, so the ±count gate is not the judge —
    // the loosened verdict is, naming both values). A reorder whose counts
    // DON'T match hits the ±count gate → unparsable (pinned separately).
    const oldLines = [
      '{',
      '  "schemaVersion": 1,',
      '  "target": "typecheck",',
      '  "metric": "typecheck-count",',
      '  "direction": "lower-is-better",',
      '  "value": 100,',
      '  "value": 5,',
      '  "unit": "errors",',
      '  "capturedAt": "2026-09-15T00:00:00.000Z",',
      '}',
    ];
    const newLines = [
      '{',
      '  "schemaVersion": 1,',
      '  "target": "typecheck",',
      '  "metric": "typecheck-count",',
      '  "direction": "lower-is-better",',
      '  "value": 5,',
      '  "value": 100,',
      '  "unit": "errors",',
      '  "capturedAt": "2026-09-15T00:00:00.000Z",',
      '}',
    ];
    const diff = modifiedSection(REL, oldLines, newLines);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, target: TARGET, metric: METRIC, oldValue: 5, newValue: 100, why: 'loosened' },
      ],
      filesChecked: 1,
    });
  });

  test('one loosened baseline among several checked files fails naming exactly that one', () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 2;',
      '',
      fullRewrite(REL, body('lower-is-better', 3), body('lower-is-better', 2)), // tightened: fine
      fullRewrite(REL_COV, covBody(85), covBody(80)), // loosened: the violation
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        {
          path: REL_COV,
          target: COV_TARGET,
          metric: COV_METRIC,
          oldValue: 85,
          newValue: 80,
          why: 'loosened',
        },
      ],
      filesChecked: 2,
    });
  });

  test.each([
    [
      'a whitespace-only rewrite (same lines, padding changed)',
      ['{', '  "value": 3,', '}'],
      ['{', '  "value": 3,  ', '}'],
    ],
  ])('%s is skipped, not condemned', (_label, minus, plus) => {
    expect(checkDiffMonotonicity(modifiedSection(REL, minus, plus))).toEqual({
      ok: true,
      violations: [],
      filesChecked: 1,
    });
  });

  test('an index/mode-only section (no content lines at all) is skipped', () => {
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'old mode 100644',
      'new mode 100755',
      'index 1111111..2222222',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });
});
