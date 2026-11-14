import { describe, expect, it } from 'vitest';
import {
  harvestBackfillFailure,
  type BackfillFailureHarvestEffects,
  type BackfillRunArtifacts,
} from '../../../src/ops/crq/internal/backfillHarvest.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

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
