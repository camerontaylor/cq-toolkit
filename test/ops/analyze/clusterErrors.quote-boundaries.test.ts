// Analyze lane G1 — test evidence for signature clustering: the exact
// normalization pipeline (what is abstracted, what is preserved, rule
// order), content-derived stable ids, the confidence decision table
// (high/low; v1 never merges, never emits 'medium'), the ledger noise seam
// (knownNoise excludes BY CLUSTER SIGNATURE — any other recorded form never
// matches), and a seeded PROPERTY test proving the acceptance constraint:
// the same failure set in any presentation order yields identical cluster
// ids, confidences, and membership. All pure — zero I/O.
//
// Split provenance: test/ops/analyze/clusterErrors.test.ts was split by
// subject into this file (quoted-span opener boundaries and pathological
// scanning) and the sibling clusterErrors.*.test.ts files plus
// clusterErrors.helpers.ts.
import { describe, expect, test } from 'vitest';
import { clusterSignature, messageTemplate } from '../../../src/ops/analyze/clusterErrors.js';
import { failureOf } from './clusterErrors.helpers.js';

describe('messageTemplate normalization pipeline (the documented contract)', () => {
  test('contraction apostrophes never open a quoted span; a real quoted span still abstracts', () => {
    // No curly rewrite anymore: the opener-boundary rule leaves the straight
    // apostrophe in place, verbatim.
    expect(messageTemplate("The option doesn't accept 'foo'")).toBe(
      "The option doesn't accept <str>",
    );
    // The over-split trap: changing the quoted word must NOT change the
    // signature — the contraction's apostrophe is not a quote-pair opener.
    const withFoo = clusterSignature(
      failureOf({ message: "The option doesn't accept 'foo'" }),
      'eslint',
    );
    const withBar = clusterSignature(
      failureOf({ message: "The option doesn't accept 'bar'" }),
      'eslint',
    );
    expect(withFoo).toBe(withBar);
    // A genuine quoted span (no contraction involved) still abstracts.
    expect(messageTemplate("'baz' is defined but never used")).toBe(
      '<str> is defined but never used',
    );
  });

  test('possessive apostrophes never open a quoted span either (space after the apostrophe)', () => {
    expect(messageTemplate("Users' setting rejects 'foo'")).toBe("Users' setting rejects <str>");
    // Same over-split discipline: the quoted word is volatile, the
    // possessive is not — both messages share one signature.
    const withFoo = clusterSignature(
      failureOf({ message: "Users' setting rejects 'foo'" }),
      'eslint',
    );
    const withBar = clusterSignature(
      failureOf({ message: "Users' setting rejects 'bar'" }),
      'eslint',
    );
    expect(withFoo).toBe(withBar);
  });

  test("Unicode letters count as word chars for the opener boundary (café's)", () => {
    // \w is ASCII-only: é is a Unicode letter but not \w, so under an ASCII
    // lookbehind the apostrophe after café OPENS a span and pairs with the
    // LATER quoted word — an over-split. The Unicode-aware boundary keeps
    // the span at 'foo'.
    expect(messageTemplate("café's setting rejects 'foo'")).toBe("café's setting rejects <str>");
    const withFoo = clusterSignature(
      failureOf({ message: "café's setting rejects 'foo'" }),
      'eslint',
    );
    const withBar = clusterSignature(
      failureOf({ message: "café's setting rejects 'bar'" }),
      'eslint',
    );
    expect(withFoo).toBe(withBar);
  });

  test.each(['𐐀', '𝟘'])('astral word character %s blocks a quoted-span opener', (prefix) => {
    // Letters and numbers have the same boundary contract outside the BMP.
    // The internal delimiter must stay literal; only the later span varies.
    for (const delimiter of ["'", '"', '`']) {
      const message = `${prefix}${delimiter}s setting rejects ${delimiter}foo${delimiter}`;
      expect(messageTemplate(message)).toBe(`${prefix}${delimiter}s setting rejects <str>`);
      expect(clusterSignature(failureOf({ message }), 'eslint')).toBe(
        clusterSignature(failureOf({ message: message.replace('foo', 'bar') }), 'eslint'),
      );
    }
  });

  test.each(['😀', '\ud800', '\udc00'])(
    'non-word character %s still permits a quoted-span opener',
    (prefix) => {
      expect(messageTemplate(`${prefix}'foo'`)).toBe(`${prefix}<str>`);
    },
  );

  test('escaped delimiters cannot close a span ("a\\"b" is ONE span)', () => {
    // The body consumes backslash pairs, so the escaped quote does not end
    // the span — changing the volatile tail must not change the signature.
    expect(messageTemplate('Invalid value "a\\"b"')).toBe('Invalid value <str>');
    const withB = clusterSignature(failureOf({ message: 'Invalid value "a\\"b"' }), 'eslint');
    const withC = clusterSignature(failureOf({ message: 'Invalid value "a\\"c"' }), 'eslint');
    expect(withB).toBe(withC);
  });

  test('a Windows path in quotes abstracts as ONE <str> span (escape pairs consumed)', () => {
    // Each \X inside the span is consumed as an escape pair, so the back
    //slashes cannot break the span and the closer is still found — the
    // whole span abstracts (the documented Windows-path tradeoff).
    expect(messageTemplate("cannot read 'C:\\temp\\log'")).toBe('cannot read <str>');
  });

  test('linear scan at scale: 2000 space-preceded apostrophes pair into 1000 spans (identical semantics)', () => {
    // Every apostrophe after the first is the previous opener's CLOSER
    // candidate, so this many-opener input pairs into spans rather than
    // failing — the exact output is pinned via .repeat, which also pins
    // the scanner's linear single-pass shape (no per-opener tail rescans).
    const message = "'a ".repeat(2000);
    // The pipeline's trailing trim removes the final space of the last
    // literal 'a ' unit.
    const expected = '<str>a '.repeat(999) + '<str>a';
    expect(messageTemplate(message)).toBe(expected);
  });

  test('a failed opener (no closer in the tail) makes the rest of the message literal', () => {
    // The failed-opener rule: the single apostrophe opens, the scan
    // exhausts the tail without a closer, and the style goes dead — the
    // whole message passes through literally. Exact output pinned.
    const message = `'${'a'.repeat(4000)}`;
    expect(messageTemplate(message)).toBe(message);
  });

  test('pathological tokens normalize with correct output (token-wise scan, unbounded messages)', () => {
    const longToken = 'a'.repeat(200_000);
    // With a separator: the whole maximal non-space run is one <path>.
    expect(messageTemplate(`${longToken}/x`)).toBe('<path>');
    // Without a separator: passed through unchanged — the case a
    // backtracking path regex makes quadratic on adversarial input.
    expect(messageTemplate(longToken)).toBe(longToken);
  });
});
