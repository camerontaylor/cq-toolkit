/**
 * Differential replay of the pure finding identity, normalization and recovery
 * row transitions. The oracle is `apps/crq-python/finding_delivery.py`.
 */
import { describe, expect, test } from 'vitest';
import {
  FindingDeliveryAttributeError,
  findingOccurrence,
  normalizeFinding,
  transitionFindingRow,
} from '../../../src/policy/crq/findingDelivery.js';
import { JsonObject, type JsonValue } from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerKeyError,
  LedgerTimestampError,
  LedgerTypeError,
  LedgerUnicodeDecodeError,
  ledgerCanonicalText,
} from '../../../src/policy/crq/ledger.js';
import { findingDigest } from '../../../src/policy/crq/repairBinding.js';
import {
  loadFindingDeliveryVectors,
  objectField,
  plain,
  stringField,
  type FindingDeliveryCase,
} from './findingDeliveryVectors.js';

const cases = loadFindingDeliveryVectors();

function pythonErrorClass(error: unknown): string {
  if (error instanceof FindingDeliveryAttributeError) return error.pythonError;
  if (error instanceof LedgerTypeError) return error.pythonError;
  if (error instanceof LedgerKeyError) return error.pythonError;
  if (error instanceof LedgerIntegrityError) return error.pythonError;
  if (error instanceof LedgerTimestampError) return error.pythonError;
  if (error instanceof LedgerJsonDecodeError) return error.pythonError;
  if (error instanceof LedgerUnicodeDecodeError) return error.pythonError;
  return error instanceof Error ? error.name : 'UnknownError';
}

function outcome(
  action: () => JsonValue,
): { ok: true; value: JsonValue } | { ok: false; error: string; message: string } {
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

function assertExpectation(entry: FindingDeliveryCase, result: ReturnType<typeof outcome>): void {
  const expectObject = entry.expect;
  if (!(expectObject.get('ok') === true)) {
    const expectedError = stringField(expectObject, 'error');
    expect(result.ok, `${entry.family}/${entry.name}: expected ${expectedError}`).toBe(false);
    if (result.ok) return;
    expect(result.error, `${entry.family}/${entry.name}`).toBe(expectedError);
    const expectedMessage = expectObject.get('message');
    if (typeof expectedMessage === 'string') {
      expect(result.message, `${entry.family}/${entry.name}`).toBe(expectedMessage);
    }
    return;
  }
  expect(result.ok, `${entry.family}/${entry.name}: unexpected refusal`).toBe(true);
}

function occurrenceOrNormalize(entry: FindingDeliveryCase): ReturnType<typeof outcome> {
  const input = entry.input;
  const producer = stringField(input, 'producer');
  const runId = stringField(input, 'run_id');
  const finding = input.get('finding') as JsonValue;
  if (entry.family === 'occurrence') {
    return outcome(() => findingOccurrence(producer, runId, finding));
  }
  return outcome(() => normalizeFinding(producer, runId, finding));
}

function transition(entry: FindingDeliveryCase): ReturnType<typeof outcome> {
  return outcome(() => {
    const result = transitionFindingRow(
      entry.input.get('row') as JsonValue,
      entry.input.get('event') as JsonValue,
    );
    if (result.kind === 'apply') {
      return new JsonObject([
        ['kind', result.kind],
        ['canonical', ledgerCanonicalText(result.row)],
      ]);
    }
    return new JsonObject([['kind', result.kind]]);
  });
}

describe('finding delivery vectors', () => {
  test('the fixture has the expected families and no duplicate case names', () => {
    const families = [...new Set(cases.map((entry) => entry.family))];
    expect(families).toEqual([
      'occurrence',
      'normalize',
      'transition',
      'ingest',
      'recover',
      'handoff',
    ]);
    expect(new Set(cases.map((entry) => `${entry.family}/${entry.name}`)).size).toBe(cases.length);
  });

  test('occurrence and normalize replay exact values and Python refusals', () => {
    const selected = cases.filter(
      (entry) => entry.family === 'occurrence' || entry.family === 'normalize',
    );
    expect(selected.length).toBeGreaterThan(0);
    for (const entry of selected) {
      const result = occurrenceOrNormalize(entry);
      assertExpectation(entry, result);
      if (entry.expect.get('ok') === true && result.ok) {
        expect(plain(result.value), `${entry.family}/${entry.name}`).toEqual(
          plain(entry.expect.get('value') as JsonValue),
        );
      }
    }
  });

  test('transition replay returns the same kind and canonical row bytes', () => {
    const selected = cases.filter((entry) => entry.family === 'transition');
    expect(selected.length).toBeGreaterThan(0);
    for (const entry of selected) {
      const result = transition(entry);
      assertExpectation(entry, result);
      if (entry.expect.get('ok') === true && result.ok) {
        const expected = objectField(entry.expect, 'value');
        expect(plain(result.value), `${entry.name}`).toEqual(plain(expected));
      }
    }
  });

  test('the occurrence identity is not the finding content digest', () => {
    const entry = cases.find(
      (candidate) => candidate.family === 'normalize' && candidate.name === 'normalize-verified',
    );
    if (entry === undefined) throw new Error('normalize-verified vector missing');
    const finding = objectField(entry.input, 'finding');
    const occurrence = findingOccurrence(
      stringField(entry.input, 'producer'),
      stringField(entry.input, 'run_id'),
      finding,
    );
    expect(occurrence).not.toBe(findingDigest(finding));
  });

  test('identity fields are load-bearing', () => {
    const entry = cases.find((candidate) => candidate.name === 'run-differs');
    if (entry === undefined) throw new Error('run-differs vector missing');
    const finding = objectField(entry.input, 'finding');
    expect(findingOccurrence('crq-runner-app', 'run-1', finding)).not.toBe(
      findingOccurrence('crq-runner-app', 'run-2', finding),
    );
    expect(findingOccurrence('crq-runner-app', 'run-1', finding)).not.toBe(
      findingOccurrence('other', 'run-1', finding),
    );
  });

  test('a duplicate without target leaves canonical_id untouched', () => {
    const entry = cases.find(
      (candidate) => candidate.name === 'transition-duplicate-without-target',
    );
    if (entry === undefined) throw new Error('duplicate-without-target vector missing');
    const result = transitionFindingRow(
      entry.input.get('row') as JsonValue,
      entry.input.get('event') as JsonValue,
    );
    expect(result.kind).toBe('apply');
    if (result.kind !== 'apply') return;
    expect(result.row.get('canonical_id')).toBe(
      objectField(entry.input, 'row').get('canonical_id'),
    );
  });

  test('the ingest and recover families carry their own operation input', () => {
    const impure = cases.filter((entry) => entry.family === 'ingest' || entry.family === 'recover');
    expect(impure.length).toBeGreaterThan(0);
    expect(impure.every((entry) => entry.input.has('review') || entry.input.has('events'))).toBe(
      true,
    );
  });
});
