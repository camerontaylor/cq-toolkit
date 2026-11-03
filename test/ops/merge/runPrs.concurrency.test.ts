// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps bounded resolution concurrency and the resolveConcurrency
// caller-error guard.
// Shared fixtures live in ./runPrs.helpers.ts (see its header for the
// suite-wide guarantees).
import { describe, expect, test } from 'vitest';
import type { OpResult } from '../../../src/kernel/types.js';
import { runMergePrs } from '../../../src/ops/merge/runPrs.js';
import type {
  ConflictResolutionValue,
  ResolveConflictInput,
} from '../../../src/ops/merge/resolveConflict.js';
import {
  acted,
  baseInput,
  conflicting,
  FakeMergeEffects,
  fakeResolve,
  MODEL_SPEC,
} from './runPrs.helpers.js';

describe('runMergePrs', () => {
  test('bounded concurrency: 3 conflicts, resolveConcurrency 2 → max 2 in flight, all resolved', async () => {
    const effects = new FakeMergeEffects();
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: ResolveConflictInput[] = [];
    const resolve = async (
      input: ResolveConflictInput,
    ): Promise<OpResult<ConflictResolutionValue>> => {
      calls.push(input);
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A real (in-process) tick: without the p-limit cap all three would
      // overlap; with it, the third waits for a slot.
      await new Promise<void>((tick) => {
        setTimeout(tick, 10);
      });
      inFlight -= 1;
      return acted(input.pr);
    };

    const outcome = await runMergePrs(
      {
        ...baseInput([conflicting(46), conflicting(47), conflicting(48)], MODEL_SPEC),
        resolveConcurrency: 2,
      },
      { effects, resolve },
    );

    expect(calls).toHaveLength(3);
    expect(maxInFlight).toBe(2);
    expect(outcome.resolutions.map((resolution) => resolution.pr)).toEqual([46, 47, 48]);
  });

  test('resolveConcurrency < 1 is a loud caller error', async () => {
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45));
    await expect(
      runMergePrs(
        { ...baseInput([conflicting(45)], MODEL_SPEC), resolveConcurrency: 0 },
        { effects, resolve },
      ),
    ).rejects.toThrow('resolveConcurrency');
  });
});
