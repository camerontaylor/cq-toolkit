import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileDiscoveryEffects } from '../../src/adapters/crq/discoverySource.js';
import { withLock } from '../../src/adapters/crq/lock.js';
import { ForgeBudget } from '../../src/policy/crq/forgeBudget.js';
import { JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../src/policy/crq/queueDoc.js';
import { InventoryCapExceeded, PageFailed } from '../../src/policy/crq/reconcileInventory.js';
import {
  discoverRolling,
  rollingInterval,
  type DiscoveryEffects,
} from '../../src/queue-runner/discovery.js';

const interval = { after: '2026-09-01T00:00:00Z', before: '2026-09-02T00:00:00Z' };
const clock = new Date('2026-10-01T00:00:00Z');
function object(value: unknown): JsonObject {
  return parseJsonValue(JSON.stringify(value)) as JsonObject;
}

describe('rolling discovery lifecycle', () => {
  it('persists a real empty rolling scan using an offline forge seam', async () => {
    const root = await mkdtemp(join(tmpdir(), 'discovery-file-'));
    await mkdir(join(root, 'reconcile'));
    await writeFile(
      join(root, 'queue.json'),
      '{"items":[],"merged_current_requests":{},"unknown":42}\n',
    );
    let calls = 0;
    const effects = fileDiscoveryEffects({
      repo: 'acme/repo',
      stateRoot: root,
      now: () => clock,
      budget: new ForgeBudget({ requests: 4, seconds: 30, clock: () => 0 }),
      gh: async () => {
        calls++;
        return { code: 0, stdout: '[]', stderr: '' };
      },
    });
    const result = await withLock(join(root, 'tick.lock'), { wait: false }, () =>
      discoverRolling(interval, effects),
    );
    expect(result.summary.get('complete')).toBe(true);
    expect(calls).toBeGreaterThan(0);
    expect(JSON.parse(await readFile(join(root, 'queue.json'), 'utf8'))).toMatchObject({
      unknown: 42,
      merged_watermark: interval.before,
      merged_discovery: { complete: true },
    });
  });
  it('freezes in-progress bounds and overlaps a completed watermark', () => {
    expect(
      rollingInterval(
        object({ merged_discovery: { ...interval, complete: false } }),
        interval.after,
        clock,
      ),
    ).toEqual(interval);
    expect(
      rollingInterval(object({ merged_watermark: interval.before }), interval.after, clock),
    ).toEqual({ after: '2026-09-01T23:55:00Z', before: '2026-09-30T23:59:59Z' });
  });

  it('persists enrollment before watermark and prune, preserving unknown queue data', async () => {
    let queue = object({ items: [], unknown: { big: 42 } });
    const steps: string[] = [];
    const effects: DiscoveryEffects = {
      loadQueue: async () => queue,
      saveQueue: async (next) => {
        queue = next;
        steps.push(`save:${String(queue.get('merged_watermark') ?? '-')}`);
      },
      reconcile: async () => {
        steps.push('enroll');
        queue = withObjectKeys(queue, [['enrolled', true]]);
        return object({ complete: true });
      },
      prune: async (current, cutoff) => {
        expect(current.get('merged_watermark')).toBe(interval.before);
        expect(cutoff).toBe('2026-09-24T00:00:00Z');
        steps.push('prune');
        return 1;
      },
      now: () => clock,
    };
    const result = await discoverRolling(interval, effects);
    expect(steps).toEqual([
      'save:-',
      'enroll',
      'save:-',
      `save:${interval.before}`,
      'prune',
      `save:${interval.before}`,
    ]);
    expect(result.pruned).toBe(1);
    expect(result.queue.get('enrolled')).toBe(true);
    expect(result.queue.get('unknown')).toBeInstanceOf(JsonObject);
  });

  it('does not advance the watermark after enrollment or save fails', async () => {
    let queue = object({ items: [] });
    let prunes = 0;
    const effects: DiscoveryEffects = {
      loadQueue: async () => queue,
      saveQueue: async (next) => {
        queue = next;
      },
      reconcile: async () => {
        throw new Error('enrollment failure');
      },
      prune: async () => {
        prunes++;
        return 0;
      },
      now: () => clock,
    };
    await expect(discoverRolling(interval, effects)).rejects.toThrow('enrollment failure');
    expect(queue.get('merged_watermark')).toBeUndefined();
    expect(prunes).toBe(0);
  });

  it('persists inventory-cap debt and resumes the frozen smaller interval', async () => {
    let queue = object({ items: [] });
    const effects: DiscoveryEffects = {
      loadQueue: async () => queue,
      saveQueue: async (next) => {
        queue = next;
      },
      reconcile: async () => {
        throw new InventoryCapExceeded('inventory cap');
      },
      prune: async () => 0,
      now: () => clock,
    };
    const result = await discoverRolling(interval, effects);
    expect(result.summary.get('reason')).toBe('inventory-cap-partitioned');
    expect(queue.get('merged_watermark')).toBeUndefined();
    expect(rollingInterval(queue, interval.after, clock)).toEqual({
      after: interval.after,
      before: '2026-09-01T12:00:00Z',
    });
  });

  it('persists page failure debt without advancing watermark', async () => {
    let queue = object({ items: [] });
    const result = await discoverRolling(interval, {
      loadQueue: async () => queue,
      saveQueue: async (next) => {
        queue = next;
      },
      reconcile: async () => {
        throw new PageFailed('offline');
      },
      prune: async () => {
        throw new Error('unexpected prune');
      },
      now: () => clock,
    });
    expect(result.summary.get('reason')).toBe('transport-failure');
    const debt = queue.get('merged_discovery');
    expect(debt).toBeInstanceOf(JsonObject);
    expect((debt as JsonObject).get('error')).toBe('offline');
    expect(queue.get('merged_watermark')).toBeUndefined();
  });

  it('does not prune again within an hour, but treats future stamps as stale', async () => {
    for (const [stamp, expected] of [
      ['2026-09-30T23:30:00Z', 0],
      ['2026-10-01T01:00:00Z', 1],
    ] as const) {
      let queue = object({ items: [], merged_wrappers_pruned_at: stamp });
      let calls = 0;
      await discoverRolling(interval, {
        loadQueue: async () => queue,
        saveQueue: async (next) => {
          queue = next;
        },
        reconcile: async () => object({ complete: true }),
        prune: async () => {
          calls++;
          return 0;
        },
        now: () => clock,
      });
      expect(calls).toBe(expected);
    }
  });
});
