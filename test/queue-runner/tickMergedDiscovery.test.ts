import { describe, expect, it } from 'vitest';
import { JsonNumber, JsonObject } from '../../src/policy/crq/jsonValue.js';
import type { ReconcileInterval } from '../../src/policy/crq/reconcileCheckpoint.js';
import {
  runMergedDiscoveryStep,
  type TickMergedDiscoveryEffects,
} from '../../src/queue-runner/tickMergedDiscovery.js';

const NOW = new Date('2026-11-15T12:00:00Z');
const obj = (entries: Array<[string, unknown]>) => new JsonObject(entries as never);
const cfg = (extra: Array<[string, unknown]> = []) =>
  obj([['enabled', true], ['after', '2026-11-01T00:00:00Z'], ...extra]);

function setup(over: Partial<TickMergedDiscoveryEffects> = {}, returned?: JsonObject) {
  const calls: ReconcileInterval[] = [];
  const fx: TickMergedDiscoveryEffects = {
    now: () => NOW,
    discover: async (interval) => {
      calls.push(interval);
      return {
        queue: returned ?? obj([['marker', 1]]),
        summary: obj([
          ['complete', true],
          ['represented', JsonNumber.int(7)],
        ]),
        pruned: 0,
      };
    },
    ...over,
  };
  return { fx, calls };
}

describe('runMergedDiscoveryStep', () => {
  it('does nothing unless the config is an object with enabled exactly true', async () => {
    const q = obj([['items', []]]);
    for (const c of [
      undefined,
      null,
      'x',
      obj([]),
      obj([['enabled', 'true']]),
      obj([['enabled', 1]]),
      obj([['enabled', false]]),
    ]) {
      const h = setup();
      expect(await runMergedDiscoveryStep(q, c, h.fx)).toEqual({ queue: q, log: [] });
      expect(h.calls).toEqual([]);
    }
  });

  it('computes the rolling interval from config.after and now - 1 s', async () => {
    const h = setup();
    await runMergedDiscoveryStep(obj([]), cfg(), h.fx);
    expect(h.calls).toEqual([{ after: '2026-11-01T00:00:00Z', before: '2026-11-15T11:59:59Z' }]);
  });

  it('logs a complete scan, carries the returned queue, and adds reason/prune lines', async () => {
    const q2 = obj([['marker', 2]]);
    const plain = setup({}, q2);
    const r = await runMergedDiscoveryStep(obj([]), cfg(), plain.fx);
    expect(r.queue).toBe(q2);
    expect(r.log).toEqual(['merged discovery: complete=True represented=7']);
    const h = setup({
      discover: async () => ({
        queue: q2,
        summary: obj([
          ['complete', false],
          ['represented', JsonNumber.int(0)],
          ['reason', 'page-budget'],
        ]),
        pruned: 3,
      }),
    });
    expect((await runMergedDiscoveryStep(obj([]), cfg(), h.fx)).log).toEqual([
      'merged discovery: complete=False represented=0 reason=page-budget',
      'pruned 3 completed rolling discovery checkpoint(s)',
    ]);
  });

  it('falls back on an invalid configured interval without calling discover', async () => {
    for (const c of [
      obj([['enabled', true]]),
      obj([
        ['enabled', true],
        ['after', 'bogus'],
      ]),
      obj([
        ['enabled', true],
        ['after', '2027-01-01T00:00:00Z'],
      ]),
    ]) {
      const h = setup();
      const r = await runMergedDiscoveryStep(
        obj([
          [
            'merged_discovery',
            obj([
              ['after', 'a'],
              ['complete', true],
            ]),
          ],
        ]),
        c,
        h.fx,
      );
      expect(h.calls).toEqual([]);
      expect(r.log).toEqual(['merged discovery disabled: invalid configured interval']);
      expect(r.queue.get('merged_discovery')).toEqual(
        obj([
          ['after', 'a'],
          ['complete', false],
        ]),
      );
    }
  });

  it('creates merged_discovery on fallback, and treats an invalid watermark like Python ValueError/TypeError', async () => {
    const h = setup();
    const r = await runMergedDiscoveryStep(obj([['merged_watermark', 'not-a-time']]), cfg(), h.fx);
    expect(r.queue.get('merged_discovery')).toEqual(obj([['complete', false]]));
    expect(r.log).toHaveLength(1);
    const n = await runMergedDiscoveryStep(
      obj([['merged_watermark', JsonNumber.int(5)]]),
      cfg(),
      h.fx,
    );
    expect(n.log).toEqual(['merged discovery disabled: invalid configured interval']);
  });

  it('raises when the fallback meets a non-object merged_discovery', async () => {
    for (const bad of ['x', null, []]) {
      await expect(
        runMergedDiscoveryStep(
          obj([['merged_discovery', bad]]),
          obj([['enabled', true]]),
          setup().fx,
        ),
      ).rejects.toThrow(TypeError);
    }
  });

  it('logs a partition and a retained debt from the saved refusal record', async () => {
    const part = obj([
      [
        'merged_discovery',
        obj([
          ['after', 'A'],
          ['before', 'B'],
          ['complete', false],
          ['error', 'cap'],
          ['reason', 'inventory-cap-partitioned'],
        ]),
      ],
    ]);
    const fail = obj([
      [
        'merged_discovery',
        obj([
          ['after', 'A'],
          ['before', 'B'],
          ['complete', false],
          ['error', 'page 3 failed'],
          ['reason', 'page-failed'],
        ]),
      ],
    ]);
    const mk = (queue: JsonObject) =>
      setup({
        discover: async () => ({
          queue,
          summary: obj([
            ['complete', false],
            ['reason', 'x'],
          ]),
          pruned: 0,
        }),
      });
    expect((await runMergedDiscoveryStep(obj([]), cfg(), mk(part).fx)).log).toEqual([
      'merged discovery incomplete; inventory cap: partitioned to (A, B]',
    ]);
    const f = await runMergedDiscoveryStep(obj([]), cfg(), mk(fail).fx);
    expect(f.log).toEqual(['merged discovery incomplete; cursor/debt retained: page 3 failed']);
    expect(f.queue).toBe(fail);
  });

  it('does not swallow non-interval errors raised while choosing the interval', async () => {
    const h = setup({
      now: () => {
        throw new Error('clock');
      },
    });
    await expect(runMergedDiscoveryStep(obj([]), cfg(), h.fx)).rejects.toThrow('clock');
    expect(h.calls).toEqual([]);
  });

  it('lets discover errors and a summary without represented escape', async () => {
    const boom = setup({
      discover: async () => {
        throw new Error('disk');
      },
    });
    await expect(runMergedDiscoveryStep(obj([]), cfg(), boom.fx)).rejects.toThrow('disk');
    const bad = setup({
      discover: async () => ({ queue: obj([]), summary: obj([['complete', true]]), pruned: 0 }),
    });
    await expect(runMergedDiscoveryStep(obj([]), cfg(), bad.fx)).rejects.toThrow(TypeError);
  });
});
