import { describe, expect, it } from 'vitest';
import {
  harvestBackfillFailure,
  type BackfillFailureHarvestEffects,
  type BackfillRunArtifacts,
} from '../../../src/ops/crq/internal/backfillHarvest.js';
import { JsonNumber, JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';

const enc = new TextEncoder();
function queue(): JsonObject {
  const q = parseJsonValue(
    '{"items":[{"id":"j","kind":"backfill","state":"reviewing","vendor_state":"live","family":"f","scope":[{"path":"a"}],"attempt_id":"a","run":{"run_id":"r","band":"background"},"failures":0}],"backfill_reservations":{"a":{"item":"j","vendor_run_id":"r","quota_state":"reserved"}},"other":1.0}',
  );
  if (!(q instanceof JsonObject)) throw new Error('fixture');
  return q;
}
function artifacts(review = '', exit = 1): BackfillRunArtifacts {
  return {
    meta: enc.encode('{"run_id":"r","item_id":"j","backfill":{"attempt_id":"a"}}'),
    exit: enc.encode(JSON.stringify({ exit, ended_at: '2026-10-30T01:00:00Z' })),
    review: enc.encode(review),
  };
}
function fixture(a = artifacts()) {
  const calls: string[] = [];
  let saved: JsonObject | undefined;
  const effects: BackfillFailureHarvestEffects = {
    readArtifacts: async () => a,
    retain: async () => {
      calls.push('retain');
    },
    stateEvent: async (q) => {
      calls.push('event');
      return q;
    },
    saveQueue: async (q) => {
      calls.push('save');
      saved = q;
    },
    cleanup: async () => {
      calls.push('cleanup');
    },
  };
  return { calls, effects, saved: () => saved };
}
const proof = { runId: 'r', exitCode: 1, terminalVerified: true } as const;
describe('bounded backfill failure harvest', () => {
  it('defers verified vendor quota with retained reservation and cooldown', async () => {
    const f = fixture(artifacts('{"type":"error","errorType":"rate_limit","recoverable":true}\n'));
    const result = await harvestBackfillFailure(queue(), 0, proof, f.effects, 2);
    expect(result.status).toBe('handled');
    expect(result.queue.get('cooldown_until')).toBe('2026-10-30T01:02:00Z');
    expect(f.calls).toEqual(['retain', 'retain', 'event', 'save', 'cleanup', 'save']);
    const hold = (result.queue.get('backfill_reservations') as JsonObject).get('a') as JsonObject;
    expect(hold.get('quota_state')).toBe('reserved');
    expect(hold.get('terminal_at')).toBe('2026-10-30T01:00:00Z');
  });
  it('leaves quota unhandled when no usable cooldown exists', async () => {
    const f = fixture(artifacts('{"type":"error","errorType":"rate_limit","recoverable":true}\n'));
    const initial = queue();
    const result = await harvestBackfillFailure(initial, 0, proof, f.effects);
    expect(result.status).toBe('unhandled');
    expect(result.queue).toBe(initial);
    expect(f.calls).toEqual([]);
  });
  it('uses the classified wait instead of the fallback', async () => {
    const f = fixture(
      artifacts(
        '{"type":"error","errorType":"rate_limit","recoverable":true,"metadata":{"waitTime":"2 minutes"}}\n',
      ),
    );
    const result = await harvestBackfillFailure(queue(), 0, proof, f.effects, 9);
    expect(result.queue.get('cooldown_until')).toBe('2026-10-30T01:02:00Z');
  });
  it.each(['retain', 'event', 'save'] as const)(
    'does not clean quota after %s fails',
    async (failure) => {
      const f = fixture(
        artifacts('{"type":"error","errorType":"rate_limit","recoverable":true}\n'),
      );
      if (failure === 'retain')
        f.effects.retain = async () => {
          throw new Error(failure);
        };
      if (failure === 'event')
        f.effects.stateEvent = async () => {
          throw new Error(failure);
        };
      if (failure === 'save')
        f.effects.saveQueue = async () => {
          throw new Error(failure);
        };
      await expect(harvestBackfillFailure(queue(), 0, proof, f.effects, 2)).rejects.toThrow(
        failure,
      );
      expect(f.calls).not.toContain('cleanup');
    },
  );
  it('retains evidence before event and save, cleans only after save', async () => {
    const initial = queue();
    const f = fixture();
    const result = await harvestBackfillFailure(initial, 0, proof, f.effects);
    expect(result.status).toBe('handled');
    expect(f.calls).toEqual(['retain', 'retain', 'event', 'save', 'cleanup']);
    expect(f.saved()).toBe(result.queue);
    expect(result.queue.get('other')).toEqual(initial.get('other'));
    const items = result.queue.get('items');
    expect(
      Array.isArray(items) && items[0] instanceof JsonObject && items[0].get('vendor_state'),
    ).toBe('terminal');
    expect((initial.get('items') as JsonObject[])[0]!.get('vendor_state')).toBe('live');
  });
  it.each(['retain', 'event', 'save'] as const)(
    'does not clean or persist after %s fails',
    async (failure) => {
      const f = fixture();
      if (failure === 'retain')
        f.effects.retain = async () => {
          throw new Error('retain');
        };
      if (failure === 'event')
        f.effects.stateEvent = async () => {
          throw new Error('event');
        };
      if (failure === 'save')
        f.effects.saveQueue = async () => {
          throw new Error('save');
        };
      await expect(harvestBackfillFailure(queue(), 0, proof, f.effects)).rejects.toThrow(failure);
      expect(f.calls).not.toContain('cleanup');
      expect(f.saved()).toBeUndefined();
    },
  );
  it('refuses mismatched ownership and malformed artifacts before effects', async () => {
    const f = fixture({
      ...artifacts(),
      meta: enc.encode('{"run_id":"r","item_id":"other","backfill":{"attempt_id":"a"}}'),
    });
    await expect(harvestBackfillFailure(queue(), 0, proof, f.effects)).rejects.toThrow(
      'identity mismatch',
    );
    expect(f.calls).toEqual([]);
    const broken = fixture({ ...artifacts(), exit: enc.encode('{') });
    await expect(harvestBackfillFailure(queue(), 0, proof, broken.effects)).rejects.toThrow();
    expect(broken.calls).toEqual([]);
    await expect(
      harvestBackfillFailure(queue(), 0, { ...proof, runId: 'other' }, fixture().effects),
    ).rejects.toThrow('ownership');
  });
  it('does not mutate mixed quota and hard failure outcomes', async () => {
    const f = fixture(
      artifacts(
        '{"type":"error","errorType":"rate_limit","recoverable":true}\n{"type":"error","errorType":"auth"}\n',
      ),
    );
    const initial = queue();
    const result = await harvestBackfillFailure(initial, 0, proof, f.effects);
    expect(result.classification.get('outcome')).toBe('auth');
    expect(result.status).toBe('unhandled');
    expect(result.queue).toBe(initial);
    expect(f.calls).toEqual([]);
  });
  it.each([
    ['state', 'pending'],
    ['vendor_state', 'unknown'],
    ['attempt_id', 'other'],
  ] as const)('refuses mismatched item %s before effects', async (field, value) => {
    const q = queue();
    const items = q.get('items');
    if (!Array.isArray(items) || !(items[0] instanceof JsonObject)) throw new Error('fixture');
    const changed = withObjectKeys(q, [['items', [withObjectKeys(items[0], [[field, value]])]]]);
    const f = fixture();
    await expect(harvestBackfillFailure(changed, 0, proof, f.effects)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each([
    ['item', 'other'],
    ['vendor_run_id', 'other'],
  ] as const)('refuses mismatched reservation %s before effects', async (field, value) => {
    const q = queue();
    const holds = q.get('backfill_reservations');
    if (!(holds instanceof JsonObject) || !(holds.get('a') instanceof JsonObject))
      throw new Error('fixture');
    const hold = holds.get('a');
    if (!(hold instanceof JsonObject)) throw new Error('fixture');
    const changed = withObjectKeys(q, [
      [
        'backfill_reservations',
        withObjectKeys(holds, [['a', withObjectKeys(hold, [[field, value]])]]),
      ],
    ]);
    const f = fixture();
    await expect(harvestBackfillFailure(changed, 0, proof, f.effects)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('refuses mismatched exit and unverified terminal proof', async () => {
    const f = fixture();
    await expect(
      harvestBackfillFailure(queue(), 0, { ...proof, exitCode: 2 }, f.effects),
    ).rejects.toThrow();
    await expect(
      // @ts-expect-error Exercise runtime rejection of an unverified caller.
      harvestBackfillFailure(queue(), 0, { ...proof, terminalVerified: false }, f.effects),
    ).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it('pauses on auth and records capacity and attempt exactly once', async () => {
    const f = fixture(artifacts('{"type":"error","errorType":"auth"}\n'));
    const result = await harvestBackfillFailure(queue(), 0, proof, f.effects);
    expect(result.queue.get('paused')).toBe(true);
    expect(result.queue.get('pause_reason')).toBe(
      'backfill vendor authentication/action required; operator ruling needed',
    );
    expect(result.queue.get('backfill_capacity_runs')).toEqual(['r']);
    const capacity = result.queue.get('backfill_daily_capacity');
    if (!(capacity instanceof JsonObject) || !(capacity.get('2026-10-30') instanceof JsonObject))
      throw new Error('capacity');
    const day = capacity.get('2026-10-30');
    if (!(day instanceof JsonObject)) throw new Error('day');
    expect(day.get('completed_partitions')).toEqual(JsonNumber.int(0));
    expect(day.get('spare_admissions')).toEqual(JsonNumber.int(0));
    const items = result.queue.get('items');
    if (!Array.isArray(items) || !(items[0] instanceof JsonObject)) throw new Error('item');
    const attempts = items[0].get('attempts');
    if (!Array.isArray(attempts) || !(attempts[0] instanceof JsonObject))
      throw new Error('attempt');
    expect(attempts).toHaveLength(1);
    expect(attempts[0].get('run_id')).toBe('r');
    expect(attempts[0].get('outcome')).toBe('auth');
  });
  it('leaves quota and counted completion untouched', async () => {
    const rate = fixture(
      artifacts('{"type":"error","errorType":"rate_limit","recoverable":true}\n'),
    );
    const initial = queue();
    const result = await harvestBackfillFailure(initial, 0, proof, rate.effects);
    expect(result.status).toBe('unhandled');
    expect(result.queue).toBe(initial);
    expect(rate.calls).toEqual([]);
    const complete = fixture(artifacts('{"type":"complete","status":"review_completed"}\n', 0));
    const done = await harvestBackfillFailure(
      initial,
      0,
      { ...proof, exitCode: 0 },
      complete.effects,
    );
    expect(done.status).toBe('unhandled');
    expect(complete.calls).toEqual([]);
  });
});
