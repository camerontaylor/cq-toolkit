// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import { verifyClosureEvidence } from '../../../src/ops/review/internal/addressVerification.js';
import { makePacket, namesOf } from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('a one-shot iterable dependencies value is unavailable, never resolved', () => {
    // A generator (or any one-shot iterable) would be exhausted by the first
    // pass, leaving later checks with an empty scan and minting false
    // closure. The declared contract is a real array; anything else is
    // unavailable evidence.
    const oneShot = makePacket();
    const iterable = {
      *[Symbol.iterator]() {
        yield {
          path: 'src/legacy.ts',
          role: 'consumer',
          text: "if (mode === 'PARTIAL_MODE') load(raw);\n",
        };
      },
    };
    (oneShot as { dependencies: unknown }).dependencies = iterable;
    const result = verifyClosureEvidence(oneShot);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('not an array');
  });

  test('an element text getter read during validation then clean must stay unresolved', () => {
    // Contract update: getter-backed evidence is not trusted evidence. The
    // element's text field is an accessor, so the record is rejected as
    // unavailable rather than resolved on either read. Closure never rests
    // on values a host can swap between reads.
    const split = makePacket();
    let reads = 0;
    const element = {
      path: 'src/legacy.ts',
      role: 'consumer',
      get text() {
        reads++;
        return reads === 1 ? "if (mode === 'PARTIAL_MODE') load(raw);\n" : "load('{}');\n";
      },
    };
    (split as { dependencies: unknown }).dependencies = [element];
    const result = verifyClosureEvidence(split);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('accessor-backed');
  });

  test('an element field getter that throws during capture yields uncertain', () => {
    const throwing = makePacket();
    const element = {
      path: 'src/x.ts',
      role: 'consumer',
      get text() {
        throw new Error('text storage failed');
      },
    };
    (throwing as { dependencies: unknown }).dependencies = [element];
    const result = verifyClosureEvidence(throwing);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('accessor-backed');
  });

  test('an accessor-backed array slot is rejected as unavailable', () => {
    const packet = makePacket();
    const slots: unknown[] = [];
    Object.defineProperty(slots, 0, {
      get() {
        return { path: 'src/clean.ts', role: 'consumer', text: "load('{}');\n" };
      },
    });
    (packet as { dependencies: unknown }).dependencies = slots;
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('slot 0 is accessor-backed');
  });

  test('non-object dependency elements are unavailable, not crashes', () => {
    const packet = makePacket();
    (packet as { dependencies: unknown }).dependencies = ['a string', 42, null];
    const result = verifyClosureEvidence(packet);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(result.checks[0]?.detail).toContain('dependency is not an object');
  });

  test('a check-side storage failure degrades to unavailable evidence', () => {
    const hostile = makePacket();
    Object.defineProperty(hostile, 'dependencies', {
      get() {
        throw new Error('storage unavailable');
      },
    });
    const result = verifyClosureEvidence(hostile);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('storage unavailable');
  });
});
