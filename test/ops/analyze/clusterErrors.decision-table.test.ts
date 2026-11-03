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
// subject into this file (the confidence/membership decision table) and the
// sibling clusterErrors.*.test.ts files plus clusterErrors.helpers.ts.
import { describe, expect, test } from 'vitest';
import { failureIdentity } from '../../../src/ops/analyze/collectFailures.js';
import { clusterErrors, clusterSignature } from '../../../src/ops/analyze/clusterErrors.js';
import { fnv1a32Hex } from '../../../src/ops/gates/fingerprint.js';
import type { CheckFailure } from '../../../src/ops/gates/index.js';
import { failureOf, setOf } from './clusterErrors.helpers.js';

describe('clusterErrors decision table', () => {
  test('same rule + same shape across files → ONE high-confidence cluster with all members', () => {
    const set = setOf([
      failureOf({ file: 'src/a.ts', line: 3, message: "'a' is defined but never used" }),
      failureOf({ file: 'src/b.ts', line: 8, message: "'b' is defined but never used" }),
      failureOf({ file: 'src/c.ts', line: 13, message: "'c' is defined but never used" }),
    ]);
    const report = clusterErrors(set);
    expect(report.noise).toEqual([]);
    expect(report.clusters).toHaveLength(1);
    const cluster = report.clusters[0];
    if (cluster === undefined) throw new Error('expected one cluster');
    expect(cluster.confidence).toBe('high');
    expect(cluster.size).toBe(3);
    expect(cluster.tool).toBe('eslint');
    expect(cluster.ruleId).toBe('rule');
    expect(cluster.id).toBe(fnv1a32Hex(cluster.signature));
    expect(cluster.signature).toBe(clusterSignature(cluster.failures[0] as CheckFailure, 'eslint'));
  });

  test('singletons are low-confidence and stay in their OWN cluster (never silently merged)', () => {
    const burstA = failureOf({ file: 'src/a.ts', message: "'x' is defined but never used" });
    const burstB = failureOf({ file: 'src/b.ts', message: "'y' is defined but never used" });
    // A same-rule NEAR-TWIN: its template ('…never used here') differs from
    // the burst's ('…never used') by more than volatile fragments, so v1
    // keeps it a separate low-confidence cluster instead of absorbing it.
    const odd = failureOf({ file: 'src/odd.ts', message: "'z' is defined but never used here" });
    const report = clusterErrors(setOf([burstA, burstB, odd]));
    expect(report.clusters).toHaveLength(2);
    const high = report.clusters.find((cluster) => cluster.size === 2);
    const low = report.clusters.find((cluster) => cluster.size === 1);
    if (high === undefined || low === undefined) throw new Error('expected 2 + 1 split');
    expect(high.confidence).toBe('high');
    expect(high.failures).toEqual([burstA, burstB]);
    expect(low.confidence).toBe('low');
    expect(low.failures).toEqual([odd]);
    // No emitted cluster ever carries the v1-unreachable 'medium'.
    for (const cluster of report.clusters) {
      expect(cluster.confidence).not.toBe('medium');
    }
  });

  test('different shapes of the same rule stay separate (no similarity merging in v1)', () => {
    const set = setOf([
      failureOf({ message: "'a' is defined but never used" }),
      failureOf({ message: 'a is assigned a value but never used' }),
    ]);
    expect(clusterErrors(set).clusters).toHaveLength(2);
  });

  test('severity is NOT part of the signature: the same shape clusters across error/warning', () => {
    const set = setOf([
      failureOf({ severity: 'error', message: "'a' is defined but never used" }),
      failureOf({ severity: 'warning', message: "'b' is defined but never used" }),
    ]);
    const report = clusterErrors(set);
    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]?.size).toBe(2);
  });

  test('ruleId is identity: identical messages under different rules never cluster together', () => {
    const set = setOf([
      failureOf({ ruleId: 'no-unused-vars', message: 'unused' }),
      failureOf({ ruleId: 'prefer-const', message: 'unused' }),
    ]);
    expect(clusterErrors(set).clusters).toHaveLength(2);
  });

  test('exact duplicates are preserved as members (occurrence count is signal)', () => {
    const same = failureOf({ file: 'src/dup.ts', line: 4 });
    const report = clusterErrors(setOf([same, { ...same }]));
    expect(report.clusters[0]?.size).toBe(2);
  });

  test('member order is the identity key: same-signature pair differing in severity AND message', () => {
    // Everything but severity and the raw message is identical, so the two
    // orderings DISAGREE: the identity tuple orders severity BEFORE message
    // ('error' sorts first), while a JSON.stringify proxy over the fixture
    // literal (message before severity) would pick the warning. Same
    // normalized template → same signature → one cluster, either way.
    const errorVariant = failureOf({
      file: 'src/same.ts',
      line: 5,
      ruleId: 'prefer-const',
      severity: 'error',
      message: "'zz' is assigned a value but never used",
    });
    const warningVariant = failureOf({
      file: 'src/same.ts',
      line: 5,
      ruleId: 'prefer-const',
      severity: 'warning',
      message: "'aa' is assigned a value but never used",
    });
    const report = clusterErrors(setOf([warningVariant, errorVariant]));
    expect(report.clusters).toHaveLength(1);
    const cluster = report.clusters[0];
    if (cluster === undefined) throw new Error('expected one cluster');
    expect(cluster.size).toBe(2);
    // severity ('error' < 'warning' in the identity tuple) decides — the
    // error variant leads despite its later message and later input position.
    expect(cluster.failures).toEqual([errorVariant, warningVariant]);
    // Monotonicity under the IMPLEMENTATION key, not a stringify proxy.
    const firstIdentity = failureIdentity(cluster.failures[0] as CheckFailure, 'eslint');
    const secondIdentity = failureIdentity(cluster.failures[1] as CheckFailure, 'eslint');
    expect(firstIdentity <= secondIdentity).toBe(true);
  });

  test('location-less failures (vitest shape) cluster by test-name shape', () => {
    const set = setOf(
      [
        failureOf({
          file: null,
          line: null,
          column: null,
          ruleId: null,
          message: 'dates > handles 3 cases',
        }),
        failureOf({
          file: null,
          line: null,
          column: null,
          ruleId: null,
          message: 'dates > handles 9 cases',
        }),
      ],
      'vitest',
    );
    const report = clusterErrors(set);
    expect(report.clusters).toHaveLength(1); // shape-identical names merge — documented
    expect(report.clusters[0]?.signature).toBe(
      JSON.stringify(['vitest', null, 'dates > handles <num> cases']),
    );
  });

  test('a null ruleId and an EMPTY-STRING ruleId are distinct signatures (no coercion), in any order', () => {
    const nullRule = failureOf({ file: 'src/n.ts', line: 1, ruleId: null, message: 'same shape' });
    const emptyRule = failureOf({ file: 'src/e.ts', line: 2, ruleId: '', message: 'same shape' });
    const forward = clusterErrors(setOf([nullRule, emptyRule]));
    const backward = clusterErrors(setOf([emptyRule, nullRule]));
    expect(forward.clusters).toHaveLength(2);
    // Order-invariant, and each cluster reports its own ruleId — the
    // members[0] read is deterministic because signature equality implies
    // an identical ruleId value.
    expect(forward.clusters).toEqual(backward.clusters);
    const byRuleId = new Map(forward.clusters.map((cluster) => [cluster.ruleId, cluster]));
    expect(byRuleId.get(null)?.failures).toEqual([nullRule]);
    expect(byRuleId.get('')?.failures).toEqual([emptyRule]);
  });

  test('empty set → empty report (clustering nothing asserts nothing)', () => {
    expect(clusterErrors(setOf([], 'eslint', 0))).toEqual({ clusters: [], noise: [] });
  });

  test('deterministic ordering: clusters by id, members and noise by exact identity', () => {
    const set = setOf([
      failureOf({ file: 'src/z.ts', line: 1, ruleId: 'rule-b', message: 'shape one 1' }),
      failureOf({ file: 'src/a.ts', line: 2, ruleId: 'rule-b', message: 'shape one 2' }),
      failureOf({ file: 'src/m.ts', line: 3, ruleId: 'rule-a', message: 'shape two' }),
    ]);
    const report = clusterErrors(set);
    const ids = report.clusters.map((cluster) => cluster.id);
    expect([...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))).toEqual(ids);
    for (const cluster of report.clusters) {
      const first = cluster.failures[0];
      const last = cluster.failures[cluster.failures.length - 1];
      if (first === undefined || last === undefined) throw new Error('empty cluster');
      // The REAL sort key — failureIdentity — not a stringify proxy.
      const firstIdentity = failureIdentity(first, 'eslint');
      const lastIdentity = failureIdentity(last, 'eslint');
      expect(firstIdentity <= lastIdentity).toBe(true);
    }
  });

  test('distinct signatures colliding on the 32-bit id still sort deterministically (pinned pair)', () => {
    // A GENUINE FNV-1a-32 collision, found by an offline brute-force search
    // over random letter-only template candidates (236,728 tried; the pair
    // is hard-coded so this test executes the signature tiebreak in the
    // cluster sort). Both templates are pure letters, so messageTemplate
    // leaves them unchanged and the failures' computed signatures equal
    // these strings verbatim.
    const sigA = JSON.stringify(['eslint', 'r', 'tjivlzyj']);
    const sigB = JSON.stringify(['eslint', 'r', 'qcmqx']);
    expect(sigA).not.toBe(sigB);
    expect(fnv1a32Hex(sigA)).toBe('e6854fd8');
    expect(fnv1a32Hex(sigB)).toBe('e6854fd8');
    const a = failureOf({ file: 'src/a.ts', ruleId: 'r', message: 'tjivlzyj' });
    const b = failureOf({ file: 'src/b.ts', ruleId: 'r', message: 'qcmqx' });
    const forward = clusterErrors(setOf([a, b]));
    const backward = clusterErrors(setOf([b, a]));
    expect(forward.clusters).toHaveLength(2); // distinct signatures: never merged
    const first = forward.clusters[0];
    const second = forward.clusters[1];
    if (first === undefined || second === undefined) throw new Error('expected two clusters');
    // The tie is REAL: two distinct signatures, one 32-bit id — both
    // singleton clusters report low confidence.
    expect(first.id).toBe(second.id);
    expect(first.id).toBe('e6854fd8');
    expect(first.confidence).toBe('low');
    expect(second.confidence).toBe('low');
    // Sorted by SIGNATURE within the tie (sigB < sigA code-unit-wise),
    // identically for both input orders — never by insertion order.
    expect(first.signature).toBe(sigB);
    expect(second.signature).toBe(sigA);
    expect(first.failures).toEqual([b]);
    expect(second.failures).toEqual([a]);
    expect(forward.clusters).toEqual(backward.clusters);
  });
});
