/**
 * Differential replay of the pure canonical handoff construction against the
 * real Python `Inbox.handoff` receipt/event/row oracle.
 *
 * The builder is not an authorization or ownership decision. Cases that the
 * shared `canonicalHandoffRefusal` owns carry an input `gate` marker and are
 * not replayed here; Phase B tests them against the merged validator.
 */
import { describe, expect, test } from 'vitest';
import {
  planFindingHandoff,
  type FindingHandoffPlan,
} from '../../../src/policy/crq/findingHandoff.js';
import { JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerKeyError,
  LedgerTimestampError,
  LedgerTypeError,
  ledgerCanonicalBytes,
  ledgerLoads,
} from '../../../src/policy/crq/ledger.js';
import {
  arrayField,
  effectsFrom,
  loadFindingDeliveryVectors,
  objectField,
  rowsFrom,
  stringField,
  type FindingDeliveryCase,
} from './findingDeliveryVectors.js';

const cases = loadFindingDeliveryVectors().filter((entry) => entry.family === 'handoff');

type PlanOutcome =
  | { readonly ok: true; readonly value: FindingHandoffPlan }
  | { readonly ok: false; readonly error: string; readonly message: string };

function pythonErrorClass(error: unknown): string {
  if (error instanceof LedgerKeyError) return error.pythonError;
  if (error instanceof LedgerTypeError) return error.pythonError;
  if (error instanceof LedgerIntegrityError) return error.pythonError;
  if (error instanceof LedgerTimestampError) return error.pythonError;
  return error instanceof Error ? error.name : 'UnknownError';
}

function outcomePlan(action: () => FindingHandoffPlan): PlanOutcome {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    return {
      ok: false,
      error: pythonErrorClass(error),
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function caseOrThrow(name: string): FindingDeliveryCase {
  const entry = cases.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`handoff vector missing: ${name}`);
  return entry;
}

function rowFrom(entry: FindingDeliveryCase, key: string): JsonObject {
  const value = ledgerLoads(stringField(entry.input, key));
  if (!(value instanceof JsonObject)) throw new Error(`${entry.name}: row is not an object`);
  return value;
}

function planFor(
  entry: FindingDeliveryCase,
  rowKey: string,
  alreadyHandedOff: boolean,
): PlanOutcome {
  return outcomePlan(() =>
    planFindingHandoff({
      row: rowFrom(entry, rowKey),
      findingId: stringField(entry.input, 'finding_id'),
      job: objectField(entry.input, 'job'),
      at: stringField(entry.input, 'at'),
      alreadyHandedOff,
    }),
  );
}

function assertExpectation(entry: FindingDeliveryCase, result: PlanOutcome): void {
  if (entry.expect.get('ok') !== true) {
    const expectedError = stringField(entry.expect, 'error');
    expect(result.ok, `${entry.name}: expected ${expectedError}`).toBe(false);
    if (result.ok) throw new Error(`${entry.name}: expected ${expectedError}`);
    expect(result.error, entry.name).toBe(expectedError);
    const expectedMessage = entry.expect.get('message');
    if (typeof expectedMessage === 'string') {
      expect(result.message, entry.name).toBe(expectedMessage);
    }
    return;
  }
  expect(result.ok, `${entry.name}: unexpected refusal`).toBe(true);
  if (!result.ok) throw new Error(`${entry.name}: unexpected refusal`);
}

function expectCanonical(value: JsonValue, expected: string, what: string): void {
  expect(Buffer.from(ledgerCanonicalBytes(value)), what).toEqual(Buffer.from(expected, 'utf8'));
}

type WritePlan = Extract<FindingHandoffPlan, { readonly kind: 'write' }>;

function requirePlan(result: PlanOutcome, name: string): FindingHandoffPlan {
  expect(result.ok, `${name}: expected a plan`).toBe(true);
  if (!result.ok) throw new Error(`${name}: expected a plan`);
  return result.value;
}

function requireWrite(plan: FindingHandoffPlan, name: string): WritePlan {
  expect(plan.kind, `${name}: expected write`).toBe('write');
  if (plan.kind !== 'write') throw new Error(`${name}: expected write plan`);
  return plan;
}

function requireNone(plan: FindingHandoffPlan, name: string): void {
  expect(plan.kind, `${name}: expected none`).toBe('none');
  if (plan.kind !== 'none') throw new Error(`${name}: expected none plan`);
}

describe('canonical handoff construction vectors', () => {
  test('the handoff family is present and names are unique', () => {
    expect(cases.length).toBeGreaterThan(0);
    expect(new Set(cases.map((entry) => entry.name)).size).toBe(cases.length);
  });

  test('construct cases match exact receipt, event and row canonical bytes', () => {
    const construct = cases.filter((entry) => stringField(entry.input, 'mode') === 'construct');
    expect(construct.length).toBeGreaterThan(0);
    const constructWrites = construct.filter(
      (entry) =>
        entry.expect.get('ok') === true &&
        objectField(entry.expect, 'value').get('kind') === 'write',
    );
    expect(constructWrites.length, 'construct write coverage').toBeGreaterThan(0);
    for (const entry of construct) {
      const already = entry.input.get('already_handed_off') === true;
      const result = planFor(entry, 'row_canonical', already);
      assertExpectation(entry, result);
      if (entry.expect.get('ok') !== true) continue;
      const plan = requirePlan(result, entry.name);
      const expected = objectField(entry.expect, 'value');
      if (expected.get('kind') === 'none') {
        requireNone(plan, entry.name);
        continue;
      }
      const write = requireWrite(plan, entry.name);
      expectCanonical(
        write.receipt,
        stringField(expected, 'receipt_canonical'),
        `${entry.name} receipt`,
      );
      expectCanonical(write.event, stringField(expected, 'event_canonical'), `${entry.name} event`);
      expectCanonical(write.row, stringField(expected, 'row_canonical'), `${entry.name} row`);
    }
  });

  test('the write case preserves failure_class and matches the outbox event bytes', () => {
    const entry = caseOrThrow('handoff-written');
    const result = planFor(entry, 'row_canonical', false);
    const plan = requireWrite(requirePlan(result, 'handoff-written'), 'handoff-written');
    const event = plan.event;
    const row = plan.row;
    const after = rowsFrom(entry.expect.get('after'));
    expect(after).toHaveLength(1);
    const afterCanonical = after[0]?.canonical;
    if (typeof afterCanonical !== 'string') {
      throw new Error('handoff-written: oracle row missing');
    }
    expectCanonical(row, afterCanonical, 'handoff-written row');
    expect(row.get('failure_class')).toBe('evidence');
    const payload = objectField(event, 'payload');
    expect(objectField(payload, 'evidence').has('failure_class')).toBe(false);

    const eventId = stringField(event, 'id');
    const write = effectsFrom(entry.expect).find(
      (effect) => effect.get('kind') === 'write' && effect.get('target') === eventId,
    );
    expect(write).toBeDefined();
    if (write === undefined) {
      throw new Error('handoff-written: pending write effect missing');
    }
    expectCanonical(event, stringField(write, 'canonical'), 'handoff-written event');
    expect(arrayField(entry.expect, 'outbox')).toEqual([eventId]);
  });

  test('idempotent cases avoid construction, including a malformed job', () => {
    const already = caseOrThrow('handoff-already-handed-off');
    const alreadyResult = planFor(already, 'row_canonical', true);
    requireNone(
      requirePlan(alreadyResult, 'handoff-already-handed-off'),
      'handoff-already-handed-off',
    );

    const malformed = caseOrThrow('handoff-construct-idempotent-no-construction');
    const malformedResult = planFor(malformed, 'row_canonical', true);
    requireNone(
      requirePlan(malformedResult, 'handoff-construct-idempotent-no-construction'),
      'handoff-construct-idempotent-no-construction',
    );
  });

  test('the recovered-after-crash case plans from the actual row after recover', () => {
    const entry = caseOrThrow('handoff-recovered-after-crash');
    const before = rowFrom(entry, 'row_canonical');
    const after = rowFrom(entry, 'row_after_canonical');
    expectCanonical(before, stringField(entry.input, 'row_canonical'), 'pre-recover row');
    expectCanonical(after, stringField(entry.input, 'row_after_canonical'), 'post-recover row');
    expect(ledgerCanonicalBytes(before)).not.toEqual(ledgerCanonicalBytes(after));
    expect(before.get('failure_class')).toBe('evidence');
    expect(after.get('failure_class')).toBeNull();

    const result = planFor(entry, 'row_after_canonical', true);
    requireNone(
      requirePlan(result, 'handoff-recovered-after-crash'),
      'handoff-recovered-after-crash',
    );
  });

  test('every effect refusal is marked as gate-owned', () => {
    const refusals = cases.filter(
      (entry) => stringField(entry.input, 'mode') === 'effect' && entry.expect.get('ok') !== true,
    );
    expect(refusals.length).toBeGreaterThan(0);
    for (const entry of refusals) {
      expect(entry.input.get('gate'), entry.name).toBe('canonicalHandoffRefusal');
    }
  });
});
