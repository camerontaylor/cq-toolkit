/** Reader for the triage judge oracle fixture (`apps/crq-python/triage_judge_vectors.py`). */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  pythonNonFinite,
  type JsonValue,
} from '../../src/policy/crq/jsonValue.js';
import { pythonJsonText } from '../../src/policy/crq/pythonJson.js';

const FIXTURE = fileURLToPath(
  new URL('../../apps/crq-python/fixtures/crq-triage-judge/cases.json', import.meta.url),
);

export function loadJudgeFixture(): JsonObject {
  return parseJsonValue(readFileSync(FIXTURE, 'utf8'), {
    parseConstant: pythonNonFinite,
  }) as JsonObject;
}

/** `value[key]` for an object, throwing on a missing key (a fixture-shape error). */
export function field(value: JsonValue | undefined, key: string): JsonValue {
  if (!(value instanceof JsonObject) || !value.has(key)) throw new Error(`fixture lacks ${key}`);
  return value.get(key) as JsonValue;
}

export function cases(group: string): JsonObject[] {
  return field(loadJudgeFixture(), group) as unknown as JsonObject[];
}

/** Canonical text with kinds and key order kept, for byte-exact comparison. */
export function canon(value: JsonValue | undefined): string {
  return pythonJsonText(value === undefined ? null : value, {
    asciiOnly: true,
    sortKeys: true,
    spacedSeparators: true,
  });
}

export function num(value: JsonValue): number {
  if (!(value instanceof JsonNumber)) throw new Error('fixture number expected');
  return value.kind === 'int' ? Number(value.integer) : (value.float as number);
}
