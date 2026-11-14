import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys, withoutObjectKey } from '../../../src/policy/crq/queueDoc.js';
import {
  inventoryTransaction,
  mergeInventory,
  type InventoryTransactionEffects,
} from '../../../src/ops/crq/backfillTransaction.js';

function doc(text: string): JsonObject {
  const value = parseJsonValue(text);
  if (!(value instanceof JsonObject)) throw new Error('not object');
  return value;
}

function fixture() {
  let queue = doc(
    '{"items":[{"id":"ordinary","kind":"merged","state":"pending","big":9007199254740993}],"diagnostic":"before","backfill_halted":"bad"}',
  );
  let config = { enabled: true };
  let held = false;
  let calls = 0;
  let busy = 0;
  let elapsed = 0;
  const log: string[] = [];
  const effects: InventoryTransactionEffects = {
    clock: () => elapsed,
    async withLock(wait, action) {
      log.push(`lock:${String(wait)}`);
      calls++;
      if (calls === busy) return null;
      expect(held).toBe(false);
      held = true;
      try {
        return await action();
      } finally {
        held = false;
      }
    },
    async loadQueue() {
      expect(held).toBe(true);
      return queue;
    },
    async settings() {
      return config;
    },
    async prepare(snapshot, enqueue) {
      expect(held).toBe(false);
      expect(enqueue).toBe(true);
      queue = doc(
        '{"items":[{"id":"ordinary","kind":"merged","state":"done","big":9007199254740993}],"diagnostic":"after","backfill_halted":"bad","tick":1.0}',
      );
      return {
        queue: withObjectKeys(snapshot, [
          [
            'items',
            [
              ...(snapshot.get('items') as []),
              doc('{"id":"new","kind":"backfill","created_at":"now"}'),
            ],
          ],
          ['backfill_last_manifest', 'new'],
        ]),
        ranked: 'ranked',
        report: 'report',
        eventItems: ['new'],
      };
    },
    async stateEvent(current, item) {
      log.push(`event:${String(item.get('id'))}`);
      return current;
    },
    async writeRanked() {
      log.push('ranked');
    },
    async writeReport() {
      log.push('report');
    },
    clearHalt(current) {
      log.push('halt');
      return withoutObjectKey(current, 'backfill_halted');
    },
    async saveQueue(current) {
      log.push('save');
      queue = current;
    },
  };
  return {
    effects,
    log,
    getQueue: () => queue,
    setQueue: (value: JsonObject) => {
      queue = value;
    },
    setBusy: (n: number) => {
      busy = n;
    },
    setElapsed: (n: number) => {
      elapsed = n;
    },
    setConfig: (value: boolean) => {
      config.enabled = value;
    },
  };
}

describe('inventory transaction', () => {
  it('merges scheduler changes and orders effects under the merge lock', async () => {
    const f = fixture();
    expect(await inventoryTransaction(f.effects, { reportOnly: false })).toBe('report');
    expect(f.log).toEqual([
      'lock:180',
      'lock:600',
      'event:new',
      'ranked',
      'report',
      'halt',
      'save',
    ]);
    const queue = f.getQueue();
    expect(queue.get('diagnostic')).toBe('after');
    expect(queue.get('backfill_halted')).toBeUndefined();
    const all = queue.get('items') as JsonObject[];
    expect(all[0]?.get('state')).toBe('done');
    expect((all[0]?.get('big') as { raw: string } | undefined)?.raw).toBe('9007199254740993');
    expect(all[1]?.get('id')).toBe('new');
  });
  it.each([1, 2])('skips without writes when lock %i is busy', async (busy) => {
    const f = fixture();
    f.setBusy(busy);
    expect(await inventoryTransaction(f.effects, { reportOnly: false })).toMatchObject({
      inventory: 'skipped',
    });
    expect(f.log.some((entry) => ['save', 'report', 'ranked'].includes(entry))).toBe(false);
  });
  it('skips when preparation spends the budget', async () => {
    const f = fixture();
    const prepare = f.effects.prepare;
    f.effects.prepare = async (...args) => {
      const result = await prepare(...args);
      f.setElapsed(2371);
      return result;
    };
    expect(await inventoryTransaction(f.effects, { reportOnly: false })).toEqual({
      inventory: 'skipped',
      reason: 'run budget spent before merge; nothing saved, next run retries',
    });
    expect(f.log).toEqual(['lock:180']);
  });
  it.each(['scope', 'config'])('rejects stale %s before effects', async (which) => {
    const f = fixture();
    const prepare = f.effects.prepare;
    f.effects.prepare = async (...args) => {
      const result = await prepare(...args);
      if (which === 'scope') f.setQueue(doc('{"items":[{"id":"x","kind":"backfill"}]}'));
      else f.setConfig(false);
      return result;
    };
    await expect(inventoryTransaction(f.effects, { reportOnly: false })).rejects.toThrow(
      'snapshot stale',
    );
    expect(f.log).toEqual(['lock:180', 'lock:600']);
  });
  it.each([
    ['event', ['lock:180', 'lock:600', 'event:new']],
    ['ranked', ['lock:180', 'lock:600', 'event:new', 'ranked']],
    ['report', ['lock:180', 'lock:600', 'event:new', 'ranked', 'report']],
    ['save', ['lock:180', 'lock:600', 'event:new', 'ranked', 'report', 'halt', 'save']],
  ])('stops after %s fails without saving the queue', async (failure, expected) => {
    const f = fixture();
    const error = new Error(`${failure} failed`);
    if (failure === 'event') {
      f.effects.stateEvent = async (_queue, item) => {
        f.log.push(`event:${String(item.get('id'))}`);
        throw error;
      };
    } else if (failure === 'ranked') {
      f.effects.writeRanked = async () => {
        f.log.push('ranked');
        throw error;
      };
    } else if (failure === 'report') {
      f.effects.writeReport = async () => {
        f.log.push('report');
        throw error;
      };
    } else {
      f.effects.saveQueue = async () => {
        f.log.push('save');
        throw error;
      };
    }
    await expect(inventoryTransaction(f.effects, { reportOnly: false })).rejects.toBe(error);
    expect(f.log).toEqual(expected);
    expect(f.getQueue().get('backfill_halted')).toBe('bad');
    expect((f.getQueue().get('items') as JsonObject[]).map((item) => item.get('id'))).toEqual([
      'ordinary',
    ]);
  });

  it('stops event publication at the first failed event before writing artifacts', async () => {
    const f = fixture();
    const prepare = f.effects.prepare;
    f.effects.prepare = async (...args) => {
      const result = await prepare(...args);
      const queue = withObjectKeys(result.queue, [
        ['items', [...(result.queue.get('items') as JsonObject[]), doc('{"id":"second"}')]],
      ]);
      return { ...result, queue, eventItems: ['new', 'second'] };
    };
    f.effects.stateEvent = async (queue, item) => {
      const ident = item.get('id');
      f.log.push(`event:${String(ident)}`);
      if (ident === 'second') throw new Error('second event failed');
      return queue;
    };
    await expect(inventoryTransaction(f.effects, { reportOnly: false })).rejects.toThrow(
      'second event failed',
    );
    expect(f.log).toEqual(['lock:180', 'lock:600', 'event:new', 'event:second']);
  });

  it('refuses a new job identity collision', () => {
    const original = doc('{"items":[]}');
    const current = doc('{"items":[{"id":"same"}]}');
    const prepared = doc('{"items":[{"id":"same"}]}');
    expect(() => mergeInventory(original, current, prepared)).toThrow('identity collision');
  });
});
