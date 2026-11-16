import { describe, expect, it } from 'vitest';
import {
  deliveryPasses,
  harvestLoop,
  pyPrefix,
  type DeliveryEffects,
  type HarvestLoopEffects,
  type Item,
  type Queue,
} from '../../src/queue-runner/harvestDelivery.js';

function loopHarness(items: Item[], over: Partial<HarvestLoopEffects> = {}) {
  const q: Queue = { items };
  const log: string[] = [];
  const calls: string[] = [];
  const fx: HarvestLoopEffects = {
    liveItems: (queue) => queue.items,
    localReviewKind: 'local-review',
    reviewReceiptKind: 'receipt',
    republish: async (_q, i) => void calls.push('republish:' + String(i.id)),
    harvestReview: async (_q, i, dry) => (calls.push(`harvest:${String(i.id)}:${dry}`), null),
    repairHarvest: async (_q, i) => (calls.push('repair:' + String(i.id)), []),
    ...over,
  };
  return { q, log, calls, fx };
}
const it1 = (id: string, over: Item = {}): Item => ({
  id,
  kind: 'review',
  state: 'pending',
  ...over,
});

describe('harvestLoop', () => {
  it('harvests reviewing items (also on dry-run) and logs a truthy message', async () => {
    for (const dry of [false, true]) {
      const h = loopHarness([it1('a', { state: 'reviewing' }), it1('b', { state: 'reviewing' })], {
        harvestReview: async (_q, i) => (i.id === 'a' ? 'got a' : ''),
      });
      await harvestLoop(h.q, h.log, dry, h.fx);
      expect(h.log).toEqual(['got a']);
    }
    const p = loopHarness([it1('a', { state: 'pending' })]);
    await harvestLoop(p.q, p.log, false, p.fx);
    expect(p.calls).toEqual([]);
  });

  it('republishes a pending local review only when not dry', async () => {
    const mk = () => [
      it1('l', { kind: 'local-review', publication_pending: true }),
      it1('o', { publication_pending: true }),
    ];
    const h = loopHarness(mk());
    await harvestLoop(h.q, h.log, false, h.fx);
    expect(h.calls).toEqual(['republish:l']);
    const d = loopHarness(mk());
    await harvestLoop(d.q, d.log, true, d.fx);
    expect(d.calls).toEqual([]);
  });

  it('retires legacy addressing items, including ones that became addressing during harvest', async () => {
    const h = loopHarness([it1('a', { state: 'addressing' }), it1('b', { state: 'reviewing' })], {
      harvestReview: async (_q, i) => {
        if (i.id === 'b') i.state = 'addressing';
        return null;
      },
    });
    await harvestLoop(h.q, h.log, false, h.fx);
    for (const i of h.q.items) {
      expect(i.state).toBe('repair_failed');
      expect(i.last_error).toBe(
        'legacy addressing retained for manual reconciliation; no new dispatch',
      );
    }
    const d = loopHarness([it1('a', { state: 'addressing' })]);
    await harvestLoop(d.q, d.log, true, d.fx);
    expect(d.q.items[0]?.state).toBe('addressing');
  });

  it('runs the repair harvest for items with repair_runs and appends its lines', async () => {
    const h = loopHarness([it1('a', { repair_runs: [{}] }), it1('b', { repair_runs: [] })], {
      repairHarvest: async (_q, i) => ['repaired ' + String(i.id)],
    });
    await harvestLoop(h.q, h.log, false, h.fx);
    expect(h.log).toEqual(['repaired a']);
    const d = loopHarness([it1('a', { repair_runs: [{}] })]);
    await harvestLoop(d.q, d.log, true, d.fx);
    expect(d.calls).toEqual([]);
  });

  it('records a repair harvest failure per kind, truncated to 300 code points, and continues', async () => {
    const boom = async () => {
      throw new Error('😀'.repeat(400));
    };
    const h = loopHarness(
      [
        it1('r', { kind: 'receipt', repair_runs: [{}] }),
        it1('o', { repair_runs: [{}] }),
        it1('z', { state: 'reviewing' }),
      ],
      { repairHarvest: boom },
    );
    await harvestLoop(h.q, h.log, false, h.fx);
    const msg = 'repair harvest failed: ' + '😀'.repeat(300);
    expect(h.q.items[0]?.repair_error).toBe(msg);
    expect(h.q.items[0]?.last_error).toBeUndefined();
    expect(h.q.items[1]?.last_error).toBe(msg);
    expect(h.q.items[1]?.repair_error).toBeUndefined();
    expect(h.calls).toContain('harvest:z:false');
  });

  it('lets a harvest_review failure and a missing state escape', async () => {
    const a = loopHarness([it1('a', { state: 'reviewing' }), it1('b', { state: 'reviewing' })], {
      harvestReview: async () => {
        throw new Error('nope');
      },
    });
    await expect(harvestLoop(a.q, a.log, false, a.fx)).rejects.toThrow('nope');
    const b = loopHarness([{ id: 'x', kind: 'review' }]);
    await expect(harvestLoop(b.q, b.log, false, b.fx)).rejects.toThrow(TypeError);
  });

  it('iterates a snapshot of live items', async () => {
    const h = loopHarness([it1('a', { state: 'reviewing' })], {
      harvestReview: async (q, i) => {
        q.items.push(it1('late', { state: 'reviewing' }));
        return i.id as string;
      },
    });
    await harvestLoop(h.q, h.log, false, h.fx);
    expect(h.log).toEqual(['a']);
  });
});

function delHarness(items: Item[], over: Partial<DeliveryEffects> = {}) {
  const q: Queue = { items };
  const log: string[] = [];
  const calls: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  let clock = 0;
  const fx: DeliveryEffects = {
    liveItems: (queue) => queue.items,
    pushCurrentKind: 'push-current',
    reconcileCompleted: async () => void calls.push('reconcileCompleted'),
    iso: () => 'T' + ++clock,
    deliverPushFindings: async (_q, i) => (calls.push('push:' + String(i.id)), null),
    deliverPendingPrReviews: async () => (calls.push('pr'), []),
    deliverPendingCleanReviews: async () => (calls.push('clean'), []),
    deliverPendingReviewRefreshes: async () => (calls.push('refresh'), []),
    repairBackfill: async () => void calls.push('backfill'),
    repairArchiveLegacy: async () => void calls.push('archive'),
    reconcileFixPrs: async () => (calls.push('reconcile'), {}),
    event: async (k, d) => void events.push([k, d]),
    ...over,
  };
  return { q, log, calls, events, fx };
}
const pc = (id: string, over: Item = {}): Item => ({
  id,
  kind: 'push-current',
  issue_pending: true,
  ...over,
});

describe('deliveryPasses', () => {
  it('does nothing on a dry run', async () => {
    const h = delHarness([pc('a')]);
    await deliveryPasses(h.q, h.log, true, h.fx);
    expect(h.calls).toEqual([]);
  });

  it('runs the passes in order', async () => {
    const h = delHarness([]);
    await deliveryPasses(h.q, h.log, false, h.fx);
    expect(h.calls).toEqual([
      'reconcileCompleted',
      'pr',
      'clean',
      'refresh',
      'backfill',
      'archive',
      'reconcile',
    ]);
  });

  it('retries at most two pending push findings, oldest attempt first, stamping each', async () => {
    const h = delHarness([
      pc('c', { issue_attempt_at: 'T9' }),
      pc('a'),
      pc('b', { issue_attempt_at: 'T1' }),
      pc('x', { issue_pending: false }),
      pc('y', { kind: 'review' }),
    ]);
    await deliveryPasses(h.q, h.log, false, h.fx);
    expect(h.calls.filter((c) => c.startsWith('push'))).toEqual(['push:a', 'push:b']);
    expect(h.q.items[1]?.issue_attempt_at).toBe('T1');
    expect(h.q.items[2]?.issue_attempt_at).toBe('T2');
    expect(h.q.items[0]?.issue_attempt_at).toBe('T9');
  });

  it('breaks attempt ties by queue order and sorts by code point', async () => {
    const h = delHarness([
      pc('p1', { issue_attempt_at: '￿' }),
      pc('p2', { issue_attempt_at: '😀' }),
      pc('p3', { issue_attempt_at: '😀' }),
    ]);
    await deliveryPasses(h.q, h.log, false, h.fx);
    // code-point order: U+FFFF < U+1F600, so p1 goes first, then the first emoji item.
    expect(h.calls.filter((c) => c.startsWith('push'))).toEqual(['push:p1', 'push:p2']);
  });

  it('logs truthy delivery messages and appends each delivery pass', async () => {
    const h = delHarness([pc('a'), pc('b')], {
      deliverPushFindings: async (_q, i) => (i.id === 'a' ? 'pushed a' : ''),
      deliverPendingPrReviews: async () => ['pr1'],
      deliverPendingCleanReviews: async () => ['clean1', 'clean2'],
      deliverPendingReviewRefreshes: async () => ['refresh1'],
    });
    await deliveryPasses(h.q, h.log, false, h.fx);
    expect(h.log).toEqual(['pushed a', 'pr1', 'clean1', 'clean2', 'refresh1']);
  });

  it('reports an examined reconcile pass, and an event only when starved or deferred', async () => {
    const quiet = delHarness([], {
      reconcileFixPrs: async () => ({ examined: 12, projected: 3, starved: 0, deferred: 0 }),
    });
    await deliveryPasses(quiet.q, quiet.log, false, quiet.fx);
    expect(quiet.log).toEqual(['reconcile: 12 examined, 3 projected, 0 starved, 0 deferred']);
    expect(quiet.events).toEqual([]);
    const starved = delHarness([], {
      reconcileFixPrs: async () => ({
        examined: 12,
        projected: 0,
        starved: 12,
        deferred: 0,
        errors: ['e'],
      }),
    });
    await deliveryPasses(starved.q, starved.log, false, starved.fx);
    expect(starved.events).toEqual([
      [
        'reconcile_incomplete',
        { examined: 12, projected: 0, starved: 12, deferred: 0, errors: ['e'] },
      ],
    ]);
    const deferred = delHarness([], { reconcileFixPrs: async () => ({ deferred: 2 }) });
    await deliveryPasses(deferred.q, deferred.log, false, deferred.fx);
    expect(deferred.log).toEqual([]);
    expect(deferred.events).toEqual([
      ['reconcile_incomplete', { examined: 0, projected: 0, starved: 0, deferred: 2, errors: [] }],
    ]);
  });

  it('treats a non-dict reconcile result as reporting nothing', async () => {
    for (const bad of [null, undefined, 5, 'x', [1, 2]]) {
      const h = delHarness([], { reconcileFixPrs: async () => bad });
      await deliveryPasses(h.q, h.log, false, h.fx);
      expect(h.log).toEqual([]);
      expect(h.events).toEqual([]);
    }
  });

  it('lets a seam failure escape and skip later passes', async () => {
    const h = delHarness([], {
      deliverPendingPrReviews: async () => {
        throw new Error('gh down');
      },
    });
    await expect(deliveryPasses(h.q, h.log, false, h.fx)).rejects.toThrow('gh down');
    expect(h.calls).not.toContain('clean');
  });
});

describe('pyPrefix', () => {
  it('counts code points', () => {
    expect(pyPrefix('a😀b', 2)).toBe('a😀');
  });
});
