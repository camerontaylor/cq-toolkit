// Split provenance: test/ops/review/addressVerification.test.ts was split into
// addressVerification.*.test.ts subject files.
import { describe, expect, test } from 'vitest';
import {
  verifyClosureEvidence,
  type CitedDependency,
} from '../../../src/ops/review/internal/addressVerification.js';
import { makePacket, namesOf } from './addressVerification.helpers.js';

describe('review.address closure evidence verifier', () => {
  test('a getter yielding different dependencies per read scans one snapshot', () => {
    // First read (validation) must be the only read: the mutating getter
    // serves a clean consumer first and the surviving trigger afterwards.
    const mutating = makePacket();
    let reads = 0;
    Object.defineProperty(mutating, 'dependencies', {
      get() {
        reads++;
        return reads === 1
          ? [
              {
                path: 'src/clean.ts',
                role: 'consumer',
                text: "load('{}');\n",
              },
            ]
          : [
              {
                path: 'src/legacy.ts',
                role: 'consumer',
                text: "if (mode === 'PARTIAL_MODE') load(raw);\n",
              },
            ];
      },
    });
    const result = verifyClosureEvidence(mutating);
    expect(result.verdict).toBe('resolved');
    expect(result.checks[0]?.detail).toContain('1 dependencies captured');
    expect(reads).toBe(1);
  });

  test('a getter turning dependencies hostile after validation cannot crash later checks', () => {
    // Validation captured the record; the getter then poisons the property.
    // Later checks must still scan the captured snapshot deterministically.
    const hostile = makePacket();
    let reads = 0;
    Object.defineProperty(hostile, 'dependencies', {
      get() {
        reads++;
        if (reads === 1)
          return [
            {
              path: 'src/clean.ts',
              role: 'consumer',
              text: "load('{}');\n",
            },
          ];
        throw new Error('dependencies withdrawn');
      },
    });
    const result = verifyClosureEvidence(hostile);
    expect(result.verdict).toBe('resolved');
    expect(result.checks[0]?.detail).toContain('1 dependencies captured');
    expect(reads).toBe(1);
  });

  test('a later-slot mutation attempt is rejected uncertain, snapshot unaffected', () => {
    // Original relay repro, under the stable-data contract: the FIRST
    // record's path getter attempts to replace the later trigger slot while
    // it is being read. Accessor-backed records are rejected without ever
    // invoking their getters, so the getter must never run, the later slot
    // must remain unchanged, and the packet is uncertain at packet-complete
    // (accessor-backed evidence is not trusted evidence).
    const clean: CitedDependency = {
      path: 'src/clean.ts',
      role: 'consumer',
      text: "load('{}');\n",
    };
    const surviving: CitedDependency = {
      path: 'src/legacy.ts',
      role: 'consumer',
      text: "if (mode === 'PARTIAL_MODE') load(raw);\n",
    };
    const supplied: CitedDependency[] = [clean, surviving];
    let getterInvoked = false;
    const first: CitedDependency = {
      get path() {
        getterInvoked = true;
        supplied[1] = clean;
        return 'src/clean.ts';
      },
      role: 'consumer',
      text: "load('{}');\n",
    };
    supplied[0] = first;
    const mutated = makePacket({ dependencies: supplied });
    const result = verifyClosureEvidence(mutated);
    expect(result.verdict).toBe('uncertain');
    expect(result.reason).toBe('unavailable-evidence');
    expect(namesOf(result)).toEqual(['packet-complete']);
    expect(result.checks[0]?.detail).toContain('accessor-backed');
    expect(getterInvoked).toBe(false);
    expect(supplied[1]).toBe(surviving);
  });
});
