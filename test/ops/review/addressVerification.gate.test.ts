// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import { verifyClosureEvidence } from '../../../src/ops/review/internal/addressVerification.js';
import { makePacket, namesOf, outcomesOf } from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('cancellation before the first check carries the gate message', () => {
    const result = verifyClosureEvidence(makePacket(), {
      admit: () => {
        throw new Error('cancelled by parent');
      },
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('cancelled by parent');
    expect(result.checks).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      check: 'packet-complete',
      outcome: 'unavailable',
      detail: 'cancelled by parent',
      reason: 'cancelled by parent',
    });
  });

  test('budget exhaustion mid-sequence keeps the passed prefix and stops', () => {
    let calls = 0;
    const result = verifyClosureEvidence(makePacket(), {
      admit: () => {
        calls++;
        if (calls > 2) throw new Error('budget exhausted');
      },
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('budget exhausted');
    expect(namesOf(result)).toEqual(['packet-complete', 'revision-pinned', 'patch-coherent']);
    expect(outcomesOf(result)).toEqual(['pass', 'pass', 'unavailable']);
  });

  test('a non-error gate refusal is still uncertain', () => {
    const result = verifyClosureEvidence(makePacket(), {
      admit: () => {
        throw 'halt';
      },
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('verification gate refused');
    expect(result.checks[0]?.detail).toBe('halt');
  });

  test.each(['toPrimitive', 'toString'] as const)(
    'hostile %s coercion stays uncertain across gate and evidence catch paths',
    (hook) => {
      const thrown: unknown =
        hook === 'toPrimitive'
          ? {
              [Symbol.toPrimitive]() {
                throw new Error('coercion failed');
              },
            }
          : {
              toString() {
                throw new Error('coercion failed');
              },
            };
      const gate = verifyClosureEvidence(makePacket(), {
        admit: () => {
          throw thrown;
        },
      });
      expect(gate.verdict).toBe('uncertain');
      expect(gate.reason).toBe('verification gate refused');
      expect(gate.checks).toEqual([
        {
          check: 'packet-complete',
          outcome: 'unavailable',
          detail: 'verification diagnostic unavailable',
          reason: 'verification gate refused',
        },
      ]);
      for (const field of ['finding', 'dependencies'] as const) {
        const packet = makePacket();
        Object.defineProperty(packet, field, {
          get() {
            throw thrown;
          },
        });
        const evidence = verifyClosureEvidence(packet);
        expect(evidence.verdict).toBe('uncertain');
        expect(evidence.reason).toBe('unavailable-evidence');
        expect(namesOf(evidence)).toEqual(['packet-complete']);
        expect(evidence.checks[0]?.detail).toContain('verification diagnostic unavailable');
      }
    },
  );

  test('an Error diagnostic is captured once and hostile message reads are contained', () => {
    const changing = new Error('initial');
    let reads = 0;
    Object.defineProperty(changing, 'message', {
      get() {
        reads++;
        if (reads > 1) throw new Error('message withdrawn');
        return 'cancelled once';
      },
    });
    const result = verifyClosureEvidence(makePacket(), {
      admit: () => {
        throw changing;
      },
    });
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('cancelled once');
    expect(result.checks[0]?.detail).toBe('cancelled once');
    expect(reads).toBe(1);
    const unavailable = verifyClosureEvidence(makePacket(), {
      admit: () => {
        throw changing;
      },
    });
    expect(unavailable.verdict).toBe('uncertain');
    expect(unavailable.reason).toBe('verification gate refused');
    expect(unavailable.checks[0]?.detail).toBe('verification diagnostic unavailable');
  });
});
