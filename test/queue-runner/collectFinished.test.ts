import { describe, expect, it } from 'vitest';
import {
  collectFinished,
  type CollectFinishedEffects,
  type Item,
  type Queue,
} from '../../src/queue-runner/collectFinished.js';

function rev(id: string, over: Item = {}): Item {
  return { id, kind: 'review', state: 'reviewing', run: { run_id: 'r-' + id }, ...over };
}
function harness(items: Item[], over: Partial<CollectFinishedEffects> = {}) {
  const q: Queue = { items };
  const log: string[] = [];
  const calls: string[] = [];
  const fx: CollectFinishedEffects = {
    liveItems: (queue) => queue.items.filter((i) => i.kind !== 'promotion'),
    localReviewKind: 'local-review',
    republish: async (_q, i) => void calls.push('republish:' + String(i.id)),
    exitFileExists: async (id) => (calls.push('exit:' + id), true),
    runLiveness: async (id) => (calls.push('live:' + id), 'harvest'),
    harvestReview: async (_q, i) => (calls.push('harvest:' + String(i.id)), null),
    reconcileCompleted: async () => void calls.push('reconcile'),
    ...over,
  };
  return { q, log, calls, fx };
}

describe('collectFinished', () => {
  it('harvests a reviewing item whose exit file exists and liveness says harvest, then reconciles', async () => {
    const h = harness([rev('a')]);
    await collectFinished(h.q, h.log, h.fx);
    expect(h.calls).toEqual(['exit:r-a', 'live:r-a', 'harvest:a', 'reconcile']);
  });

  it('logs only a truthy harvest message', async () => {
    const h = harness([rev('a'), rev('b'), rev('c')], {
      harvestReview: async (_q, i) =>
        i.id === 'a' ? 'harvested a' : i.id === 'b' ? '' : undefined,
    });
    await collectFinished(h.q, h.log, h.fx);
    expect(h.log).toEqual(['harvested a']);
  });

  it('skips items that are not reviewing or have no run', async () => {
    const h = harness([
      rev('p', { state: 'pending' }),
      rev('n', { run: null }),
      rev('e', { run: {} }),
    ]);
    await collectFinished(h.q, h.log, h.fx);
    expect(h.calls).toEqual(['reconcile']);
  });

  it('does not probe liveness without an exit file', async () => {
    const h = harness([rev('a')], { exitFileExists: async () => false });
    await collectFinished(h.q, h.log, h.fx);
    expect(h.calls).toEqual(['reconcile']);
  });

  it('retains capacity for any liveness other than harvest', async () => {
    for (const verdict of ['live', 'unverifiable', 'unknown', '']) {
      const h = harness([rev('a')], { runLiveness: async () => verdict });
      await collectFinished(h.q, h.log, h.fx);
      expect(h.calls).toEqual(['exit:r-a', 'reconcile']);
    }
  });

  it('republishes a pending local review before the state check, for any state', async () => {
    const h = harness([
      { id: 'l1', kind: 'local-review', state: 'done', publication_pending: true },
      { id: 'l2', kind: 'local-review', state: 'done', publication_pending: false },
      { id: 'o', kind: 'review', state: 'done', publication_pending: true },
    ]);
    await collectFinished(h.q, h.log, h.fx);
    expect(h.calls).toEqual(['republish:l1', 'reconcile']);
  });

  it('a reviewing local review is republished and then harvested', async () => {
    const h = harness([
      {
        id: 'l',
        kind: 'local-review',
        state: 'reviewing',
        publication_pending: true,
        run: { run_id: 'r-l' },
      },
    ]);
    await collectFinished(h.q, h.log, h.fx);
    expect(h.calls).toEqual(['republish:l', 'exit:r-l', 'live:r-l', 'harvest:l', 'reconcile']);
  });

  it('iterates a snapshot of live items', async () => {
    // liveItems returns the queue array itself, so only the loop's copy can fence off `added`.
    const added = rev('late');
    const h: ReturnType<typeof harness> = harness([rev('a')], {
      liveItems: (q) => q.items,
      harvestReview: async (q, i) => {
        h.calls.push('harvest:' + String(i.id));
        if (i.id === 'a') q.items.push(added);
        return null;
      },
    });
    await collectFinished(h.q, h.log, h.fx);
    expect(h.calls.filter((c) => c.startsWith('harvest'))).toEqual(['harvest:a']);
    expect(h.q.items).toContain(added);
  });

  it('a seam failure skips later items and the final reconcile', async () => {
    const h = harness([rev('a'), rev('b')], {
      harvestReview: async () => {
        throw new Error('harvest broke');
      },
    });
    await expect(collectFinished(h.q, h.log, h.fx)).rejects.toThrow('harvest broke');
    expect(h.calls).not.toContain('reconcile');
    expect(h.calls.filter((c) => c.startsWith('exit'))).toEqual(['exit:r-a']);
  });

  it('throws like a KeyError for an item without state or a run without run_id', async () => {
    const a = harness([{ id: 'x', kind: 'review' }]);
    await expect(collectFinished(a.q, a.log, a.fx)).rejects.toThrow(TypeError);
    const b = harness([rev('y', { run: { pid: 1 } })]);
    await expect(collectFinished(b.q, b.log, b.fx)).rejects.toThrow(TypeError);
  });

  it('reconciles even with no items', async () => {
    const h = harness([]);
    await collectFinished(h.q, h.log, h.fx);
    expect(h.calls).toEqual(['reconcile']);
  });
});
