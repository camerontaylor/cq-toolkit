import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  LedgerIntegrityError,
  LedgerJsonDecodeError,
  LedgerTimestampError,
  LedgerUnicodeDecodeError,
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

function bytesAt(object: JsonObject, key: string): Uint8Array {
  return Uint8Array.from(
    arrayAt(object, key).map((entry) => {
      if (!(entry instanceof JsonNumber) || entry.kind !== 'int') {
        throw new Error(`non-integer byte in ${key}`);
      }
      const byte = Number(entry.integer);
      if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new Error(`byte out of range in ${key}`);
      }
      return byte;
    }),
  );
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
      error instanceof LedgerJsonDecodeError ||
      error instanceof LedgerUnicodeDecodeError
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
      return toPlainJson(
        input.get('bytes') === undefined
          ? ledgerLoads(stringAt(input, 'raw'))
          : ledgerLoads(bytesAt(input, 'bytes')),
      );
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

  test('loads detects UTF-16 and UTF-32 byte encodings like Python', () => {
    // `{"雪":1}` in UTF-16LE, selected by the `xx 00` heuristic.
    const utf16 = new Uint8Array(Buffer.from('{"雪":1}', 'utf16le'));
    expect(toPlainJson(ledgerLoads(utf16))).toEqual({ 雪: 1 });

    // `{}` in UTF-32BE, selected by the `00 00` heuristic.
    const utf32 = new Uint8Array([0, 0, 0, 0x7b, 0, 0, 0, 0x7d]);
    expect(toPlainJson(ledgerLoads(utf32))).toEqual({});

    // A UTF-16BE BOM outranks the byte heuristics.
    const bom = new Uint8Array([0xfe, 0xff, 0, 0x7b, 0, 0x7d]);
    expect(toPlainJson(ledgerLoads(bom))).toEqual({});
  });

  test('an invalid byte encoding keeps the Python UnicodeDecodeError class', () => {
    expect(() => ledgerLoads(new Uint8Array([0x80]))).toThrow(LedgerUnicodeDecodeError);
    expect(() => ledgerLoads(new Uint8Array([0x7b, 0, 0, 0, 0x7d, 0, 0]))).toThrow(
      LedgerUnicodeDecodeError,
    );
  });

  test('loads refuses floats and constants while scanning, in document order', () => {
    // Python's parse_float/parse_constant refusals happen before a later
    // syntax error, while object_pairs_hook waits for the object to close.
    expect(() => ledgerLoads('[1.0,]')).toThrow(LedgerIntegrityError);
    expect(() => ledgerLoads('{broken NaN}')).toThrow(LedgerJsonDecodeError);
    expect(() => ledgerLoads('{"a":1,"a":2,}')).toThrow(LedgerJsonDecodeError);
    expect(() => ledgerLoads('{"a":1,"a":2}')).toThrow(LedgerIntegrityError);
    expect(() => ledgerLoads('{"a":1,"a":2,"b":}')).toThrow(LedgerJsonDecodeError);
  });

  test('an invalid calendar timestamp keeps the Python ValueError class', () => {
    expect(() => ledgerTimestamp('2026-02-30T00:00:00Z')).toThrow(LedgerTimestampError);
    expect(() => ledgerTimestamp('٢٠٢٦-١١-٠٩T٠٠:٠٠:٠٠Z')).toThrow(LedgerTimestampError);
  });

  test("timestamp reproduces strptime's Unicode digit grammar", () => {
    expect(ledgerTimestamp('٢٠٢٦-11-09T00:00:00Z').year).toBe(2026);
    expect(ledgerTimestamp('२०२६-11-09T00:00:00Z').year).toBe(2026);
    expect(ledgerTimestamp('2026-11-1٢T00:00:00Z').day).toBe(12);
    expect(ledgerTimestamp('2026-11-09T0٢:00:00Z').hour).toBe(2);
    expect(ledgerTimestamp('2026-11-09T00:5٩:00Z').minute).toBe(59);
    expect(ledgerTimestamp('2026-11-09T00:00:5٩Z').second).toBe(59);
    // %m is ASCII-only and a leading non-ASCII digit is refused.
    expect(() => ledgerTimestamp('2026-١١-09T00:00:00Z')).toThrow(LedgerTimestampError);
    expect(() => ledgerTimestamp('2026-11-٢٢T00:00:00Z')).toThrow(LedgerTimestampError);
  });

  test('a record whose id does not match its digest is refused', () => {
    const event = vectors.find(
      (vector) => vector.family === 'validate' && vector.name === 'valid-review',
    );
    if (event === undefined) throw new Error('valid-review vector missing');
    const record = requireObject(valueAt(event.input, 'value'), 'record');
    const valid = capture(() => ledgerValidate(record));
    expect(valid.ok, valid.ok ? undefined : valid.message).toBe(true);

    const tampered = new JsonObject(
      record.entries.map(([key, value]): readonly [string, JsonValue] => [
        key,
        key === 'id' ? '0'.repeat(64) : value,
      ]),
    );
    const refused = capture(() => ledgerValidate(tampered));
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.pythonError).toBe('IntegrityError');
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
