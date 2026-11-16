import { describe, expect, test } from 'vitest';
import { JsonObject } from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import { RefreshExhausted } from '../../../src/policy/crq/forgeBudget.js';
import { runReconcileFixPrs } from '../../../src/ops/crq/reconcileFixPrs.js';
import {
  makeFixRunAdapter,
  type FixRunAdapterInput,
  type FixRunAdvance,
} from '../../../src/ops/crq/internal/reconcileFixRunAdapter.js';

function obj(value: unknown): JsonObject {
  const v = fromPlainJson(value);
  if (!(v instanceof JsonObject)) throw new Error('not object');
  return v;
}
const run = (n: number) => ({ fix_pr: { number: n } });
function item(id: string, runs: string[]): JsonObject {
  return obj({ id, kind: 'pr', repair_runs: Object.fromEntries(runs.map((r, i) => [r, run(i)])) });
}
function mark(base: JsonObject, tag: string): JsonObject {
  return new JsonObject([...base.entries, [`seen_${tag}`, true]]);
}
function fixture(
  items: JsonObject[],
  reconcile: (item: JsonObject, run: string) => Promise<FixRunAdvance>,
) {
  const persisted: string[] = [];
  const input: FixRunAdapterInput = {
    items,
    isReceipt: () => false,
    reconcileReceipt: async () => ({}),
    reconcile,
    persist: async (_i, r) => {
      persisted.push(r);
    },
  };
  return { adapter: makeFixRunAdapter(input), persisted, input };
}

describe('reconcile fix-run adapter', () => {
  test('counts a projected run and persists the returned item', async () => {
    const f = fixture([item('i1', ['r1'])], async (i) => ({
      kind: 'projected',
      item: mark(i, 'r1'),
    }));
    const stats = await runReconcileFixPrs(f.adapter.effects);
    expect(stats).toMatchObject({ examined: 1, projected: 1, deferred: 0, starved: 0 });
    expect(f.persisted).toEqual(['r1']);
    expect((f.adapter.current()[0] as JsonObject).get('seen_r1')).toBe(true);
  });
  test('pending, skipped and closed are examined but never projected', async () => {
    const kinds = ['pending', 'skipped', 'closed'] as const;
    for (const kind of kinds) {
      const f = fixture([item('i1', ['r1'])], async (i) => ({ kind, item: i }));
      const stats = await runReconcileFixPrs(f.adapter.effects);
      expect(stats).toMatchObject({ examined: 1, projected: 0, deferred: 0 });
      expect(f.persisted).toEqual(['r1']);
    }
  });
  test('persists partial state, then surfaces the error as deferred', async () => {
    const f = fixture([item('i1', ['r1'])], async (i) => ({
      kind: 'error',
      item: mark(i, 'partial'),
      error: new Error('boom'),
    }));
    const stats = await runReconcileFixPrs(f.adapter.effects);
    expect(stats).toMatchObject({ examined: 1, projected: 0, deferred: 1, starved: 0 });
    expect(stats.errors).toEqual([{ item: 'i1', run: 'r1', error: 'Error: boom' }]);
    expect(f.persisted).toEqual(['r1']);
    expect((f.adapter.current()[0] as JsonObject).get('seen_partial')).toBe(true);
  });
  test('budget starvation is counted as starved, not deferred', async () => {
    const f = fixture([item('i1', ['r1'])], async (i) => ({
      kind: 'error',
      item: i,
      error: new RefreshExhausted('shard budget'),
    }));
    const stats = await runReconcileFixPrs(f.adapter.effects);
    expect(stats).toMatchObject({ starved: 1, deferred: 0 });
  });
  test('a second run of one item sees the first run update', async () => {
    const seen: boolean[] = [];
    const f = fixture([item('i1', ['r1', 'r2'])], async (i, r) => {
      seen.push(i.get('seen_r1') === true);
      return { kind: 'projected', item: mark(i, r) };
    });
    const stats = await runReconcileFixPrs(f.adapter.effects);
    expect(seen).toEqual([false, true]);
    expect(stats.projected).toBe(2);
    const final = f.adapter.current()[0] as JsonObject;
    expect([final.get('seen_r1'), final.get('seen_r2')]).toEqual([true, true]);
  });
  test('a persistence failure is counted and the run is not projected', async () => {
    const f = fixture([item('i1', ['r1'])], async (i) => ({ kind: 'projected', item: i }));
    f.input.persist = async () => {
      throw new Error('disk full');
    };
    const adapter = makeFixRunAdapter(f.input);
    const stats = await runReconcileFixPrs(adapter.effects);
    expect(stats).toMatchObject({ projected: 0, deferred: 1 });
  });
  test('a non-JSON-object item is refused, not advanced', async () => {
    let called = false;
    const plain = { id: 'p', repair_runs: { r1: run(1) } };
    const adapter = makeFixRunAdapter({
      items: [plain],
      isReceipt: () => false,
      reconcileReceipt: async () => ({}),
      reconcile: async (i) => {
        called = true;
        return { kind: 'projected', item: i };
      },
      persist: async () => {},
    });
    const stats = await runReconcileFixPrs(adapter.effects);
    expect(called).toBe(false);
    expect(stats.deferred).toBe(1);
  });
});
