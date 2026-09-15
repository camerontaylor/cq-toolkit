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
//      flip redefines which way tighten points — fail-closed).
//   3. File lifecycle is not a loosening: an ADDED baseline file and a
//      DELETED baseline file are skipped (counted in filesChecked via the
//      `+++ b/` path, falling back to the `diff --git` b-side for /dev/null
//      new-sides); non-baseline sections are ignored entirely
//      (filesChecked 0).
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
//   6. A hunk that carries the direction and value lines as ± pairs is
//      judged from the ± sides directly (rule 3's new-side preference).
//   6. Whitespace-only rewrites and index/mode-only sections are skipped.
//   7. formatViolations renders the three violation kinds verbatim.
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';
import { checkDiffMonotonicity, formatViolations } from '../../../src/ops/ratchet/monotonicGuard.js';
import { describe, expect, test } from 'vitest';

const CAPTURED_AT = '2026-09-15T00:00:00.000Z';
const TARGET = 'typecheck';
const METRIC = 'typecheck-count';
const REL = baselineRelPath(TARGET, METRIC);
const COV_TARGET = 'coverage';
const COV_METRIC = 'coverage';
const REL_COV = baselineRelPath(COV_TARGET, COV_METRIC);

/** A real baseline body, rendered by the production serializer. */
function body(direction: Direction, value: number, overrides: Partial<BaselineFile> = {}): string {
  return renderBaseline({
    schemaVersion: 1,
    target: TARGET,
    metric: METRIC,
    direction,
    value,
    unit: 'errors',
    capturedAt: CAPTURED_AT,
    ...overrides,
  });
}

function covBody(value: number): string {
  return body('higher-is-better', value, {
    target: COV_TARGET,
    metric: COV_METRIC,
    unit: 'pct',
  });
}

function bodyLines(b: string): string[] {
  return b.split('\n').filter((l) => l !== '');
}

/** Full-file-rewrite form: every old line removed, every new line added. */
function fullRewrite(rel: string, oldBody: string, newBody: string): string {
  return (
    [
      `diff --git a/${rel} b/${rel}`,
      'index 1111111..2222222 100644',
      `--- a/${rel}`,
      `+++ b/${rel}`,
      '@@ -1,7 +1,7 @@',
      ...bodyLines(oldBody).map((l) => `-${l}`),
      ...bodyLines(newBody).map((l) => `+${l}`),
    ].join('\n') + '\n'
  );
}

/**
 * Hunk form for bodies identical except one replaced line: only the
 * replaced line (plus `context` surrounding lines) appears, as a real git
 * diff would render it — context lines are space-prefixed and undiffed.
 */
function hunkDiff(rel: string, oldBody: string, newBody: string, context: number): string {
  const a = bodyLines(oldBody);
  const b = bodyLines(newBody);
  let first = 0;
  while (first < a.length && a[first] === b[first]) first += 1;
  let lastA = a.length - 1;
  while (lastA >= first && a[lastA] === b[lastA]) lastA -= 1;
  const start = Math.max(0, first - context);
  const end = Math.min(a.length - 1, lastA + context);
  const lines: string[] = [
    `diff --git a/${rel} b/${rel}`,
    'index 1111111..2222222 100644',
    `--- a/${rel}`,
    `+++ b/${rel}`,
    `@@ -${start + 1},${end - start + 1} +${start + 1},${end - start + 1} @@`,
  ];
  for (let k = start; k <= end; k++) {
    if (k < first || k > lastA) lines.push(` ${a[k]}`);
    else {
      lines.push(`-${a[k]}`);
      lines.push(`+${b[k]}`);
    }
  }
  return lines.join('\n') + '\n';
}

/** Hand-built MODIFIED section with exactly the given `-`/`+` content lines. */
function modifiedSection(rel: string, minus: string[], plus: string[]): string {
  return (
    [
      `diff --git a/${rel} b/${rel}`,
      'index 1111111..2222222 100644',
      `--- a/${rel}`,
      `+++ b/${rel}`,
      `@@ -1,${minus.length} +1,${plus.length} @@`,
      ...minus.map((l) => `-${l}`),
      ...plus.map((l) => `+${l}`),
    ].join('\n') + '\n'
  );
}

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

  test('an added baseline file is skipped (capture committing data), counted in filesChecked', () => {
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'new file mode 100644',
      'index 0000000..1111111',
      '--- /dev/null',
      `+++ b/${REL}`,
      '@@ -0,0 +1,7 @@',
      ...bodyLines(body('lower-is-better', 3)).map((l) => `+${l}`),
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a deleted baseline file is skipped (prune lifecycle); path falls back to the diff --git b-side', () => {
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'deleted file mode 100644',
      'index 1111111..0000000',
      `--- a/${REL}`,
      '+++ /dev/null',
      '@@ -1,7 +0,0 @@',
      ...bodyLines(body('lower-is-better', 3)).map((l) => `-${l}`),
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('non-baseline file changes are ignored entirely (filesChecked 0)', () => {
    const diff = [
      'diff --git a/src/index.ts b/src/index.ts',
      'index 1111111..2222222 100644',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -1,1 +1,1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 0 });
  });

  test.each([
    [
      'a truncated value line (no number after the colon)',
      ['  "value": 3,'],
      ['  "value": '],
    ],
    [
      'a renamed field (value absent from the new side)',
      ['  "value": 3,'],
      ['  "points": 3,'],
    ],
    ['content the baseline schema cannot speak (garbage)', ['hello'], ['world']],
    [
      'a non-Direction direction string',
      ['  "direction": "sideways",', '  "value": 3,'],
      ['  "direction": "sideways",', '  "value": 2,'],
    ],
  ])('a modified section with %s fails closed as unparsable (I5: never a pass)', (_label, minus, plus) => {
    const diff = modifiedSection(REL, minus, plus);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('a ±count mismatch (two removed values, one added) fails closed — the pair cannot be lined up', () => {
    const diff = modifiedSection(
      REL,
      ['  "value": 2,', '  "value": 3,'],
      ['  "value": 4,'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
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
    const oldBody = '{\n  "schemaVersion": 1,\n  "target": "hand",\n  "metric": "m",\n  "value": 3\n}\n';
    const newBody = '{\n  "schemaVersion": 1,\n  "target": "hand",\n  "metric": "m",\n  "value": 4\n}\n';
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
    const tighten = modifiedSection(REL, [
      '  "direction": "lower-is-better",',
      '  "value": 3,',
    ], [
      '  "direction": "lower-is-better",',
      '  "value": 2,',
    ]);
    expect(checkDiffMonotonicity(tighten)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    const loosen = modifiedSection(REL, [
      '  "direction": "lower-is-better",',
      '  "value": 2,',
    ], [
      '  "direction": "lower-is-better",',
      '  "value": 3,',
    ]);
    expect(checkDiffMonotonicity(loosen)).toEqual({
      ok: false,
      // The hunk carries only direction+value, so target/metric are not
      // reconstructable and stay undefined (rendered as '(unknown)' by
      // formatViolations).
      violations: [{ path: REL, oldValue: 2, newValue: 3, why: 'loosened' }],
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

describe('formatViolations', () => {
  test('loosened renders path + metric + old → new, verbatim', () => {
    const verdict = checkDiffMonotonicity(fullRewrite(REL, body('lower-is-better', 2), body('lower-is-better', 3)));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: metric typecheck-count loosened 2 → 3 — only tightening diffs pass`,
    ]);
  });

  test('direction changed renders the old → new directions, verbatim', () => {
    const verdict = checkDiffMonotonicity(fullRewrite(REL, body('lower-is-better', 3), body('higher-is-better', 3)));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: direction changed lower-is-better → higher-is-better`,
    ]);
  });

  test('unparsable renders the I5 wording, verbatim', () => {
    const verdict = checkDiffMonotonicity(
      modifiedSection(REL, ['  "value": 3,'], ['  "value": ']),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: unparsable baseline diff — non-passing evidence (I5)`,
    ]);
  });
});
