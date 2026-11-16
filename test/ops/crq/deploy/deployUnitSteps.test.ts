import { describe, expect, test } from 'vitest';
import {
  FailStop,
  Refused,
  dumpSorted,
  drainServices,
  restartTriggers,
  stopTriggers,
  type UnitControl,
} from '../../../../src/ops/crq/deploy/deployUnitSteps.js';

function units(states: Record<string, string[]>) {
  const log: string[] = [];
  const u: UnitControl = {
    stop: async (n) => void log.push(`stop ${n.join(',')}`),
    start: async (n) => void log.push(`start ${n.join(',')}`),
    state: async (n) => {
      const q = states[n]!;
      return q.length > 1 ? q.shift()! : q[0]!;
    },
  };
  return { u, log };
}

describe('stopTriggers', () => {
  test('requires the hold before touching units, stops sorted, accepts dead states', async () => {
    const a = units({ 'b.timer': ['inactive'], 'a.timer': ['failed'] });
    await expect(
      stopTriggers({ holdOwns: async () => false, units: a.u, triggers: ['b.timer', 'a.timer'] }),
    ).rejects.toThrow('hold lost before trigger stop');
    expect(a.log).toEqual([]);
    await stopTriggers({
      holdOwns: async () => true,
      units: a.u,
      triggers: ['b.timer', 'a.timer'],
    });
    expect(a.log).toEqual(['stop a.timer,b.timer']);
  });
  test('an unsettled trigger refuses with sorted json evidence', async () => {
    const a = units({ 'b.timer': ['active'], 'a.timer': ['inactive'] });
    const err = await stopTriggers({
      holdOwns: async () => true,
      units: a.u,
      triggers: ['b.timer', 'a.timer'],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Refused);
    expect((err as Error).message).toBe(
      'trigger stop did not settle: {"a.timer": "inactive", "b.timer": "active"}',
    );
  });
});

describe('drainServices', () => {
  test('polls every 5s until dead, and returns at once when empty', async () => {
    const a = units({ 's.service': ['active', 'deactivating', 'inactive'] });
    let t = 0;
    const sleeps: number[] = [];
    await drainServices({
      units: a.u,
      services: ['s.service'],
      deadlineS: 100,
      clock: () => t,
      sleep: async (s) => void (sleeps.push(s), (t += s)),
    });
    expect(sleeps).toEqual([5, 5]);
    await drainServices({
      units: a.u,
      services: [],
      deadlineS: 0,
      clock: () => 1e9,
      sleep: async () => {
        throw new Error('slept');
      },
    });
  });
  test('expiry is a FailStop naming the deadline and states; the deadline is inclusive', async () => {
    const a = units({ 's.service': ['active'] });
    let t = 0;
    const err = await drainServices({
      units: a.u,
      services: ['s.service'],
      deadlineS: 10,
      clock: () => t,
      sleep: async (s) => void (t += s),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FailStop);
    expect(err).toBeInstanceOf(Refused);
    expect((err as Error).message).toBe(
      'service drain expired after 10s; hold retained, nothing killed: {"s.service": "active"}',
    );
    expect(t).toBe(10);
  });
});

describe('restartTriggers', () => {
  const original = { 'a.timer': 'active', 'b.timer': 'inactive' };
  test('starts only the originally active units and returns the verified map', async () => {
    const a = units({ 'a.timer': ['active'], 'b.timer': ['inactive'] });
    expect(
      await restartTriggers({ units: a.u, triggers: ['a.timer', 'b.timer'], original }),
    ).toEqual(original);
    expect(a.log).toEqual(['start a.timer']);
  });
  test('a first-read mismatch refuses with both maps', async () => {
    const a = units({ 'a.timer': ['inactive'], 'b.timer': ['inactive'] });
    await expect(
      restartTriggers({ units: a.u, triggers: ['a.timer', 'b.timer'], original }),
    ).rejects.toThrow(
      'trigger restart mismatch: observed {"a.timer": "inactive", "b.timer": "inactive"} expected {"a.timer": "active", "b.timer": "inactive"}',
    );
  });
  test('a second-read flap refuses as a verification mismatch', async () => {
    const a = units({ 'a.timer': ['active', 'inactive'], 'b.timer': ['inactive'] });
    await expect(
      restartTriggers({ units: a.u, triggers: ['a.timer', 'b.timer'], original }),
    ).rejects.toThrow(
      'trigger restart verification mismatch: second read {"a.timer": "inactive", "b.timer": "inactive"}',
    );
  });
});

describe('dumpSorted', () => {
  test('matches json.dumps(sort_keys=True): code-point key order, ascii escapes, spaced separators', () => {
    expect(dumpSorted({ '\u{1F600}': 'x', '\uFF5E': 'é', a: 'b' })).toBe(
      '{"a": "b", "\\uff5e": "\\u00e9", "\\ud83d\\ude00": "x"}',
    );
  });
});
