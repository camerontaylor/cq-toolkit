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
// subject into this file (the ledger-matching signature form and its
// truncation bounds) and the sibling clusterErrors.*.test.ts files plus
// clusterErrors.helpers.ts.
import { describe, expect, test } from 'vitest';
import { clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import { SIGNATURE_MAX_CHARS } from '../../../src/ops/ledger/ledger.js';
import { failureOf } from './clusterErrors.helpers.js';

describe('clusterSignature (the ledger-matching form)', () => {
  test('is the canonical JSON tuple: tool, ruleId (null stays null — never coerced), template', () => {
    expect(
      clusterSignature(failureOf({ ruleId: 'prefer-const', message: 'x is 3' }), 'eslint'),
    ).toBe(JSON.stringify(['eslint', 'prefer-const', 'x is <num>']));
    expect(clusterSignature(failureOf({ ruleId: null, message: 'a' }), 'vitest')).toBe(
      JSON.stringify(['vitest', null, 'a']),
    );
  });

  test('volatile fragments do not change the signature; ANY other change does', () => {
    const base = clusterSignature(failureOf({ message: "'a' used at line 3" }), 'eslint');
    expect(clusterSignature(failureOf({ message: "'b' used at line 99" }), 'eslint')).toBe(base);
    expect(clusterSignature(failureOf({ message: "'a' used at line 3" }), 'tsc')).not.toBe(base);
    expect(
      clusterSignature(failureOf({ ruleId: 'other', message: "'a' used at line 3" }), 'eslint'),
    ).not.toBe(base);
  });

  test('a very long message yields a bounded, deterministic signature (ledger record seam)', () => {
    const long = 'x'.repeat(5000);
    const signature = clusterSignature(failureOf({ message: long }), 'eslint');
    expect(signature.length).toBeLessThanOrEqual(SIGNATURE_MAX_CHARS);
    expect(clusterSignature(failureOf({ message: long }), 'eslint')).toBe(signature);
    // Distinct long messages stay distinct when they differ BEFORE the cut…
    expect(clusterSignature(failureOf({ message: 'y'.repeat(5000) }), 'eslint')).not.toBe(
      signature,
    );
    // …and the DOCUMENTED coarseness: messages differing only after the
    // truncation point sign ONE signature (accepted prefix-collision class).
    expect(clusterSignature(failureOf({ message: `${long}suffix` }), 'eslint')).toBe(signature);
  });

  test('escape inflation near the cut exercises the MULTI-iteration truncation path', () => {
    // One raw double quote sits INSIDE the first budget window, so the
    // first cut escapes it (+1 JSON unit) and overflows the bound by one —
    // the loop must shrink the budget and cut again. Both calls agree
    // (determinism) and terminate UNDER the bound.
    const message = `${'x'.repeat(450)}"${'x'.repeat(5000)}`;
    const signature = clusterSignature(failureOf({ message }), 'eslint');
    expect(signature.length).toBeLessThanOrEqual(SIGNATURE_MAX_CHARS);
    expect(clusterSignature(failureOf({ message }), 'eslint')).toBe(signature);
    // Truncation actually happened (the marker is present).
    expect(signature).toContain('…');
  });

  test('escape-inflated overhead: the LIBRARY-only over-bound residual, deterministic and terminating', () => {
    // Direct clusterSignature calls bypass the registry's ENCODED-size
    // bounds, so 200 double-quote characters in tool and ruleId are
    // constructible here: each encodes to 402 JSON units (> 120), the
    // fixed overhead inflates past SIGNATURE_MAX_CHARS, the budget bottoms
    // out, and the loop returns the over-bound signature deterministically.
    // Through the op this input cannot pass the registry; the ledger record
    // boundary would reject the over-bound result — no suppression, never
    // wrong suppression.
    const quoted = '"'.repeat(200);
    const failure = failureOf({ ruleId: quoted, message: 'x'.repeat(5000) });
    const signature = clusterSignature(failure, quoted);
    expect(signature.length).toBeGreaterThan(SIGNATURE_MAX_CHARS);
    expect(clusterSignature(failure, quoted)).toBe(signature);
  });
});
