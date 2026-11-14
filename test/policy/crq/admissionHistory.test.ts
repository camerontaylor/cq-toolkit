import { describe, expect, test } from 'vitest';
import { toPlainJson, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
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

test('an appended row is the bounded summary, not the whole decision', () => {
  const queue: Record<string, unknown> = {};
  const row = appendAdmission(queue, decision('2026-11-09T00:00:00Z')) as Record<string, unknown>;
  expect(row).toEqual({
    at: '2026-11-09T00:00:00Z',
    item: 'job-1',
    ordinary_eligible: true,
    effective_remaining: 1,
    decision: 'defer',
    observation: { successful: true, observed_at: '2026-11-09T00:00:00Z', remaining: 0 },
    reservation_counts: { reserved: 1 },
  });
  expect(queue[ADMISSION_HISTORY_MARKER]).toBe(ADMISSION_HISTORY_VERSION);
  expect(queue['backfill_admissions']).toEqual([row]);
});

test('retention drops the oldest rows past the limit', () => {
  const rows: unknown[] = [];
  for (let index = 0; index < ADMISSION_HISTORY_LIMIT; index += 1) {
    rows.push({ at: `old-${index}` });
  }
  const queue: Record<string, unknown> = { backfill_admissions: rows };
  appendAdmission(queue, decision('2026-11-09T00:00:00Z'));
  const kept = queue['backfill_admissions'] as Array<Record<string, unknown>>;
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
  const queue: Record<string, unknown> = { backfill_admissions: {} };
  expect(() => appendAdmission(queue, decision('2026-11-09T00:00:00Z'))).toThrow(
    'backfill_admissions must be an array',
  );
});

test('a decision without an observation records an explicit null', () => {
  const { observation, ...rest } = decision('2026-11-09T00:00:00Z');
  expect(observation).toBeDefined();
  const row = summarizeAdmission(rest) as Record<string, unknown>;
  expect(row).toHaveProperty('observation', null);
  expect(row['reservation_counts']).toEqual({ reserved: 1 });
});
