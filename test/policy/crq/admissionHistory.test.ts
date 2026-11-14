import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { recordGet } from '../../../src/policy/crq/queueDoc.js';
import {
  ADMISSION_HISTORY_LIMIT,
  ADMISSION_HISTORY_MARKER,
  ADMISSION_HISTORY_VERSION,
  AdmissionHistoryError,
  appendAdmission,
  summarizeAdmission,
} from '../../../src/policy/crq/admissionHistory.js';
import { loadFamily, valueAt } from './backfillFixtures.js';

const SUMMARIZE = loadFamily('backfill').filter(
  (vector) => vector.source === 'admission_history.summarize',
);

describe.each(SUMMARIZE)('group-p admission-history/$name', (vector) => {
  test('admission_history.summarize matches the Python oracle', () => {
    expect(summarizeAdmission(valueAt(vector.input, 'decision'))).toEqual(
      toPlainJson(valueAt(vector.expect, 'value') as JsonValue),
    );
  });
});

function decision(at: string): Record<string, unknown> {
  return {
    at,
    item: 'job-1',
    ordinary_eligible: true,
    effective_remaining: 1,
    decision: 'defer',
    observation: { successful: true, observed_at: at, remaining: 0, ignored: 'x' },
    reservations: { a: { quota_state: 'reserved' } },
  };
}

/** A queue document as the runner decodes it: lossless, not a plain object. */
function decodedQueue(value: unknown): JsonObject {
  const parsed = parseJsonValue(JSON.stringify(value));
  if (!(parsed instanceof JsonObject)) throw new Error('queue fixture is not an object');
  return parsed;
}

function humanRow(index: number): Record<string, unknown> {
  return { at: `old-${index}`, item: `job-${index}`, decision: 'defer' };
}

test('an appended row is the bounded summary, not the whole decision', () => {
  const { queue, row } = appendAdmission(decodedQueue({}), decision('2026-11-09T00:00:00Z'));
  expect(toPlainJson(row)).toEqual({
    at: '2026-11-09T00:00:00Z',
    item: 'job-1',
    ordinary_eligible: true,
    effective_remaining: 1,
    decision: 'defer',
    observation: { successful: true, observed_at: '2026-11-09T00:00:00Z', remaining: 0 },
    reservation_counts: { reserved: 1 },
  });
  expect(toPlainJson(recordGet(queue, ADMISSION_HISTORY_MARKER) as JsonValue)).toBe(
    ADMISSION_HISTORY_VERSION,
  );
  expect(toPlainJson(recordGet(queue, 'backfill_admissions') as JsonValue)).toEqual([
    toPlainJson(row),
  ]);
});

test('appending keeps the queue lossless and leaves the given document alone', () => {
  const original = decodedQueue({ items: [{ id: 'a' }] });
  const { queue } = appendAdmission(original, decision('2026-11-09T00:00:00Z'));
  // The oracle mutates in place; an immutable document returns the next one.
  expect(recordGet(original, 'backfill_admissions')).toBeUndefined();
  expect(Array.isArray(recordGet(queue, 'backfill_admissions'))).toBe(true);
  expect(toPlainJson(recordGet(queue, 'items') as JsonValue)).toEqual([{ id: 'a' }]);
});

test('retention drops the oldest rows past the limit', () => {
  const rows: unknown[] = [];
  for (let index = 0; index < ADMISSION_HISTORY_LIMIT; index += 1) rows.push(humanRow(index));
  const { queue } = appendAdmission(
    decodedQueue({ backfill_admissions: rows }),
    decision('2026-11-09T00:00:00Z'),
  );
  const kept = toPlainJson(recordGet(queue, 'backfill_admissions') as JsonValue) as Array<
    Record<string, unknown>
  >;
  expect(kept).toHaveLength(ADMISSION_HISTORY_LIMIT);
  expect(kept[0]?.['at']).toBe('old-1');
  expect(kept[kept.length - 1]?.['at']).toBe('2026-11-09T00:00:00Z');
});

test('an explicit reservation_counts wins over the recount', () => {
  const row = summarizeAdmission({
    ...decision('2026-11-09T00:00:00Z'),
    reservation_counts: { exhausted: 2 },
  }) as Record<string, unknown>;
  expect(row['reservation_counts']).toEqual({ exhausted: 2 });
});

test('a malformed admission refuses instead of writing a partial row', () => {
  expect(() => summarizeAdmission(null)).toThrow(AdmissionHistoryError);
  expect(() => summarizeAdmission({ reservations: { a: {} }, observation: 3 })).toThrow(
    'observation must be an object',
  );
  expect(() => summarizeAdmission({ reservations: { a: { quota_state: 7 } } })).toThrow(
    'reservation quota_state must be a string',
  );
  expect(() =>
    appendAdmission(decodedQueue({ backfill_admissions: {} }), decision('2026-11-09T00:00:00Z')),
  ).toThrow('backfill_admissions must be an array');
});

test('a decision without an observation records an explicit null', () => {
  const { observation, ...rest } = decision('2026-11-09T00:00:00Z');
  expect(observation).toBeDefined();
  const row = summarizeAdmission(rest) as Record<string, unknown>;
  expect(row).toHaveProperty('observation', null);
  expect(row['reservation_counts']).toEqual({ reserved: 1 });
});
