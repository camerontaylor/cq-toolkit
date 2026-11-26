import { describe, expect, test } from 'vitest';
import {
  createHarvestPhases,
  type HarvestWiringDeps,
  type LocalReviewJsonSeams,
} from '../../../src/adapters/crq/harvestWiring.js';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  toPlainJsonRetainingNumbers,
} from '../../../src/policy/crq/jsonValue.js';
import { fromPlainJson } from '../../../src/policy/crq/queueDoc.js';
import type { HarvestReviewEffects } from '../../../src/queue-runner/harvestReview.js';

const doc = (v: unknown): JsonObject => parseJsonValue(JSON.stringify(v)) as JsonObject;
const plain = (
  q: JsonObject,
): { items: Array<Record<string, unknown>> } & Record<string, unknown> => toPlainJson(q) as never;

const LOCAL = 'local-review';
const run = (id: string) => ({ run_id: id, band: 'fast', started_at: 't0' });

interface Rig {
  deps: HarvestWiringDeps;
  calls: string[];
  seen: JsonObject[];
}

function rig(
  over: {
    local?: Partial<LocalReviewJsonSeams>;
    review?: Partial<HarvestReviewEffects>;
    repair?: HarvestWiringDeps['repairHarvest'];
    liveness?: string;
  } = {},
): Rig {
  const calls: string[] = [];
  const seen: JsonObject[] = [];
  const review = {
    kinds: {
      localReview: LOCAL,
      reviewReceipt: 'review-receipt',
      pushCurrent: 'push-current',
      backfill: 'backfill',
      author: 'author',
    },
    exitFileExists: async (id: string) => (calls.push('exit?:' + id), true),
    runLiveness: async (id: string, _i: unknown, _r: unknown, has: boolean) => (
      calls.push(`live:${id}:${String(has)}`),
      over.liveness ?? 'alive'
    ),
    ...over.review,
  } as unknown as HarvestReviewEffects;
  const local: LocalReviewJsonSeams = {
    kind: LOCAL,
    harvest: async (queue) => (
      seen.push(queue),
      calls.push('local.harvest'),
      { queue, message: null }
    ),
    republish: async (queue) => (calls.push('local.republish'), queue),
    reconcileCompleted: async (queue) => (calls.push('local.reconcile'), queue),
    ...over.local,
  };
  return {
    deps: {
      local,
      reviewReceiptKind: 'review-receipt',
      review,
      repairHarvest: over.repair ?? (async () => (calls.push('repair'), [])),
    },
    calls,
    seen,
  };
}

describe('harvestItems', () => {
  test('harvests a reviewing non-local item in the plain model and keeps integers as JsonNumber', async () => {
    const r = rig();
    const q = doc({
      version: 2,
      items: [{ id: 'a', kind: 'open', state: 'reviewing', failures: 2, run: run('r-1') }],
    });
    const out = await createHarvestPhases(r.deps).harvestItems(q, false);
    expect(r.calls).toEqual(['exit?:r-1', 'live:r-1:true']);
    expect(out.log).toEqual([]);
    const item = plain(out.queue).items[0] as Record<string, unknown>;
    expect(item.wait_reason).toBe('detached review still alive');
    const retained = toPlainJsonRetainingNumbers(out.queue) as {
      items: Array<Record<string, unknown>>;
    };
    expect(retained.items[0]?.failures).toBeInstanceOf(JsonNumber);
    expect(retained.items[0]?.failures).toMatchObject({ kind: 'int' });
  });

  test('does not mutate the input queue', async () => {
    const r = rig();
    const q = doc({ items: [{ id: 'a', kind: 'open', state: 'reviewing', run: run('r-1') }] });
    const before = JSON.stringify(toPlainJson(q));
    await createHarvestPhases(r.deps).harvestItems(q, false);
    expect(JSON.stringify(toPlainJson(q))).toBe(before);
  });

  test('a dry pass reaches harvest_review without writing and runs no repair harvest', async () => {
    const r = rig({ liveness: 'harvest', review: { readExitCode: async () => 0 } });
    const q = doc({
      items: [{ id: 'a', kind: 'open', state: 'reviewing', run: run('r-1'), repair_runs: [{}] }],
    });
    const out = await createHarvestPhases(r.deps).harvestItems(q, true);
    expect(out.log).toEqual(['would harvest r-1']);
    expect(r.calls).not.toContain('repair');
  });

  test('runs the injected repair harvest for items with repair runs and logs its lines', async () => {
    const r = rig({ repair: async (_q, item) => [`repaired ${String(item.id)}`] });
    const q = doc({ items: [{ id: 'a', kind: 'open', state: 'done', repair_runs: [{ x: 1 }] }] });
    const out = await createHarvestPhases(r.deps).harvestItems(q, false);
    expect(out.log).toEqual(['repaired a']);
  });

  test('routes local-review items to the immutable port and syncs the result into the plain queue', async () => {
    const r: Rig = rig({
      local: {
        harvest: async (queue, item) => {
          r.calls.push('local.harvest');
          const id = item.get('id');
          const next = fromPlainJson({
            ...(toPlainJson(queue) as object),
            marker: `after-${String(id)}`,
            items: (toPlainJson(queue) as { items: object[] }).items.map((i, n) =>
              n === 0 ? { ...i, state: 'done', wait_reason: null } : i,
            ),
          }) as JsonObject;
          return { queue: next, message: `local ${String(id)}` };
        },
      },
    });
    const q = doc({
      items: [
        { id: 'l1', kind: LOCAL, state: 'reviewing', run: run('r-1') },
        { id: 'l2', kind: LOCAL, state: 'reviewing', run: run('r-2') },
      ],
    });
    const out = await createHarvestPhases(r.deps).harvestItems(q, false);
    expect(out.log).toEqual(['local l1', 'local l2']);
    const after = plain(out.queue);
    expect(after.marker).toBe('after-l2');
    expect(after.items.map((i) => i.state)).toEqual(['done', 'reviewing']);
    expect(r.calls).toEqual(['local.harvest', 'local.harvest']);
  });

  test('the second local harvest sees the first one’s queue changes', async () => {
    const markers: unknown[] = [];
    const r = rig({
      local: {
        harvest: async (queue) => {
          markers.push(queue.get('marker') ?? null);
          const p = toPlainJson(queue) as Record<string, unknown>;
          return {
            queue: fromPlainJson({ ...p, marker: markers.length }) as JsonObject,
            message: null,
          };
        },
      },
    });
    const q = doc({
      items: [
        { id: 'l1', kind: LOCAL, state: 'reviewing', run: run('r-1') },
        { id: 'l2', kind: LOCAL, state: 'reviewing', run: run('r-2') },
      ],
    });
    await createHarvestPhases(r.deps).harvestItems(q, false);
    expect(markers.map((m) => (m instanceof JsonNumber ? Number(m.integer) : m))).toEqual([
      null,
      1,
    ]);
  });

  test('republishes a publication-pending local item first, but not on a dry pass', async () => {
    const q = doc({
      items: [{ id: 'l', kind: LOCAL, state: 'done', publication_pending: true }],
    });
    const wet = rig();
    await createHarvestPhases(wet.deps).harvestItems(q, false);
    expect(wet.calls).toEqual(['local.republish']);
    const dry = rig();
    await createHarvestPhases(dry.deps).harvestItems(q, true);
    expect(dry.calls).toEqual([]);
  });

  test('a non-record slot before a local item is kept, not copied as a record', async () => {
    const r = rig();
    const q = doc({
      items: [null, { id: 'l', kind: LOCAL, state: 'reviewing', run: run('r-1') }],
    });
    const out = await createHarvestPhases(r.deps).harvestItems(q, false);
    const items = plain(out.queue).items as unknown[];
    expect(items[0]).toBeNull();
    expect(r.calls).toEqual(['local.harvest']);
  });

  test('a local port that changes the item count is rejected rather than silently desynced', async () => {
    const r = rig({
      local: {
        harvest: async (queue) => ({
          queue: fromPlainJson({ ...(toPlainJson(queue) as object), items: [] }) as JsonObject,
          message: null,
        }),
      },
    });
    const q = doc({ items: [{ id: 'l', kind: LOCAL, state: 'reviewing', run: run('r-1') }] });
    await expect(createHarvestPhases(r.deps).harvestItems(q, false)).rejects.toThrow(
      /changed the queue items/,
    );
  });

  test('an error from the review effects propagates and the input is untouched', async () => {
    const r = rig({
      review: {
        exitFileExists: async () => {
          throw new Error('disk');
        },
      },
    });
    const q = doc({ items: [{ id: 'a', kind: 'open', state: 'reviewing', run: run('r-1') }] });
    await expect(createHarvestPhases(r.deps).harvestItems(q, false)).rejects.toThrow('disk');
  });
});

describe('collectFinished', () => {
  test('harvests only items whose exit file exists and whose liveness is harvest, then reconciles', async () => {
    const r = rig({
      liveness: 'harvest',
      local: {
        harvest: async (queue) => (r.calls.push('local.harvest'), { queue, message: 'done l' }),
        reconcileCompleted: async (queue) => (r.calls.push('local.reconcile'), queue),
      },
    });
    const q = doc({
      items: [
        { id: 'l', kind: LOCAL, state: 'reviewing', run: run('r-1') },
        { id: 'idle', kind: LOCAL, state: 'pending' },
      ],
    });
    const out = await createHarvestPhases(r.deps).collectFinished(q);
    expect(out.log).toEqual(['done l']);
    expect(r.calls).toEqual(['exit?:r-1', 'live:r-1:true', 'local.harvest', 'local.reconcile']);
  });

  test('a live run is left alone', async () => {
    const r = rig({ liveness: 'alive' });
    const q = doc({ items: [{ id: 'l', kind: LOCAL, state: 'reviewing', run: run('r-1') }] });
    const out = await createHarvestPhases(r.deps).collectFinished(q);
    expect(out.log).toEqual([]);
    expect(r.calls).toEqual(['exit?:r-1', 'live:r-1:true', 'local.reconcile']);
  });

  test('the reconcile result is synced back into the returned queue', async () => {
    const r = rig({
      local: {
        reconcileCompleted: async (queue) =>
          fromPlainJson({
            ...(toPlainJson(queue) as { items: object[] }),
            items: (toPlainJson(queue) as { items: object[] }).items.map((i) => ({
              ...i,
              reconciled: true,
            })),
          }) as JsonObject,
      },
    });
    const q = doc({ items: [{ id: 'l', kind: LOCAL, state: 'done' }] });
    const out = await createHarvestPhases(r.deps).collectFinished(q);
    expect(plain(out.queue).items[0]).toMatchObject({ reconciled: true });
  });

  test('a harvest error skips the final reconcile, as an uncaught Python exception would', async () => {
    const r = rig({
      liveness: 'harvest',
      local: {
        harvest: async () => {
          throw new Error('boom');
        },
      },
    });
    const q = doc({ items: [{ id: 'l', kind: LOCAL, state: 'reviewing', run: run('r-1') }] });
    await expect(createHarvestPhases(r.deps).collectFinished(q)).rejects.toThrow('boom');
    expect(r.calls).not.toContain('local.reconcile');
  });
});

describe('reconcileCompleted', () => {
  test('is the local-review port itself, on the immutable queue', async () => {
    const r = rig();
    const q = doc({ items: [] });
    const out = await createHarvestPhases(r.deps).reconcileCompleted(q);
    expect(out).toBe(q);
    expect(r.calls).toEqual(['local.reconcile']);
  });
});
