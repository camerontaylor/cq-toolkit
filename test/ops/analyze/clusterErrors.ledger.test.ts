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
// subject into this file (the ledger noise seam) and the sibling
// clusterErrors.*.test.ts files plus clusterErrors.helpers.ts.
import { describe, expect, test } from 'vitest';
import { clusterErrors, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import type { LedgerView } from '../../../src/ops/ledger/index.js';
import { failureOf, ledgerOf, setOf } from './clusterErrors.helpers.js';

describe('clusterErrors × ledger (known noise never clusters as signal)', () => {
  const noisy = failureOf({
    file: 'src/noisy.ts',
    line: 5,
    message: "'n' is defined but never used",
  });
  // A different message SHAPE, so it does not share noisy's signature and
  // genuinely tests that suppression is per-signature, not global.
  const signal = failureOf({
    file: 'src/signal.ts',
    line: 7,
    message: "'s' is assigned a value but never used",
  });

  test('a failure whose CLUSTER SIGNATURE is in knownNoise goes to noise, not clusters', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const report = clusterErrors(setOf([noisy, signal]), ledgerOf([signature]));
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]?.failures).toEqual([signal]);
    expect(report.noise).toEqual([noisy]);
    // Noise never leaks into any cluster, by identity.
    for (const cluster of report.clusters) {
      expect(cluster.failures).not.toContainEqual(noisy);
    }
  });

  test('the seam is signature-form: a ledger entry recorded as the RAW message never matches', () => {
    const report = clusterErrors(setOf([noisy]), ledgerOf([noisy.message]));
    expect(report.noise).toEqual([]);
    expect(report.clusters).toHaveLength(1);
  });

  test('a needsHuman escalation (count ≥ escalateAt) is inside knownNoise and is excluded', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const ledger: LedgerView = {
      entries: [{ signature, count: 3 }],
      knownNoise: [signature],
      needsHuman: [signature],
    };
    const report = clusterErrors(setOf([noisy]), ledger);
    expect(report.noise).toEqual([noisy]);
    expect(report.clusters).toEqual([]);
  });

  test('knownNoise with NO grounding entry throws (stale or hand-built view)', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const stale: LedgerView = { entries: [], knownNoise: [signature], needsHuman: [] };
    expect(() => clusterErrors(setOf([noisy]), stale)).toThrow(/knownNoise.*entry/);
    // A view whose entries DO contain the signature still suppresses.
    const grounded = clusterErrors(setOf([noisy]), ledgerOf([signature]));
    expect(grounded.noise).toEqual([noisy]);
  });

  test('a hand-built view violating needsHuman ⊆ knownNoise throws (enforced, not assumed)', () => {
    const signature = clusterSignature(noisy, 'eslint');
    const badView: LedgerView = {
      entries: [{ signature, count: 3 }],
      knownNoise: [],
      needsHuman: [signature],
    };
    expect(() => clusterErrors(setOf([noisy]), badView)).toThrow(/needsHuman.*knownNoise/);
  });

  test('no ledger (or an empty view) suppresses nothing', () => {
    expect(clusterErrors(setOf([noisy])).noise).toEqual([]);
    expect(clusterErrors(setOf([noisy]), ledgerOf([])).noise).toEqual([]);
  });

  test('a ledger recorded under a DIFFERENT tool namespace does not match', () => {
    const signature = clusterSignature(noisy, 'tsc'); // wrong tool in the signature
    const report = clusterErrors(setOf([noisy]), ledgerOf([signature]));
    expect(report.noise).toEqual([]);
  });
});
