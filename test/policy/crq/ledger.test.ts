import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerTimestampError,
  independentBatch,
  independentImport,
  initialInventoryEnrollment,
  ledgerCanonicalText,
  ledgerCreditable,
  ledgerDigestOf,
  ledgerEvent,
  ledgerIntervals,
  ledgerLoads,
  ledgerPath,
  ledgerRecordPath,
  ledgerScope,
  ledgerTimestamp,
  ledgerValidate,
  ledgerValidateSequence,
} from '../../../src/policy/crq/ledger.js';
import { REVIEW_LEDGER_SCHEMA } from '../../../src/policy/crq/ledgerSchema.js';
import { PythonJsonError, compareCodePoints } from '../../../src/policy/crq/pythonJson.js';

const VECTORS = new URL(
  '../../../apps/crq-python/fixtures/crq-ledger-b1/vectors.json',
  import.meta.url,
);
const SCHEMA = new URL('../../../policy/review-ledger.schema.json', import.meta.url);
const ACTION_ENUM = [
  'confirmed',
  'already-fixed',
  'needs-retriage',
  'superseded',
  'dismissed',
  'needs-human',
  'duplicate',
  'delivered',
  'fixed',
] as const;

interface VectorCase {
  readonly family: string;
  readonly name: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly expect: JsonObject;
}

type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly pythonError: string; readonly message: string };

function requireObject(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${what} is not an object`);
  return value;
}

function stringAt(object: JsonObject, key: string): string {
  const value = object.get(key);
  if (typeof value !== 'string') throw new Error(`missing string ${key}`);
  return value;
}

function valueAt(object: JsonObject, key: string): JsonValue {
  const value = object.get(key);
  if (value === undefined) throw new Error(`missing value ${key}`);
  return value;
}

function arrayAt(object: JsonObject, key: string): JsonValue[] {
  const value = object.get(key);
  if (!Array.isArray(value)) throw new Error(`missing array ${key}`);
  return value;
}

function loadVectors(): VectorCase[] {
  const document = requireObject(parseJsonValue(readFileSync(VECTORS, 'utf8')), 'vector document');
  if (document.get('schema') !== 'cq.crq-ledger-b1-vector/v1') {
    throw new Error('unexpected B1 vector schema');
  }
  const cases: VectorCase[] = [];
  for (const familyValue of arrayAt(document, 'families')) {
    const family = requireObject(familyValue, 'family');
    const name = stringAt(family, 'family');
    for (const caseValue of arrayAt(family, 'cases')) {
      const entry = requireObject(caseValue, 'case');
      cases.push({
        family: name,
        name: stringAt(entry, 'name'),
        source: stringAt(entry, 'source'),
        input: requireObject(entry.get('input'), 'input'),
        expect: requireObject(entry.get('expect'), 'expect'),
      });
    }
  }
  return cases;
}

function capture(action: () => unknown): Outcome {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    if (
      error instanceof PythonJsonError ||
      error instanceof LedgerIntegrityError ||
      error instanceof LedgerTimestampError ||
      error instanceof LedgerJsonDecodeError
    ) {
      return { ok: false, pythonError: error.pythonError, message: error.message };
    }
    throw error;
  }
}

function projectScope(rows: JsonValue): unknown {
  const scope = ledgerScope(rows);
  const projected: Array<[string, string, number[]]> = [];
  for (const [path, blobs] of scope) {
    for (const [blob, lines] of blobs) {
      projected.push([path, blob, [...lines].sort((left, right) => left - right)]);
    }
  }
  projected.sort(
    (left, right) => compareCodePoints(left[0], right[0]) || compareCodePoints(left[1], right[1]),
  );
  return projected;
}

function sortedKeys(ids: Map<string, JsonValue>): string[] {
  return [...ids.keys()].sort();
}

function run(vector: VectorCase): unknown {
  const input = vector.input;
  switch (vector.source) {
    case 'review_ledger.canonical+digest': {
      const value = valueAt(input, 'value');
      return { canonical: ledgerCanonicalText(value), sha256: ledgerDigestOf(value) };
    }
    case 'review_ledger.loads':
      return toPlainJson(ledgerLoads(stringAt(input, 'raw')));
    case 'review_ledger.timestamp':
      return ledgerTimestamp(valueAt(input, 'value'));
    case 'review_ledger.path':
      return ledgerPath(valueAt(input, 'value'));
    case 'review_ledger.intervals':
      return [...ledgerIntervals(valueAt(input, 'rows'))].sort((left, right) => left - right);
    case 'review_ledger.scope':
      return projectScope(valueAt(input, 'rows'));
    case 'review_ledger.event': {
      const value = ledgerEvent(
        stringAt(input, 'kind'),
        stringAt(input, 'source_key'),
        stringAt(input, 'occurred_at'),
        valueAt(input, 'payload'),
      );
      return {
        value: toPlainJson(value),
        canonical: ledgerCanonicalText(value),
        sha256: ledgerDigestOf(value),
        record_path: ledgerRecordPath(value),
      };
    }
    case 'review_ledger.validate':
      return toPlainJson(ledgerValidate(valueAt(input, 'value')));
    case 'review_ledger.record_path':
      return ledgerRecordPath(valueAt(input, 'value'));
    case 'review_ledger.creditable':
      return ledgerCreditable(valueAt(input, 'value'));
    case 'review_ledger.independent_import':
      return independentImport(valueAt(input, 'value'));
    case 'review_ledger.initial_inventory_enrollment':
      return initialInventoryEnrollment(valueAt(input, 'value'));
    case 'review_ledger.independent_batch':
      return independentBatch(arrayAt(input, 'values'), arrayAt(input, 'previous'));
    case 'review_ledger.validate_sequence':
      return sortedKeys(ledgerValidateSequence(arrayAt(input, 'values')));
    default:
      throw new Error(`unmapped vector source ${vector.source}`);
  }
}

function assertExpected(vector: VectorCase): void {
  const outcome = capture(() => run(vector));
  const expectedOk = vector.expect.get('ok');
  const label = `${vector.family}/${vector.name}`;
  if (expectedOk === true) {
    expect(outcome.ok, label).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value, label).toEqual(toPlainJson(valueAt(vector.expect, 'value')));
    return;
  }
  expect(outcome.ok, label).toBe(false);
  if (outcome.ok) return;
  expect(outcome.pythonError, label).toBe(stringAt(vector.expect, 'error'));
}

const vectors = loadVectors();

describe('B1 ledger vectors (Python oracle)', () => {
  test('every recorded case is exercised once', () => {
    expect(vectors.length).toBeGreaterThan(100);
    expect(new Set(vectors.map((vector) => `${vector.family}/${vector.name}`)).size).toBe(
      vectors.length,
    );
  });

  for (const family of new Set(vectors.map((vector) => vector.family))) {
    describe(family, () => {
      for (const vector of vectors.filter((entry) => entry.family === family)) {
        test(`${vector.name} (${vector.source})`, () => {
          assertExpected(vector);
        });
      }
    });
  }

  test('a changed canonical byte fails the differential', () => {
    const vector = vectors.find((entry) => entry.name === 'nested-unicode');
    if (vector === undefined) throw new Error('nested-unicode vector missing');
    const value = valueAt(vector.input, 'value');
    const actual = { canonical: ledgerCanonicalText(value), sha256: ledgerDigestOf(value) };
    const expected = toPlainJson(valueAt(vector.expect, 'value')) as { canonical: string };
    expect(() =>
      expect({ ...actual, canonical: `${actual.canonical} ` }).toEqual(expected),
    ).toThrow();
  });
});

describe('ledger schema contract', () => {
  test('the embedded schema equals the signer-validated policy document', () => {
    const source = toPlainJson(parseJsonValue(readFileSync(SCHEMA, 'utf8')));
    expect(REVIEW_LEDGER_SCHEMA).toEqual(source);
  });

  test('the finding action enum is unchanged (owner ruling D1)', () => {
    expect(findActionEnum(REVIEW_LEDGER_SCHEMA)).toEqual([...ACTION_ENUM]);
  });

  test('the schema version constant matches the embedded document', () => {
    const oneOf = REVIEW_LEDGER_SCHEMA['oneOf'];
    if (!Array.isArray(oneOf)) throw new Error('ledger schema lost oneOf');
    for (const branch of oneOf) {
      expect(
        isRecord(branch) ? (branch['properties'] as Record<string, unknown>)['schema'] : null,
      ).toEqual({
        const: 'cq.review-ledger/v1',
      });
    }
  });
});

describe('ledger records are pure and self-describing', () => {
  test('loads accepts bytes and strips a UTF-8 BOM like Python', () => {
    const bytes = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    expect(toPlainJson(ledgerLoads(bytes))).toEqual({});
  });

  test('an invalid calendar timestamp keeps the Python ValueError class', () => {
    expect(() => ledgerTimestamp('2026-02-30T00:00:00Z')).toThrow(LedgerTimestampError);
    expect(() => ledgerTimestamp('٢٠٢٦-١١-٠٩T٠٠:٠٠:٠٠Z')).toThrow(LedgerTimestampError);
  });

  test('record paths zero-pad the year and month', () => {
    const record = requireObject(
      parseJsonValue('{"occurred_at":"0001-01-02T00:00:00Z","id":"d"}'),
      'record',
    );
    expect(ledgerRecordPath(record)).toBe('records/0001/01/d.json');
  });
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function findActionEnum(value: unknown): readonly string[] | undefined {
  if (Array.isArray(value)) {
    if (value.includes('needs-retriage')) return value as readonly string[];
    for (const entry of value) {
      const found = findActionEnum(entry);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) {
      const found = findActionEnum(entry);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}
