import { describe, expect, it } from 'vitest';
import {
  planDelta,
  planOpen,
  type OrdinaryItem,
  type OrdinaryOutcome,
  type OrdinaryPlanEffects,
  type OrdinaryPrInfo,
} from '../../src/queue-runner/ordinaryPlan.js';

const HEAD = 'h'.repeat(40);
const PIN = 'p'.repeat(40);

function harness(over: Partial<OrdinaryPlanEffects> = {}, present = true) {
  const calls: string[] = [];
  const effects: OrdinaryPlanEffects = {
    defaultBranch: () => null,
    ensureCommit: async (pr, sha) => {
      calls.push(`ensure ${pr} ${sha}`);
      return present;
    },
    mergeBase: async (target, head) => {
      calls.push(`merge-base ${target} ${head}`);
      return PIN;
    },
    ...over,
  };
  return { effects, calls };
}
const open = (over: Partial<OrdinaryPrInfo> = {}): OrdinaryPrInfo => ({
  state: 'OPEN',
  isDraft: false,
  headRefOid: HEAD,
  headRefName: 'feat',
  baseRefName: 'main',
  ...over,
});
const item = (over: OrdinaryItem = {}): OrdinaryItem => ({
  id: 'pr-1',
  kind: 'open',
  pr: 1,
  ...over,
});
const planOf = (o: OrdinaryOutcome) => {
  if (o.outcome !== 'plan') throw new Error(`expected plan, got ${o.outcome}`);
  return o.plan;
};

describe('planOpen', () => {
  it('plans the captured range against the PR base and pins the item', async () => {
    const { effects, calls } = harness();
    const it1 = item();
    const plan = planOf(await planOpen(it1, open(), false, effects));
    expect(plan).toEqual({
      base: PIN,
      head: HEAD,
      target: 'origin/main',
      label: 'one review of captured range',
      cycle: 1,
      notes: [],
      branch: 'feat',
      review_pin: PIN,
      range_policy: 'full-range-once-v1',
    });
    expect(it1).toMatchObject({ pinned_base: PIN, target_ref: 'origin/main' });
    expect(calls).toEqual([`ensure 1 ${HEAD}`, `merge-base origin/main ${HEAD}`]);
  });

  it('refuses non-open and draft PRs without touching git', async () => {
    const { effects, calls } = harness();
    expect(await planOpen(item(), open({ state: 'CLOSED' }), false, effects)).toEqual({
      outcome: 'not-ready',
      reason: 'PR is CLOSED',
    });
    expect(await planOpen(item(), open({ isDraft: true }), false, effects)).toEqual({
      outcome: 'not-ready',
      reason: 'PR is draft',
    });
    expect(calls).toEqual([]);
  });

  it('waits when the source head cannot be fetched', async () => {
    const { effects, calls } = harness({}, false);
    expect(await planOpen(item(), open(), false, effects)).toEqual({
      outcome: 'not-ready',
      reason: 'source head unavailable',
    });
    expect(calls).toHaveLength(1);
  });

  it('uses the configured default branch for a foreign repo and passes the repo through', async () => {
    const seen: (string | null)[] = [];
    const { effects, calls } = harness({
      defaultBranch: (repo) => (seen.push(repo), 'trunk'),
    });
    const plan = planOf(await planOpen(item({ repo: 'o/other' }), open(), false, effects));
    expect(plan.target).toBe('origin/trunk');
    expect(seen).toEqual(['o/other']);
    expect(calls[1]).toBe(`merge-base origin/trunk ${HEAD}`);
  });

  const reviewed = (over: Record<string, unknown> = {}) => ({
    base: PIN,
    head: HEAD,
    dirty_diff: 'clean tree',
    run_id: 'r1',
    range_policy: 'full-range-once-v1',
    ...over,
  });

  it('skips an exactly captured range and mutates nothing', async () => {
    const { effects } = harness();
    const it1 = item({ cycles: [reviewed()] });
    expect(await planOpen(it1, open(), false, effects)).toEqual({
      outcome: 'nothing-to-review',
      reason: 'exact captured base/head range already reviewed',
    });
    expect(it1.pinned_base).toBeUndefined();
  });

  it.each([
    ['other base', { base: 'x' }],
    ['other head', { head: 'x' }],
    ['dirty tree', { dirty_diff: 'dirty' }],
    ['no run id', { run_id: '' }],
    ['other policy', { range_policy: 'legacy' }],
  ])('does not treat a cycle with %s as already reviewed', async (_name, over) => {
    const { effects } = harness();
    const plan = planOf(await planOpen(item({ cycles: [reviewed(over)] }), open(), false, effects));
    expect(plan.cycle).toBe(2);
  });

  it('notes base drift once pinned_base differs, and dry runs leave the item alone', async () => {
    const { effects } = harness();
    const it1 = item({ pinned_base: 'old' });
    const plan = planOf(await planOpen(it1, open(), true, effects));
    expect(plan.notes).toEqual([
      'base drift: retain prior evidence; review the newly captured range once',
    ]);
    expect(it1.pinned_base).toBe('old');
    expect(it1.target_ref).toBeUndefined();
    const same = planOf(await planOpen(item({ pinned_base: PIN }), open(), true, effects));
    expect(same.notes).toEqual([]);
  });

  it('hands the plan to reconcile and returns its verdict', async () => {
    const calls: string[] = [];
    const { effects } = harness({
      reconcile: async (_item, plan, dry) => {
        calls.push(`reconcile dry=${dry} ${plan.base}`);
        return { outcome: 'not-ready', reason: 'equivalent-local-review' };
      },
    });
    expect(await planOpen(item(), open(), true, effects)).toEqual({
      outcome: 'not-ready',
      reason: 'equivalent-local-review',
    });
    expect(calls).toEqual([`reconcile dry=true ${PIN}`]);
  });
});

describe('planDelta', () => {
  it('plans a full-range review of an open PR', async () => {
    const { effects, calls } = harness();
    const plan = planOf(await planDelta(item({ kind: 'delta' }), open(), false, effects));
    expect(plan).toEqual({
      base: PIN,
      head: HEAD,
      pr_head: HEAD,
      target: 'origin/main',
      label: 'one full-range review (prior equivalent scope unproven)',
      cycle: null,
      notes: [],
      branch: 'feat',
      review_pin: PIN,
      range_policy: 'full-range-once-v1',
    });
    expect(calls[1]).toBe(`merge-base origin/main ${HEAD}`);
  });

  it('reviews a merged PR against the first parent of its merge commit, with no branch', async () => {
    const { effects, calls } = harness();
    const info = open({ state: 'MERGED', mergeCommit: { oid: 'm'.repeat(40) } });
    const plan = planOf(await planDelta(item({ kind: 'delta' }), info, false, effects));
    expect(plan.target).toBe(`${'m'.repeat(40)}^1`);
    expect(plan.branch).toBeNull();
    expect(calls[1]).toBe(`merge-base ${'m'.repeat(40)}^1 ${HEAD}`);
  });

  it('does not pin the item (delta never writes pinned_base) and ignores draft', async () => {
    const { effects } = harness();
    const it1 = item({ kind: 'delta' });
    planOf(await planDelta(it1, open({ isDraft: true }), false, effects));
    expect(it1.pinned_base).toBeUndefined();
  });

  it('refuses closed PRs', async () => {
    const { effects } = harness();
    expect(await planDelta(item(), open({ state: 'CLOSED' }), false, effects)).toEqual({
      outcome: 'not-ready',
      reason: 'PR is CLOSED',
    });
  });

  it('a merged PR without a merge commit is a planning error, not a silent plan', async () => {
    const { effects } = harness();
    await expect(
      planDelta(item(), open({ state: 'MERGED', mergeCommit: null }), false, effects),
    ).rejects.toThrow(TypeError);
  });

  it('skips only a cycle with the same pin, head, policy and a run id', async () => {
    const { effects } = harness();
    const cycle = { base: PIN, head: HEAD, range_policy: 'full-range-once-v1', run_id: 'r1' };
    expect(await planDelta(item({ cycles: [cycle] }), open(), false, effects)).toEqual({
      outcome: 'nothing-to-review',
      reason: 'equivalent captured full range already reviewed',
    });
    // Unlike plan_open, plan_delta does not require dirty_diff.
    for (const over of [{ run_id: '' }, { range_policy: 'x' }, { head: 'x' }]) {
      planOf(await planDelta(item({ cycles: [{ ...cycle, ...over }] }), open(), false, effects));
    }
  });
});
