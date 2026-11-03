// Split provenance: test/ops/merge/runPrs.test.ts was split by subject; this
// file keeps the pass-2 seam: in-memory vs refetched candidate sets,
// closed-anchoring of pass-1 merges, and retargeted-pr re-entry.
// Shared fixtures live in ./runPrs.helpers.ts (see its header for the
// suite-wide guarantees).
import { describe, expect, test } from 'vitest';
import { headRefFor } from '../../../src/adapters/forge-github/mergeEffects.js';
import { runMergePrs } from '../../../src/ops/merge/runPrs.js';
import {
  acted,
  baseInput,
  conflicting,
  eligible,
  FakeMergeEffects,
  fakeRefetch,
  fakeResolve,
  MODEL_SPEC,
} from './runPrs.helpers.js';

describe('runMergePrs', () => {
  test('conflict → acted, NO refetch seam: pass 2 runs on the in-memory candidates', async () => {
    const candidates = [eligible(44), conflicting(45)];
    const effects = new FakeMergeEffects();
    // No refetch seam: pass 2 classifies the IN-MEMORY candidates, so the
    // caller-side flip of the candidate stands in for the pushed
    // resolution changing reality. Safe, never unsound: executeMerges
    // revalidates live state per action, so stale candidates can only
    // produce skipped-with-reason outcomes — this test pins the in-memory
    // path (the seam path is the next test).
    const { resolve, calls } = fakeResolve(acted(45, 'union merge pushed'), (input) => {
      const target = candidates.find((candidate) => candidate.pr === input.pr);
      if (target !== undefined) target.mergeState = 'CLEAN';
    });

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // Pass 1: only the eligible pr merges; the conflicting one is withheld
    // (consistent with the planner's 'not_eligible' for a DIRTY pr).
    expect(outcome.firstPass.merged).toEqual([44]);
    // The agent was dispatched on exactly the conflicting pr, with the
    // composed input (stack branch names + modelSpec; passthroughs absent
    // when the input omits them).
    expect(calls).toEqual([
      {
        pr: 45,
        repoRoot: '/repo',
        headBranch: 'feat/45',
        baseBranch: 'main',
        modelSpec: MODEL_SPEC,
      },
    ]);
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'acted', summary: 'union merge pushed' },
    ]);
    // Pass 2 ran, re-planned, and the formerly-conflicting pr MERGED there.
    expect(outcome.secondPass).not.toBeNull();
    expect(outcome.secondPass?.merged).toContain(45);
    expect(outcome.needsHuman).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  test('no-refetch pass 2 CLOSED-ANCHORS pass-1 merged prs: 44 never re-merged, 45 still processes', async () => {
    const candidates = [eligible(44), conflicting(45)];
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'), (input) => {
      const target = candidates.find((candidate) => candidate.pr === input.pr);
      if (target !== undefined) target.mergeState = 'CLEAN';
    });

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // mergePr(44) EXACTLY once — pass 1 only. A server-side merge does not
    // delete refs/pull/44/head, so an unguarded pass 2 would re-attempt it
    // (per-action revalidation cannot withhold a merged pr) and fail it
    // into a false needsHuman row.
    const mergeCalls = effects.calls.filter((call) => call.startsWith('merge:'));
    expect(mergeCalls).toEqual(['merge:44:merge', 'merge:45:merge']);
    // 44 re-enters pass 2 as a CLOSED structural row (open row dropped,
    // input row forced closed): the planner never orders it, so the
    // executor never touches it again — exactly its two pass-1 fetches,
    // nothing more.
    const fetch44 = effects.calls.filter((call) => call === `fetch:${headRefFor(44)}`);
    expect(fetch44).toHaveLength(2); // baseline sweep + pass-1 revalidation
    // Pass 2 processed ONLY the flipped pr: 45 merges there; the merged
    // parent is closed structure, not a pass-2 merge candidate.
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.secondPass?.merged).toEqual([45]);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('refetch pass 2 also CLOSED-ANCHORS pass-1 merged prs (a racing fetch cannot resurrect one)', async () => {
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed set still lists pr 44 as OPEN — as if the fetch raced
    // the server-side merge: the open row is dropped and the closed anchor
    // (input row forced closed) is appended instead.
    const { refetch } = fakeRefetch([eligible(44), eligible(45)]);

    const outcome = await runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    const mergeCalls = effects.calls.filter((call) => call.startsWith('merge:'));
    expect(mergeCalls).toEqual(['merge:44:merge', 'merge:45:merge']);
    // The refreshed open row for 44 was dropped: the only fetches of its
    // ref are pass 1's two (the closed anchor is never executed).
    const fetch44 = effects.calls.filter((call) => call === `fetch:${headRefFor(44)}`);
    expect(fetch44).toHaveLength(2);
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.secondPass?.merged).toEqual([45]);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('a merged parent CLOSED-ANCHORS pass 2: a refetch omitting it still lets the stacked child proceed', async () => {
    const effects = new FakeMergeEffects();
    const candidates = [
      eligible(44, { headRefName: 'feat/44' }),
      conflicting(45, { baseRefName: 'feat/44' }),
    ];
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed set OMITS the merged parent 44 — and the child's
    // refreshed row STILL names the old base ('feat/44'). Without the
    // closed anchor, 45's base would resolve to nothing (unresolved_base)
    // and the rung would stall. The anchor (input row forced closed) keeps
    // 44's head resolvable, so plan2 plans 45 as retarget-self onto the
    // trunk — F3's closed-ancestor rule — and it merges in a future run.
    const { refetch, callCount } = fakeRefetch([eligible(45, { baseRefName: 'feat/44' })]);

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    // Pass 1 merged the parent; the resolution acted for the child.
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'acted', summary: 'union merge pushed' },
    ]);
    expect(callCount()).toBe(1);
    // Pass 2: the rung PROCEEDED — 45 was retargeted onto the trunk (the
    // unresolved_base withhold is gone), and the merged parent was never
    // re-merged.
    expect(outcome.secondPass?.retargeted).toEqual([45]);
    expect(effects.calls.filter((call) => call.startsWith('retarget:'))).toEqual([
      'retarget:45:base=main',
    ]);
    const mergeCalls = effects.calls.filter((call) => call.startsWith('merge:'));
    expect(mergeCalls).toEqual(['merge:44:merge']);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('refetch pass 2 RE-ENTERS a retargeted pr whose refreshed row names the new base', async () => {
    const effects = new FakeMergeEffects();
    // pr 43 is a CLOSED rung; pr 44 stacked on it → pass 1 plans 44 as
    // retarget-self (a forge base-edit — the pr stays open) and merges
    // nothing; pr 45 is conflicting and acted.
    const candidates = [
      { ...eligible(43), state: 'closed' as const, headRefName: 'old-rung' },
      eligible(44, { baseRefName: 'old-rung' }),
      conflicting(45),
    ];
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed forge view: 44's base is NOW the trunk (the retarget
    // moved it) and 45 is CLEAN — so pass 2 replans 44 as an ordinary root
    // (F3's retarget-self contract) and merges both.
    const { refetch, callCount } = fakeRefetch([eligible(44), eligible(45)]);

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    // Pass 1: the retarget-self base-edit ran once; nothing merged (45 was
    // conflicting).
    expect(outcome.firstPass.retargeted).toEqual([44]);
    expect(outcome.firstPass.merged).toEqual([]);
    expect(effects.calls.filter((call) => call.startsWith('retarget:'))).toEqual([
      'retarget:44:base=main',
    ]);
    expect(callCount()).toBe(1);
    // Pass 2 re-planned the retargeted pr from its refreshed row and
    // merged BOTH.
    expect(outcome.secondPass).not.toBeNull();
    expect(outcome.secondPass?.merged).toEqual([44, 45]);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('no-refetch pass 2 EXCLUDES a retargeted pr (its in-memory row names the stale old base)', async () => {
    const candidates = [
      { ...eligible(43), state: 'closed' as const, headRefName: 'old-rung' },
      eligible(44, { baseRefName: 'old-rung' }),
      conflicting(45),
    ];
    const effects = new FakeMergeEffects();
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'), (input) => {
      const target = candidates.find((candidate) => candidate.pr === input.pr);
      if (target !== undefined) target.mergeState = 'CLEAN';
    });

    const outcome = await runMergePrs(baseInput(candidates, MODEL_SPEC), { effects, resolve });

    // Pass 1: the retarget-self edit ran exactly once.
    expect(outcome.firstPass.retargeted).toEqual([44]);
    expect(effects.calls.filter((call) => call.startsWith('retarget:'))).toEqual([
      'retarget:44:base=main',
    ]);
    // Pass 2 (in-memory) excludes the retargeted pr — its row still names
    // the OLD base — so it is NOT re-retargeted and NOT re-processed; only
    // the flipped 45 merges.
    expect(effects.calls.filter((call) => call.startsWith('retarget:'))).toHaveLength(1);
    expect(outcome.secondPass?.merged).toEqual([45]);
    expect(outcome.needsHuman).toEqual([]);
  });

  test('conflict → acted WITH refetch: pass 2 classifies the REFRESHED set and merges there', async () => {
    const effects = new FakeMergeEffects();
    // The resolve fake does NOT touch the candidates: the in-memory
    // snapshot stays stale (still DIRTY) exactly as it would in production
    // — the pushed resolution lives on the remote.
    const { resolve } = fakeResolve(acted(45, 'union merge pushed'));
    // The refreshed forge view: the formerly-DIRTY pr arrives CLEAN (and a
    // merged/closed pr could be omitted entirely — same shape, fewer rows).
    const { refetch, callCount } = fakeRefetch([eligible(44), eligible(45)]);

    const outcome = await runMergePrs(baseInput([eligible(44), conflicting(45)], MODEL_SPEC), {
      effects,
      resolve,
      refetch,
    });

    // Pass 1: only the eligible pr merges; the conflicting one is withheld.
    expect(outcome.firstPass.merged).toEqual([44]);
    expect(outcome.resolutions).toEqual([
      { pr: 45, decision: 'acted', summary: 'union merge pushed' },
    ]);
    // The seam earned its keep: invoked exactly once, and pass 2 — planned
    // from the REFRESHED set — merges the formerly-conflicting pr.
    expect(callCount()).toBe(1);
    expect(outcome.secondPass).not.toBeNull();
    expect(outcome.secondPass?.merged).toContain(45);
    expect(outcome.needsHuman).toEqual([]);
  });
});
