import { describe, expect, it, vi } from 'vitest';
import { JsonObject, parseJsonValue } from '../../../src/policy/crq/jsonValue.js';

let classification = '';
vi.mock('../../../src/policy/crq/classification.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/policy/crq/classification.js')>()),
  classify: () => parseJsonValue(classification),
}));

const { harvestBackfillFailure } = await import('../../../src/ops/crq/internal/backfillHarvest.js');

const enc = new TextEncoder();
const queue = parseJsonValue(
  '{"items":[{"id":"j","kind":"backfill","state":"reviewing","vendor_state":"live","family":"f","scope":[{"path":"a"}],"attempt_id":"a","run":{"run_id":"r","band":"background"},"failures":0}],"backfill_reservations":{"a":{"item":"j","vendor_run_id":"r","quota_state":"reserved"}}}',
) as JsonObject;
const artifacts = {
  meta: enc.encode('{"run_id":"r","item_id":"j","backfill":{"attempt_id":"a"}}'),
  exit: enc.encode('{"exit":1,"ended_at":"2026-10-30T01:00:00Z"}'),
  review: enc.encode(''),
};
const proof = { runId: 'r', exitCode: 1, terminalVerified: true } as const;
const vendor = '{"category":"vendor-rate-limited","code":"rate_limit","source":"vendor"}';
const classified = (complete: boolean, causes: string) =>
  `{"counted":false,"outcome":"rate_limited","wait_seconds":60,"failure_provenance":{"complete":${complete},"causes":[${causes}]}}`;

/** Python reclassifies an unproven rate-limit label as integrity, never defers it as quota. */
describe('unproven quota label', () => {
  it.each([
    ['incomplete provenance', classified(false, vendor)],
    ['no causes', classified(true, '')],
    [
      'a non-quota vendor cause',
      classified(true, '{"category":"unknown","code":"x","source":"vendor"}'),
    ],
  ])('quarantines as integrity with %s', async (_name, text) => {
    classification = text;
    const effects = {
      readArtifacts: async () => artifacts,
      retain: async () => undefined,
      stateEvent: async (q: JsonObject) => q,
      saveQueue: async () => undefined,
      cleanup: async () => undefined,
    };
    const result = await harvestBackfillFailure(queue, 0, proof, effects, 2);
    const item = (result.queue.get('items') as JsonObject[])[0] as JsonObject;
    expect(result.queue.get('cooldown_until')).toBeUndefined();
    expect(item.get('state')).toBe('quarantined');
  });
});
