import { describe, expect, test } from 'vitest';
import {
  enqueue,
  admission,
  eligible,
  bindRun,
  cancelBeforeVendor,
  isExecutionOwner,
  scopeOwner,
  units,
} from '../../../src/policy/crq/backfillJobs.js';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';
import { LedgerIntegrityError } from '../../../src/policy/crq/ledger.js';
import { atomicJsonText } from '../../../src/policy/crq/pythonJson.js';

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

describe('backfill admission and ownership', () => {
  const input = obj(
    '{"unknown":1.0,"items":[{"id":"one","job_id":"job","kind":"backfill","state":"pending","vendor_state":"none","attempt":0,"family":"f","scope":[]},{"id":"two","kind":"backfill","state":"pending","vendor_state":"none","attempt":0,"family":"g","scope":[]}]}',
  );
  const usage = obj('{"successful":true,"remaining":2,"observed_at":"2026-10-30T00:00:00Z"}');
  test('reserves before launch and subtracts an unreflected reservation on the next decision', () => {
    const first = admission(input, 0, at, usage, false);
    expect(first.decision.get('decision')).toBe('admit');
    expect(first.item.get('state')).toBe('launch-unknown');
    expect(first.item.get('vendor_state')).toBe('unknown');
    expect(first.item.get('attempt_id')).toBe('job:1');
    expect(first.queue.get('unknown')).toBe(input.get('unknown'));
    const second = admission(first.queue, 1, at, usage, false);
    expect(second.decision.get('decision')).toBe('one-slot-reserve');
    expect(second.item.get('state')).toBe('pending');
    const bound = bindRun(first.queue, 0, 'vendor-1');
    expect(bound.item.get('state')).toBe('reviewing');
    expect(() => bindRun(bound.queue, 0, 'vendor-2')).toThrow('vendor identity conflict');
    const missingRunId = obj('{"items":[{"attempt_id":"a"}],"backfill_reservations":{"a":{}}}');
    expect(() => bindRun(missingRunId, 0, 'vendor-1')).toThrow('vendor_run_id');
    const cancelled = cancelBeforeVendor(first.queue, 0);
    expect((cancelled.queue.get('backfill_reservations') as JsonObject).get('job:1')).toEqual(
      obj(
        '{"item":"one","at":"2026-10-30T00:00:00Z","quota_state":"released","vendor_run_id":null}',
      ),
    );
    const withRun = obj('{"items":[{"run":{"id":"live"}}]}');
    expect(() => cancelBeforeVendor(withRun, 0)).toThrow('cannot cancel');
  });
  test('refuses stale, invalid, unknown quota and ordinary priority', () => {
    const decisions = [
      [null, 'usage-unknown'],
      [obj('{"successful":false}'), 'usage-unknown'],
      [
        obj('{"successful":true,"remaining":8,"observed_at":"2026-10-29T23:56:59Z"}'),
        'usage-stale-or-invalid',
      ],
      [
        obj('{"successful":true,"remaining":8.0,"observed_at":"2026-10-30T00:00:00Z"}'),
        'usage-stale-or-invalid',
      ],
      [obj('{"successful":true,"remaining":8,"observed_at":"bad"}'), 'usage-stale-or-invalid'],
      [
        obj('{"successful":true,"remaining":8,"observed_at":"2026-10-30T00:00:01Z"}'),
        'usage-stale-or-invalid',
      ],
    ] as const;
    for (const [observation, reason] of decisions)
      expect(admission(input, 0, at, observation, false).decision.get('decision')).toBe(reason);
    expect(admission(input, 0, at, usage, true).decision.get('decision')).toBe('ordinary-eligible');
    expect(
      admission(
        input,
        0,
        at,
        obj('{"successful":true,"remaining":8,"observed_at":"2026-10-29T23:57:00Z"}'),
        false,
        false,
      ).decision.get('decision'),
    ).toBe('admit');
  });
  test('subtracts only unreflected, active holds', () => {
    const queue = obj(
      '{"items":[{"id":"one","kind":"backfill"}],"backfill_reservations":{"a":{"quota_state":"reserved"},"b":{"quota_state":"reserved"},"c":{"quota_state":"released"},"d":{"quota_state":"expired"}}}',
    );
    const observation = obj(
      '{"successful":true,"remaining":3,"observed_at":"2026-10-30T00:00:00Z","reflected_reservations":["a"]}',
    );
    const result = admission(queue, 0, at, observation, false, false);
    expect(result.decision.get('decision')).toBe('admit');
    expect(result.decision.get('effective_remaining')).toEqual(obj('{"value":2}').get('value'));
    const mixed = obj(
      '{"successful":true,"remaining":3,"observed_at":"2026-10-30T00:00:00Z","reflected_reservations":["a",4,true,null]}',
    );
    expect(admission(queue, 0, at, mixed, false, false).decision.get('decision')).toBe('admit');
    const unhashable = obj(
      '{"successful":true,"remaining":3,"observed_at":"2026-10-30T00:00:00Z","reflected_reservations":[{}]}',
    );
    expect(() => admission(queue, 0, at, unhashable, false, false)).toThrow('unhashable');
  });
  test('retains the exact observed float in the persisted refusal diagnostic', () => {
    const floatUsage = obj(
      '{"successful":true,"remaining":8.0,"observed_at":"2026-10-30T00:00:00Z"}',
    );
    const result = admission(input, 0, at, floatUsage, false);
    expect(result.decision.get('decision')).toBe('usage-stale-or-invalid');
    expect(atomicJsonText(result.queue)).toContain('"remaining": 8.0');
  });
  test('dry admission records diagnostics without ownership and counts coverage in cap', () => {
    const dry = admission(input, 0, at, usage, false, false);
    expect(dry.item).toBe((input.get('items') as JsonObject[])[0]);
    expect((dry.queue.get('backfill_reservations') as JsonObject).entries).toHaveLength(0);
    const cap = obj(
      '{"items":[{"id":"one","state":"pending"},{"kind":"coverage","state":"reviewing"},{"kind":"backfill","vendor_state":"unknown"}]}',
    );
    expect(
      admission(
        cap,
        0,
        at,
        obj('{"successful":true,"remaining":10,"observed_at":"2026-10-30T00:00:00Z"}'),
        false,
      ).decision.get('decision'),
    ).toBe('rank4-inflight-cap');
  });
  test('eligibility observes cooldown, quarantine and persisted lineage histories', () => {
    const item = (input.get('items') as JsonObject[])[0];
    if (item === undefined) throw new Error('missing test item');
    expect(eligible(input, item, at).eligible).toBe(true);
    expect(eligible(obj('{"cooldown_until":"bad"}'), item, at).eligible).toBe(false);
    expect(
      eligible(obj('{"backfill_families":{"f":{"quarantined":true}}}'), item, at).eligible,
    ).toBe(false);
  });
});
