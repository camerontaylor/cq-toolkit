import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import { JsonObject, parseJsonValue, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import { planRepairHarvest } from '../../../src/policy/crq/repairHarvest.js';
import { withoutObjectKey } from '../../../src/policy/crq/queueDoc.js';

const fixture = parseJsonValue(
  readFileSync(
    new URL('../../../apps/crq-python/fixtures/repair-harvest/cases.json', import.meta.url),
    'utf8',
  ),
) as JsonObject;
const seed = (fixture.get('harvest_cases') as JsonObject[]).find(
  (entry) => entry.get('name') === 'failed-exhausted',
) as JsonObject;
// A delivered row with no receipt: the first write leaves it receiptless.
const ROW = withoutObjectKey(seed.get('row_before') as JsonObject, 'receipt');
const RETAINED = seed.get('retained_before') as JsonValue[];

function plan(row: JsonObject, retained: readonly JsonValue[], job: string) {
  return planRepairHarvest({
    row,
    findingId: fixture.get('finding_id') as string,
    job,
    verdict: { verdict: 'failed', failureClass: 'exhausted', reason: 'driver budget exhausted' },
    reason: 'driver budget exhausted',
    at: fixture.get('at') as string,
    maxFindingRetries: 1,
    retained,
  });
}

describe('planRepairHarvest replay of a receiptless row', () => {
  test('replaying the persisted write is already-recorded, not escalated', () => {
    const first = plan(ROW, RETAINED, 'job-1');
    expect(first.kind).toBe('write');
    if (first.kind !== 'write') return;
    expect(first.action).toBe('needs-retriage');
    const replay = plan(first.row, [...RETAINED, first.event], 'job-1');
    expect(replay).toEqual({ kind: 'already-recorded', action: 'needs-retriage' });
  });

  test('a distinct job still escalates once the retry bound is reached', () => {
    const first = plan(ROW, RETAINED, 'job-1');
    if (first.kind !== 'write') throw new Error('expected a write');
    const other = plan(first.row, [...RETAINED, first.event], 'job-2');
    expect(other.kind).toBe('write');
    if (other.kind === 'write') expect(other.action).toBe('needs-human');
  });
});
