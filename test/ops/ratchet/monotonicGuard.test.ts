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
//   3. File lifecycle is not a loosening, and comes from METADATA markers
//      (`new file mode` / `--- /dev/null` for added; `deleted file mode` /
//      `+++ /dev/null` for deleted), never from content-line counts —
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
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselineRelPath, renderBaseline } from '../../../src/ops/ratchet/format.js';
import type { BaselineFile, Direction } from '../../../src/ops/ratchet/format.js';
import {
  checkDiffMonotonicity,
  formatViolations,
} from '../../../src/ops/ratchet/monotonicGuard.js';
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

function gitAvailable(): boolean {
  return spawnSync('git', ['--version']).status === 0;
}

/**
 * Feed the guard LITERAL git output: a real temp repo, `before` committed
 * (its absence = added-file lifecycle), `after` staged (its absence =
 * deleted-file lifecycle), and `git diff --cached` returned verbatim.
 * Identity configs ride on the commit as -c flags — one spawn per git
 * verb keeps the sandboxed-spawn overhead well inside the test timeout.
 */
async function realGitDiff(before: string | null, after: string | null): Promise<string> {
  const ws = await mkdtemp(join(tmpdir(), 'cq-gitdiff-'));
  try {
    const run = (args: string[]): void => {
      const r = spawnSync('git', args, { cwd: ws, encoding: 'utf8' });
      if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${String(r.stderr)}`);
    };
    run(['init', '-q']);
    await mkdir(join(ws, 'baselines'), { recursive: true });
    await writeFile(join(ws, 'README.md'), 'seed commit\n', 'utf8');
    const abs = join(ws, REL);
    if (before !== null) await writeFile(abs, before, 'utf8');
    run(['add', '-A']);
    run([
      '-c',
      'user.email=guard@test',
      '-c',
      'user.name=guard',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-q',
      '-m',
      'base',
    ]);
    if (after === null) await rm(abs, { force: true });
    else await writeFile(abs, after, 'utf8');
    run(['add', '-A']);
    const d = spawnSync('git', ['diff', '--cached'], { cwd: ws, encoding: 'utf8' });
    if (d.status !== 0 || typeof d.stdout !== 'string') throw new Error('git diff failed');
    return d.stdout;
  } finally {
    await rm(ws, { recursive: true, force: true });
  }
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
      oldOverrides: { unit: undefined },
      newOverrides: {},
      oldUnit: undefined,
      newUnit: 'errors',
    },
    {
      label: 'a unit REMOVED between the sides (errors → undefined)',
      oldOverrides: {},
      newOverrides: { unit: undefined },
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
    ['a truncated value line (no number after the colon)', ['  "value": 3,'], ['  "value": ']],
    ['a renamed field (value absent from the new side)', ['  "value": 3,'], ['  "points": 3,']],
    ['content the baseline schema cannot speak (garbage)', ['hello'], ['world']],
    [
      'a non-Direction direction string',
      ['  "direction": "sideways",', '  "value": 3,'],
      ['  "direction": "sideways",', '  "value": 2,'],
    ],
    [
      // Codex P1: valid JSON parsing to Infinity — parseBaseline would
      // reject the committed file, so the diff is corrupt evidence and
      // loosens(80, Infinity, …) must never wave it through.
      'a non-finite value literal (1e999 → Infinity)',
      ['  "value": 80,'],
      ['  "value": 1e999,'],
    ],
  ])(
    'a modified section with %s fails closed as unparsable (I5: never a pass)',
    (_label, minus, plus) => {
      const diff = modifiedSection(REL, minus, plus);
      expect(checkDiffMonotonicity(diff)).toEqual({
        ok: false,
        violations: [{ path: REL, why: 'unparsable baseline diff' }],
        filesChecked: 1,
      });
    },
  );

  test('a plus-only section WITHOUT new-file metadata fails closed (Codex P1)', () => {
    // No `new file mode` / `--- /dev/null`: this is a modification of an
    // EXISTING baseline that only adds content — counting lines would let
    // it ride the added-file skip. Unjudgeable → non-passing evidence.
    const diff = modifiedSection(REL, [], ['  "value": 100,']);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('a minus-only section WITHOUT deleted-file metadata fails closed (Codex P1)', () => {
    const diff = modifiedSection(REL, ['  "value": 3,'], []);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('the duplicate-"value" insertion scenario fails closed, not ok (Codex P1)', () => {
    // The exact thread scenario: an existing baseline whose PR inserts a
    // second value line after the first — JSON.parse would honor the LATER
    // duplicate, silently raising the threshold from 3 to 100. Rendered as
    // a real -U1 hunk it is plus-only with no lifecycle metadata: it must
    // be a violation, never a skipped "added file".
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      `--- a/${REL}`,
      `+++ b/${REL}`,
      '@@ -5,1 +5,2 @@',
      '  "value": 3,',
      '+  "value": 100,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test.each(['b/', 'a/', 'i/', 'w/', 'c/', 'o/', ''])(
    'dialect prefix %s on the +++ line is attributed and judged',
    (prefix) => {
      const diff = [
        `diff --git a/${REL} b/${REL}`,
        'index 1111111..2222222 100644',
        `--- a/${REL}`,
        `+++ ${prefix}${REL}`,
        '@@ -1,4 +1,4 @@',
        '-  "direction": "lower-is-better",',
        '-  "value": 3,',
        '+  "direction": "lower-is-better",',
        '+  "value": 2,',
      ].join('\n');
      expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    },
  );

  test('a noprefix dialect (no a//b/ markers anywhere) is attributed via the printed-identical header pair', () => {
    const diff = [
      `diff --git ${REL} ${REL}`,
      'index 1111111..2222222 100644',
      `--- ${REL}`,
      `+++ ${REL}`,
      '@@ -1,4 +1,4 @@',
      '-  "direction": "lower-is-better",',
      '-  "value": 3,',
      '+  "direction": "lower-is-better",',
      '+  "value": 2,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a section with no +++ line falls back to the diff --git b-side path and is judged', () => {
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      `--- a/${REL}`,
      '@@ -1,4 +1,4 @@',
      '-  "direction": "lower-is-better",',
      '-  "value": 3,',
      '+  "direction": "lower-is-better",',
      '+  "value": 2,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a content section with no extractable path fails closed, naming the raw header (unknown dialect)', () => {
    const diff = [
      'diff --git mangled-nonstandard-output',
      '@@ -1,4 +1,4 @@',
      '-  "direction": "lower-is-better",',
      '-  "value": 3,',
      '+  "direction": "lower-is-better",',
      '+  "value": 2,',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: 'diff --git mangled-nonstandard-output', why: 'unparsable baseline diff' },
      ],
      filesChecked: 0,
    });
  });

  test('a pathless section with NO content lines stays ignored (true non-file noise)', () => {
    const diff = ['diff --git noise-entry', 'index abc..def 100644'].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 0 });
  });

  test('a removed `-- /dev/null` line rendering as `--- /dev/null` inside a hunk does NOT flip lifecycle to deleted', () => {
    // The old body contained the literal line `-- /dev/null`; its removal
    // renders exactly as the deleted-file marker — but INSIDE the hunk that
    // is evidence movement, not file lifecycle. Before the header-region
    // fix this section rode the deleted-file skip to ok.
    const diff = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 2,', '-- /dev/null'],
      ['  "direction": "lower-is-better",', '  "value": 3,'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      // The hand-built hunk carries no metric/target lines — both stay
      // undefined while the loosened values are named.
      violations: [{ path: REL, oldValue: 2, newValue: 3, why: 'loosened' }],
      filesChecked: 1,
    });
  });

  test('an added `++ /dev/null` line rendering as `+++ /dev/null` inside a hunk does NOT flip lifecycle to added', () => {
    const diff = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 2,'],
      ['  "direction": "lower-is-better",', '  "value": 3,', '++ /dev/null'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, oldValue: 2, newValue: 3, why: 'loosened' }],
      filesChecked: 1,
    });
  });

  test('a non-finite reconstructed value (1e999 → Infinity) fails closed — parseBaseline would reject the committed file', () => {
    // `1e999` is valid JSON parsing to Infinity, and higher-is-better is the
    // wave-through shape: loosens(80, Infinity, 'higher-is-better') is
    // false, so before the fix the guard returned ok for evidence
    // parseBaseline would go on to reject as corrupt.
    const diff = modifiedSection(
      REL,
      ['  "direction": "higher-is-better",', '  "value": 80,'],
      ['  "direction": "higher-is-better",', '  "value": 1e999,'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('a CRLF-normalized loosening diff still fires (extracted paths survive \\r\\n)', () => {
    // Literal git output on CRLF checkouts: every line carries a trailing
    // \r, which would survive into the extracted path and fail the
    // $-anchored baseline regex — silently skipping EVERY section.
    const diff = fullRewrite(REL, body('lower-is-better', 2), body('lower-is-better', 3))
      .split('\n')
      .join('\r\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, target: TARGET, metric: METRIC, oldValue: 2, newValue: 3, why: 'loosened' },
      ],
      filesChecked: 1,
    });
  });

  test('a binary baseline modification (Binary files differ / GIT binary patch) fails closed', () => {
    // Binary sections have no ± lines to reconstruct — and binary content
    // is exactly what parseBaseline would reject as corrupt. They must not
    // ride the index/mode-only skip to ok.
    const differ = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      'Binary files a/baselines/x and b/baselines/x differ',
    ].join('\n');
    expect(checkDiffMonotonicity(differ)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
    const patch = [
      `diff --git a/${REL} b/${REL}`,
      'index 1111111..2222222 100644',
      'GIT binary patch',
      'literal 0',
    ].join('\n');
    expect(checkDiffMonotonicity(patch)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('normal JSON numbers — ints, floats, exponents — are still judged (tighten passes)', () => {
    // The strict tokenizer must not over-reject: valid ints, floats, and
    // scientific notation reconstruct exactly as before (last-minus 2e1 =
    // 20 tightens to last-plus 1e1 = 10 under lower-is-better).
    const diff = modifiedSection(
      REL,
      ['  "direction": "lower-is-better",', '  "value": 3.5,', '  "value": 2e1,'],
      ['  "direction": "lower-is-better",', '  "value": 2.5,', '  "value": 1e1,'],
    );
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test.each([
    ['a leading-dot number (.70 — invalid JSON)', '  "value": .70,'],
    ['a trailing-dot number (1. — invalid JSON)', '  "value": 1.,'],
    ['a leading-zero token followed by junk (01x — invalid JSON)', '  "value": 01x,'],
  ])(
    'an invalid-JSON numeric token on the + side (%s) fails closed — the committed file would not parse',
    (_label, plusLine) => {
      // The strict tokenizer captures NO number from these tokens, so the ±
      // value counts mismatch (old 1, new 0) and the section fails closed:
      // a threshold the committed file could never contain is never judged
      // as a tighten.
      const diff = modifiedSection(
        REL,
        ['  "direction": "lower-is-better",', '  "value": 3,'],
        ['  "direction": "lower-is-better",', plusLine],
      );
      expect(checkDiffMonotonicity(diff)).toEqual({
        ok: false,
        violations: [{ path: REL, why: 'unparsable baseline diff' }],
        filesChecked: 1,
      });
    },
  );

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

  test('a ±count mismatch (two removed values, one added) fails closed — the pair cannot be lined up', () => {
    const diff = modifiedSection(REL, ['  "value": 2,', '  "value": 3,'], ['  "value": 4,']);
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

const gitDescribe = gitAvailable() ? describe : describe.skip;
gitDescribe('real git diff fixtures (literal git output from a temp repo)', () => {
  test('a real tighten diff passes', { timeout: 20_000 }, async () => {
    const diff = await realGitDiff(body('lower-is-better', 3), body('lower-is-better', 2));
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a real loosen diff fails naming path + metric + values', { timeout: 20_000 }, async () => {
    const diff = await realGitDiff(body('lower-is-better', 2), body('lower-is-better', 3));
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [
        { path: REL, target: TARGET, metric: METRIC, oldValue: 2, newValue: 3, why: 'loosened' },
      ],
      filesChecked: 1,
    });
  });

  test('a noprefix DELETED baseline is attributed via the header fallback (floor-halved pair) and skipped', () => {
    // RED before the round-3 fix: the identical `X X` header pair is always
    // ODD-length, so the old %2===0 gate was dead code and the b-side path
    // was never recovered — the section fail-closed on its minus lines.
    // Now the path is recovered and the header-only `deleted file mode`
    // lifecycle metadata skips the section.
    const diff = [
      `diff --git ${REL} ${REL}`,
      'deleted file mode 100644',
      'index 1111111..0000000',
      `--- ${REL}`,
      '+++ /dev/null',
      '@@ -1,7 +0,0 @@',
      ...bodyLines(body('lower-is-better', 3)).map((l) => `-${l}`),
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test(
    'a real added-baseline diff is skipped via its metadata markers',
    { timeout: 20_000 },
    async () => {
      const diff = await realGitDiff(null, body('lower-is-better', 3));
      expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    },
  );

  test(
    'a real deleted-baseline diff is skipped via its metadata markers',
    { timeout: 20_000 },
    async () => {
      const diff = await realGitDiff(body('lower-is-better', 3), null);
      expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    },
  );

  test(
    'a real clock-only re-capture diff is skipped silently (value unmoved in context)',
    { timeout: 20_000 },
    async () => {
      const diff = await realGitDiff(
        body('lower-is-better', 2),
        body('lower-is-better', 2, { capturedAt: '2026-09-15T01:00:00.000Z' }),
      );
      expect(checkDiffMonotonicity(diff)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    },
  );
});

describe('formatViolations', () => {
  test('loosened renders path + metric + old → new, verbatim', () => {
    const verdict = checkDiffMonotonicity(
      fullRewrite(REL, body('lower-is-better', 2), body('lower-is-better', 3)),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: metric typecheck-count loosened 2 → 3 — only tightening diffs pass`,
    ]);
  });

  test('direction changed renders the old → new directions, verbatim', () => {
    const verdict = checkDiffMonotonicity(
      fullRewrite(REL, body('lower-is-better', 3), body('higher-is-better', 3)),
    );
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: direction changed lower-is-better → higher-is-better`,
    ]);
  });

  test('a QUOTE-BEARING unit change is caught (review-debt #79/#80): the escaped bodies decode before comparing', () => {
    // renderBaseline commits `scale"old` JSON-escaped as `scale\"old`; the
    // old `[^"]*` capture stopped at the escape's quote, so old and new
    // both captured `scale\\` — the identity check read a REAL SCALE
    // CHANGE as unchanged and the same-value shortcut waved it through.
    const changed = checkDiffMonotonicity(
      fullRewrite(
        REL,
        body('lower-is-better', 3, { unit: 'scale"old' }),
        body('lower-is-better', 3, { unit: 'scale"new' }),
      ),
    );
    expect(changed).toEqual({
      ok: false,
      violations: [
        {
          path: REL,
          target: TARGET,
          metric: METRIC,
          oldValue: 3,
          newValue: 3,
          why: 'unit changed',
          oldUnit: 'scale"old',
          newUnit: 'scale"new',
        },
      ],
      filesChecked: 1,
    });
    // The honest counterpart: an IDENTICAL quote-bearing unit on both sides
    // (a clock-only re-capture) still passes — no false violation.
    const sameUnit = checkDiffMonotonicity(
      fullRewrite(
        REL,
        body('lower-is-better', 3, { unit: 'scale"old' }),
        body('lower-is-better', 3, { unit: 'scale"old' }),
      ),
    );
    expect(sameUnit).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('a MALFORMED unit escape is fail-closed (the committed file could not parse back)', () => {
    // The plus side's unit body carries an INVALID JSON escape (`\x` is
    // not a JSON escape sequence): the field regex captures it as escape
    // pairs, but decode fails — the section must fail closed rather than
    // compare garbage or fall back to the other side's unit.
    const base = fullRewrite(REL, body('lower-is-better', 3), body('lower-is-better', 3));
    const plusAt = base.indexOf('+++ b/');
    const diff =
      base.slice(0, plusAt) + base.slice(plusAt).replace('"unit": "errors"', '"unit": "errors\\x"');
    const verdict = checkDiffMonotonicity(diff);
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.why).toBe('unparsable baseline diff');
    }
  });

  test('unit changed renders old → new — with undefined for an absent side — verbatim', () => {
    const flipped = checkDiffMonotonicity(
      fullRewrite(
        REL,
        body('lower-is-better', 3),
        body('lower-is-better', 3, { unit: 'failures' }),
      ),
    );
    expect(flipped.ok).toBe(false);
    if (flipped.ok) throw new Error('unreachable');
    expect(formatViolations(flipped.violations)).toEqual([
      `${REL}: unit changed errors → failures — incomparable scale`,
    ]);
    const added = checkDiffMonotonicity(
      fullRewrite(REL, body('lower-is-better', 3, { unit: undefined }), body('lower-is-better', 3)),
    );
    expect(added.ok).toBe(false);
    if (added.ok) throw new Error('unreachable');
    expect(formatViolations(added.violations)).toEqual([
      `${REL}: unit changed undefined → errors — incomparable scale`,
    ]);
  });

  test('unparsable renders the I5 wording, verbatim', () => {
    const verdict = checkDiffMonotonicity(modifiedSection(REL, ['  "value": 3,'], ['  "value": ']));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(formatViolations(verdict.violations)).toEqual([
      `${REL}: unparsable baseline diff — non-passing evidence (I5)`,
    ]);
  });
});
