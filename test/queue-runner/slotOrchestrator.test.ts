import { describe, expect, it } from 'vitest';
import { JsonNumber, JsonObject } from '../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../src/policy/crq/queueDoc.js';
import {
  runScheduledSlot,
  runSlot,
  SLOT_QUEUE_CHANGED_LOG,
  SLOT_RUNNER_DISABLED_LOG,
  type ScheduledSlotPhases,
  type SlotLock,
} from '../../src/queue-runner/slotOrchestrator.js';

const base = () => new JsonObject([['n', JsonNumber.int(0)]]);
const nOf = (q: JsonObject) => {
  const n = q.get('n');
  return n instanceof JsonNumber ? Number(n.integer) : -1;
};
const bump = (q: JsonObject) => withObjectKeys(q, [['n', JsonNumber.int(nOf(q) + 1)]]);

function harness(over: Partial<ScheduledSlotPhases> = {}, loaded: JsonObject = base()) {
  const calls: string[] = [];
  const seen = new Map<string, number>();
  const saved: JsonObject[] = [];
  const deadline: unknown[][] = [];
  const admitReq: Array<{ usage: unknown; reserved: readonly unknown[]; log: readonly string[] }> =
    [];
  const p: ScheduledSlotPhases = {
    runnerDisabled: async () => (calls.push('runnerDisabled'), false),
    loadQueue: async () => (calls.push('loadQueue'), loaded),
    collectFinished: async (q) => (
      calls.push('collectFinished'),
      seen.set('collectFinished', nOf(q)),
      { queue: bump(q), log: ['C'] }
    ),
    readSlotUsage: async (q) => (
      calls.push('readSlotUsage'),
      seen.set('readSlotUsage', nOf(q)),
      { usage: 'U', reserved: ['r'] }
    ),
    admit: async (q, req) => (
      calls.push('admit'),
      seen.set('admit', nOf(q)),
      admitReq.push({ ...req, log: [...req.log] }),
      { queue: bump(q), log: ['A'], globalGate: 'slots', remaining: 3 }
    ),
    saveQueue: async (q) => void (calls.push('saveQueue'), seen.set('save', nOf(q)), saved.push(q)),
    refreshSlotDeadline: async (q, usage, remaining, gate, at) => (
      calls.push('refreshSlotDeadline'),
      seen.set('refreshSlotDeadline', nOf(q)),
      void deadline.push([usage, remaining, gate, at])
    ),
    nowMs: () => 1234,
    sameQueue: (a, b) => a === b,
    ...over,
  };
  return { p, calls, seen, saved, deadline, admitReq };
}

describe('runSlot', () => {
  it('runs collect, usage, admit, save, deadline in order, threading the queue', async () => {
    const h = harness();
    const log = await runSlot({}, h.p);
    expect(h.calls).toEqual([
      'runnerDisabled',
      'loadQueue',
      'collectFinished',
      'readSlotUsage',
      'admit',
      'saveQueue',
      'refreshSlotDeadline',
    ]);
    expect(h.seen.get('collectFinished')).toBe(0);
    expect(h.seen.get('readSlotUsage')).toBe(1);
    expect(h.seen.get('admit')).toBe(1);
    expect(h.seen.get('save')).toBe(2);
    expect(h.seen.get('refreshSlotDeadline')).toBe(2);
    expect(log).toEqual(['C', 'A']);
    expect(h.admitReq[0]).toEqual({ usage: 'U', reserved: ['r'], log: ['C'] });
    expect(h.deadline).toEqual([['U', 3, 'slots', 1234]]);
  });

  it('a disabled runner returns the handover line and touches nothing else', async () => {
    const h = harness({ runnerDisabled: async () => true });
    expect(await runSlot({}, h.p)).toEqual([SLOT_RUNNER_DISABLED_LOG]);
    expect(h.calls).toEqual([]);
  });

  it('a supplied queue is not reloaded, and a supplied observation is not re-read', async () => {
    const h = harness();
    const q = withObjectKeys(base(), [['n', JsonNumber.int(10)]]);
    await runSlot({ queue: q, observation: { usage: null, reserved: [] } }, h.p);
    expect(h.calls).not.toContain('loadQueue');
    expect(h.calls).not.toContain('readSlotUsage');
    expect(h.seen.get('collectFinished')).toBe(10);
    expect(h.admitReq[0]?.usage).toBeNull();
    expect(h.deadline[0]?.[0]).toBeNull();
  });

  it('a null usage observation is a real value, not a missing one', async () => {
    const h = harness();
    await runSlot({ observation: { usage: null, reserved: ['x', 'y'] } }, h.p);
    expect(h.calls).not.toContain('readSlotUsage');
    expect(h.admitReq[0]?.reserved).toEqual(['x', 'y']);
  });

  it('writes no status, heartbeat or summary: the seams do not exist', async () => {
    const h = harness();
    await runSlot({}, h.p);
    expect(Object.keys(h.p)).not.toContain('writeStatus');
  });

  const order = [
    'loadQueue',
    'collectFinished',
    'readSlotUsage',
    'admit',
    'saveQueue',
    'refreshSlotDeadline',
  ] as const;
  it.each(order)('%s throwing leaves every later phase unrun', async (name) => {
    const h = harness({
      [name]: async () => {
        throw new Error(`${name} failed`);
      },
    } as Partial<ScheduledSlotPhases>);
    await expect(runSlot({}, h.p)).rejects.toThrow(`${name} failed`);
    const full = ['runnerDisabled', ...order];
    expect(h.calls).toEqual(full.slice(0, full.indexOf(name)));
  });

  it('a failed admission saves nothing and sets no deadline', async () => {
    const h = harness({
      admit: async () => {
        throw new Error('launch');
      },
    });
    await expect(runSlot({}, h.p)).rejects.toThrow('launch');
    expect(h.saved).toEqual([]);
    expect(h.deadline).toEqual([]);
  });

  it('saves before the deadline is refreshed, so a deadline error keeps the save', async () => {
    const h = harness({
      refreshSlotDeadline: async () => {
        throw new Error('timer');
      },
    });
    await expect(runSlot({}, h.p)).rejects.toThrow('timer');
    expect(h.saved).toHaveLength(1);
  });
});

describe('runScheduledSlot', () => {
  function lockWith(busyOn: number[] = [], events: string[] = []): SlotLock {
    let acquires = 0;
    return {
      withLock: async (fn) => {
        acquires += 1;
        events.push('acquire' + String(acquires));
        if (busyOn.includes(acquires)) return { ran: false };
        try {
          return { ran: true, value: await fn() };
        } finally {
          events.push('release' + String(acquires));
        }
      },
    };
  }

  it('snapshots under the lock, probes outside it, then commits under a second lock', async () => {
    const events: string[] = [];
    const h = harness({
      readSlotUsage: async () => (events.push('probe'), { usage: 'U', reserved: [] }),
    });
    const loaded = h.p.loadQueue;
    h.p.loadQueue = async () => {
      events.push('load');
      return loaded();
    };
    const log = await runScheduledSlot(lockWith([], events), h.p);
    expect(events).toEqual([
      'acquire1',
      'load',
      'release1',
      'probe',
      'acquire2',
      'load',
      'release2',
    ]);
    expect(log).toEqual(['C', 'A']);
    // The pass runs on the snapshot with the probe taken outside the lock.
    expect(h.calls).toEqual([
      'runnerDisabled',
      'loadQueue',
      'loadQueue',
      'runnerDisabled',
      'collectFinished',
      'admit',
      'saveQueue',
      'refreshSlotDeadline',
    ]);
  });

  it('returns the handover line without taking the lock', async () => {
    const events: string[] = [];
    const h = harness({ runnerDisabled: async () => true });
    expect(await runScheduledSlot(lockWith([], events), h.p)).toEqual([SLOT_RUNNER_DISABLED_LOG]);
    expect(events).toEqual([]);
  });

  it('a busy first lock returns an empty log and never probes', async () => {
    const h = harness();
    expect(await runScheduledSlot(lockWith([1]), h.p)).toEqual([]);
    expect(h.calls).toEqual(['runnerDisabled']);
  });

  it('a busy commit lock returns an empty log and runs nothing after the probe', async () => {
    const h = harness();
    expect(await runScheduledSlot(lockWith([2]), h.p)).toEqual([]);
    expect(h.calls).toEqual(['runnerDisabled', 'loadQueue', 'readSlotUsage']);
  });

  it('a queue that changed during the probe discards the observation', async () => {
    let loads = 0;
    const h = harness({
      loadQueue: async () => ((loads += 1), loads === 1 ? base() : bump(base())),
      sameQueue: (a, b) => nOf(a) === nOf(b),
    });
    expect(await runScheduledSlot(lockWith(), h.p)).toEqual([SLOT_QUEUE_CHANGED_LOG]);
    expect(h.calls).toEqual(['runnerDisabled', 'readSlotUsage']);
  });

  it('commits the snapshot, not the freshly loaded queue, and re-checks the disabled marker under the lock', async () => {
    let checks = 0;
    const h = harness({
      loadQueue: async () => base(),
      sameQueue: () => true,
      runnerDisabled: async () => (checks += 1) >= 2,
    });
    expect(await runScheduledSlot(lockWith(), h.p)).toEqual([SLOT_RUNNER_DISABLED_LOG]);
    expect(h.calls).not.toContain('collectFinished');
  });

  it('releases the lock and propagates a commit error; a probe error never takes the second lock', async () => {
    const events: string[] = [];
    const bad = harness({
      admit: async () => {
        throw new Error('launch');
      },
    });
    await expect(runScheduledSlot(lockWith([], events), bad.p)).rejects.toThrow('launch');
    expect(events).toEqual(['acquire1', 'release1', 'acquire2', 'release2']);
    const events2: string[] = [];
    const probe = harness({
      readSlotUsage: async () => {
        throw new Error('quota');
      },
    });
    await expect(runScheduledSlot(lockWith([], events2), probe.p)).rejects.toThrow('quota');
    expect(events2).toEqual(['acquire1', 'release1']);
  });
});
