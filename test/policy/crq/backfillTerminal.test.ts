import { describe, expect, it } from 'vitest';
import { terminalBackfill } from '../../../src/policy/crq/backfillTerminal.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
const obj = (source: string): JsonObject => {
  const value = parseJsonValue(source);
  if (!(value instanceof JsonObject)) throw new Error('bad fixture');
  return value;
};
const input = () =>
  obj(
    '{"items":[{"id":"j","family":"f","scope":[{"path":"a"},{"path":"b"}],"state":"reviewing","vendor_state":"live","attempt_id":"x","run":{"run_id":"r"},"failures":0}],"backfill_reservations":{"x":{"quota_state":"reserved"}},"unknown":1.0}',
  );
const at = '2026-10-30T00:00:00Z';
describe('backfill terminal policy', () => {
  it('holds unknown ownership and defers successful completion to publication', () => {
    const unknown = terminalBackfill(input(), 0, at, 'error', false);
    expect(unknown.item.get('state')).toBe('launch-unknown');
    expect(unknown.item.get('run')).toBeInstanceOf(JsonObject);
    const success = terminalBackfill(input(), 0, at, 'completed', true);
    expect(success.item.get('state')).toBe('publication-pending');
    expect(success.item.get('run')).toBeNull();
    const holds = success.queue.get('backfill_reservations') as JsonObject;
    expect((holds.get('x') as JsonObject).get('terminal_at')).toBe(at);
  });
  it('updates family and scope cooldowns, blocks at three and quarantines at six', () => {
    let q = input();
    for (let i = 0; i < 6; i++) {
      const result = terminalBackfill(q, 0, at, 'error', true);
      q = result.queue;
      if (i === 0) expect(result.item.get('not_before')).toBe('2026-10-30T01:00:00Z');
      if (i === 2) expect(result.item.get('state')).toBe('blocked');
      if (i === 5) expect(result.item.get('state')).toBe('quarantined');
    }
    const family = q.get('backfill_families') as JsonObject;
    const scopes = q.get('backfill_scope_failures') as JsonObject;
    for (const row of [family.get('f'), scopes.get('a'), scopes.get('b')]) {
      expect((row as JsonObject).get('failures')).toEqual(obj('{"n":6}').get('n'));
      expect((row as JsonObject).get('quarantined')).toBe(true);
    }
  });
  it('honors retry-after and immediate quarantine', () => {
    const result = terminalBackfill(input(), 0, at, 'auth', true, 7200, 'auth error');
    expect(result.item.get('state')).toBe('quarantined');
    expect(result.item.get('not_before')).toBe('2026-10-30T02:00:00Z');
    expect(result.item.get('last_error')).toBe('auth error');
  });
});
