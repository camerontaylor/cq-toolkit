import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { RefreshExhausted } from '../../../src/policy/crq/forgeBudget.js';
import { toPlainJson } from '../../../src/policy/crq/jsonValue.js';
import { reconcileReceiptLane } from '../../../src/ops/crq/internal/receiptLaneError.js';
import { runReconcileFixPrs } from '../../../src/ops/crq/reconcileFixPrs.js';

function object(value: unknown): JsonObject {
  const v = parseJsonValue(JSON.stringify(value));
  if (!(v instanceof JsonObject)) throw new Error('not object');
  return v;
}
const item = object({
  id: 'r1',
  kind: 'receipt',
  run: 'run-1',
  remediation: { x: 1 },
  remediation_state: 'fixed',
  keep: true,
});
function lane(reconcile: () => Promise<unknown>): {
  saved: JsonObject[];
  run: () => Promise<unknown>;
} {
  const saved: JsonObject[] = [];
  return {
    saved,
    run: () => reconcileReceiptLane(item, { reconcile, persist: (i) => void saved.push(i) }),
  };
}
describe('receipt lane error handling', () => {
  test('a genuine error drops remediation, demotes fixed, records repair_error, then rethrows', async () => {
    const l = lane(async () => {
      throw new Error('boom');
    });
    await expect(l.run()).rejects.toThrow('boom');
    expect(toPlainJson(l.saved[0]!)).toEqual({
      id: 'r1',
      kind: 'receipt',
      run: 'run-1',
      remediation_state: 'pending-merged-evidence',
      keep: true,
      repair_error: 'boom',
    });
  });
  test('a non-fixed state is left alone and the message is cut at 300 code points', async () => {
    const other = object({ id: 'r', remediation_state: 'pending' });
    const saved: JsonObject[] = [];
    await expect(
      reconcileReceiptLane(other, {
        reconcile: async () => {
          throw new Error('é😀'.repeat(200));
        },
        persist: (i) => void saved.push(i),
      }),
    ).rejects.toThrow();
    const out = toPlainJson(saved[0]!) as Record<string, string>;
    expect(out.remediation_state).toBe('pending');
    expect(Array.from(out.repair_error!)).toHaveLength(300);
  });
  test('RefreshExhausted rethrows without touching the item', async () => {
    const l = lane(async () => {
      throw new RefreshExhausted('shard budget');
    });
    await expect(l.run()).rejects.toBeInstanceOf(RefreshExhausted);
    expect(l.saved).toEqual([]);
  });
  test('success returns the skip report and persists nothing', async () => {
    const l = lane(async () => ({ starved: 1 }));
    expect(await l.run()).toEqual({ starved: 1 });
    expect(l.saved).toEqual([]);
  });
  test('inside the envelope an error counts deferred and starvation counts starved', async () => {
    const items = [item, object({ id: 'r2', kind: 'receipt', run: 'run-2' })];
    const saved: JsonObject[] = [];
    let n = 0;
    const stats = await runReconcileFixPrs({
      items: () => items,
      isReceipt: () => true,
      reconcileReceipt: (i) =>
        reconcileReceiptLane(i as JsonObject, {
          reconcile: async () => {
            throw ++n === 1 ? new Error('boom') : new RefreshExhausted('late');
          },
          persist: (v) => void saved.push(v),
        }),
      repairRuns: () => [],
      advanceFixRun: async () => 'skipped',
    });
    expect(stats.deferred).toBe(1);
    expect(stats.starved).toBe(1);
    expect(saved).toHaveLength(1);
  });
});
