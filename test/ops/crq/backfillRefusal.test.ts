import { describe, expect, it } from 'vitest';
import {
  recordPreVendorRefusal,
  replayBackfillRefusal,
  type BackfillRefusalEffects,
} from '../../../src/ops/crq/internal/backfillRefusal.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { withObjectKeys } from '../../../src/policy/crq/queueDoc.js';
const parse = (source: string): JsonObject => {
  const v = parseJsonValue(source);
  if (!(v instanceof JsonObject)) throw new Error('fixture');
  return v;
};
const initial = (): JsonObject =>
  parse(
    '{"items":[{"id":"j","kind":"backfill","family":"f","scope":[{"path":"a"}],"state":"launch-unknown","vendor_state":"unknown","attempt_id":"a","failures":0,"run":null}],"backfill_reservations":{"a":{"item":"j","quota_state":"reserved","vendor_run_id":null}}}',
  );
const evidence = { kind: 'verified-pre-spawn-refusal' as const, itemId: 'j', attemptId: 'a' };
function item(q: JsonObject): JsonObject {
  const rows = q.get('items');
  if (!Array.isArray(rows) || !(rows[0] instanceof JsonObject)) throw new Error('bad item');
  return rows[0];
}
function hold(q: JsonObject): JsonObject {
  const rows = q.get('backfill_reservations');
  if (!(rows instanceof JsonObject) || !(rows.get('a') instanceof JsonObject))
    throw new Error('bad hold');
  return rows.get('a') as JsonObject;
}
describe('pre-vendor refusal replay', () => {
  it('saves quarantine and marker before event, then clears and saves after it', async () => {
    const calls: string[] = [];
    let disk = initial();
    const fx: BackfillRefusalEffects = {
      now: () => '2026-10-30T00:00:00Z',
      loadQueue: async () => disk,
      saveQueue: async (q) => {
        disk = q;
        calls.push('save');
      },
      stateEvent: async (q, row) => {
        calls.push('event');
        expect(item(disk).get('state')).toBe('quarantined');
        expect(row.has('refusal_state_event')).toBe(true);
        expect(hold(disk).get('quota_state')).toBe('released');
        return q;
      },
    };
    const result = await recordPreVendorRefusal(initial(), 0, evidence, fx);
    expect(calls).toEqual(['save', 'event', 'save']);
    expect(item(result).has('refusal_state_event')).toBe(false);
    expect(item(result).get('failures')).toEqual(parse('{"n":1}').get('n'));
  });
  it('uses reloaded error and a single clock value for terminal and marker', async () => {
    const stale = initial();
    let disk = withObjectKeys(stale, [
      ['items', [withObjectKeys(item(stale), [['last_error', 'durable detail']])]],
    ]);
    let calls = 0;
    let seenAt = '';
    let savedTerminal = '';
    const fx: BackfillRefusalEffects = {
      now: () => {
        calls++;
        return calls === 1 ? '2026-10-30T00:00:00Z' : '2026-10-30T00:00:01Z';
      },
      loadQueue: async () => disk,
      saveQueue: async (q) => {
        disk = q;
      },
      stateEvent: async (q, _item, at) => {
        seenAt = at;
        savedTerminal = String(hold(q).get('terminal_at'));
        return q;
      },
    };
    const result = await recordPreVendorRefusal(stale, 0, evidence, fx);
    expect(item(result).get('last_error')).toBe('durable detail');
    expect(calls).toBe(1);
    expect(seenAt).toBe('2026-10-30T00:00:00Z');
    expect(savedTerminal).toBe(seenAt);
  });
  it('replays a persisted marker after spool failure without another terminal transition', async () => {
    let disk = initial();
    let failed = true;
    let spooled = 0;
    const fx: BackfillRefusalEffects = {
      now: () => '2026-10-30T00:00:00Z',
      loadQueue: async () => disk,
      saveQueue: async (q) => {
        disk = q;
      },
      stateEvent: async (q) => {
        if (failed) throw new Error('offline');
        spooled++;
        return q;
      },
    };
    await expect(recordPreVendorRefusal(initial(), 0, evidence, fx)).rejects.toThrow('offline');
    expect(item(disk).has('refusal_state_event')).toBe(true);
    failed = false;
    disk = await replayBackfillRefusal(disk, 0, fx);
    expect(item(disk).get('state')).toBe('quarantined');
    expect(item(disk).get('failures')).toEqual(parse('{"n":1}').get('n'));
    expect(item(disk).has('refusal_state_event')).toBe(false);
    await replayBackfillRefusal(disk, 0, fx);
    expect(spooled).toBe(1);
  });
  it('replays idempotent event after post-spool save failure', async () => {
    let disk = initial(),
      saves = 0,
      spools = 0;
    const eventKeys = new Set<string>();
    const fx: BackfillRefusalEffects = {
      now: () => '2026-10-30T00:00:00Z',
      loadQueue: async () => disk,
      saveQueue: async (q) => {
        saves++;
        if (saves === 2) throw new Error('save failed');
        disk = q;
      },
      stateEvent: async (q, _row, at, reason) => {
        spools++;
        eventKeys.add(at + reason);
        return q;
      },
    };
    await expect(recordPreVendorRefusal(initial(), 0, evidence, fx)).rejects.toThrow('save failed');
    expect(item(disk).has('refusal_state_event')).toBe(true);
    disk = await replayBackfillRefusal(disk, 0, fx);
    expect(spools).toBe(2);
    expect(eventKeys.size).toBe(1);
    expect(item(disk).has('refusal_state_event')).toBe(false);
  });
  it('does not spool when the initial durable marker save fails', async () => {
    let events = 0;
    const fx: BackfillRefusalEffects = {
      now: () => '2026-10-30T00:00:00Z',
      loadQueue: async () => initial(),
      saveQueue: async () => {
        throw new Error('save unavailable');
      },
      stateEvent: async (q) => {
        events++;
        return q;
      },
    };
    await expect(recordPreVendorRefusal(initial(), 0, evidence, fx)).rejects.toThrow(
      'save unavailable',
    );
    expect(events).toBe(0);
  });
  it('refuses a recorded child run despite claimed pre-spawn evidence', async () => {
    const q = initial();
    const row = withObjectKeys(item(q), [
      ['run', parse('{"run_id":"r","pid":null,"launch_pending":true}')],
    ]);
    const changed = withObjectKeys(q, [['items', [row]]]);
    let saves = 0;
    const fx: BackfillRefusalEffects = {
      now: () => '2026-10-30T00:00:00Z',
      loadQueue: async () => changed,
      saveQueue: async () => {
        saves++;
      },
      stateEvent: async (v) => v,
    };
    await expect(recordPreVendorRefusal(initial(), 0, evidence, fx)).rejects.toThrow(
      'pre-spawn evidence',
    );
    expect(saves).toBe(0);
    expect(hold(changed).get('quota_state')).toBe('reserved');
  });
});
