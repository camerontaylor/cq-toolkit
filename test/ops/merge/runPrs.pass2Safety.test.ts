// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps the pass-2 safety nets: pass-1 failures and withholds surviving
// a refetch, a retried merge clearing its row, and the fail-closed refetch
// THROW.
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
  draft,
  eligible,
  FakeMergeEffects,
  fakeRefetch,
  fakeResolve,
  MODEL_SPEC,
} from './runPrs.helpers.js';

describe('runMergePrs', () => {
  test('the pass-1 safety net: a refetch that omits a pass-1-failed pr keeps its row', async () => {
    const effects = new FakeMergeEffects();
    effects.mergeFailures.add(44); // 44 fails in pass 1
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed set OMITS 44 entirely (say it was closed after the
    // failure): pass 2 never re-examines it, so its pass-1 failure must
    // not vanish from the union.
    const { refetch } = fakeRefetch([eligible(45)]);

    const outcome = await runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    // Pass 2 re-examined only 45 and merged it.
    expect(outcome.firstPass.failed.map((entry) => entry.pr)).toEqual([44]);
    expect(outcome.secondPass?.merged).toEqual([45]);
    // The pass-1 failure row survives (lowest priority — but nothing
    // supersedes it, because pass 2 never touched 44).
    expect(outcome.needsHuman).toEqual([
      { pr: 44, reason: 'gh pr merge 44 --merge failed (exit 1): refused by the forge' },
    ]);
  });

  test('a pass-1-failed pr that pass 2 retries and MERGES leaves NO needsHuman row', async () => {
    const candidates = [eligible(44), conflicting(45)];
    const effects = new FakeMergeEffects();
    effects.mergeFailOnce.add(44); // the first attempt fails; the retry lands
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'), (input) => {
      const target = candidates.find((candidate) => candidate.pr === input.pr);
      if (target !== undefined) target.mergeState = 'CLEAN';
    });

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // Pass 1 failed 44; pass 2 (no refetch: failed prs are NOT excluded —
    // their in-memory state allows a replan) retried 44 successfully and
    // merged the flipped 45.
    expect(outcome.firstPass.failed.map((entry) => entry.pr)).toEqual([44]);
    expect(outcome.secondPass?.merged).toEqual([44, 45]);
    // Merged in pass 2 wins: the resolved failure leaves no row.
    expect(outcome.needsHuman).toEqual([]);
  });

  test('the pass-1 safety net: a refetch that omits a pass-1-WITHHELD pr keeps its withhold row', async () => {
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed set omits the DRAFT pr 41 (withheld in pass 1 as
    // not_eligible): pass 2 never re-plans it, so its pass-1 withhold row
    // must survive — while 45 (merged in pass 2) suppresses its own.
    const { refetch } = fakeRefetch([eligible(45)]);

    const outcome = await runMergePrs(baseInput([draft(41), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    expect(outcome.firstPass.merged).toEqual([]);
    expect(outcome.secondPass?.merged).toEqual([45]);
    expect(outcome.needsHuman).toEqual([{ pr: 41, reason: 'not_eligible' }]);
  });

  test('refetch THROW fails closed: no re-plan, secondPass null, every acted pr owed a row', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(46, 'pushed 46'));
    // Two acted prs: the failure rows must name EVERY one of them.
    const { resolve: resolveSecond, calls: callsSecond } = fakeResolve(acted(47, 'pushed 47'));
    const bothResolve = async (
      input: ResolveConflictInput,
    ): Promise<OpResult<ConflictResolutionValue>> =>
      input.pr === 46 ? resolve(input) : resolveSecond(input);
    const { refetch, callCount } = fakeRefetch(new Error('forge unreachable'));

    const outcome = await runMergePrs(baseInput([conflicting(46), conflicting(47)], MODEL_SPEC), {
      effects,
      resolve: bothResolve,
      refetch,
    });

    // The resolutions happened and stay recorded as acted.
    expect(outcome.resolutions).toEqual([
      { pr: 46, decision: 'acted', summary: 'pushed 46' },
      { pr: 47, decision: 'acted', summary: 'pushed 47' },
    ]);
    // Fail closed: the seam was tried, pass 2 never ran.
    expect(callCount()).toBe(1);
    expect(outcome.secondPass).toBeNull();
    // Every acted pr is owed a row naming the refresh failure — the
    // resolution happened but re-entry is unproven, never a silent success.
    expect(outcome.needsHuman).toEqual([
      { pr: 46, reason: 'pass-2 refresh failed: forge unreachable' },
      { pr: 47, reason: 'pass-2 refresh failed: forge unreachable' },
    ]);
    expect(outcome.firstPass.merged).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(callsSecond).toHaveLength(1);
  });
});
