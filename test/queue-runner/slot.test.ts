import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withLock } from '../../src/adapters/crq/lock.js';
import { fileSlotPreflightEffects, futureSlotHint } from '../../src/adapters/crq/slotSource.js';
import { scheduledSlot, slotPreflight, type SlotEffects } from '../../src/queue-runner/slot.js';

const now = Date.parse('2026-10-28T01:01:00Z');

describe('slot preflight', () => {
  it('validates hints and requires a strictly future timestamp', () => {
    expect(futureSlotHint('2026-10-28T01:01:01Z\n', now)).toBe(true);
    expect(futureSlotHint('2026-10-28T1:1:00Z', now)).toBe(false);
    expect(futureSlotHint('2026-02-30T00:00:00Z', now)).toBe(false);
    expect(futureSlotHint('invalid', now)).toBe(false);
  });

  it('avoids creating a lock for a future hint, then releases the lock before running', async () => {
    const root = await mkdtemp(join(tmpdir(), 'slot-preflight-'));
    const hint = join(root, 'next-review-at');
    await writeFile(hint, '2026-10-28T01:02:00Z');
    let calls = 0;
    const effects = fileSlotPreflightEffects(
      root,
      async () => {
        calls++;
        return withLock(join(root, 'tick.lock'), { wait: false }, async () => ['ran']);
      },
      () => now,
    );
    expect(await slotPreflight(effects)).toEqual([]);
    await expect(readFile(join(root, 'tick.lock'))).rejects.toMatchObject({ code: 'ENOENT' });
    await writeFile(hint, 'bad');
    expect(await slotPreflight(effects)).toEqual(['ran']);
    expect(calls).toBe(1);
  });

  it('returns quietly if busy or the hint changes under lock', async () => {
    let calls = 0;
    expect(
      await slotPreflight({
        hintIsFuture: async () => false,
        withTickLock: async () => ({ acquired: false }),
        runScheduledSlot: async () => {
          calls++;
          return [];
        },
      }),
    ).toEqual([]);
    let reads = 0;
    expect(
      await slotPreflight({
        hintIsFuture: async () => ++reads === 2,
        withTickLock: async (work) => ({ acquired: true, value: await work() }),
        runScheduledSlot: async () => {
          calls++;
          return [];
        },
      }),
    ).toEqual([]);
    expect(calls).toBe(0);
  });
});

describe('scheduled slot transaction', () => {
  it('probes outside the lock and refuses any changed queue', async () => {
    let queue = { items: [1], extra: 'preserved' };
    let locked = false;
    let admits = 0;
    const effects: SlotEffects<typeof queue, number> = {
      disabled: async () => false,
      withTickLock: async (work) => {
        expect(locked).toBe(false);
        locked = true;
        try {
          return { acquired: true, value: await work() };
        } finally {
          locked = false;
        }
      },
      loadQueue: async () => {
        expect(locked).toBe(true);
        return queue;
      },
      copyQueue: (value) => structuredClone(value),
      equalQueue: (a, b) => JSON.stringify(a) === JSON.stringify(b),
      readUsage: async (observed) => {
        expect(locked).toBe(false);
        observed.items.push(2);
        queue = { ...queue, extra: 'changed' };
        return 3;
      },
      admit: async () => {
        admits++;
        return [];
      },
    };
    expect(await scheduledSlot(effects)).toEqual([
      'queue changed during quota probe; retry next slot tick',
    ]);
    expect(admits).toBe(0);
    expect(queue.items).toEqual([1]);
  });

  it('commits the observed copy with the lock held and skips when disabled', async () => {
    let locked = false;
    let disabled = false;
    let calls = 0;
    const effects: SlotEffects<{ count: number }, number> = {
      disabled: async () => disabled,
      withTickLock: async (work) => {
        locked = true;
        try {
          return { acquired: true, value: await work() };
        } finally {
          locked = false;
        }
      },
      loadQueue: async () => ({ count: 1 }),
      copyQueue: (queue) => ({ ...queue }),
      equalQueue: (a, b) => a.count === b.count,
      readUsage: async (queue) => {
        queue.count++;
        return 7;
      },
      admit: async (queue, usage) => {
        expect(locked).toBe(true);
        calls++;
        return [`${queue.count}:${usage}`];
      },
    };
    expect(await scheduledSlot(effects)).toEqual(['2:7']);
    disabled = true;
    expect(await scheduledSlot(effects)).toEqual(['runner disabled for host handover']);
    expect(calls).toBe(1);
  });

  it('rechecks disarm after the quota probe before admission', async () => {
    let disabled = false;
    let admitted = false;
    const effects: SlotEffects<{ count: number }, null> = {
      disabled: async () => disabled,
      withTickLock: async (work) => ({ acquired: true, value: await work() }),
      loadQueue: async () => ({ count: 1 }),
      copyQueue: (queue) => ({ ...queue }),
      equalQueue: (a, b) => a.count === b.count,
      readUsage: async () => {
        disabled = true;
        return null;
      },
      admit: async () => {
        admitted = true;
        return [];
      },
    };
    expect(await scheduledSlot(effects)).toEqual(['runner disabled for host handover']);
    expect(admitted).toBe(false);
  });
});
