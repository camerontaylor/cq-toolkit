// The canonical branch grammar (shared/refname.ts) and the two places that consume
// it: the dev ledger validator and the queue wire/origin schemas must agree, so the
// vectors are read from ONE shared fixture rather than restated per language.
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { branchPathFault } from '../../src/shared/refname.js';
import { branchPathFault as recordFault } from '../../src/ops/dev/record.js';
import { branchPathFault as publicFault } from '../../src/ops/dev/index.js';

interface Vector {
  value: string;
  accept: boolean;
  rule: string;
}

const { vectors } = JSON.parse(
  readFileSync(new URL('../fixtures/refname-vectors.json', import.meta.url), 'utf8'),
) as { vectors: Vector[] };

const accepts = vectors.filter((v) => v.accept);
const rejects = vectors.filter((v) => !v.accept);

describe('branchPathFault', () => {
  test('accepts every approved branch target', () => {
    expect(accepts.length).toBeGreaterThan(0);
    for (const vector of accepts) {
      expect(
        branchPathFault(vector.value),
        `${vector.rule}: ${JSON.stringify(vector.value)}`,
      ).toBeNull();
    }
  });

  test('rejects every invalid refname with a named rule', () => {
    expect(rejects.length).toBeGreaterThan(0);
    for (const vector of rejects) {
      expect(
        branchPathFault(vector.value),
        `${vector.rule}: ${JSON.stringify(vector.value)}`,
      ).not.toBeNull();
    }
  });

  test('tightened rules fire individually: controls, lone @, @{, trailing dot', () => {
    expect(branchPathFault('a\u0001b')).toMatch(/control character/);
    expect(branchPathFault('a\tb')).toMatch(/control character/);
    expect(branchPathFault('a\u007fb')).toMatch(/control character/);
    expect(branchPathFault('@')).toMatch(/single character/);
    expect(branchPathFault('a@{b')).toMatch(/@\{/);
    expect(branchPathFault('main.')).toMatch(/must not end with/);
    // Still accepted: an internal dot, and a slash-joined target.
    expect(branchPathFault('a.b')).toBeNull();
    expect(branchPathFault('release/1.4')).toBeNull();
  });

  test('Unicode whitespace that JS and Python \\s disagree on is accepted by both rules', () => {
    // The explicit C0/DEL/U+0020 rule replaced a `\s` class precisely so these two
    // cases cannot split the implementations: Python's `\s` matches U+0085 and
    // ECMAScript's matches U+FEFF, and neither character is forbidden.
    expect(branchPathFault('a\u0085b')).toBeNull();
    expect(branchPathFault('a\ufeffb')).toBeNull();
    expect(branchPathFault('a\u00a0b')).toBeNull();
    // The literal space and C0 controls are still refused.
    expect(branchPathFault('a b')).toMatch(/space or control character/);
    expect(branchPathFault('a\u001fb')).toMatch(/space or control character/);
  });

  test('record re-export preserves the public API and the local binding', () => {
    // dev/record.ts imports the leaf (its own devLedgerPath caller needs a local
    // binding) and re-exports it, so both the module and the ops barrel answer the
    // same verdicts as the leaf for every vector.
    for (const vector of vectors) {
      const leaf = branchPathFault(vector.value);
      expect(recordFault(vector.value), `record: ${vector.rule}`).toBe(leaf);
      expect(publicFault(vector.value), `index: ${vector.rule}`).toBe(leaf);
    }
  });
});
