import { describe, expect, test } from 'vitest';
import { JsonObject, toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import {
  reconcileFixRun,
  SourcePublicationFailed,
  type ReconcileFixRunEffects,
} from '../../../src/ops/crq/internal/reconcileFixRun.js';

const merge = 'a'.repeat(40);
function obj(value: unknown): JsonObject {
  const v = fromPlainJson(value);
  if (!(v instanceof JsonObject)) throw new Error('not object');
  return v;
}
function item(): JsonObject {
  return obj({
    id: 'i1',
    blocking: [{ repair_job: 'crq-j1' }, { repair_job: 'crq-other' }],
    repair_runs: {
      r1: {
        fix_pr: { number: 42, url: 'u' },
        jobs: ['crq-j1', 'crq-j2'],
        verdicts: [
          { job: 'crq-j1', verdict: 'FIXED' },
          { job: 'crq-j2', verdict: 'NOT-FIXED' },
        ],
      },
    },
  });
}
function fixture(pr: unknown = { state: 'MERGED', mergeCommit: { oid: merge } }) {
  const calls: string[] = [];
  const effects: ReconcileFixRunEffects = {
    prInfo: async () => obj(pr),
    defaultTip: async () => 'tip',
    isAncestor: async () => true,
    now: () => 'T',
    proveMerge: async () => {
      calls.push('prove');
      return { proof: obj({ published_head: 'p' }), projected: false };
    },
    recheckRevalidation: async () => {
      calls.push('recheck');
    },
    markFixedOutcome: async (job) => {
      calls.push(`mark:${job}`);
    },
    publishSource: async () => {
      calls.push('publish');
      return { pending: false };
    },
  };
  return { effects, calls };
}
const run = (i: JsonObject) =>
  (toPlainJson(i) as { repair_runs: { r1: Record<string, unknown> } }).repair_runs.r1;

describe('externally merged fix PR reconciliation', () => {
  test('projects a merged run: proof, outcome for FIXED jobs only, blocker, fix_merged', async () => {
    const { effects, calls } = fixture();
    const result = await reconcileFixRun(item(), 'r1', effects);
    expect(result.kind).toBe('projected');
    expect(calls).toEqual(['prove', 'mark:crq-j1', 'publish']);
    const r = run(result.item);
    expect(r.fix_merged).toBe('T');
    expect(r.validated_merge_head).toEqual({ published_head: 'p', merge_commit: merge });
    expect(r.source_publication_error).toBeUndefined();
    const blocking = (toPlainJson(result.item) as { blocking: Record<string, unknown>[] }).blocking;
    expect(blocking[0]!.resolution).toEqual({ fix_pr: 42, merge, at: 'T' });
    expect(blocking[1]!.resolution).toBeUndefined();
  });
  test('a projected proof appends no outcome', async () => {
    const { effects, calls } = fixture();
    effects.proveMerge = async () => ({ proof: obj({ x: 1 }), projected: true });
    expect((await reconcileFixRun(item(), 'r1', effects)).kind).toBe('projected');
    expect(calls).toEqual(['publish']);
  });
  test('a closed PR gets the terminal marker and no further forge work', async () => {
    const { effects, calls } = fixture({ state: 'CLOSED' });
    const result = await reconcileFixRun(item(), 'r1', effects);
    expect(result.kind).toBe('closed');
    expect(run(result.item).fix_closed).toBe('T');
    expect(calls).toEqual([]);
  });
  test('an open PR or a merge outside the default tip is skipped untouched', async () => {
    const open = fixture({ state: 'OPEN' });
    const a = await reconcileFixRun(item(), 'r1', open.effects);
    expect(a.kind).toBe('skipped');
    expect(run(a.item).fix_merged).toBeUndefined();
    const out = fixture();
    out.effects.isAncestor = async () => false;
    const b = await reconcileFixRun(item(), 'r1', out.effects);
    expect(b.kind).toBe('skipped');
    expect(out.calls).toEqual([]);
  });
  test('a proof failure records source_publication_error and never marks or merges', async () => {
    const { effects, calls } = fixture();
    effects.proveMerge = async () => {
      throw new Error('x'.repeat(400));
    };
    const result = await reconcileFixRun(item(), 'r1', effects);
    expect(result.kind).toBe('error');
    expect((run(result.item).source_publication_error as string).length).toBe(300);
    expect(run(result.item).fix_merged).toBeUndefined();
    expect(calls).toEqual([]);
  });
  test('a stale revalidation refuses before any outcome', async () => {
    const { effects, calls } = fixture();
    effects.proveMerge = async () => ({
      proof: obj({ fixed_revalidation: { reason: 'r' } }),
      projected: false,
    });
    effects.recheckRevalidation = async () => {
      throw new Error('fixed revalidation changed');
    };
    const result = await reconcileFixRun(item(), 'r1', effects);
    expect(result.kind).toBe('error');
    expect(run(result.item).source_publication_error).toBe('fixed revalidation changed');
    expect(calls).toEqual([]);
  });
  test('a pending source thread clears the error and retries without fix_merged', async () => {
    const { effects } = fixture();
    effects.publishSource = async () => ({ pending: true });
    const base = item();
    const result = await reconcileFixRun(base, 'r1', effects);
    expect(result.kind).toBe('pending');
    expect(run(result.item).fix_merged).toBeUndefined();
    expect(run(result.item).source_publication_error).toBeUndefined();
  });
  test('a feedback failure keeps the outcome and records the error', async () => {
    const { effects } = fixture();
    effects.publishSource = async () => {
      throw new Error('changed before source feedback');
    };
    const result = await reconcileFixRun(item(), 'r1', effects);
    expect(result.kind).toBe('error');
    expect(run(result.item).source_publication_error).toBe('changed before source feedback');
    expect(run(result.item).fix_merged).toBeUndefined();
  });
  test('a feedback failure after the publication latched keeps record.publication', async () => {
    const { effects } = fixture();
    effects.publishSource = async () => {
      throw new SourcePublicationFailed('feedback failed', obj({ head: 'h' }));
    };
    const result = await reconcileFixRun(item(), 'r1', effects);
    expect(result.kind).toBe('error');
    expect(run(result.item).publication).toEqual({ head: 'h' });
    expect(run(result.item).source_publication_error).toBe('feedback failed');
    expect(run(result.item).fix_merged).toBeUndefined();
  });
  test('a plain pre-feedback failure keeps no publication', async () => {
    const { effects } = fixture();
    effects.publishSource = async () => {
      throw new Error('canonical fixed finding changed before source feedback');
    };
    const result = await reconcileFixRun(item(), 'r1', effects);
    expect(run(result.item).publication).toBeUndefined();
  });
});
