import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { reconcileCompletedLocalReviews } from '../../../src/ops/crq/localReviewReconcile.js';
function doc(text: string): JsonObject {
  const value = parseJsonValue(text);
  if (!(value instanceof JsonObject)) throw new Error('object');
  return value;
}
describe('completed review reconciliation', () => {
  it('backs off unavailable evidence and later clears the failure', async () => {
    const queue = doc('{"items":[{"kind":"local-review","state":"pending","extra":1.0}]}');
    const clock = () => '2026-11-14T12:00:00Z';
    const failed = await reconcileCompletedLocalReviews(queue, 5, {
      nowIso: clock,
      prepareCompleted: async () => {
        throw new Error('unavailable');
      },
    });
    const item = (failed.get('items') as JsonObject[])[0]!;
    expect(item.get('not_before')).toBe('2026-11-14T12:05:00Z');
    expect(item.get('wait_reason')).toBe('completed-evidence-unavailable: Error: unavailable');
    let calls = 0;
    const pending = await reconcileCompletedLocalReviews(failed, 5, {
      nowIso: clock,
      prepareCompleted: async (q) => {
        calls++;
        return q;
      },
    });
    expect(calls).toBe(0);
    const recovered = await reconcileCompletedLocalReviews(pending, 5, {
      nowIso: () => '2026-11-14T12:06:00Z',
      prepareCompleted: async (q) => q,
    });
    const recoveredItem = (recovered.get('items') as JsonObject[])[0]!;
    expect(recoveredItem.has('not_before')).toBe(false);
    expect(recoveredItem.has('reconcile_failures')).toBe(false);
    expect(recoveredItem.get('wait_reason')).toBeNull();
    expect(recoveredItem.get('extra')).toBe(item.get('extra'));
  });
});
