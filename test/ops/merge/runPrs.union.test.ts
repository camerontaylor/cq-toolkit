// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps the needs-human union (escalation + planner + execution rows,
// pr-sorted and deduped) and the determinism pin.
// Shared fixtures live in ./runPrs.helpers.ts (see its header for the
// suite-wide guarantees).
import { describe, expect, test } from 'vitest';
import { headRefFor } from '../../../src/adapters/forge-github/mergeEffects.js';
import { runMergePrs } from '../../../src/ops/merge/runPrs.js';
import {
  acted,
  baseInput,
  conflicting,
  draft,
  eligible,
  escalated,
  FakeMergeEffects,
  fakeResolve,
  MODEL_SPEC,
} from './runPrs.helpers.js';

describe('runMergePrs', () => {
  test('the needs-human union: escalation + planner + stale + failed + blocked, pr-sorted, deduped', async () => {
    const effects = new FakeMergeEffects();
    effects.mergeFailures.add(44); // the eligible root's merge is refused
    effects.driftRefs.add(headRefFor(48)); // 48's head moves after the baseline → stale
    // The GENERALIZED #153 shape (PR #234 r1): a failed merge can only
    // orphan a child when the failing entry is itself a stacked merge —
    // and the generalized planner no longer orders such a child at all.
    // So the executor's blocked leg is driven by a failed RETARGET here:
    // 50 is a retarget-self root (its rung 49 closed), its retarget is
    // refused, 51 (its plan-ordered depth-1 child) blocks on the failed
    // ancestor, and 52 — which the pre-generalization planner ORDERED
    // into 51's would-be-orphaned branch — is withheld at plan time
    // (stack_base_merging_this_pass): 51 merges earlier in the pass, so
    // merging 52 into 51's branch would strand it off the trunk.
    effects.retargetFailures.add(50);
    const { resolve, calls } = fakeResolve(escalated('a human must reconcile the semantics'));

    const outcome = await runMergePrs(
      baseInput(
        [
          draft(41),
          eligible(44),
          // 44's child: 44 is a same-pass merge root, so the planner
          // defers 47 (stack_base_merging_this_pass) instead of ordering
          // it into 44's soon-to-be-orphaned branch (review-debt #153).
          eligible(47, { baseRefName: 'feat/44' }),
          conflicting(45),
          eligible(48),
          { ...eligible(49), state: 'closed' as const, headRefName: 'gone-49' },
          eligible(50, { baseRefName: 'gone-49' }),
          eligible(51, { baseRefName: 'feat/50' }),
          eligible(52, { baseRefName: 'feat/51' }),
        ],
        MODEL_SPEC,
      ),
      {
        effects,
        resolve,
      },
    );

    // No second pass: nothing acted.
    expect(outcome.secondPass).toBeNull();
    expect(outcome.firstPass.merged).toEqual([]);
    // The execution buckets: 44 failed, 48 stale (drift), 50's retarget
    // failed, and 51 blocked by its failed ancestor. 47 AND 52 never
    // reached execution — the generalized planner withheld both
    // (#153: 47's base is a same-pass merge root; 52's base 51 merges
    // earlier in the pass under retarget-self root 50).
    expect(outcome.firstPass.failed.map((entry) => entry.pr)).toEqual([44, 50]);
    expect(outcome.firstPass.stale.map((entry) => entry.pr)).toEqual([48]);
    expect(outcome.firstPass.blocked.map((entry) => entry.pr)).toEqual([51]);
    // Dedupe + priority pinned on pr 45: it is BOTH an escalation AND a
    // planner withhold ('not_eligible' — it is conflicting) — the decided
    // escalation's summary wins, the planner's gate reason does not.
    expect(outcome.needsHuman.map((row) => row.pr)).toEqual([41, 44, 45, 47, 48, 50, 51, 52]);
    const reasonOf = (pr: number): string => {
      const row = outcome.needsHuman.find((candidate) => candidate.pr === pr);
      if (row === undefined) throw new Error(`no needsHuman row for pr ${String(pr)}`);
      return row.reason;
    };
    expect(reasonOf(41)).toBe('not_eligible');
    expect(reasonOf(44)).toBe('gh pr merge 44 --merge failed (exit 1): refused by the forge');
    expect(reasonOf(45)).toBe('a human must reconcile the semantics');
    expect(reasonOf(47)).toBe('stack_base_merging_this_pass');
    // The stale row carries the drift detail (baseline sha vs moved sha).
    expect(reasonOf(48)).toContain('head moved between plan and run');
    expect(reasonOf(50)).toBe('gh pr edit 50 --base main failed (exit 1): refused by the forge');
    expect(reasonOf(51)).toBe('blocked_by_ancestor');
    expect(reasonOf(52)).toBe('stack_base_merging_this_pass');
    // The final report is pass 1, so its post-mortem names all four
    // execution outcomes.
    expect(outcome.diagnosis.needsHuman).toEqual([44, 48, 50, 51]);
    expect(calls).toHaveLength(1);
  });

  test('determinism: same input + same nowMs → deep-equal outcome (acted, unflipped data)', async () => {
    const run = async (): Promise<unknown> => {
      const effects = new FakeMergeEffects();
      const { resolve } = fakeResolve(acted(45));
      return runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
        effects,
        resolve,
      });
    };

    const first = await run();
    const second = await run();
    expect(second).toEqual(first);
    // And the shape is the honest one for a claimed-but-unobserved flip:
    // the agent acted, the second pass ran on the guarded set (the
    // pass-1-merged pr 44 is excluded, so it is not re-merged), the data
    // still says DIRTY for 45, so the final plan withholds the pr and the
    // union carries it.
    const outcome = (await run()) as Awaited<ReturnType<typeof runMergePrs>>;
    expect(outcome.secondPass).not.toBeNull();
    expect(outcome.secondPass?.merged).toEqual([]);
    expect(outcome.needsHuman).toEqual([{ pr: 45, reason: 'not_eligible' }]);
  });
});
