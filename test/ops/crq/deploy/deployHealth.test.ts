import { describe, expect, test } from 'vitest';
import {
  FailStop,
  Refused,
  checkHealth,
  drainQueue,
  type DrainDeps,
  type HealthDeps,
  type Result,
} from '../../../../src/ops/crq/deploy/deployHealth.js';

type Rec = { name: string; value: Result };
function drainFixture(polls: Result[], over: Partial<DrainDeps<string>> = {}) {
  const log: string[] = [];
  const records: Rec[] = [];
  let now = 0;
  let i = 0;
  const deps: DrainDeps<string> = {
    controller: {
      runnerLiveness: async (e) => {
        log.push(`liveness:${e}`);
        return 'L';
      },
      drainCheck: async (e, l) => {
        log.push(`check:${e}:${String(l)}`);
        return polls[Math.min(i++, polls.length - 1)]!;
      },
    },
    effects: 'fx',
    writeRecord: async (name, value) => {
      records.push({ name, value });
    },
    clock: () => now,
    sleep: async (s) => {
      log.push(`sleep:${String(s)}`);
      now += s;
    },
    drainDeadlineS: 10,
    drainIntervalS: 3,
    ...over,
  };
  return { deps, log, records };
}

describe('drainQueue', () => {
  test('injected drainFn: one poll, record, no controller calls', async () => {
    const f = drainFixture([], { drainFn: async () => ({ drained: true }) });
    await drainQueue(f.deps);
    expect(f.log).toEqual([]);
    expect(f.records).toEqual([
      {
        name: 'drain.json',
        value: { polls: [{ drained: true }], drained: true, deadline_s: null },
      },
    ]);
  });
  test('injected drainFn not drained: records then fail-stops with sorted blocked json', async () => {
    const f = drainFixture([], {
      drainFn: async () => ({ drained: false, blocked: { b: 1, a: 'é' } }),
    });
    const err = await drainQueue(f.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailStop);
    expect((err as Error).message).toBe(
      'queue drain expired; hold retained, nothing killed: {"a": "\\u00e9", "b": 1}',
    );
    expect(f.records[0]!.value.drained).toBe(false);
    expect(f.records[0]!.value.deadline_s).toBeNull();
  });
  test('polls until drained, sleeping the interval between polls', async () => {
    const f = drainFixture([{ drained: false }, { drained: false }, { drained: true }]);
    await drainQueue(f.deps, 'x.json');
    expect(f.log).toEqual([
      'liveness:fx',
      'check:fx:L',
      'sleep:3',
      'check:fx:L',
      'sleep:3',
      'check:fx:L',
    ]);
    expect(f.records).toHaveLength(1);
    expect(f.records[0]!.name).toBe('x.json');
    expect(f.records[0]!.value).toEqual({
      polls: [{ drained: false }, { drained: false }, { drained: true }],
      drained: true,
      deadline_s: 10,
    });
  });
  test('liveness is read once, before the first poll', async () => {
    const f = drainFixture([{ drained: false }, { drained: true }]);
    await drainQueue(f.deps);
    expect(f.log.filter((l) => l.startsWith('liveness'))).toHaveLength(1);
    expect(f.log[0]).toBe('liveness:fx');
  });
  test('deadline: records the polls and fail-stops after the poll that reaches it', async () => {
    const f = drainFixture([{ drained: false, blocked: ['w'] }]);
    const err = await drainQueue(f.deps).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailStop);
    expect((err as Error).message).toBe(
      'queue drain expired after 10s; hold retained, nothing killed: ["w"]',
    );
    // now: 0,3,6,9 -> poll at 9 sleeps to 12 -> poll at 12 >= 10 stops
    expect(f.log.filter((l) => l.startsWith('check'))).toHaveLength(5);
    expect(f.records[0]!.value.drained).toBe(false);
    expect(f.records[0]!.value.deadline_s).toBe(10);
    expect((f.records[0]!.value.polls as unknown[]).length).toBe(5);
  });
  test('stops when the clock equals the deadline exactly (>=, not >)', async () => {
    const f = drainFixture([{ drained: false }], { drainDeadlineS: 9 });
    await expect(drainQueue(f.deps)).rejects.toBeInstanceOf(FailStop);
    // now: 0,3,6,9 -> the poll at 9 stops
    expect(f.log.filter((l) => l.startsWith('check'))).toHaveLength(4);
  });
  test('a poll that drains exactly at the deadline still succeeds', async () => {
    let n = 0;
    const f = drainFixture([], {
      drainDeadlineS: 0,
      controller: {
        runnerLiveness: async () => 'L',
        drainCheck: async () => ({ drained: ++n > 0 }),
      },
    });
    await drainQueue(f.deps);
    expect(f.records[0]!.value.drained).toBe(true);
  });
  test('a poll without a drained key is a KeyError, nothing recorded', async () => {
    const f = drainFixture([{ blocked: [] }]);
    await expect(drainQueue(f.deps)).rejects.toThrow("KeyError: 'drained'");
    expect(f.records).toEqual([]);
  });
  test('Refused is the base of FailStop', () => {
    expect(new FailStop('x')).toBeInstanceOf(Refused);
    expect(new Refused('x').name).toBe('Refused');
    expect(new FailStop('x').name).toBe('FailStop');
  });
});

function healthFixture(over: Partial<HealthDeps<string>> = {}, twoSlot?: Result) {
  const log: string[] = [];
  let now = 100;
  const deps: HealthDeps<string> = {
    controller: {
      waitForFirstTick: async (e, prior, timeout, clocks) => {
        log.push(`first:${e}:${String(prior)}:${String(timeout)}:${String(clocks.clock())}`);
        await clocks.sleep(1);
        return 'T1';
      },
      healthObservation: async (e, prior) => {
        log.push(`obs:${e}:${String(prior)}`);
        return 'T2';
      },
      twoSlotHealth: async (_e, observe) => {
        const a = await observe('P0');
        const b = await observe(a);
        log.push(`seen:${String(a)}:${String(b)}`);
        return twoSlot ?? { healthy: true, ticks: 2 };
      },
    },
    effects: 'fx',
    units: {
      state: async (u) => {
        log.push(`state:${u}`);
        return 'active';
      },
    },
    triggers: ['a.timer', 'b.path'],
    original: { 'a.timer': 'active', 'b.path': 'inactive' },
    clock: () => now,
    sleep: async (s) => {
      log.push(`sleep:${String(s)}`);
      now += s;
    },
    healthTimeoutS: 60,
    healthIntervalS: 5,
    ...over,
  };
  return { deps, log };
}

describe('checkHealth', () => {
  test('injected healthFn is returned untouched with no controller or unit calls', async () => {
    const r = { healthy: false };
    const f = healthFixture({ healthFn: async () => r });
    expect(await checkHealth(f.deps)).toBe(r);
    expect(f.log).toEqual([]);
  });
  test('first observation waits for the first tick, later ones sleep the interval', async () => {
    const f = healthFixture();
    const r = await checkHealth(f.deps);
    expect(f.log.slice(0, 5)).toEqual([
      'first:fx:P0:60:100',
      'sleep:1',
      'sleep:5',
      'obs:fx:T1',
      'seen:T1:T2',
    ]);
    expect(r).toEqual({
      healthy: true,
      ticks: 2,
      unit_states: { 'a.timer': 'active', 'b.path': 'active' },
    });
  });
  test('a zero interval skips the sleep', async () => {
    const f = healthFixture({ healthIntervalS: 0 });
    await checkHealth(f.deps);
    expect(f.log).not.toContain('sleep:0');
    expect(f.log.filter((l) => l.startsWith('sleep'))).toEqual(['sleep:1']);
  });
  test('an originally-active trigger now not active forces unhealthy with the reason', async () => {
    const f = healthFixture({
      units: { state: async (u) => (u === 'a.timer' ? 'failed' : 'inactive') },
    });
    const r = await checkHealth(f.deps);
    expect(r['healthy']).toBe(false);
    expect(r['reason']).toBe('restarted trigger(s) not active: {"a.timer": "failed"}');
    expect(r['unit_states']).toEqual({ 'a.timer': 'failed', 'b.path': 'inactive' });
  });
  test('an originally-inactive trigger that stays inactive does not affect health', async () => {
    const f = healthFixture({
      units: { state: async (u) => (u === 'a.timer' ? 'active' : 'inactive') },
    });
    const r = await checkHealth(f.deps);
    expect(r['healthy']).toBe(true);
    expect(r).not.toHaveProperty('reason');
  });
  test('an already-unhealthy controller result keeps its own reason when triggers are fine', async () => {
    const f = healthFixture({}, { healthy: false, reason: 'no tick' });
    const r = await checkHealth(f.deps);
    expect(r['healthy']).toBe(false);
    expect(r['reason']).toBe('no tick');
  });
  test('does not mutate the controller result object', async () => {
    const own: Result = { healthy: true };
    const f = healthFixture({}, own);
    await checkHealth(f.deps);
    expect(own).toEqual({ healthy: true });
  });
});
