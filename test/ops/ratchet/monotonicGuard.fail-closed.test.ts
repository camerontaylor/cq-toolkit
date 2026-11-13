// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import { checkDiffMonotonicity } from '../../../src/ops/ratchet/monotonicGuard.js';
import {
  REL,
  addedSection,
  body,
  deletedSection,
  modifiedSection,
} from './monotonicGuard.helpers.js';

describe('checkDiffMonotonicity', () => {
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

  test.each([
    ['val\\u0075e', '"metric": "typecheck-count", "val\\u0075e": 50'],
    ['dir\\u0065ction', '"metric": "typecheck-count", "dir\\u0065ction": "lower-is-better"'],
  ])('an escaped property key (%s) on the modified path fails closed', (_key, injected) => {
    const diff = modifiedSection(
      REL,
      ['  "direction": "higher-is-better",', '  "value": 80,', '  "metric": "typecheck-count",'],
      ['  "direction": "higher-is-better",', '  "value": 80,', `  ${injected},`],
    );
    expect(checkDiffMonotonicity(diff)).toMatchObject({ ok: false });
  });

  test.each(['\n', '\n\t', '\r\n'])(
    'an escaped key split from its colon by %j fails closed',
    (whitespace) => {
      const old = body('higher-is-better', 80);
      const injected = old.replace('"value": 80', `"value": 80, "val\\u0075e"${whitespace}: 50`);
      const parsed = JSON.parse(injected) as { value: unknown };
      expect(parsed.value).toBe(50);
      const diff = modifiedSection(REL, old.trimEnd().split('\n'), injected.trimEnd().split('\n'));
      expect(checkDiffMonotonicity(diff)).toEqual({
        ok: false,
        violations: [{ path: REL, why: 'unparsable baseline diff' }],
        filesChecked: 1,
      });
    },
  );

  test('an escaped key after a separator in context retains line-start detection', () => {
    const injected = '  "val\\u0075e": 50, "capturedAt": "2026-09-15T00:00:00.000Z"';
    const parsed = JSON.parse(`{"value": 81, ${injected}}`) as { value: unknown };
    expect(parsed.value).toBe(50);
    const diff = [
      `diff --git a/${REL} b/${REL}`,
      `--- a/${REL}`,
      `+++ b/${REL}`,
      '@@ -1,9 +1,9 @@',
      ' {',
      '   "direction": "higher-is-better",',
      '-  "value": 80',
      '+  "value": 81',
      '   ,',
      '   "unit": "errors"',
      '   ,',
      '-  "capturedAt": "2026-09-15T00:00:00.000Z"',
      `+${injected}`,
      ' }',
    ].join('\n');
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('an escaped property key on the delete+add path fails closed', () => {
    const old = body('higher-is-better', 80);
    const injected = body('higher-is-better', 80).replace(
      '"value": 80',
      '"value": 80, "val\\u0075e": 50',
    );
    expect(injected).not.toBe(old);
    const diff = deletedSection(REL, old) + addedSection(REL, injected);
    expect(checkDiffMonotonicity(diff)).toMatchObject({ ok: false });
  });

  test('a key ending in an escaped backslash fails closed — the linear scan reads the pair', () => {
    // The key `a\` rendered as JSON is `"a\\"`: VALID (it parses back to the
    // key `a\`) yet the ambiguous `(?:[^"\\]|\\.)*\\(?:[^"\\]|\\.)*` shape
    // could not see it — the body's only two backslashes were both
    // claimable by one `\\.` pair, so no bare `\` was left reachable and the
    // escaped key escaped detection. Any escaped key fails closed.
    const injected = body('higher-is-better', 80).replace(
      '"value": 80',
      '"value": 80, "a\\\\": 50',
    );
    expect(() => void JSON.parse(injected)).not.toThrow();
    expect(
      checkDiffMonotonicity(
        modifiedSection(
          REL,
          body('higher-is-better', 80).trimEnd().split('\n'),
          injected.trimEnd().split('\n'),
        ),
      ),
    ).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });

  test('the escaped-key scan stays LINEAR on a crafted escape run (no O(n²) stall)', () => {
    // The gate reads PR-author-controlled diff text. A long key body with
    // many escapes and no colon used to make the scan retry every split
    // point from the opening quote: ~5s at this size, unbounded growth with
    // length. The single-escape shape answers in well under a millisecond.
    const run = `"${'\\a'.repeat(60_000)}`;
    const started = performance.now();
    const verdict = checkDiffMonotonicity(
      modifiedSection(
        REL,
        ['  "direction": "higher-is-better",', '  "value": 80,'],
        ['  "direction": "higher-is-better",', '  "value": 80,', `  ${run},`],
      ),
    );
    const elapsed = performance.now() - started;
    // The escape run names no key (no colon), so it moves no field: the
    // section's direction/value pair still judges as unchanged. The time is
    // the assertion — the scan must not re-walk the tail per split point.
    expect(verdict).toEqual({ ok: true, violations: [], filesChecked: 1 });
    expect(elapsed).toBeLessThan(3_000);
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

  test('a ±count mismatch (two removed values, one added) fails closed — the pair cannot be lined up', () => {
    const diff = modifiedSection(REL, ['  "value": 2,', '  "value": 3,'], ['  "value": 4,']);
    expect(checkDiffMonotonicity(diff)).toEqual({
      ok: false,
      violations: [{ path: REL, why: 'unparsable baseline diff' }],
      filesChecked: 1,
    });
  });
});
