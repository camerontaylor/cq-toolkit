// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps escalation: the model gate, policy-disabled conflicts, and
// failed/indeterminate/budget-exhausted resolve verdicts.
// Shared fixtures live in ./runPrs.helpers.ts (see its header for the
// suite-wide guarantees).
import { describe, expect, test } from 'vitest';
import { MODEL_SPEC_REQUIRED_REASON, runMergePrs } from '../../../src/ops/merge/runPrs.js';
import {
  acted,
  baseInput,
  conflicting,
  eligible,
  escalated,
  FakeMergeEffects,
  fakeResolve,
  MODEL_SPEC,
  resolveFailed,
} from './runPrs.helpers.js';

describe('runMergePrs', () => {
  test('conflict → escalate: needs-human row with the summary; NO second pass; never merged', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(escalated('a human must reconcile the semantics'));

    const outcome = await runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
    });

    // The decision is carried verbatim; nothing is re-guessed.
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'escalate', summary: 'a human must reconcile the semantics' },
    ]);
    // A non-acted outcome earns NO second pass.
    expect(outcome.secondPass).toBeNull();
    // The escalation is the union row (priority: escalation first — it
    // outranks the planner's 'not_eligible' for the same pr), and the pr
    // is in NO merged bucket.
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'a human must reconcile the semantics' },
    ]);
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.secondPass?.merged).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  test('conflicts + modelSpec absent: needsHuman rows name modelSpec; resolve NEVER called', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(45));

    const outcome = await runMergePrs(baseInput([conflicting(44), conflicting(45)]), {
      effects,
      resolve,
    });

    expect(outcome.secondPass).toBeNull();
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([
      { pr: 44, reason: MODEL_SPEC_REQUIRED_REASON },
      { pr: 45, reason: MODEL_SPEC_REQUIRED_REASON },
    ]);
    expect(calls).toEqual([]);
  });

  test('conflict policy-disabled reason is explicit and never dispatches the resolver', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(45));
    const input = { ...baseInput([conflicting(45)]), conflictResolutionDisabled: true };
    const outcome = await runMergePrs(input, { effects, resolve });
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'conflict resolution disabled by self-host policy — needs human' },
    ]);
    expect(outcome.resolutions).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('conflictResolutionDisabled wins over a supplied modelSpec on the library path', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(45));
    const input = {
      ...baseInput([conflicting(45)], MODEL_SPEC),
      conflictResolutionDisabled: true,
    };
    const outcome = await runMergePrs(input, { effects, resolve });
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'conflict resolution disabled by self-host policy — needs human' },
    ]);
    expect(outcome.resolutions).toEqual([]);
    expect(calls).toEqual([]);
  });

  test('conflict → failed resolve: escalate with the did-not-complete prefix; NO second pass', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(resolveFailed('worktree add exploded'));

    const outcome = await runMergePrs(baseInput([conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
    });

    expect(outcome.resolutions).toEqual([
      {
        pr: 45,
        decision: 'escalate',
        summary: 'conflict agent did not complete: worktree add exploded',
      },
    ]);
    expect(outcome.secondPass).toBeNull();
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'conflict agent did not complete: worktree add exploded' },
    ]);
    expect(calls).toHaveLength(1);
  });

  test('indeterminate and budget-exhausted verdicts escalate too (never silent, never guessed)', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve({
      status: 'indeterminate',
      detail: 'worker lost mid-run',
    });

    const indeterminate = await runMergePrs(baseInput([conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
    });
    expect(indeterminate.resolutions).toEqual([
      {
        pr: 45,
        decision: 'escalate',
        summary: 'conflict agent did not complete: worker lost mid-run',
      },
    ]);

    const { resolve: resolveBudget, calls: budgetCalls } = fakeResolve({
      status: 'budget-exhausted',
    });
    const budget = await runMergePrs(baseInput([conflicting(46)], MODEL_SPEC), {
      effects,
      resolve: resolveBudget,
    });
    expect(budget.resolutions).toEqual([
      {
        pr: 46,
        decision: 'escalate',
        summary: 'conflict agent did not complete: the conflict agent hit its budget bound',
      },
    ]);
    // Neither verdict earned a second pass.
    expect(indeterminate.secondPass).toBeNull();
    expect(budget.secondPass).toBeNull();
    expect(calls).toHaveLength(1);
    expect(budgetCalls).toHaveLength(1);
  });
});
