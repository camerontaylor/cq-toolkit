import { describe, expect, it } from 'vitest';
import {
  bindBackfillLaunch,
  saveUnknownBackfillLaunch,
  type BackfillBindingEffects,
} from '../../../src/ops/crq/internal/backfillBinding.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';

const queue = (): JsonObject => {
  const value = parseJsonValue(
    '{"items":[{"id":"j","state":"reviewing","vendor_state":"unknown","attempt_id":"a","run":{"run_id":"r","extra":1.0}}],"backfill_reservations":{"a":{"vendor_run_id":null,"quota_state":"reserved"}},"other":1.0}',
  );
  if (!(value instanceof JsonObject)) throw new Error('bad fixture');
  return value;
};
function item(q: JsonObject): JsonObject {
  const items = q.get('items');
  if (!Array.isArray(items) || !(items[0] instanceof JsonObject)) throw new Error('bad item');
  return items[0];
}
function hold(q: JsonObject): JsonObject {
  const reservations = q.get('backfill_reservations');
  if (!(reservations instanceof JsonObject) || !(reservations.get('a') instanceof JsonObject))
    throw new Error('bad hold');
  return reservations.get('a') as JsonObject;
}
describe('backfill binding lifecycle', () => {
  it('binds before spooling and saves the returned queue after event', async () => {
    const calls: string[] = [];
    let saved: JsonObject | null = null;
    const effects: BackfillBindingEffects = {
      now: () => '2026-10-30T00:00:00Z',
      stateEvent: async (q, row, _at, reason) => {
        calls.push(reason);
        expect(hold(q).get('vendor_run_id')).toBe('r');
        expect(row.get('vendor_state')).toBe('live');
        return withObjectKeys(q, [['event_marker', true]]);
      },
      loadQueue: async () => queue(),
      saveQueue: async (q) => {
        calls.push('save');
        saved = q;
      },
    };
    const result = await bindBackfillLaunch(queue(), 0, 'r', effects);
    expect(calls).toEqual(['vendor identity bound', 'save']);
    expect(saved).toBe(result);
    expect(result.get('event_marker')).toBe(true);
    expect(hold(result).get('quota_state')).toBe('reserved');
  });
  it('persists bound ownership if spooling fails and preserves uncertain identity on conflict', async () => {
    const saves: JsonObject[] = [];
    const fx: BackfillBindingEffects = {
      now: () => '2026-10-30T00:00:00Z',
      stateEvent: async () => {
        throw new Error('spool');
      },
      loadQueue: async () => queue(),
      saveQueue: async (q) => {
        saves.push(q);
      },
    };
    await expect(bindBackfillLaunch(queue(), 0, 'r', fx)).rejects.toThrow('spool');
    expect(hold(saves[0]!).get('vendor_run_id')).toBe('r');
    expect(item(saves[0]!).get('state')).toBe('reviewing');
    await expect(bindBackfillLaunch(queue(), 0, 'different', fx)).rejects.toThrow(
      'recorded reviewing run identity',
    );
    expect(item(saves[1]!).get('state')).toBe('launch-unknown');
    expect(item(saves[1]!).get('run')).toEqual(item(queue()).get('run'));
    expect(hold(saves[1]!).get('quota_state')).toBe('reserved');
  });
  it('retries the bound save after a save error and preserves the original error', async () => {
    let calls = 0;
    const fx: BackfillBindingEffects = {
      now: () => '2026-10-30T00:00:00Z',
      stateEvent: async (q) => q,
      loadQueue: async () => queue(),
      saveQueue: async () => {
        calls++;
        if (calls === 1) throw new Error('save');
      },
    };
    await expect(bindBackfillLaunch(queue(), 0, 'r', fx)).rejects.toThrow('save');
    expect(calls).toBe(2);
  });
  it('saves unknown state without dropping a recorded run or reservation', async () => {
    let saved: JsonObject | null = null;
    const durable = withObjectKeys(queue(), [['newly_saved', 'preserved']]);
    const result = await saveUnknownBackfillLaunch('j', 'a', {
      loadQueue: async () => durable,
      saveQueue: async (q) => {
        saved = q;
      },
    });
    expect(result.get('newly_saved')).toBe('preserved');
    await expect(
      saveUnknownBackfillLaunch('j', 'other', {
        loadQueue: async () => durable,
        saveQueue: async () => {
          throw new Error('must not save');
        },
      }),
    ).rejects.toThrow('attempt changed');
    expect(saved).toBe(result);
    expect(item(result).get('state')).toBe('launch-unknown');
    expect(item(result).get('vendor_state')).toBe('unknown');
    expect(item(result).get('run')).toEqual(item(queue()).get('run'));
    expect(hold(result).get('quota_state')).toBe('reserved');
  });
});
