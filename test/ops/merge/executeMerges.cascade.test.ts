// Split from test/ops/merge/executeMerges.test.ts (F3): failed ancestors
// block descendants — (c) withheld lineages; round-2 rejecting effects.
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import { executeMerges } from '../../../src/ops/merge/executeMerges.js';
import { entry, FakeMergeEffects, handPlan, mergeCalls, sha } from './executeMerges.helpers.js';

describe('executeMerges — (c) failed ancestor blocks descendants, independent roots continue', () => {
  test('pr 7 fails → pr 8 blocked; independent root pr 9 still merges', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(8, sha('b'));
    fake.heads.set(9, sha('c'));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'required statuses missing' }]);
    // Hand-built (#153): a same-pass merge root's child no longer plans,
    // so the blocked-ancestor cascade is pinned on a handed plan — roots
    // first (7, 9), then 7's subtree (8), exactly as F2 ordered it.
    const plan = handPlan([entry(7), entry(9), entry(8, 'merge', 7, 1, 'feat-7')]);
    // The plan is the executor's gospel — it follows this order exactly.
    expect(plan.order.map((e) => e.pr)).toEqual([7, 9, 8]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('required statuses missing') },
    ]);
    expect(report.merged).toEqual([9]);
    expect(report.blocked).toEqual([{ pr: 8, reason: 'blocked_by_ancestor' }]);
    expect(report.stale).toEqual([]);
    // Pr 8 was never EXECUTED: the sweep fetched + validated its head
    // (2 calls); the blocked action added nothing.
    expect(fake.calls.filter((call) => call.includes('pull/8/head')).length).toBe(2);
    expect(fake.calls.includes('merge:8:merge')).toBe(false);
    // The independent root continued after the failure, in plan order.
    expect(mergeCalls(fake)).toEqual(['merge:7:merge', 'merge:9:merge']);
  });
});

describe('executeMerges — rejecting effects and the transitive cascade (round 2, finding 5)', () => {
  test('a rejecting mergePr → failed; the report stays total', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.mergeThrows = new Error('spawn enoent');

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('mergePr for pr 7 threw: spawn enoent') },
    ]);
    expect(report.merged).toEqual([]);
  });

  test('a rejecting retargetBase → failed', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.retargetThrows = new Error('gh went away');

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.failed).toEqual([
      { pr: 5, error: match.stringContaining('retargetBase for pr 5 threw: gh went away') },
    ]);
    expect(report.retargeted).toEqual([]);
  });

  test('a transitive cascade — the GRANDCHILD of a failed ancestor is blocked, never executed', async () => {
    const fake = new FakeMergeEffects();
    for (const pr of [7, 8, 9]) fake.heads.set(pr, sha(String(pr)));
    fake.mergeQueue.set(7, [{ code: 1, stdout: '', stderr: 'blocked by protection' }]);
    // Hand-built (#153): the grandchild cascade is pinned on a handed
    // root+child+grandchild plan.
    const plan = handPlan([
      entry(7),
      entry(8, 'merge', 7, 1, 'feat-7'),
      entry(9, 'merge', 8, 2, 'feat-8'),
    ]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.failed).toEqual([{ pr: 7, error: match.any(String) }]);
    expect(report.blocked).toEqual([
      { pr: 8, reason: 'blocked_by_ancestor' },
      { pr: 9, reason: 'blocked_by_ancestor' },
    ]);
    expect(report.merged).toEqual([]);
    // Only the root was ever attempted — 8 and 9 were never executed.
    expect(mergeCalls(fake)).toEqual(['merge:7:merge']);
  });

  test('a RETARGETED ancestor does not withhold its merge descendant', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.heads.set(6, sha('b'));
    const plan = handPlan([entry(5, 'retarget-self'), entry(6, 'merge', 5, 1)]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.retargeted).toEqual([5]);
    expect(report.merged).toEqual([6]);
    expect(report.blocked).toEqual([]);
  });

  test('round-3 finding 4: a FAILED retarget blocks its merge descendant', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.heads.set(6, sha('b'));
    fake.retargetFailures.add(5);
    const plan = handPlan([entry(5, 'retarget-self'), entry(6, 'merge', 5, 1)]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.failed).toEqual([
      { pr: 5, error: match.stringContaining('gh pr edit 5 --base main') },
    ]);
    expect(report.blocked).toEqual([{ pr: 6, reason: 'blocked_by_ancestor' }]);
    expect(report.retargeted).toEqual([]);
    expect(report.merged).toEqual([]);
    // Zero effect calls on 6 beyond the mandatory baseline sweep (one
    // fetch + one validate): the withheld cascade fired before any action.
    expect(fake.calls.filter((call) => call.includes('pull/6')).length).toBe(2);
    expect(fake.calls.includes('merge:6:merge')).toBe(false);
    expect(fake.calls.some((call) => call.startsWith('retarget:6'))).toBe(false);
  });
});
