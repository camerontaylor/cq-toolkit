import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, test } from 'vitest';
import {
  JsonObject,
  parseJsonValue,
  toPlainJson,
  type JsonValue,
} from '../../../src/policy/crq/jsonValue.js';
import {
  PythonJsonError,
  atomicJsonText,
  ledgerJsonBytes,
  receiptJsonBytes,
  sha256Hex,
} from '../../../src/policy/crq/pythonJson.js';
import { parseIso, parseUtc, UtcParseError } from '../../../src/policy/crq/utc.js';
import { decideCompletion, parseReviewerStream } from '../../../src/ops/dev/coderabbit.js';

const GROUP_P = new URL('../../../apps/crq-python/fixtures/group-p/', import.meta.url);

interface VectorCase {
  readonly family: string;
  readonly name: string;
  readonly source: string;
  readonly input: JsonObject;
  readonly expect: JsonObject;
}

type Outcome = { ok: true; value: unknown } | { ok: false; pythonError: string };

function loadFamily(name: string): VectorCase[] {
  const document = parseJsonValue(readFileSync(new URL(`${name}.json`, GROUP_P), 'utf8'));
  if (!(document instanceof JsonObject))
    throw new Error(`${name}: family document is not an object`);
  const cases = document.get('cases');
  if (!Array.isArray(cases)) throw new Error(`${name}: missing cases`);
  return cases.map((entry) => {
    if (!(entry instanceof JsonObject)) throw new Error(`${name}: case is not an object`);
    const input = entry.get('input');
    const expected = entry.get('expect');
    if (!(input instanceof JsonObject) || !(expected instanceof JsonObject)) {
      throw new Error(`${name}: malformed case ${String(entry.get('name'))}`);
    }
    return {
      family: name,
      name: stringAt(entry, 'name'),
      source: stringAt(entry, 'source'),
      input,
      expect: expected,
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

function capture(action: () => unknown): Outcome {
  try {
    return { ok: true, value: action() };
  } catch (error) {
    if (error instanceof PythonJsonError || error instanceof UtcParseError) {
      return { ok: false, pythonError: error.pythonError };
    }
    throw error;
  }
}

function assertExpected(vector: VectorCase, outcome: Outcome): void {
  const ok = vector.expect.get('ok');
  if (ok === true) {
    expect(outcome.ok, `${vector.family}/${vector.name}`).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).toEqual(toPlainJson(valueAt(vector.expect, 'value')));
    return;
  }
  expect(outcome.ok, `${vector.family}/${vector.name}`).toBe(false);
  if (outcome.ok) return;
  expect(outcome.pythonError).toBe(stringAt(vector.expect, 'error'));
}

function encodeCanonical(vector: VectorCase): unknown {
  const value = valueAt(vector.input, 'value');
  const bytes = vector.source.startsWith('review_receipt.')
    ? receiptJsonBytes(value)
    : ledgerJsonBytes(value);
  return { canonical: Buffer.from(bytes).toString('utf8'), sha256: sha256Hex(bytes) };
}

function encodeQueue(vector: VectorCase): unknown {
  const source = vector.input.has('raw')
    ? parseJsonValue(stringAt(vector.input, 'raw'))
    : valueAt(vector.input, 'value');
  const text = atomicJsonText(source);
  return { text, sha256: sha256Hex(Buffer.from(text, 'utf8')) };
}

function parseVectorTime(vector: VectorCase): unknown {
  const raw = toPlainJson(valueAt(vector.input, 'value'));
  if (vector.source === 'queue_time.parse_utc') return { utc: parseUtc(raw)?.iso ?? null };
  return { utc: parseIso(raw)?.iso ?? null };
}

describe.each(loadFamily('canonical'))('canonical/$name', (vector) => {
  test(`${vector.source} matches the Python oracle`, () => {
    assertExpected(
      vector,
      capture(() => encodeCanonical(vector)),
    );
  });
});

test('a changed canonical byte fails the differential', () => {
  const vector = loadFamily('canonical')[0];
  if (vector === undefined) throw new Error('canonical vectors are empty');
  const result = encodeCanonical(vector) as { canonical: string; sha256: string };
  expect(() =>
    assertExpected(vector, { ok: true, value: { ...result, canonical: `${result.canonical} ` } }),
  ).toThrow();
});

describe.each(loadFamily('time'))('time/$name', (vector) => {
  test(`${vector.source} matches the Python oracle`, () => {
    assertExpected(
      vector,
      capture(() => parseVectorTime(vector)),
    );
  });
});

describe.each(loadFamily('queue-bytes'))('queue-bytes/$name', (vector) => {
  test('crq_repair.atomic bytes match the Python oracle', () => {
    assertExpected(
      vector,
      capture(() => encodeQueue(vector)),
    );
  });
});

// Only completion eligibility is implemented by the existing TS classifier;
// the Python diagnostic fields and retry provenance await the crq port.
test('classifier vectors include the D2 no-fresh case', () => {
  expect(loadFamily('classify').map((vector) => vector.name)).toContain(
    'affirmative-no-fresh-completion-is-skipped',
  );
});
describe.each(loadFamily('classify'))('classify/$name', (vector) => {
  test('completion eligibility matches Python, with the D2 no-fresh exception', () => {
    const ndjson = toPlainJson(valueAt(vector.input, 'ndjson'));
    const exit = toPlainJson(valueAt(vector.input, 'exit_code'));
    const expected = toPlainJson(valueAt(vector.expect, 'value')) as {
      counted: boolean;
      outcome: string;
    };
    const verdict = decideCompletion(
      typeof exit === 'number' ? exit : -1,
      parseReviewerStream(typeof ndjson === 'string' ? ndjson : ''),
    );
    expect(verdict.kind === 'terminal').toBe(expected.counted);
    if (vector.name === 'affirmative-no-fresh-completion-is-skipped') {
      expect(expected.outcome).toBe('skipped');
      expect(verdict.kind).toBe('blocked');
      if (verdict.kind === 'blocked') expect(verdict.reason).toContain('skipped:no-fresh');
    }
  });
});

/**
 * A family WITHOUT a ported implementation. The reason is part of the test so
 * the runner cannot claim broad vector coverage by omission.
 */
const NOT_APPLICABLE: Readonly<Record<string, string>> = {
  'backfill-accounting': 'backfill accounting is a later group-P port',
  'backfill-inventory': 'backfill inventory is a later group-P port',
  'backfill-report': 'backfill report is a later group-P port',
  backfill: 'backfill driver helpers are a later group-P port',
  coverage: 'coverage policy is a later group-P port',
  ledger:
    'ledger validators/interval/path/creditable functions are a later group-P port; review_ledger.canonical+digest cases live in canonical.json and ARE replayed above',
  'merged-reconcile': 'merged-interval math is a later group-P port',
  'promotion-filter': 'promotion filters are retained Python behaviour until the C2 port',
  'status-helpers': 'status helpers are a later group-P port',
  summary: 'summary rendering is a later group-P port',
  usage: 'usage/slot pacing is a later group-P port',
};

const HANDLED = new Set(['canonical', 'time', 'queue-bytes', 'classify']);

test('every group-P family is either replayed or explicitly not applicable', () => {
  const families = readdirSync(GROUP_P)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const document = parseJsonValue(readFileSync(new URL(name, GROUP_P), 'utf8'));
      if (!(document instanceof JsonObject)) throw new Error(`${name} is not a family`);
      return stringAt(document, 'family');
    })
    .sort();
  const known = [...HANDLED, ...Object.keys(NOT_APPLICABLE)].sort();
  expect(families).toEqual(known);
  for (const [family, reason] of Object.entries(NOT_APPLICABLE)) {
    expect(reason.length, family).toBeGreaterThan(0);
  }
});
