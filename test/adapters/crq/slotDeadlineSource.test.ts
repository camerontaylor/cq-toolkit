import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileHeartbeatEffects,
  fileSlotDeadlineEffects,
} from '../../../src/adapters/crq/slotDeadlineSource.js';
import {
  refreshSlotDeadline,
  writeHeartbeat,
} from '../../../src/queue-runner/slotDeadlineHeartbeat.js';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'slot-deadline-'));
});
afterEach(async () => rm(root, { recursive: true, force: true }));

const AT = Date.UTC(2026, 10, 15, 1, 2, 3, 999);

describe('file slot deadline effects', () => {
  it('writes the wake hint as whole-second UTC (12 minutes when a slot is free)', async () => {
    const fx = fileSlotDeadlineEffects({ stateRoot: join(root, 'state'), now: () => AT });
    const queue = { items: [{ state: 'pending', kind: 'review' }] };
    const deadline = await refreshSlotDeadline(queue, null, 3, null, undefined, fx);
    expect(deadline).toBe(AT + 12 * 60_000);
    expect(await readFile(join(root, 'state', 'next-review-at'), 'utf8')).toBe(
      '2026-11-15T01:14:03Z\n',
    );
  });

  it('wakes within a minute for a detached review', async () => {
    const fx = fileSlotDeadlineEffects({ stateRoot: root, now: () => AT });
    await refreshSlotDeadline(
      { items: [{ state: 'reviewing', run: { run_id: 'r' }, kind: 'review' }] },
      null,
      3,
      null,
      undefined,
      fx,
    );
    expect(await readFile(join(root, 'next-review-at'), 'utf8')).toBe('2026-11-15T01:03:00Z\n');
  });

  it('parses ISO to epoch ms, null for missing and throws for garbage', () => {
    const fx = fileSlotDeadlineEffects({ stateRoot: root });
    expect(fx.parseIsoMs('2026-11-15T01:02:03Z')).toBe(Date.UTC(2026, 10, 15, 1, 2, 3));
    expect(fx.parseIsoMs(null)).toBeNull();
    expect(() => fx.parseIsoMs('garbage')).toThrow();
  });

  it('maps next_slot through ms and returns null for no candidate', () => {
    const fx = fileSlotDeadlineEffects({ stateRoot: root });
    const start = AT - 60_000;
    const slot = fx.nextSlot([start], AT, {
      remaining: 0,
      limit: 1,
      rollingWindowMs: 3_600_000,
    } as never);
    expect(slot).toBe(start + 3_600_000);
  });
});

describe('file heartbeat effects', () => {
  const config = { schedule_id: 's1', alerts: { alert_agent_id: 'a' } };
  it('writes heartbeat.json', async () => {
    const fx = fileHeartbeatEffects({
      watchdogHome: join(root, 'wd'),
      config,
      root: '/r',
      event: async () => {},
    });
    await writeHeartbeat({ items: [], last_tick: 'T' }, fx);
    expect(await readFile(join(root, 'wd', 'heartbeat.json'), 'utf8')).toBe(
      '{"last_tick": "T", "stale_alarm_min": 36, "schedule_id": "s1", "root": "/r", "alert_agent_id": "a", "alert_agent_host": null}\n',
    );
  });
  it('turns an unwritable home into a heartbeat_failed event', async () => {
    await writeFile(join(root, 'wd'), 'file');
    const events: string[] = [];
    const fx = fileHeartbeatEffects({
      watchdogHome: join(root, 'wd'),
      config,
      root: '/r',
      event: async (kind) => void events.push(kind),
    });
    await writeHeartbeat({ items: [], last_tick: 'T' }, fx);
    expect(events).toEqual(['heartbeat_failed']);
  });
});
