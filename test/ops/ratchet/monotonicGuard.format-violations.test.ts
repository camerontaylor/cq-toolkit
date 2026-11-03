// Split out of the pre-split monotonicGuard.test.ts so review tooling can
// see below the 256 KiB single-file cap; describe wrappers are reproduced
// verbatim so every test's full title path stays byte-identical.

import { describe, expect, test } from 'vitest';
import {
  checkDiffMonotonicity,
  formatViolations,
} from '../../../src/ops/ratchet/monotonicGuard.js';
import {
  METRIC,
  REL,
  TARGET,
  body,
  fullRewrite,
  modifiedSection,
} from './monotonicGuard.helpers.js';

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

  test('a MINIFIED malformed DIRECTION at equal values fails closed — the direction-key delimiter path pinned (PR #129 review, Codex P2)', () => {
    // The UNIT row pins UNIT_KEY_RE; this row pins DIRECTION_KEY_RE alone:
    // a minified baseline whose direction value is undecodable after a
    // ',' — reverting ONLY the direction anchor to line-start-only lets
    // equal values take the same-value path on a file parseBaseline
    // rejects. (The existing malformed-direction case is pretty-printed,
    // so the old anchor matched it — this row is the minified twin.)
    const bad = (value: number): string =>
      `{"schemaVersion":1,"target":"typecheck","metric":"typecheck-count","direction":"lower-is-\\x","value":${value},"capturedAt":"2026-09-15T00:00:00.000Z"}`;
    const diff = fullRewrite(REL, bad(3), bad(3));
    const verdict = checkDiffMonotonicity(diff);
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.why).toBe('unparsable baseline diff');
    }
  });

  test('a MINIFIED key with an UNDECODABLE value fails closed — key presence is what the delimiter anchor buys (PR #128 review, Codex P2)', () => {
    // The behavior the delimiter-aware KEY regexes actually change: key
    // PRESENCE with an uncapturable/undecodable value. A minified
    // baseline carrying "unit":"bad\\x" (invalid JSON escape) after a
    // ',' — the line-start-only anchor missed the key entirely, so both
    // sides read unit-less and a value-only tightening PASSED a file
    // parseBaseline rejects; the delimiter-aware key check fails closed.
    // (The PR #126 row's VALID units exercise the value regex, which was
    // never anchored — this row pins the key regex itself, verified by
    // revert-and-run.)
    const bad = (value: number): string =>
      `{"schemaVersion":1,"target":"typecheck","metric":"typecheck-count","direction":"lower-is-better","value":${value},"unit":"bad\\x","capturedAt":"2026-09-15T00:00:00.000Z"}`;
    const diff = fullRewrite(REL, bad(5), bad(3));
    const verdict = checkDiffMonotonicity(diff);
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.why).toBe('unparsable baseline diff');
    }
  });

  test('a MINIFIED one-line baseline: real keys still match the key check (PR #126 review, Codex P2)', () => {
    // A hand-edited baseline placing properties on ONE line: the unit key
    // follows '{' or ',' instead of a line start — the line-start-only
    // anchor missed it, both sides read unit-less, and the guard passed a
    // file parseBaseline would reject. The delimiter-aware anchor matches.
    const minified = (value: number, unit?: string): string =>
      `{"schemaVersion":1,"target":"typecheck","metric":"typecheck-count","direction":"lower-is-better","value":${value}${unit === undefined ? '' : `,"unit":"${unit}"`},"capturedAt":"2026-09-15T00:00:00.000Z"}`;
    // A unit change on a minified baseline is caught (key after ',').
    const diff = fullRewrite(REL, minified(5, 'errors'), minified(3, 'failures'));
    const verdict = checkDiffMonotonicity(diff);
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.why).toBe('unit changed');
    }
    // Same unit on both sides still passes.
    const same = fullRewrite(REL, minified(5, 'errors'), minified(3, 'errors'));
    expect(checkDiffMonotonicity(same)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('key-like text never fires the key check — escaped in rendered values, raw mid-line in hand-crafted diffs (PR #118/#123 reviews)', () => {
    // Two layers, both pinned (PR #123 review caught the earlier version
    // of this test being vacuous — the fixture passed against the
    // UNANCHORED matcher too):
    // (a) RENDERED baselines: a target like `contains "unit": nope` is
    //     committed JSON-ESCAPED (\"unit\") — neither matcher can read
    //     the escaped form, so this row documents the escaping invariant.
    const rendered = fullRewrite(
      REL,
      body('lower-is-better', 5, { target: 'contains "unit": nope' }),
      body('lower-is-better', 3, { target: 'contains "unit": nope' }),
    );
    expect(checkDiffMonotonicity(rendered)).toEqual({ ok: true, violations: [], filesChecked: 1 });
    // (b) HAND-CRAFTED diffs: a hostile line carrying the RAW sequence
    //     mid-value (`"target": "prefix "unit": nope"`) is not valid JSON,
    //     but the guard judges diff TEXT — the UNANCHORED matcher read it
    //     as a unit key at a non-property position and failed the section
    //     closed; the ^\s* anchor matches only property positions, so the
    //     section judges normally (a tightening of 5 → 3 passes).
    const crafted = fullRewrite(
      REL,
      body('lower-is-better', 5, { unit: null }),
      body('lower-is-better', 3, { unit: null }),
    ).replace('"target": "typecheck"', '"target": "prefix "unit": nope"');
    expect(checkDiffMonotonicity(crafted)).toEqual({ ok: true, violations: [], filesChecked: 1 });
  });

  test('malformed direction escapes on BOTH sides at equal values fail closed (PR #108 review, CodeRabbit Major)', () => {
    // Both sides carry `direction: "lower-is-\x"` — decode fails for both,
    // which previously read as NEITHER side having a direction, letting
    // equal values take the same-value success path. Key presence + decode
    // now fails closed.
    const base = fullRewrite(REL, body('lower-is-better', 3), body('lower-is-better', 3));
    const diff = base
      .split('\n')
      .map((line) =>
        line.includes('"direction": "lower-is-better"')
          ? `${line[0]}"direction": "lower-is-\\x"`
          : line,
      )
      .join('\n');
    const verdict = checkDiffMonotonicity(diff);
    expect(verdict.ok).toBe(false);
    if (verdict.ok === false) {
      expect(verdict.violations[0]?.why).toBe('unparsable baseline diff');
    }
  });

  test('an UNTERMINATED unit escape fails closed — key present, value uncapturable (PR #108 review, Codex P1)', () => {
    // The plus side adds `"unit": "errors\"` (a stray backslash swallows
    // the closing quote): the value regex matches nothing, and the old
    // logic read the unit as ABSENT — an added-unit re-scaling could be
    // waved through. Key presence now fails closed.
    const base = fullRewrite(
      REL,
      body('lower-is-better', 3, { unit: null }),
      body('lower-is-better', 3, { unit: null }),
    );
    const plusAt = base.indexOf('+++ b/');
    const diff =
      base.slice(0, plusAt) +
      base
        .slice(plusAt)
        .split('\n')
        .map((line) =>
          line.startsWith('+') && line.includes('"value"')
            ? `${line}\n+    "unit": "errors\\`
            : line,
        )
        .join('\n');
    expect(checkDiffMonotonicity(diff).ok).toBe(false);
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
      fullRewrite(REL, body('lower-is-better', 3, { unit: null }), body('lower-is-better', 3)),
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
