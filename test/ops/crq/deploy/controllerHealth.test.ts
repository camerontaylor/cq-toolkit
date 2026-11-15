import { describe, expect, test } from 'vitest';
import {
  OSError,
  Refused,
  ValueError,
  drainCheck,
  healthObservation,
  parseIso,
  pyRepr,
  readQueue,
  strictTick,
  tickValue,
  twoSlotHealth,
  waitForFirstTick,
  type DrainEffects,
  type HealthEffects,
  type Liveness,
  type Result,
} from '../../../../src/ops/crq/deploy/controllerHealth.js';

const RID = 'item-1-20261115T010203Z';
function drainFx(queue: unknown, exits: string[] = []): DrainEffects {
  return {
    stateDir: () => '/s',
    readJson: async (rel) => {
      if (rel !== 'queue.json') throw new Error('bad rel');
      if (queue instanceof Error) throw queue;
      return queue;
    },
    exists: async (p) => exits.includes(p),
  };
}
const alive: Liveness = async () => 'alive';
const harvest: Liveness = async () => 'harvest';

describe('readQueue', () => {
  test('refuses non-object roots with the Python type name', async () => {
    await expect(readQueue(drainFx(null))).rejects.toThrow(
      'queue.json root is NoneType, not a JSON object',
    );
    await expect(readQueue(drainFx([]))).rejects.toThrow('root is list');
    await expect(readQueue(drainFx('x'))).rejects.toThrow('root is str');
    await expect(readQueue(drainFx(3))).rejects.toThrow('root is int');
  });
  test('refuses a non-array items, accepts a missing one', async () => {
    await expect(readQueue(drainFx({ items: {} }))).rejects.toThrow('items is not a JSON array');
    await expect(readQueue(drainFx({ items: null }))).rejects.toThrow('items is not a JSON array');
    expect(await readQueue(drainFx({}))).toEqual({});
  });
});

describe('drainCheck', () => {
  test('empty queue is drained', async () => {
    expect(await drainCheck(drainFx({ items: [] }), alive)).toEqual({ blocked: [], drained: true });
    expect(await drainCheck(drainFx({}), alive)).toEqual({ blocked: [], drained: true });
  });
  test('unreadable queue becomes Refused with clipped message; other errors propagate', async () => {
    const e = await drainCheck(drainFx(new OSError('x'.repeat(300))), alive).catch(
      (x: unknown) => x,
    );
    expect(e).toBeInstanceOf(Refused);
    expect((e as Error).message).toBe(
      `queue unreadable, refusing to reason about drain: ${'x'.repeat(160)}`,
    );
    await expect(drainCheck(drainFx(new ValueError('bad json')), alive)).rejects.toThrow(Refused);
    await expect(drainCheck(drainFx(null), alive)).rejects.toThrow('root is NoneType');
    await expect(drainCheck(drainFx(new TypeError('boom')), alive)).rejects.not.toBeInstanceOf(
      Refused,
    );
  });
  test('malformed item, unstarted, consumed and damaged run records', async () => {
    const q = {
      items: [5, { id: 'a' }, { id: 'b', run: null }, { id: 'c', run: 'x' }, { run: [] }],
    };
    expect(await drainCheck(drainFx(q), alive)).toEqual({
      drained: false,
      blocked: [
        { item: null, state: 'ambiguous', reason: 'malformed queue item' },
        { item: 'c', state: 'ambiguous', reason: 'malformed recorded run metadata' },
        { item: null, state: 'ambiguous', reason: 'malformed recorded run metadata' },
      ],
    });
  });
  test('run id must match the pattern, be a string and be at most 255 chars', async () => {
    const bad = [
      undefined,
      5,
      '',
      '../x',
      'a/b',
      'abc',
      'x'.repeat(256),
      '../deadbeef',
      'deadbeef/',
      'deadbeef\n',
      `${'a'.repeat(250)}-20261115T010203Z`,
    ];
    for (const run_id of bad) {
      const r = await drainCheck(drainFx({ items: [{ id: 'i', run: { run_id } }] }), alive);
      expect(r['blocked']).toEqual([{ item: 'i', state: 'ambiguous', reason: 'malformed run id' }]);
    }
    for (const ok of ['deadbeef', RID, 'a-b.c_d+e-20261115T010203Z', 'abcdef01-2345-6789']) {
      const r = await drainCheck(drainFx({ items: [{ id: 'i', run: { run_id: ok } }] }), harvest);
      expect(r).toEqual({ blocked: [], drained: true });
    }
  });
  test('passes rdir, item, run and has_exit to the probe; alive and ambiguous block, harvest and others do not', async () => {
    const calls: unknown[] = [];
    const states = ['alive', 'ambiguous', 'harvest', 'dead'];
    let i = 0;
    const live: Liveness = async (rdir, item, run, hasExit) => {
      calls.push([rdir, item['id'], run['run_id'], hasExit]);
      return states[i++]!;
    };
    const items = states.map((_, n) => ({ id: `i${String(n)}`, run: { run_id: RID } }));
    const r = await drainCheck(drainFx({ items }, [`/s/runs/${RID}/exit.json`]), live);
    expect(calls[0]).toEqual([`/s/runs/${RID}`, 'i0', RID, true]);
    expect(r).toEqual({
      drained: false,
      blocked: [
        { item: 'i0', state: 'alive', run: RID },
        { item: 'i1', state: 'ambiguous', run: RID },
      ],
    });
  });
  test('has_exit false when no exit.json', async () => {
    let seen: boolean | null = null;
    await drainCheck(
      drainFx({ items: [{ id: 'i', run: { run_id: RID } }] }),
      async (_d, _i, _r, h) => {
        seen = h;
        return 'harvest';
      },
    );
    expect(seen).toBe(false);
  });
  test('a throwing probe is ambiguous with a clipped reason and does not stop the scan', async () => {
    const live: Liveness = async (_d, item) => {
      if (item['id'] === 'a') throw new Error('y'.repeat(200));
      return 'alive';
    };
    const items = [
      { id: 'a', run: { run_id: RID } },
      { id: 'b', run: { run_id: RID } },
    ];
    expect((await drainCheck(drainFx({ items }), live))['blocked']).toEqual([
      { item: 'a', state: 'ambiguous', reason: `liveness probe failed: ${'y'.repeat(120)}` },
      { item: 'b', state: 'alive', run: RID },
    ]);
  });
});

describe('time helpers', () => {
  test('parseIso mirrors strptime: calendar-real, 1-2 digit fields allowed', () => {
    expect(parseIso('2026-11-15T01:02:03Z').toISOString()).toBe('2026-11-15T01:02:03.000Z');
    expect(parseIso('2026-1-5T1:2:3Z').toISOString()).toBe('2026-01-05T01:02:03.000Z');
    expect(parseIso('2024-02-29T00:00:00Z')).toBeInstanceOf(Date);
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-01-00T00:00:00Z',
      '2026-01-01T24:00:00Z',
      '2026-01-01T00:60:00Z',
      '2026-01-01T00:00:60Z',
      '0000-01-01T00:00:00Z',
      '2026-01-01T00:00:00',
      '2026-01-01T00:00:00Z\n',
      '2026-01-01 00:00:00Z',
      '2023-02-29T00:00:00Z',
    ])
      expect(() => parseIso(bad), bad).toThrow(ValueError);
  });
  test('strictTick requires the zero-padded producer shape and a real calendar', () => {
    expect(strictTick('2026-11-15T01:02:03Z')).toBe(true);
    expect(strictTick('2026-1-5T1:2:3Z')).toBe(false);
    expect(strictTick('2026-02-30T00:00:00Z')).toBe(false);
    expect(strictTick('2026-11-15T01:02:03Z\n')).toBe(false);
  });
  test('pyRepr follows Python repr quoting', () => {
    expect(pyRepr('a')).toBe("'a'");
    expect(pyRepr("it's")).toBe('"it\'s"');
    expect(pyRepr('a\'b"c')).toBe("'a\\'b\"c'");
    expect(pyRepr('a\nb\\')).toBe("'a\\nb\\\\'");
    expect(pyRepr(null)).toBe('None');
    expect(pyRepr(true)).toBe('True');
    expect(pyRepr([1, 'x', null])).toBe("[1, 'x', None]");
    expect(pyRepr({ a: 1 })).toBe("{'a': 1}");
  });
});

const T0 = '2026-11-15T01:00:00Z';
const T1 = '2026-11-15T01:01:00Z';
const T2 = '2026-11-15T01:02:00Z';
function healthFx(
  over: Partial<HealthEffects> & { ticks?: string[] } = {},
): HealthEffects & { log: string[] } {
  const log: string[] = [];
  const ticks = over.ticks ?? [T1];
  let i = 0;
  const { ticks: _t, ...rest } = over;
  void _t;
  return {
    log,
    root: '/repo',
    readCompletionHeartbeat: async () => {
      log.push('hb');
      return { root: '/repo/apps/crq-python', last_tick: ticks[Math.min(i++, ticks.length - 1)] };
    },
    runMetadataSample: async () => null,
    receiptValidation: async () => null,
    ...rest,
  };
}

describe('tickValue', () => {
  test('refuses a missing heartbeat', async () => {
    await expect(
      tickValue(healthFx({ readCompletionHeartbeat: async () => null })),
    ).rejects.toThrow(
      "no completion heartbeat observed under the runner's WATCHDOG_HOME; cannot assess health",
    );
  });
  test('refuses another checkout root, with repr in the message', async () => {
    const fx = healthFx({
      readCompletionHeartbeat: async () => ({ root: '/other', last_tick: T1 }),
    });
    const e = await tickValue(fx).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(Refused);
    expect((e as Error).message).toBe(
      "completion heartbeat root '/other' is not this checkout's runner directory '/repo/apps/crq-python'",
    );
    const none = healthFx({ readCompletionHeartbeat: async () => ({ last_tick: T1 }) });
    await expect(tickValue(none)).rejects.toThrow('root None is not');
  });
  test('refuses a non-strict last_tick', async () => {
    for (const last_tick of [undefined, 5, '2026-02-30T00:00:00Z', 'x'.repeat(200)]) {
      const fx = healthFx({
        readCompletionHeartbeat: async () => ({ root: '/repo/apps/crq-python', last_tick }),
      });
      const e = await tickValue(fx).catch((x: unknown) => x);
      expect((e as Error).message).toMatch(
        /^completion heartbeat last_tick .* is not a strict UTC YYYY-MM-DDTHH:MM:SSZ timestamp$/,
      );
    }
    const long = healthFx({
      readCompletionHeartbeat: async () => ({
        root: '/repo/apps/crq-python',
        last_tick: 'x'.repeat(200),
      }),
    });
    await expect(tickValue(long)).rejects.toThrow(`last_tick '${'x'.repeat(79)} is not`);
  });
  test('returns the strict value', async () => {
    expect(await tickValue(healthFx())).toBe(T1);
  });
});

describe('healthObservation', () => {
  test('advanced is strictly later, equal is not', async () => {
    expect((await healthObservation(healthFx(), T0))['advanced']).toBe(true);
    expect((await healthObservation(healthFx(), T1))['advanced']).toBe(false);
    expect((await healthObservation(healthFx(), T2))['advanced']).toBe(false);
  });
  test('a malformed prior tick is a ValueError before the heartbeat is read', async () => {
    const fx = healthFx();
    await expect(healthObservation(fx, 'nope')).rejects.toThrow(ValueError);
    expect(fx.log).toEqual([]);
  });
  test('receipt verdicts: null without a sample or validation', async () => {
    const r = await healthObservation(healthFx(), T0);
    expect(r).toEqual({
      observed_tick: T1,
      advanced: true,
      receipts: null,
      receipts_readable: null,
      receipt_validation: null,
      receipts_valid: null,
    });
  });
  test('receipts_readable follows unreadable only when sampled; receipts_valid follows valid', async () => {
    const mk = (sample: Result | null, validation: Result | null) =>
      healthObservation(
        healthFx({
          runMetadataSample: async () => sample,
          receiptValidation: async () => validation,
        }),
        T0,
      );
    expect(await mk({ sampled: 3, unreadable: [] }, { valid: true })).toMatchObject({
      receipts_readable: true,
      receipts_valid: true,
    });
    expect(await mk({ sampled: 3, unreadable: [{ run: 'x' }] }, { valid: false })).toMatchObject({
      receipts_readable: false,
      receipts_valid: false,
    });
    expect(await mk({ sampled: 0, unreadable: [] }, null)).toMatchObject({
      receipts_readable: null,
      receipts_valid: null,
    });
    await expect(mk({ unreadable: [] }, null)).rejects.toThrow("KeyError: 'sampled'");
    await expect(mk(null, { ok: 1 })).rejects.toThrow("KeyError: 'valid'");
  });
});

describe('waitForFirstTick', () => {
  function clocks() {
    let now = 0;
    const sleeps: number[] = [];
    return {
      sleeps,
      clocks: {
        clock: () => now,
        sleep: async (s: number) => {
          sleeps.push(s);
          now += s;
        },
      },
    };
  }
  test('returns immediately when the first observation advanced', async () => {
    const c = clocks();
    const r = await waitForFirstTick(healthFx(), T0, 60, c.clocks);
    expect(r['advanced']).toBe(true);
    expect(c.sleeps).toEqual([]);
  });
  test('polls with min(5, remaining) sleeps until advanced', async () => {
    const c = clocks();
    const fx = healthFx({ ticks: [T0, T0, T1] });
    const r = await waitForFirstTick(fx, T0, 60, c.clocks);
    expect(r['observed_tick']).toBe(T1);
    expect(c.sleeps).toEqual([5, 5]);
  });
  test('gives up at the deadline with the last non-advanced observation; final sleep is the remainder', async () => {
    const c = clocks();
    const r = await waitForFirstTick(healthFx({ ticks: [T0] }), T0, 7, c.clocks);
    expect(r['advanced']).toBe(false);
    expect(c.sleeps).toEqual([5, 2]);
  });
  test('a zero timeout still observes exactly once', async () => {
    const c = clocks();
    const fx = healthFx({ ticks: [T0] });
    await waitForFirstTick(fx, T0, 0, c.clocks);
    expect(fx.log).toEqual(['hb']);
    expect(c.sleeps).toEqual([]);
  });
});

describe('twoSlotHealth', () => {
  const obs = (tick: string, extra: Result = {}): Result => ({
    observed_tick: tick,
    advanced: true,
    ...extra,
  });
  test('healthy: two advancing observations, each against the previous tick', async () => {
    const seen: string[] = [];
    const queue = [obs(T1), obs(T2)];
    const r = await twoSlotHealth(healthFx({ ticks: [T0] }), async (p) => {
      seen.push(p);
      return queue.shift()!;
    });
    expect(seen).toEqual([T0, T1]);
    expect(r).toEqual({
      healthy: true,
      observations: [obs(T1), obs(T2)],
      receipts_readable: null,
      receipts_valid: null,
    });
  });
  test('first not advancing stops after one observation', async () => {
    let n = 0;
    const r = await twoSlotHealth(
      healthFx({ ticks: [T0] }),
      async () => (++n, { observed_tick: T0, advanced: false }),
    );
    expect(n).toBe(1);
    expect(r['healthy']).toBe(false);
    expect(r['reason']).toBe(`first observation did not advance past ${T0}`);
  });
  test('second not advancing reports both and the second tick', async () => {
    const queue: Result[] = [obs(T1), { observed_tick: T1, advanced: false }];
    const r = await twoSlotHealth(healthFx({ ticks: [T0] }), async () => queue.shift()!);
    expect(r['healthy']).toBe(false);
    expect(r['reason']).toBe(`second observation did not advance past ${T1}`);
    expect((r['observations'] as unknown[]).length).toBe(2);
  });
  test('receipt verdicts: any false wins, nulls are skipped, all null stays null', async () => {
    const run = async (a: Result, b: Result) => {
      const q = [a, b];
      return twoSlotHealth(healthFx({ ticks: [T0] }), async () => q.shift()!);
    };
    expect(
      await run(
        obs(T1, { receipts_readable: true, receipts_valid: true }),
        obs(T2, { receipts_readable: false, receipts_valid: null }),
      ),
    ).toMatchObject({ receipts_readable: false, receipts_valid: true });
    expect(
      await run(obs(T1, { receipts_readable: null }), obs(T2, { receipts_readable: true })),
    ).toMatchObject({ receipts_readable: true, receipts_valid: null });
    expect(
      await run(obs(T1, { receipts_valid: 1 }), obs(T2, { receipts_valid: true })),
    ).toMatchObject({ receipts_valid: false });
  });
  test('failure results carry the receipt verdicts too', async () => {
    const r = await twoSlotHealth(healthFx({ ticks: [T0] }), async () => ({
      observed_tick: T0,
      advanced: false,
      receipts_valid: false,
    }));
    expect(r).toMatchObject({ healthy: false, receipts_valid: false, receipts_readable: null });
  });
  test('a missing observed_tick on a first advance is a KeyError', async () => {
    await expect(
      twoSlotHealth(healthFx({ ticks: [T0] }), async () => ({ advanced: true })),
    ).rejects.toThrow("KeyError: 'observed_tick'");
  });
});
