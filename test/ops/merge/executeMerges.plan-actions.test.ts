// Split from test/ops/merge/executeMerges.test.ts (F3): the plan is the
// only source of actions (needsHuman, retarget-self CR1, totality).
import { describe, expect, test } from 'vitest';
import { match } from '../../helpers/matchers.js';
import { executeMerges } from '../../../src/ops/merge/executeMerges.js';
import { entry, FakeMergeEffects, handPlan, mergeCalls, sha } from './executeMerges.helpers.js';

describe('executeMerges — the plan is the only source of actions', () => {
  test('needsHuman entries are NEVER executed (no effect call touches them)', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.heads.set(3, sha('x')); // live head, but needs-human: still untouched
    const plan = handPlan([entry(7)], [{ pr: 3, reason: 'not_eligible' }]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.merged).toEqual([7]);
    // The full sequence mentions pr 7 only — pr 3 never validated, fetched,
    // prepared, merged, pushed, or removed.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'fetch:refs/pull/7/head',
      'validate:refs/pull/7/head',
      'readBase:7',
      'merge:7:merge',
    ]);
    expect(JSON.stringify(report).includes('3')).toBe(false);
  });

  test('a retarget-self entry executes the forge base edit — never a merge, worktree, or push', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    const plan = handPlan([entry(5, 'retarget-self')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.retargeted).toEqual([5]);
    expect(report.merged).toEqual([]);
    // The retarget rides the forge base edit ONLY (CR1): after the baseline
    // fetch+validate and the drift guard, retargetBase(pr, baseBranch) —
    // no prepare, no push, no remove.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/5/head',
      'validate:refs/pull/5/head',
      'fetch:refs/pull/5/head',
      'validate:refs/pull/5/head',
      'retarget:5:base=main',
    ]);
    expect(fake.calls.some((call) => call.startsWith('merge:'))).toBe(false);
  });

  test('a failed forge retarget lands in failed — no worktree was ever involved', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.retargetFailures.add(5);

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.retargeted).toEqual([]);
    expect(report.failed).toEqual([
      { pr: 5, error: match.stringContaining('gh pr edit 5 --base main') },
    ]);
    expect(
      fake.calls.some((call) => call.startsWith('prepare:') || call.startsWith('remove:')),
    ).toBe(false);
  });

  test('round-1 finding 6: an action-time fetch failure → failed with the error, never merged', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(7, sha('a'));
    fake.fetchFailures.add(7); // every fetch for pr 7 fails

    const report = await executeMerges({ plan: handPlan([entry(7)]), effects: fake });

    // The BASELINE fetch is best-effort (tolerated — the sweep validate
    // still saw the locally-known head); the ACTION fetch failing is fatal
    // to the action: failed, never merged.
    expect(report.failed).toEqual([
      { pr: 7, error: match.stringContaining('fatal: could not read from remote repository') },
    ]);
    expect(report.merged).toEqual([]);
    expect(mergeCalls(fake)).toEqual([]);
    expect(fake.calls.filter((call) => call.startsWith('fetch:')).length).toBe(2); // baseline + action
  });

  test('round-1 finding 6: drift on a retarget-self entry → skipped stale; retargetBase never called', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.driftSha = sha('b'); // every validation after the baseline sees the moved head

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.retargeted).toEqual([]);
    expect(report.stale).toEqual([
      { pr: 5, detail: match.stringContaining('moved between plan and run') },
    ]);
    expect(fake.calls.some((call) => call.startsWith('retarget:'))).toBe(false);
  });

  test('CR1 regression: a forge that rejects pull-ref pushes never receives one from a retarget', async () => {
    const fake = new FakeMergeEffects();
    fake.heads.set(5, sha('a'));
    fake.pushFailures.add(5); // the hostile forge: any push would be recorded AND rejected

    const report = await executeMerges({
      plan: handPlan([entry(5, 'retarget-self')]),
      effects: fake,
    });

    expect(report.retargeted).toEqual([5]);
    // The OLD shape pushed the read-only refs/pull/<n>/head — GitHub rejects
    // that. The pin: NO pushRef call happens anywhere in the retarget flow,
    // pull-ref or otherwise; the retarget rides the forge base edit only.
    const pushedRefs = fake.calls
      .filter((call) => call.startsWith('push:'))
      .map((call) => call.slice('push:'.length).split('@')[0])
      .filter((ref): ref is string => ref !== undefined);
    expect(pushedRefs).toEqual([]);
    expect(pushedRefs.some((ref) => ref.startsWith('refs/pull/'))).toBe(false);
    expect(fake.calls).toContain('retarget:5:base=main');
  });

  test('CR1 totality: an effects throw at the baseline fails the run wholesale — total report, nothing executed', async () => {
    const fake = new FakeMergeEffects();
    fake.validateThrows = new Error('spawn boom');
    const plan = handPlan([entry(7), entry(8)]);

    const report = await executeMerges({ plan, effects: fake });

    // Resolves (no unhandled rejection) with EVERY planned pr failed and
    // nothing else executed — the run-scoped wholesale wording (round 2,
    // finding 4) names the phase and the pr it aborted on, for every record.
    expect(report).toEqual({
      merged: [],
      retargeted: [],
      stale: [],
      failed: [
        {
          pr: 7,
          error: match.stringContaining(
            'baseline sweep aborted during validateRef (first failure at pr 7): spawn boom',
          ),
        },
        {
          pr: 8,
          error: match.stringContaining(
            'baseline sweep aborted during validateRef (first failure at pr 7): spawn boom',
          ),
        },
      ],
      blocked: [],
    });
    // The fetch PHASE ran to completion (both heads fetched, CR-4), then
    // the VALIDATE phase threw on the first probe.
    expect(fake.calls).toEqual([
      'fetch:refs/pull/7/head',
      'fetch:refs/pull/8/head',
      'validate:refs/pull/7/head',
    ]);
  });
});
