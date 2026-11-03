// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import {
  verifyClosureEvidence,
  type ClosureVerification,
  type VerificationCheck,
} from '../../../src/ops/review/internal/addressVerification.js';
import {
  CHECK_ORDER,
  HEAD,
  PARENT,
  expectLastCheck,
  expectPrefix,
  makePacket,
  namesOf,
  outcomesOf,
} from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('a valid fix resolves only when every check passes', () => {
    const result = verifyClosureEvidence(makePacket());
    expect(result.verdict).toBe('resolved');
    expect(result.reason).toBe('closure-evidence-complete');
    expect(namesOf(result)).toEqual([...CHECK_ORDER]);
    expect(outcomesOf(result)).toEqual(['pass', 'pass', 'pass', 'pass', 'pass']);
    expect(result.revision).toEqual({ head: HEAD, parent: PARENT });
  });

  test('no gate means full evaluation', () => {
    const result = verifyClosureEvidence(makePacket(), undefined);
    expect(result.verdict).toBe('resolved');
  });

  test('omitted consumer or dependency attestation yields uncertain', () => {
    const result = verifyClosureEvidence(makePacket({ relevantDependenciesComplete: false }));
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('omitted-consumer-or-dependency');
    expect(namesOf(result)).toEqual([...CHECK_ORDER]);
    expectLastCheck(result, { check: 'dependencies-covered', outcome: 'unavailable' });
    expect(result.checks[4]?.detail).toContain('completeness is not attested');
  });

  test('verdict invariants hold over the core scenarios', () => {
    const scenarios: ClosureVerification[] = [
      verifyClosureEvidence(makePacket()),
      verifyClosureEvidence(makePacket({ relevantDependenciesComplete: false })),
      verifyClosureEvidence(makePacket(), { admit: () => undefined }),
      verifyClosureEvidence(makePacket({ metadata: { revision: { head: HEAD, parent: HEAD } } })),
    ];
    for (const result of scenarios) {
      expect(['resolved', 'unresolved', 'uncertain']).toContain(result.verdict);
      const failing = result.checks.filter((entry: VerificationCheck) => entry.outcome === 'fail');
      const unavailable = result.checks.filter(
        (entry: VerificationCheck) => entry.outcome === 'unavailable',
      );
      if (result.verdict === 'resolved') {
        expect(result.checks).toHaveLength(5);
        expect(failing).toHaveLength(0);
        expect(unavailable).toHaveLength(0);
      }
      if (result.verdict === 'unresolved') expect(failing.length).toBeGreaterThan(0);
      if (result.verdict === 'uncertain') {
        expect(unavailable.length).toBeGreaterThan(0);
        expect(failing).toHaveLength(0);
      }
      expectPrefix(result);
    }
  });
});
