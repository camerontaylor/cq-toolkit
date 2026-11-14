import { describe, expect, test } from 'vitest';
import {
  enqueue,
  isExecutionOwner,
  scopeOwner,
  units,
} from '../../../src/policy/crq/backfillJobs.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { LedgerIntegrityError } from '../../../src/policy/crq/ledger.js';

const obj = (source: string): JsonObject => {
  const value = parseJsonValue(source);
  if (!(value instanceof JsonObject)) throw new Error('expected object');
  return value;
};
const at = '2026-10-30T00:00:00Z';
const partition = obj(
  '{"job_id":"j:0","subject_id":"j","generation":0,"kind":"A","target":"t","scope_digest":"d","family":"f","scope":[{"path":"new"},{"path":"other"},{"path":"new"}],"path_lineages":{"new":"old"},"prs":[42],"unknown":900719925474099312345,"fraction":1.0}',
);

describe('backfill enqueue policy', () => {
  test('sorts lineage units by Unicode code point', () => {
    expect(units(obj('{"scope":[{"path":"😀"},{"path":""}]}'))).toEqual(['', '😀']);
  });
  test('constructs a lossless job and histories, then deduplicates by generation', () => {
    const input = obj('{"extra":1.0}');
    const first = enqueue(input, partition, at);
    expect(first.item.get('id')).toBe('backfill-j-g0');
    expect(first.item.get('subject_kind')).toBe('A');
    expect(first.item.get('unknown')).toBe(partition.get('unknown'));
    expect(first.item.get('fraction')).toBe(partition.get('fraction'));
    expect(units(first.item)).toEqual(['old', 'other']);
    expect(input.has('items')).toBe(false);
    const second = enqueue(first.queue, partition, at);
    expect(second.item).toBe(first.item);
    expect(second.queue).toBe(first.queue);
    expect(() =>
      enqueue(first.queue, obj('{"job_id":"j:0","scope_digest":"different"}'), at),
    ).toThrowError(new LedgerIntegrityError('job generation scope conflict'));
  });

  test('scope ownership includes pending, publication and uncertain runs but not terminal blocked jobs', () => {
    for (const item of [
      '{"state":"pending"}',
      '{"state":"publication-pending"}',
      '{"vendor_state":"unknown"}',
      '{"run":{"id":"x"}}',
    ])
      expect(scopeOwner(obj(item))).toBe(true);
    expect(isExecutionOwner(obj('{"state":"publication-pending"}'))).toBe(false);
    expect(scopeOwner(obj('{"state":"blocked","vendor_state":"terminal","run":null}'))).toBe(false);
    const queue = obj(
      '{"items":[{"job_id":"other","state":"publication-pending","target":"t","scope_digest":"d"}]}',
    );
    expect(enqueue(queue, partition, at).queue).toBe(queue);
  });

  test('family and lineage failures survive changed generations and quarantine', () => {
    const queue = obj(
      '{"items":[],"backfill_families":{"f":{"failures":3,"quarantined":false,"next_eligible_at":null,"extra":1.0}},"backfill_scope_failures":{"old":{"failures":6,"quarantined":true,"next_eligible_at":"2026-11-01T00:00:00Z"}}}',
    );
    const { item, queue: result } = enqueue(queue, partition, at);
    expect(item.get('state')).toBe('quarantined');
    expect(item.get('family_failures')).toEqual(obj('{"x":6}').get('x'));
    expect((result.get('backfill_families') as JsonObject).get('f')).toBe(
      (queue.get('backfill_families') as JsonObject).get('f'),
    );
    expect((result.get('backfill_scope_failures') as JsonObject).has('other')).toBe(true);
  });

  test('validates timestamp before deduplication', () => {
    const first = enqueue(obj('{}'), partition, at);
    expect(() => enqueue(first.queue, partition, 'bad')).toThrow();
  });
});
