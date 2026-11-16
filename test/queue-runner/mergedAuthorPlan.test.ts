import { describe, expect, it } from 'vitest';
import {
  planAuthor,
  planMerged,
  type MergedAuthorPlanEffects,
  type PlanItem,
} from '../../src/queue-runner/mergedAuthorPlan.js';

const B = 'b'.repeat(40);
const H = 'e'.repeat(40);
function harness(over: Partial<MergedAuthorPlanEffects> = {}) {
  const calls: string[] = [];
  const have = new Set<string>([B, H]);
  const effects: MergedAuthorPlanEffects = {
    defaultRef: 'origin/main',
    revParseCommit: async (ref) => (calls.push(`rev-parse ${ref}`), 't'.repeat(40)),
    isAncestor: async (a, d) => (calls.push(`ancestor ${a} ${d}`), true),
    buildSynthetic: async (_i, target) => (
      calls.push(`synth ${target}`),
      { base: 'sb', head: 'sh', paths: 7 }
    ),
    checkAuthorLease: () => void calls.push('lease'),
    authorBinding: () => ({ base: B, head: H, target: 'origin/main', cycle: 2 }),
    objectPresent: async (sha) => (calls.push(`present ${sha[0]}`), have.has(sha)),
    fetch: async () => void calls.push('fetch'),
    diffHasPaths: async () => (calls.push('diff'), true),
    ...over,
  };
  return { effects, calls, have };
}
const merged = (o: PlanItem = {}): PlanItem => ({
  id: 'm-1',
  kind: 'merged',
  merge_commit: 'm'.repeat(40),
  ...o,
});

describe('planMerged', () => {
  it('dry run returns the synthetic placeholder without touching git', async () => {
    const { effects, calls } = harness();
    expect(await planMerged(merged(), true, effects)).toEqual({
      outcome: 'plan',
      plan: {
        base: '(synthetic)',
        head: '(synthetic)',
        target: 'origin/main',
        label: 'post-merge synthetic review',
        cycle: null,
        notes: [],
        branch: null,
      },
    });
    expect(calls).toEqual([]);
  });

  it('projects the promoted target when the merge commit is an ancestor', async () => {
    const { effects, calls } = harness();
    expect(await planMerged(merged(), false, effects)).toEqual({
      outcome: 'plan',
      plan: {
        base: 'sb',
        head: 'sh',
        target: 't'.repeat(40),
        cycle: null,
        branch: null,
        notes: [],
        label: 'post-merge current projection (7 PR-touched paths at promoted main)',
      },
    });
    expect(calls).toEqual([
      'rev-parse origin/main^{commit}',
      `ancestor ${'m'.repeat(40)} ${'t'.repeat(40)}`,
      `synth ${'t'.repeat(40)}`,
    ]);
  });

  it('waits when the merge commit is not yet promoted and builds nothing', async () => {
    const { effects, calls } = harness({ isAncestor: async () => false });
    expect(await planMerged(merged(), false, effects)).toEqual({
      outcome: 'not-ready',
      reason: 'not-yet-promoted: merge commit is not an ancestor of origin/main',
    });
    expect(calls).toEqual(['rev-parse origin/main^{commit}']);
  });

  it('a missing merge_commit is a planning error, not a silent wait', async () => {
    const { effects } = harness();
    await expect(planMerged(merged({ merge_commit: undefined }), false, effects)).rejects.toThrow(
      TypeError,
    );
  });
});

describe('planAuthor', () => {
  const item = (): PlanItem => ({ id: 'a-1', kind: 'author' });

  it('checks the lease first, then builds the labelled plan', async () => {
    const { effects, calls } = harness();
    const out = await planAuthor(item(), false, effects);
    expect(out).toEqual({
      outcome: 'plan',
      plan: {
        base: B,
        head: H,
        target: 'origin/main',
        cycle: 2,
        branch: null,
        notes: [],
        label: `author review — cycle 2 ${B.slice(0, 12)}..${H.slice(0, 12)} → origin/main`,
      },
    });
    expect(calls[0]).toBe('lease');
  });

  it('dry run returns the plan without checking objects or the diff', async () => {
    const { effects, calls } = harness();
    expect((await planAuthor(item(), true, effects)).outcome).toBe('plan');
    expect(calls).toEqual(['lease']);
  });

  it('a lease refusal propagates before anything else runs', async () => {
    const { effects, calls } = harness({
      checkAuthorLease: () => {
        throw new Error('author lease deadline passed; queue grant refused');
      },
    });
    await expect(planAuthor(item(), false, effects)).rejects.toThrow('deadline passed');
    expect(calls).toEqual([]);
  });

  it('a binding refusal propagates', async () => {
    const { effects } = harness({
      authorBinding: () => {
        throw new Error('base and head are the same commit');
      },
    });
    await expect(planAuthor(item(), true, effects)).rejects.toThrow('same commit');
  });

  it('fetches once when an object is missing, then proceeds if the fetch fixed it', async () => {
    const { effects, calls, have } = harness({
      fetch: async () => void (calls.push('fetch'), have.add(H)),
    });
    have.delete(H);
    expect((await planAuthor(item(), false, effects)).outcome).toBe('plan');
    expect(calls.filter((c) => c === 'fetch')).toHaveLength(1);
  });

  it('waits, naming the 10-char range, when the binding is still not fetchable', async () => {
    const { effects, have } = harness();
    have.delete(B);
    expect(await planAuthor(item(), false, effects)).toEqual({
      outcome: 'not-ready',
      reason: `author binding not fetchable (${B.slice(0, 10)}..${H.slice(0, 10)})`,
    });
  });

  it('does not fetch when both objects are already present', async () => {
    const { effects, calls } = harness();
    await planAuthor(item(), false, effects);
    expect(calls).not.toContain('fetch');
  });

  it('skips an author binding whose diff is empty', async () => {
    const { effects } = harness({ diffHasPaths: async () => false });
    expect(await planAuthor(item(), false, effects)).toEqual({
      outcome: 'nothing-to-review',
      reason: 'author binding has an empty diff',
    });
  });
});
