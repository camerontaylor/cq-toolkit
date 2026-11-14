import { describe, expect, it } from 'vitest';
import { JsonObject, parseJsonValue } from '../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../src/policy/crq/queueDoc.js';
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

  it('refuses unimplemented partition hints before any effectful write', async () => {
    const queue = object({ merged_discovery: { ...interval, complete: false, span: 30 } });
    const effects: DiscoveryEffects = {
      loadQueue: async () => queue,
      saveQueue: async () => {
        throw new Error('unexpected save');
      },
      reconcile: async () => {
        throw new Error('unexpected reconcile');
      },
      prune: async () => 0,
      now: () => clock,
    };
    await expect(discoverRolling(interval, effects)).rejects.toThrow(
      'partition hints are not implemented',
    );
  });
});
