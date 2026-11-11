/**
 * Differential tests for `coverage.utilization_digest` (A1 publish section).
 *
 * Two oracle sources are replayed:
 *
 * - the shared group-P family `fixtures/group-p/coverage.json`, selecting the
 *   four `source: "coverage.utilization_digest"` cases (the rest of coverage
 *   remains a later port and stays NOT_APPLICABLE in `vectors.test.ts`);
 * - the A1 family `fixtures/a1-status/utilization.json`, emitted by
 *   `emit.py` from the real `coverage.utilization_digest` at the same commit.
 *
 * Both are parsed with `parseJsonValue`, never `JSON.parse`, so `5.0`,
 * `15.0`, `0.0`, `1e308`, `NaN`/`Infinity` and non-BMP input strings keep the
 * bytes the Python oracle produced. Outputs are compared as compact
 * `pythonJsonText`, not materialised JavaScript numbers.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonNumber,
  JsonObject,
  parseJsonValue,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import { pythonJsonText, type PythonJsonOptions } from '../../../src/policy/crq/pythonJson.js';
import {
  CoverageUtilizationError,
  utilizationDigest,
} from '../../../src/policy/crq/coverageUtilization.js';

const GROUP_P = new URL('../../../apps/crq-python/fixtures/group-p/', import.meta.url);
const A1 = new URL('../../../apps/crq-python/fixtures/a1-status/', import.meta.url);
const COMPACT: PythonJsonOptions = {
  asciiOnly: true,
  sortKeys: false,
  keyOrder: 'insertion',
  indent: null,
};

interface Expectation {
  readonly ok: boolean;
  readonly value?: JsonValue;
  readonly error?: string;
  readonly message?: string;
}

interface Case {
  readonly family: string;
  readonly name: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly expect: Expectation;
}

interface Outcome {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: string;
  readonly message?: string;
}

function constant(raw: string): JsonValue {
  if (raw === 'NaN') return JsonNumber.float(Number.NaN);
  if (raw === 'Infinity') return JsonNumber.float(Number.POSITIVE_INFINITY);
  return JsonNumber.float(Number.NEGATIVE_INFINITY);
}

function loadDocument(directory: URL, name: string): JsonObject {
  const parsed = parseJsonValue(readFileSync(new URL(`${name}.json`, directory), 'utf8'), {
    parseConstant: constant,
  });
  if (!(parsed instanceof JsonObject)) throw new Error(`${name}: root is not an object`);
  return parsed;
}

function casesOf(document: JsonObject, family: string): Case[] {
  const cases = document.get('cases');
  if (!Array.isArray(cases)) throw new Error(`${family}: missing cases`);
  return cases.map((entry, index) => {
    if (!(entry instanceof JsonObject)) throw new Error(`${family}[${String(index)}]`);
    const input = entry.get('input');
    const expected = entry.get('expect');
    if (!(input instanceof JsonObject) || !(expected instanceof JsonObject)) {
      throw new Error(`${family}[${String(index)}]: malformed case`);
    }
    const ok = expected.get('ok');
    if (typeof ok !== 'boolean') throw new Error(`${family}[${String(index)}]: missing ok`);
    return {
      family,
      name: stringAt(entry, 'name'),
      source: stringAt(entry, 'source'),
      input,
      expect: {
        ok,
        ...(ok ? { value: valueAt(expected, 'value') } : {}),
        ...(ok ? {} : { error: stringAt(expected, 'error') }),
        ...(ok ? {} : { message: stringAt(expected, 'message') }),
      },
    };
  });
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

function run(vector: Case): Outcome {
  const now = vector.input.get('now');
  const cap = vector.input.get('max_starts_per_hour');
  const queue = vector.input.get('queue');
  const ledger = vector.input.get('ledger');
  try {
    return {
      ok: true,
      value: utilizationDigest(queue, ledger, { now, maxStartsPerHour: cap }),
    };
  } catch (error) {
    if (error instanceof CoverageUtilizationError) {
      return { ok: false, error: error.pythonError, message: error.message };
    }
    throw error;
  }
}

function assertCase(vector: Case): void {
  const outcome = run(vector);
  expect(outcome.ok, vector.name).toBe(vector.expect.ok);
  if (vector.expect.ok) {
    expect(outcome.value, vector.name).toBeDefined();
    expect(compact(outcome.value), vector.name).toBe(compact(vector.expect.value));
    return;
  }
  expect(outcome.error, vector.name).toBe(vector.expect.error);
  expect(outcome.message, vector.name).toBe(vector.expect.message);
}

function compact(value: unknown): string {
  return pythonJsonText(value, COMPACT);
}

const groupP = casesOf(loadDocument(GROUP_P, 'coverage'), 'coverage').filter(
  (vector) => vector.source === 'coverage.utilization_digest',
);
const a1 = casesOf(loadDocument(A1, 'utilization'), 'utilization');

describe.each(groupP.map((vector) => [vector.name, vector] as const))(
  'group-P coverage.utilization_digest/$name',
  (_name, vector) => {
    test('matches the Python oracle bytes', () => {
      assertCase(vector);
    });
  },
);

describe.each(a1.map((vector) => [vector.name, vector] as const))(
  'a1 utilization/$name',
  (_name, vector) => {
    test('matches the Python oracle bytes or refusal', () => {
      assertCase(vector);
    });
  },
);

function emptyQueue(): JsonObject {
  return new JsonObject([
    ['starts', []],
    ['cooldown_until', null],
  ]);
}

function emptyLedger(): JsonObject {
  return new JsonObject([
    ['schema_version', JsonNumber.int(1)],
    ['paths', new JsonObject([])],
    ['runs', new JsonObject([])],
    ['observations', new JsonObject([])],
  ]);
}

function digest(cap: unknown): string {
  return compact(
    utilizationDigest(emptyQueue(), emptyLedger(), {
      now: '2026-11-09T12:00:00Z',
      maxStartsPerHour: cap,
    }),
  );
}

describe('numeric boundary contract', () => {
  test('a lossless int cap and the same float cap serialize differently', () => {
    expect(digest(JsonNumber.int(5))).toContain('"nominal_cap_24h":120,');
    expect(digest(JsonNumber.float(5))).toContain('"nominal_cap_24h":120.0,');
    expect(digest(JsonNumber.float(5))).toContain('"nominal_utilization":0.0,');
  });

  test('an exact bigint cap keeps every digit', () => {
    const cap = 10n ** 30n;
    expect(digest(cap)).toContain('"nominal_cap_24h":24000000000000000000000000000000,');
  });

  test('an unsafe plain integer refuses instead of rounding', () => {
    expect(() => digest(2 ** 53)).toThrow(CoverageUtilizationError);
    expect(() => digest(2 ** 53)).toThrow(/lossless JsonNumber or bigint/u);
  });

  test('a true cap is the Python int 1 and a false cap is refused', () => {
    expect(digest(true)).toContain('"nominal_cap_24h":24,');
    expect(() => digest(false)).toThrow('max_starts_per_hour must be positive');
  });
});

describe('timestamp and cooldown rounding contract', () => {
  test('fromtimestamp rounds the binary64 microsecond product half-even', () => {
    const queue = new JsonObject([
      ['starts', [JsonNumber.float(0.0000025)]],
      ['cooldown_until', null],
    ]);
    const value = utilizationDigest(queue, emptyLedger(), {
      now: '1970-01-01T00:00:00.000002Z',
      maxStartsPerHour: 5,
    });
    // Exact-rational rounding would produce 3 microseconds and exclude the
    // start; CPython multiplies in binary64 first and rounds 2.5 to 2.
    expect(compact(value)).toContain('"starts_24h":1,');
  });

  test('cooldown uses timedelta.total_seconds exact int ratio', () => {
    const queue = new JsonObject([
      ['starts', []],
      ['cooldown_until', '2400-01-01T00:00:00.000001Z'],
    ]);
    const value = utilizationDigest(queue, emptyLedger(), {
      now: '2026-11-09T12:00:00Z',
      maxStartsPerHour: 5,
    });
    // Converting the whole microsecond delta to binary64 first loses the low
    // bit and yields 196254000.0.
    expect(compact(value)).toContain('"cooldown_minutes":196254000.00000003,');
  });
});

function observationLedger(pending: readonly unknown[]): Record<string, unknown> {
  const observations: Record<string, unknown> = {};
  pending.forEach((value, index) => {
    observations[`2026-11-09T11:${String(index).padStart(2, '0')}:00Z`] = {
      started: false,
      pending: value,
      candidate_exists: true,
      blocked_reason: null,
    };
  });
  return { schema_version: 1, paths: {}, runs: {}, observations };
}

function pendingDigest(pending: readonly unknown[]): string {
  return compact(
    utilizationDigest({ starts: [] }, observationLedger(pending), {
      now: '2026-11-09T12:00:00Z',
      maxStartsPerHour: 5,
    }),
  );
}

describe('plain bigint observations', () => {
  test('an exact bigint stays exact instead of refusing', () => {
    expect(pendingDigest([9007199254740993n])).toContain(
      '"idle_while_pending_24h":9007199254740993,',
    );
  });

  test('a bigint followed by a float converts once, like PyNumber_Add', () => {
    expect(pendingDigest([10n ** 30n, 0.5])).toContain('"idle_while_pending_24h":1e+30,');
  });

  test('a huge bigint with a float raises Python OverflowError', () => {
    try {
      pendingDigest([10n ** 400n, 0.5]);
      throw new Error('expected OverflowError');
    } catch (error) {
      expect(error).toBeInstanceOf(CoverageUtilizationError);
      expect((error as CoverageUtilizationError).pythonError).toBe('OverflowError');
      expect((error as CoverageUtilizationError).message).toBe('int too large to convert to float');
    }
  });
});
