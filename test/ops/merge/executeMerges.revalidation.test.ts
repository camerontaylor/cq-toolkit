// Split from test/ops/merge/executeMerges.test.ts (F3): revalidation —
// (a) head drift skipped, never merged; (g) forge base-ref re-read (#193).
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import { executeMerges } from '../../../src/ops/merge/executeMerges.js';
import {
  entry,
  FakeMergeEffects,
  handPlan,
  mergeCalls,
  rootChildPlan,
  sha,
} from './executeMerges.helpers.js';

describe('executeMerges — (a) live-state revalidation: drift is skipped, never merged', () => {
  test('a head that moved between plan and run → stale, no worktree, no merge', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.driftSha = sha('b'); // every validation after the baseline sees the moved head
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('moved between plan and run') },
    ]);
    expect(report.failed).toEqual([]);
    // The exact calls prove it: baseline fetch → baseline (sha a) → action
    // fetch → revalidate (sha b ≠ a) → skipped. No prepare, no merge, no
    // remove.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
    ]);
  });

  test('a miss the baseline fetch CURES is not stale — the pr proceeds to merge (CR-4)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.headsBehindFetch.add(7); // fresh clone: nothing local until fetched

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([7]);
    expect(report.stale).toEqual([]);
    // The sweep fetched BEFORE validating, so the baseline saw the cured
    // sha and the action ran normally (server-side merge — no worktree).
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'readBase:7',
      'merge:7:merge',
    ]);
  });

  test('a head unresolvable even AFTER its baseline fetch → stale before any action', async () => {
    const fake = new FakeMergeEffects(); // heads map empty: the ref is gone upstream too
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });
    expect(report.stale).toEqual([
      { pr: 7, detail: 'head ref unresolvable when execution started' },
    ]);
    // The fetch was attempted first; the miss that survived it is genuine.
    expect(fake.calls).toEqual(['fetch:refs/pull/7/head', 'validate:refs/pull/7/head']);
  });

  test('a fetch throw at the baseline fails the run wholesale — total report, nothing executed', async () => {
    const fake = new FakeMergeEffects();
    fake.fetchThrows = new Error('network down');
    const plan = handPlan([entry(7), entry(8)]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report).toEqual({
      merged: [],
      retargeted: [],
      stale: [],
      failed: [
        {
          pr: 7,
          error: match.stringContaining(
            'baseline sweep aborted during fetchRef (first failure at pr 7): network down',
          ),
        },
        {
          pr: 8,
          error: match.stringContaining(
            'baseline sweep aborted during fetchRef (first failure at pr 7): network down',
          ),
        },
      ],
      blocked: [],
    });
    expect(fake.calls).toEqual(['fetch:refs/pull/7/head']); // first fetch threw; run over
  });

  test('a stale ancestor blocks its descendants (rule c cascade, zero calls on them)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    fake.driftSha = sha('c');
    const plan = rootChildPlan(7, 8, 'feat-7');

    const report = await executeMerges({ plan, effects: fake });

    expect(report.stale).toEqual([{ pr: 7, detail: match.any(String) }]);
    expect(report.blocked).toEqual([{ pr: 8, reason: 'blocked_by_ancestor' }]);
    expect(report.merged).toEqual([]);
    // Pr 8 was NEVER executed: the sweep fetched + validated its head
    // (2 calls) and the blocked action added nothing.
    expect(fake.calls.filter((call) => call.includes('pull/8')).length).toBe(2);
    expect(fake.calls.includes('prepare:8@refs/pull/8/head')).toBe(false);
  });
});

describe('executeMerges — (g) forge base-ref re-read (#193): a retarget is skipped, never merged', () => {
  test('a base that MOVED between plan and run → stale, never merged', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.baseRefs.set(7, 'release'); // the forge now targets a different base
    const report = await executeMerges({
      plan: handPlan([entry(7, 'merge', null, 0, 'main')]),
      effects: fake,
    });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 7, detail: match.stringContaining('base moved between plan and run') },
    ]);
    expect(mergeCalls(fake)).toEqual([]);
    // The read happened AFTER the head revalidation and BEFORE any merge.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'readBase:7',
    ]);
  });

  test('an UNCHANGED base → merged (the re-read is a gate, not a blocker)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.baseRefs.set(7, 'feat-7'); // the plan expected 'feat-7' too
    const report = await executeMerges({
      plan: handPlan([entry(7, 'merge', null, 0, 'feat-7')]),
      effects: fake,
    });

    expect(report.merged).toEqual([7]);
    expect(report.stale).toEqual([]);
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']);
  });

  test('an OMITTED entry base defaults to the plan baseBranch (the root case)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    // No entry.baseRefName: the executor compares against plan.baseBranch.
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });
    expect(report.merged).toEqual([7]);
  });

  test('a read that answers { ok: false } → failed, never merged', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.baseReadFailures.add(7);
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('readBaseRef for pr 7 unavailable') },
    ]);
    expect(mergeCalls(fake)).toEqual([]);
  });

  test('a seam that answers { ok: true } with a NON-string base → failed (the guard does not trust the type)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.baseReadNonString = true;
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('readBaseRef for pr 7 unavailable') },
    ]);
    expect(mergeCalls(fake)).toEqual([]);
  });

  test('a read that THROWS → failed (fail closed), never merged', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.baseReadThrows = new Error('gh pr view exploded');
    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.merged).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('readBaseRef for pr 7 threw: gh pr view exploded') },
    ]);
    expect(mergeCalls(fake)).toEqual([]);
  });

  test('a moved base on a stacked child → stale; the parent still merged', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    fake.baseRefs.set(8, 'main'); // the child was retargeted to the trunk after planning
    const plan = rootChildPlan(7, 8, 'feat-7');
    const report = await executeMerges({ plan, effects: fake });

    expect(report.merged).toEqual([7]);
    expect(report.stale).toEqual([
      { pr: 8, detail: match.stringContaining('base moved between plan and run') },
    ]);
  });

  test('a retarget-self entry does NOT read the base (it merges nothing)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });
    expect(report.retargeted).toEqual([5]);
    expect(fake.calls.some((call) => call.startsWith('readBase:'))).toBe(false);
  });
});
