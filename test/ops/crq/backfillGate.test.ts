import { describe, expect, it } from 'vitest';
import {
  rank4Gate,
  usageContext,
  type Rank4GateEffects,
} from '../../../src/ops/crq/internal/backfillGate.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

const at = '2026-10-30T00:10:00Z';
function obj(text: string): JsonObject {
  const value = parseJsonValue(text);
  if (!(value instanceof JsonObject)) throw new Error('expected object');
  return value;
}
const queue = obj(
  '{"unknown":1.0,"items":[{"id":"one","job_id":"job","kind":"backfill","state":"pending","attempt":0}],"starts":[],"backfill_reservations":{}}',
);
const usage = obj('{"remaining":3,"rollingWindowMs":3600000}');

describe('backfill usage context', () => {
  it('reflects terminal holds, expires old holds and subtracts only unrepresented starts', () => {
    const input = obj(
      '{"unknown":1.0,"items":[{"attempt_id":"a","run":{"started_at":"start-a"}}],"backfill_reservations":{"a":{"terminal_at":"2026-10-30T00:05:00Z","quota_state":"reserved"},"b":{"terminal_at":"2026-10-29T23:00:00Z","quota_state":"reserved"},"c":{"terminal_at":"2026-10-30T00:05:00Z","quota_state":"released"},"d":{"terminal_at":"2026-10-30T00:11:00Z","quota_state":"reserved"}}}',
    );
    const result = usageContext(input, usage, ['start-a', 'ordinary'], at);
    expect(result.get('unknown')).toBe(input.get('unknown'));
    const observation = result.get('backfill_usage') as JsonObject;
    expect(observation.get('reflected_reservations')).toEqual(['a']);
    expect(observation.get('remaining')).toEqual(obj('{"n":2}').get('n'));
    const holds = result.get('backfill_reservations') as JsonObject;
    expect((holds.get('b') as JsonObject).get('quota_state')).toBe('expired');
    expect((holds.get('c') as JsonObject).get('quota_state')).toBe('released');
    expect((holds.get('d') as JsonObject).get('quota_state')).toBe('reserved');
  });
  it('does not infer reflection from an active vendor run or a failed probe', () => {
    const input = obj(
      '{"items":[{"attempt_id":"a","run":{"started_at":"start"}}],"backfill_reservations":{"a":{"quota_state":"reserved"}}}',
    );
    expect(
      (usageContext(input, usage, [], at).get('backfill_usage') as JsonObject).get(
        'reflected_reservations',
      ),
    ).toEqual([]);
    const failed = usageContext(input, null, [], at).get('backfill_usage') as JsonObject;
    expect(failed.get('successful')).toBe(false);
    expect(failed.get('reflected_reservations')).toEqual([]);
  });
  it('refuses null reservation state and rounds fractional window at microsecond precision', () => {
    expect(() =>
      usageContext(obj('{"items":[],"backfill_reservations":null}'), usage, [], at),
    ).toThrow('backfill_reservations');
    expect(() =>
      usageContext(queue, obj('{"remaining":3,"reflected_reservations":null}'), [], at),
    ).toThrow('reflected_reservations');
    const input = obj(
      '{"items":[],"backfill_reservations":{"a":{"terminal_at":"2026-10-30T00:09:59Z","quota_state":"reserved"}}}',
    );
    const exact = usageContext(input, obj('{"remaining":3,"rollingWindowMs":1000.0004}'), [], at);
    const later = usageContext(input, obj('{"remaining":3,"rollingWindowMs":1000.0006}'), [], at);
    expect(
      ((exact.get('backfill_reservations') as JsonObject).get('a') as JsonObject).get(
        'quota_state',
      ),
    ).toBe('expired');
    expect(
      ((later.get('backfill_reservations') as JsonObject).get('a') as JsonObject).get(
        'quota_state',
      ),
    ).toBe('reserved');
  });
});

describe('rank-four gate', () => {
  it('refreshes stale usage and spools before saving the reservation', async () => {
    const calls: string[] = [];
    let saved: JsonObject | undefined;
    const effects: Rank4GateEffects = {
      now: () => at,
      async refreshUsage(value) {
        calls.push('refresh');
        return { queue: usageContext(value, usage, [], at), successful: true };
      },
      async stateEvent(value, item, _at, reason) {
        calls.push('event');
        expect(item.get('vendor_state')).toBe('unknown');
        expect(reason).toBe('atomic quota reservation before launch');
        expect((value.get('backfill_reservations') as JsonObject).has('job:1')).toBe(true);
        return value;
      },
      async saveQueue(value) {
        calls.push('save');
        saved = value;
      },
    };
    const result = await rank4Gate(queue, 0, false, false, effects);
    expect(result.admitted).toBe(true);
    expect(calls).toEqual(['refresh', 'event', 'save']);
    expect(saved).toBe(result.queue);
    expect(result.queue.get('backfill_starts_at_observation')).toEqual(obj('{"n":0}').get('n'));
    expect((result.queue.get('backfill_daily_capacity') as JsonObject).has('2026-10-30')).toBe(
      true,
    );
  });
  it('subtracts later ordinary starts and refuses without event or save', async () => {
    const input = obj(
      '{"items":[{"id":"one","kind":"backfill","state":"pending"}],"starts":["s1"],"backfill_starts_at_observation":0,"backfill_usage":{"successful":true,"remaining":2,"observed_at":"2026-10-30T00:10:00Z"}}',
    );
    const calls: string[] = [];
    const result = await rank4Gate(input, 0, false, false, {
      now: () => at,
      async stateEvent(q) {
        calls.push('event');
        return q;
      },
      async saveQueue() {
        calls.push('save');
      },
    });
    expect(result.admitted).toBe(false);
    expect(calls).toEqual([]);
    expect((result.queue.get('items') as JsonObject[])[0]?.get('wait_reason')).toBe(
      'one-slot-reserve',
    );
  });
  it('preserves the old checkpoint after a failed usage refresh', async () => {
    const stale = obj(
      '{"items":[{"id":"one"}],"starts":["a","b","c","d","e"],"backfill_starts_at_observation":2,"backfill_usage":{"successful":true,"remaining":5,"observed_at":"2026-10-30T00:08:00Z"}}',
    );
    const result = await rank4Gate(stale, 0, false, true, {
      now: () => at,
      async refreshUsage(q) {
        return { queue: q, successful: false };
      },
      async stateEvent(q) {
        return q;
      },
      async saveQueue() {
        throw new Error('unexpected save');
      },
    });
    expect(result.admitted).toBe(true);
    expect(result.queue.get('backfill_starts_at_observation')).toEqual(obj('{"n":2}').get('n'));
    const row = (result.queue.get('backfill_admissions') as JsonObject[])[0];
    expect(row?.get('effective_remaining')).toEqual(obj('{"n":2}').get('n'));
  });
  it('does not refresh under ordinary priority or repeat a recent failed probe', async () => {
    let refreshes = 0;
    const effects: Rank4GateEffects = {
      now: () => at,
      async refreshUsage(q) {
        refreshes++;
        return { queue: q, successful: false };
      },
      async stateEvent(q) {
        return q;
      },
      async saveQueue() {
        throw new Error('unexpected save');
      },
    };
    expect((await rank4Gate(queue, 0, true, false, effects)).admitted).toBe(false);
    const recent = obj('{"items":[{"id":"one"}],"backfill_usage_probe_at":"2026-10-30T00:09:30Z"}');
    expect((await rank4Gate(recent, 0, false, false, effects)).admitted).toBe(false);
    expect(refreshes).toBe(0);
  });
  it('retains an empty observation and avoids double-counting a held start', async () => {
    const effects: Rank4GateEffects = {
      now: () => at,
      async stateEvent(q) {
        return q;
      },
      async saveQueue() {
        throw new Error('unexpected save');
      },
    };
    const empty = obj('{"items":[{"id":"one"}],"backfill_usage":{}}');
    const refused = await rank4Gate(empty, 0, false, true, effects);
    const history = refused.queue.get('backfill_admissions') as JsonObject[];
    expect(history[0]?.get('observation')).toEqual(obj('{}'));
    const held = obj(
      '{"items":[{"id":"one"}],"starts":["s1"],"backfill_starts_at_observation":0,"backfill_reservations":{"x":{"at":"2026-10-30T00:10:00Z","quota_state":"reserved"}},"backfill_usage":{"successful":true,"remaining":3,"observed_at":"2026-10-30T00:10:00Z"}}',
    );
    const result = await rank4Gate(held, 0, false, true, effects);
    expect(result.admitted).toBe(true);
    const row = (result.queue.get('backfill_admissions') as JsonObject[])[0];
    expect(row?.get('effective_remaining')).toEqual(obj('{"value":2}').get('value'));
  });
  it('dry run does not reserve or perform durable effects', async () => {
    const ready = usageContext(queue, usage, [], at);
    const result = await rank4Gate(ready, 0, false, true, {
      now: () => at,
      async stateEvent() {
        throw new Error('unexpected event');
      },
      async saveQueue() {
        throw new Error('unexpected save');
      },
    });
    expect(result.admitted).toBe(true);
    expect((result.queue.get('items') as JsonObject[])[0]?.get('state')).toBe('pending');
  });
  it('propagates durable failures and never reaches save after a failed event', async () => {
    const ready = usageContext(queue, usage, [], at);
    let saved = false;
    await expect(
      rank4Gate(ready, 0, false, false, {
        now: () => at,
        async stateEvent() {
          throw new Error('event failed');
        },
        async saveQueue() {
          saved = true;
        },
      }),
    ).rejects.toThrow('event failed');
    expect(saved).toBe(false);
    await expect(
      rank4Gate(ready, 0, false, false, {
        now: () => at,
        async stateEvent(q) {
          return q;
        },
        async saveQueue() {
          throw new Error('save failed');
        },
      }),
    ).rejects.toThrow('save failed');
  });
  it('refuses null daily capacity rather than silently overwriting it', async () => {
    const ready = usageContext(
      obj(
        '{"items":[{"id":"one","job_id":"job","kind":"backfill","state":"pending","attempt":0}],"starts":[],"backfill_daily_capacity":null}',
      ),
      usage,
      [],
      at,
    );
    let saved = false;
    await expect(
      rank4Gate(ready, 0, false, false, {
        now: () => at,
        async stateEvent(q) {
          return q;
        },
        async saveQueue() {
          saved = true;
        },
      }),
    ).rejects.toThrow('backfill_daily_capacity');
    expect(saved).toBe(false);
  });
});
