// Split from test/ops/merge/executeMerges.test.ts (F3): per-effective-base
// serial order (d), recorded in call order.
import { describe, expect, test } from 'vitest';
import { executeMerges } from '../../../src/ops/merge/executeMerges.js';
import { FakeMergeEffects, planned, sha, stackPlan } from './executeMerges.helpers.js';

describe('executeMerges — (d) per-effective-base serial order, recorded in call order', () => {
  test('independent roots run strictly serially in plan order', async () => {
    const fake = new FakeMergeEffects();
    for (const pr of [5, 6]) fake.heads.set(pr, sha(String(pr)));
    const plan = stackPlan([planned(5, 'main', 'feat-5'), planned(6, 'main', 'feat-6')]);

    const report = await executeMerges({ plan, effects: fake });

    expect(report.merged).toEqual([5, 6]);
    // One action at a time, plan order, each fetch→validate→merge block
    // complete before the next begins (the whole-run serialization;
    // per-base grouping is preserved by the same order in the report).
    expect(fake.calls).toEqual([
      'fetch:refs/pull/5/head', // baseline sweep — fetch first (CR-4)
      'fetch:refs/pull/6/head',
      'validate:refs/pull/5/head',
      'validate:refs/pull/6/head',
      'fetch:refs/pull/5/head',
      'validate:refs/pull/5/head',
      'readBase:5',
      'merge:5:merge',
      'fetch:refs/pull/6/head',
      'validate:refs/pull/6/head',
      'readBase:6',
      'merge:6:merge',
    ]);
  });
});
