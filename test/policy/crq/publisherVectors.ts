/** Shared loader and evidence helpers for the B1 publisher oracle vectors. */
import { readFileSync } from 'node:fs';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { ledgerCanonicalBytes, ledgerRecordPath } from '../../../src/policy/crq/ledger.js';
import { sha256Hex } from '../../../src/policy/crq/pythonJson.js';

const VECTORS = new URL(
  '../../../apps/crq-python/fixtures/crq-publisher-b1/vectors.json',
  import.meta.url,
);

export interface PublisherVectorCase {
  readonly family: string;
  readonly name: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly expect: JsonObject;
}

export interface RecordEvidence {
  readonly id: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly canonical?: string;
}

export function requireObject(value: JsonValue | undefined, what: string): JsonObject {
  if (!(value instanceof JsonObject)) throw new Error(`${what} is not an object`);
  return value;
}

export function stringAt(object: JsonObject, key: string): string {
  const value = object.get(key);
  if (typeof value !== 'string') throw new Error(`missing string ${key}`);
  return value;
}

export function numberAt(object: JsonObject, key: string): number {
  const value = object.get(key);
  if (!(value instanceof JsonNumber) || value.kind !== 'int') {
    throw new Error(`missing integer ${key}`);
  }
  const number = Number(value.integer);
  if (!Number.isSafeInteger(number)) throw new Error(`unsafe integer ${key}`);
  return number;
}

export function arrayAt(object: JsonObject, key: string): JsonValue[] {
  const value = object.get(key);
  if (!Array.isArray(value)) throw new Error(`missing array ${key}`);
  return value;
}

export function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`missing vector entry ${String(index)}`);
  return item;
}

export function arrayValue(value: JsonValue | undefined, what: string): JsonValue[] {
  if (!Array.isArray(value)) throw new Error(`${what} is not an array`);
  return value;
}

export function idsAt(object: JsonObject, key: string): string[] {
  return arrayAt(object, key).map((entry) => {
    if (typeof entry !== 'string') throw new Error(`non-string id in ${key}`);
    return entry;
  });
}

export function recordId(value: JsonValue): string {
  const record = requireObject(value, 'record');
  return stringAt(record, 'id');
}

export function recordEventType(value: JsonValue): string {
  return stringAt(requireObject(value, 'record'), 'event_type');
}

export function recordEvidence(value: JsonValue): RecordEvidence {
  const raw = ledgerCanonicalBytes(value);
  return {
    id: recordId(value),
    path: ledgerRecordPath(value),
    bytes: raw.byteLength,
    sha256: sha256Hex(raw),
    ...(raw.byteLength <= 4096 ? { canonical: new TextDecoder().decode(raw) } : {}),
  };
}

export function batchEvidence(batches: readonly (readonly JsonValue[])[]): RecordEvidence[][] {
  return batches.map((batch) => batch.map(recordEvidence));
}

export function expectedBatchEvidence(value: JsonValue): RecordEvidence[][] {
  return arrayValue(requireObject(value, 'expected value').get('batches'), 'expected batches').map(
    (batch) => evidenceList(batch),
  );
}

export function evidenceList(value: JsonValue | undefined): RecordEvidence[] {
  return arrayValue(value, 'evidence list').map((row) => {
    const entry = requireObject(row, 'expected record');
    return {
      id: stringAt(entry, 'id'),
      path: stringAt(entry, 'path'),
      bytes: numberAt(entry, 'bytes'),
      sha256: stringAt(entry, 'sha256'),
      ...(entry.has('canonical') ? { canonical: stringAt(entry, 'canonical') } : {}),
    };
  });
}

export function artifactSha(reference: JsonValue): string {
  return stringAt(requireObject(reference, 'artifact reference'), 'sha256');
}

export function loadPublisherVectors(): PublisherVectorCase[] {
  const document = requireObject(
    parseJsonValue(readFileSync(VECTORS, 'utf8')),
    'publisher vector document',
  );
  if (document.get('schema') !== 'cq.crq-publisher-b1-vector/v1') {
    throw new Error('unexpected publisher vector schema');
  }
  const cases: PublisherVectorCase[] = [];
  for (const familyValue of arrayAt(document, 'families')) {
    const family = requireObject(familyValue, 'family');
    const familyName = stringAt(family, 'family');
    for (const caseValue of arrayAt(family, 'cases')) {
      const entry = requireObject(caseValue, 'case');
      cases.push({
        family: familyName,
        name: stringAt(entry, 'name'),
        source: stringAt(entry, 'source'),
        input: requireObject(entry.get('input'), 'input'),
        expect: requireObject(entry.get('expect'), 'expect'),
      });
    }
  }
  return cases;
}
