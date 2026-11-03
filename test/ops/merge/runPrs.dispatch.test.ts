// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps the composition boundary and dispatch input: the candidate-base
// rule, duplicate-row refusal, hostile refname screening, and resolve-input
// passthroughs.
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
  eligible,
  FakeMergeEffects,
  fakeResolve,
  MODEL_SPEC,
} from './runPrs.helpers.js';

describe('runMergePrs', () => {
  test('the resolve input carries the CANDIDATE base: stacked vs root', async () => {
    const effects = new FakeMergeEffects();
    // pr 43: root on 'main' (its head is the stack's parent branch);
    // pr 45: stacked ON that parent branch — its conflict is against
    // 'b-parent', not the trunk; pr 46: an ordinary conflicting root.
    const candidates = [
      eligible(43, { headRefName: 'b-parent' }),
      conflicting(45, { baseRefName: 'b-parent' }),
      conflicting(46),
    ];
    const calls: ResolveConflictInput[] = [];
    const resolve = async (
      input: ResolveConflictInput,
    ): Promise<OpResult<ConflictResolutionValue>> => {
      calls.push(input);
      return acted(input.pr, `pushed ${String(input.pr)}`);
    };

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // The dispatch base is each candidate's OWN baseRefName: the stacked
    // pr resolves against 'b-parent' (its parent's head branch), the root
    // against input.baseBranch ('main' — a root's baseRefName IS the base
    // branch, so roots are unchanged by the candidate-base rule).
    expect(calls.map((call) => ({ pr: call.pr, baseBranch: call.baseBranch }))).toEqual([
      { pr: 45, baseBranch: 'b-parent' },
      { pr: 46, baseBranch: 'main' },
    ]);
    expect(calls[0]).toEqual({
      pr: 45,
      repoRoot: '/repo',
      headBranch: 'feat/45',
      baseBranch: 'b-parent',
      modelSpec: MODEL_SPEC,
    });
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'acted', summary: 'pushed 45' },
      { pr: 46, decision: 'acted', summary: 'pushed 46' },
    ]);
    // Pass 1 merged the eligible parent; pass 2 (guarded) excluded it and
    // the two unflipped conflicts re-withheld — the honest no-refetch
    // outcome for a claimed-but-unobserved flip.
    expect(outcome.firstPass.merged).toEqual([43]);
    expect(outcome.secondPass?.merged).toEqual([]);
    expect(outcome.needsHuman).toEqual([
      { pr: 45, reason: 'not_eligible' },
      { pr: 46, reason: 'not_eligible' },
    ]);
  });

  test('duplicate conflicting rows are refused ENTIRELY: zero dispatches, one escalation row', async () => {
    const effects = new FakeMergeEffects();
    // The same pr twice with DIVERGENT head refs — the fetch layer cannot
    // say which row is real, so a write-capable resolver is never
    // dispatched on arbitrary metadata (the planner's duplicate_pr gate
    // refuses the merge for the same reason).
    const candidates = [
      conflicting(45, { headRefName: 'feat/45' }),
      conflicting(45, { headRefName: 'feat/45-typo' }),
    ];
    const { resolve, calls } = fakeResolve(acted(45, 'pushed once'));

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    expect(calls).toEqual([]);
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([
      {
        pr: 45,
        reason: 'duplicate candidate rows for pr 45 — refusing to dispatch the conflict agent',
      },
    ]);
  });

  test('duplicate rows count over the COMPLETE candidate set: a conflicting+eligible pair is refused', async () => {
    const effects = new FakeMergeEffects();
    // pr 45: one CONFLICTING row + one ELIGIBLE row — the ambiguity is in
    // the FETCH, not the classification, so a mixed pair is refused
    // exactly like a double-conflicting pair (counting conflicting rows
    // alone would miss it and dispatch a write-capable resolver anyway).
    // pr 46 appears once and still dispatches.
    const candidates = [
      conflicting(45, { headRefName: 'feat/45' }),
      eligible(45, { headRefName: 'feat/45-other' }),
      conflicting(46),
    ];
    const { resolve, calls } = fakeResolve(acted(46, 'pushed 46'), (input) => {
      const target = candidates.find((candidate) => candidate.pr === input.pr);
      if (target !== undefined) target.mergeState = 'CLEAN';
    });

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // Zero dispatches for the ambiguous pr; the once-listed pr dispatched.
    expect(calls).toEqual([
      {
        pr: 46,
        repoRoot: '/repo',
        headBranch: 'feat/46',
        baseBranch: 'main',
        modelSpec: MODEL_SPEC,
      },
    ]);
    expect(outcome.resolutions).toEqual([{ pr: 46, decision: 'acted', summary: 'pushed 46' }]);
    // Pass 2 (no refetch): 46 flipped CLEAN and merges; the duplicate 45
    // rows are withheld duplicate_pr by the planner. The refusal row wins
    // (escalation priority, first reason).
    expect(outcome.secondPass?.merged).toEqual([46]);
    expect(outcome.needsHuman).toEqual([
      {
        pr: 45,
        reason: 'duplicate candidate rows for pr 45 — refusing to dispatch the conflict agent',
      },
    ]);
  });

  test('a hostile candidate refname is refused at the composition boundary (library path)', async () => {
    const effects = new FakeMergeEffects();
    // The LIBRARY path has no schema gate (deps.resolve is injected
    // directly), so the composition screens both branch fields of every
    // conflicting candidate before dispatch — first failing field wins.
    const candidates = [
      conflicting(45, { headRefName: 'topic$(touch x)' }),
      conflicting(46, { baseRefName: 'a b' }),
    ];
    const { resolve, calls } = fakeResolve(acted(45, 'pushed'));

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // Zero dispatches; each hostile refname goes to needsHuman naming the
    // failing field and value.
    expect(calls).toEqual([]);
    expect(outcome.resolutions).toEqual([]);
    expect(outcome.needsHuman).toEqual([
      {
        pr: 45,
        reason: 'branch name fails the conservative refname gate: headRefName=topic$(touch x)',
      },
      { pr: 46, reason: 'branch name fails the conservative refname gate: baseRefName=a b' },
    ]);
  });
  test('resolve passthroughs (protectedBranch/wallClockMs) ride the resolve input', async () => {
    const effects = new FakeMergeEffects();
    const { resolve, calls } = fakeResolve(acted(45));
    const outcome = await runMergePrs(
      {
        ...baseInput([conflicting(45)], MODEL_SPEC),
        protectedBranch: 'trunk',
        wallClockMs: 1234,
      },
      { effects, resolve },
    );

    expect(outcome.resolutions).toHaveLength(1);
    expect(calls[0]).toEqual({
      pr: 45,
      repoRoot: '/repo',
      headBranch: 'feat/45',
      baseBranch: 'main',
      modelSpec: MODEL_SPEC,
      protectedBranch: 'trunk',
      wallClockMs: 1234,
    });
  });
});
