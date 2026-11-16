import { describe, expect, it } from 'vitest';
import {
  HeartbeatIoError,
  refreshSlotDeadline,
  writeHeartbeat,
  type HeartbeatEffects,
  type Item,
  type Queue,
  type SlotDeadlineEffects,
} from '../../src/queue-runner/slotDeadlineHeartbeat.js';

const AT = Date.parse('2026-11-15T12:00:30Z');
const MIN = 60_000;
const iso = (s: string): number => Date.parse(s);
const pend = (): Item => ({ id: 'p', state: 'pending' });

function dl(q: Partial<Queue> = {}, over: Partial<SlotDeadlineEffects> = {}) {
  const written: number[] = [];
  const next: Array<[unknown, number]> = [];
  const queue: Queue = { items: [pend()], ...q };
  const fx: SlotDeadlineEffects = {
    nowMs: () => AT,
    liveItems: (x) => x.items,
    parseIsoMs: (s) => (s === null || s === undefined ? null : iso(String(s))),
    nextSlot: (starts, at) => (next.push([starts, at]), AT + 5 * MIN),
    writeNext: async (h) => void written.push(h),
    ...over,
  };
  return { queue, fx, written, next };
}
const run = (
  h: ReturnType<typeof dl>,
  remaining = 3,
  gate: string | null = null,
  usage = null,
  at: number | undefined = AT,
) => refreshSlotDeadline(h.queue, usage, remaining, gate, at, h.fx);

describe('refreshSlotDeadline', () => {
  it('waits 12 minutes with available slots and an eligible item', async () => {
    const h = dl();
    expect(await run(h)).toBe(AT + 12 * MIN);
    expect(h.written).toEqual([AT + 12 * MIN]);
  });

  it('waits 12 minutes when paused, inflight-gated, or nothing is pending', async () => {
    for (const h of [dl({ paused: true }), dl(), dl({ items: [{ id: 'x', state: 'done' }] })]) {
      expect(
        await run(
          h,
          0,
          h.queue.paused ? null : h.queue.items[0]?.state === 'done' ? null : 'inflight',
        ),
      ).toBe(AT + 12 * MIN);
      expect(h.next).toEqual([]);
    }
  });

  it('waits for a future cooldown but ignores a past or equal one', async () => {
    const future = dl({ cooldown_until: '2026-11-15T12:30:00Z' });
    expect(await run(future)).toBe(iso('2026-11-15T12:30:00Z'));
    const equal = dl({ cooldown_until: new Date(AT).toISOString() });
    expect(await run(equal)).toBe(AT + 12 * MIN);
    const past = dl({ cooldown_until: '2026-11-15T11:00:00Z' });
    expect(await run(past)).toBe(AT + 12 * MIN);
  });

  it('cooldown outranks exhausted slots; paused outranks cooldown', async () => {
    const h = dl({ cooldown_until: '2026-11-15T12:30:00Z' });
    expect(await run(h, 0)).toBe(iso('2026-11-15T12:30:00Z'));
    const p = dl({ paused: true, cooldown_until: '2026-11-15T12:30:00Z' });
    expect(await run(p, 0)).toBe(AT + 12 * MIN);
  });

  it('asks nextSlot when no slots remain, parsing starts, and falls back to 60 s on null', async () => {
    const h = dl({ starts: ['2026-11-15T11:30:00Z'] });
    expect(await run(h, 0, null, { remaining: 0 } as never)).toBe(AT + 5 * MIN);
    expect(h.next).toEqual([[[iso('2026-11-15T11:30:00Z')], AT]]);
    const none = dl({}, { nextSlot: () => null });
    expect(await run(none, -1)).toBe(AT + 60_000);
  });

  it('uses the clock when `at` is omitted', async () => {
    const h = dl();
    expect(await run(h, 3, null, null, undefined)).toBe(AT + 12 * MIN);
  });

  it('hints the next minute boundary for collectable runs but returns the admission deadline', async () => {
    const h = dl({ items: [pend(), { id: 'r', state: 'reviewing', run: { run_id: 'x' } }] });
    expect(await run(h)).toBe(AT + 12 * MIN);
    expect(h.written).toEqual([iso('2026-11-15T12:01:00Z')]);
    const exact = dl({ items: [pend(), { id: 'r', state: 'reviewing', run: { run_id: 'x' } }] });
    await refreshSlotDeadline(exact.queue, null, 3, null, iso('2026-11-15T12:00:00Z'), exact.fx);
    expect(exact.written).toEqual([iso('2026-11-15T12:01:00Z')]);
  });

  it('keeps an earlier deadline over the minute hint', async () => {
    const h = dl({
      cooldown_until: '2026-11-15T12:00:40Z',
      items: [pend(), { id: 'r', state: 'reviewing', run: { a: 1 } }],
    });
    await run(h);
    expect(h.written).toEqual([iso('2026-11-15T12:00:40Z')]);
  });

  it('ignores reviewing items without a run', async () => {
    const h = dl({ items: [pend(), { id: 'r', state: 'reviewing', run: null }] });
    await run(h);
    expect(h.written).toEqual([AT + 12 * MIN]);
  });

  it('throws like KeyError on an item without state, but only if the scan reaches it', async () => {
    const bad = dl({ items: [{ id: 'x' }] });
    await expect(run(bad)).rejects.toThrow(TypeError);
    // paused skips the pending scan; the collectable scan stops at its first hit.
    const short = dl({
      paused: true,
      items: [{ id: 'r', state: 'reviewing', run: { a: 1 } }, { id: 'x' }],
    });
    expect(await run(short)).toBe(AT + 12 * MIN);
    expect(short.written).toEqual([iso('2026-11-15T12:01:00Z')]);
    // the collectable scan has no short-circuit before the stateless item, so it raises.
    const reaches = dl({ paused: true, items: [pend(), { id: 'x' }] });
    await expect(run(reaches)).rejects.toThrow(TypeError);
  });
});

function hb(over: Partial<HeartbeatEffects> = {}, config: Record<string, unknown> = {}) {
  const steps: string[] = [];
  const events: Array<[string, Record<string, unknown>]> = [];
  let text = '';
  const fx: HeartbeatEffects = {
    mkdirHome: async () => void steps.push('mkdir'),
    writeTemp: async (t) => (steps.push('write'), void (text = t)),
    commit: async () => void steps.push('commit'),
    event: async (k, d) => void events.push([k, d]),
    config: {
      stale_alarm_min: 20,
      schedule_id: 's1',
      alerts: { alert_agent_id: 'a', alert_agent_host: 'h' },
      ...config,
    },
    root: '/srv/crq',
    ...over,
  };
  return { fx, steps, events, text: () => text };
}

describe('writeHeartbeat', () => {
  it('writes Python-shaped JSON in key order then commits', async () => {
    const h = hb();
    await writeHeartbeat({ items: [], last_tick: '2026-11-15T12:00:00Z' }, h.fx);
    expect(h.steps).toEqual(['mkdir', 'write', 'commit']);
    expect(h.text()).toBe(
      '{"last_tick": "2026-11-15T12:00:00Z", "stale_alarm_min": 20, "schedule_id": "s1", "root": "/srv/crq", "alert_agent_id": "a", "alert_agent_host": "h"}\n',
    );
  });

  it('defaults stale_alarm_min to 36 and missing alert fields to null; escapes non-ASCII', async () => {
    const h = hb(
      { root: '/srv/é' },
      { stale_alarm_min: undefined, alerts: undefined, schedule_id: undefined },
    );
    delete (h.fx.config as Record<string, unknown>).stale_alarm_min;
    await writeHeartbeat({ items: [], last_tick: 't' }, h.fx);
    expect(h.text()).toBe(
      '{"last_tick": "t", "stale_alarm_min": 36, "schedule_id": null, "root": "/srv/\\u00e9", "alert_agent_id": null, "alert_agent_host": null}\n',
    );
  });

  it('logs an OS failure as heartbeat_failed truncated to 200 and does not commit', async () => {
    const h = hb({
      writeTemp: async () => {
        throw new HeartbeatIoError('😀'.repeat(300));
      },
    });
    await writeHeartbeat({ items: [], last_tick: 't' }, h.fx);
    expect(h.events).toEqual([['heartbeat_failed', { error: '😀'.repeat(200) }]]);
    expect(h.steps).not.toContain('commit');
  });

  it('lets a non-OS failure and a missing last_tick escape', async () => {
    const a = hb({
      commit: async () => {
        throw new Error('bug');
      },
    });
    await expect(writeHeartbeat({ items: [], last_tick: 't' }, a.fx)).rejects.toThrow('bug');
    const b = hb();
    await expect(writeHeartbeat({ items: [] }, b.fx)).rejects.toThrow(TypeError);
    expect(b.events).toEqual([]);
  });
});
