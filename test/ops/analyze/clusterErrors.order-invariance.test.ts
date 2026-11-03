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
// subject into this file (the seeded order-invariance property) and the
// sibling clusterErrors.*.test.ts files plus clusterErrors.helpers.ts.
import { describe, expect, test } from 'vitest';
import { clusterErrors, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';
import { failureOf, ledgerOf, setOf } from './clusterErrors.helpers.js';

describe('clusterErrors order-invariance property (seeded, deterministic)', () => {
  /** mulberry32 — tiny seeded PRNG; a fixed seed makes the property deterministic. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Fisher-Yates over a copy; the input array is never mutated. */
  function shuffled<T>(items: readonly T[], rng: () => number): T[] {
    const copy = [...items];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      const swap = copy[i];
      const other = copy[j];
      if (swap === undefined || other === undefined) throw new Error('shuffle index out of range');
      copy[i] = other;
      copy[j] = swap;
    }
    return copy;
  }

  // Four signatures: two multi-member bursts (shape-identical messages that
  // differ only in volatile fragments), one singleton, one known-noise
  // signature — so the property covers ids, confidence, membership, AND the
  // noise split.
  const fixture: CheckFailure[] = [
    failureOf({
      file: 'src/a.ts',
      line: 1,
      ruleId: 'no-unused-vars',
      message: "'a' unused at line 1",
    }),
    failureOf({
      file: 'src/b.ts',
      line: 2,
      ruleId: 'no-unused-vars',
      message: "'b' unused at line 22",
    }),
    failureOf({
      file: 'src/c.ts',
      line: 3,
      ruleId: 'no-unused-vars',
      message: "'c' unused at line 333",
    }),
    failureOf({
      file: 'src/d.ts',
      line: 4,
      ruleId: 'prefer-const',
      message: 'expected 2 args, got 3',
    }),
    failureOf({
      file: 'src/e.ts',
      line: 5,
      ruleId: 'prefer-const',
      message: 'expected 7 args, got 1',
    }),
    failureOf({ file: 'src/f.ts', line: 6, ruleId: 'lonely-rule', message: 'one of a kind' }),
    failureOf({ file: 'src/g.ts', line: 7, ruleId: 'noisy-rule', message: 'noise burst 1' }),
    failureOf({ file: 'src/h.ts', line: 8, ruleId: 'noisy-rule', message: 'noise burst 2' }),
  ];
  const noiseSignature = clusterSignature(fixture[6] as CheckFailure, 'eslint');
  const ledger = ledgerOf([noiseSignature]);

  test('every permutation yields identical ids, confidence, membership, and noise (40 iterations)', () => {
    const rng = mulberry32(0xc1a57e8);
    const reference = clusterErrors(setOf(fixture), ledger);
    expect(reference.clusters).toHaveLength(3);
    expect(reference.noise).toHaveLength(2);
    expect(reference.clusters.map((cluster) => cluster.confidence).sort()).toEqual([
      'high',
      'high',
      'low',
    ]);
    for (let i = 0; i < 40; i++) {
      expect(clusterErrors(setOf(shuffled(fixture, rng)), ledger)).toEqual(reference);
    }
  });

  test('the ids are content-derived: the same failures under a different tool namespace re-key', () => {
    const reference = clusterErrors(setOf(fixture), ledger);
    const otherTool = clusterErrors(setOf(fixture, 'tsc'));
    expect(otherTool.clusters).toHaveLength(4); // the suppressed noise pair clusters as tsc signal
    for (const cluster of reference.clusters) {
      expect(cluster.tool).toBe('eslint');
      // Every signature embeds its tool, so no tsc signature equals an eslint one.
      for (const other of otherTool.clusters) {
        expect(other.signature).not.toBe(cluster.signature);
      }
    }
  });
});
